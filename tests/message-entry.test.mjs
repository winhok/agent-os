import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { SessionManager } from "../src/core/session-manager.ts";
import { BotMessageDeduplicator, externalBotTaskOwner } from "../src/app/external-bot-task.ts";
import * as collaboration from "../src/core/collaboration.ts";
import { parseCommand, parseCliRequest } from "../src/core/command-parser.ts";
import { handleSessionCommand } from "../src/app/command-handler.ts";
import { markSessionIdle } from "../src/app/session-view.ts";
import { topicTaskId } from "../src/core/topic-task.ts";
import { resolveMentions, extractResourceKeys } from "../src/im/message-parser.ts";
import { findApprovalRequest } from "../src/core/approval.ts";
import { ensureProductSpecSubmission } from "../src/app/product-spec-submission.ts";
import { sendResultNotification } from "../src/app/notification-service.ts";
import {
  answerNeedsContinuation,
  answerContinuation,
  splitLongText,
  buildTaskCard,
  ThrottledCardUpdater,
} from "../src/im/card.ts";
import { TaskProgressTracker } from "../src/core/task-progress.ts";

// Execute the actual onMessage callback without starting index.ts's bots or API.
const source = ts.createSourceFile(
  "index.ts",
  readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let callback;
function find(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === "onMessage")
    callback = node.initializer.getText(source);
  ts.forEachChild(node, find);
}
find(source);
assert.ok(callback);
const compiled = ts.transpileModule(`const handler = ${callback};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function fixture() {
  const sessions = new SessionManager();
  const activeRuns = new Map();
  const config = { id: "developer", defaultCliId: "claude", workspaceDir: "/tmp/demo", skills: [] };
  const runtime = { sessions, activeRuns };
  const scheduler = {
    pause: () => {
      pauses++;
      return { id: "job" };
    },
  };
  const completions = [];
  const notifications = [];
  let starts = 0;
  let pauses = 0;
  const dependencies = {
    sessions,
    activeRuns,
    config,
    runtime,
    scheduler,
    ...collaboration,
    externalBotTaskOwner,
    parseCommand,
    parseCliRequest,
    handleSessionCommand,
    markSessionIdle,
    topicTaskId,
    resolveMentions,
    extractResourceKeys,
    buildTaskCard,
    ThrottledCardUpdater,
    findApprovalRequest,
    ensureProductSpecSubmission,
    sendResultNotification,
    answerNeedsContinuation,
    answerContinuation,
    splitLongText,
    TaskProgressTracker,
    processedBotMessages: new BotMessageDeduplicator(),
    processedCollaborationTurns: new Set(),
    collaborationInbox: new collaboration.CollaborationInbox(),
    botRuntimes: new Map([["developer", { identity: { openId: "ou_dev" } }]]),
    teamRegistry: { contextFor: () => ({}) },
    agentOsConfig: { defaultProductDeliveryMode: "local" },
    buildBotPrompt: (_config, text) => text,
    getCliAdapter: () => ({ id: "claude", displayName: "Claude" }),
    contextWindows: new Map(),
    executeCli: () => {
      starts++;
      return new Promise((resolve) => completions.push(resolve));
    },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    process: { env: { OWNER_OPEN_ID: "ou_owner" } },
  };
  const handler = new Function(...Object.keys(dependencies), `${compiled}\nreturn handler;`)(
    ...Object.values(dependencies),
  );
  const bot = {
    reply: async () => "om_reply",
    replyCard: async () => "om_card",
    updateCard: async () => {},
    replyMention: async (_id, _target, text) => {
      notifications.push(text);
      return "om_notice";
    },
  };
  const message = (id, text = "检查日志") => ({
    messageId: id,
    chatId: "oc_chat",
    chatType: "group",
    threadId: "thread",
    rootId: "",
    senderType: "bot",
    senderOpenId: "ou_webhook",
    senderUnionId: "",
    messageType: "text",
    rawContent: JSON.stringify({ text }),
    text,
    mentions: [{ key: "@_user_1", openId: "ou_dev", name: "开发" }],
  });
  return {
    sessions,
    activeRuns,
    handler,
    bot,
    message,
    dependencies,
    completions,
    notifications,
    get starts() {
      return starts;
    },
    get pauses() {
      return pauses;
    },
  };
}

test("入口：旧任务卡片失败后，新任务启动不被旧finally改为空闲", async () => {
  const f = fixture();
  let inserted = false;
  const originalTransition = f.sessions.transition.bind(f.sessions);
  f.sessions.transition = async (id, status) => {
    const result = await originalTransition(id, status);
    if (status === "idle" && !inserted) {
      inserted = true;
      await f.handler(f.message("om_b"), f.bot);
    }
    return result;
  };
  await assert.rejects(
    f.handler(f.message("om_a"), {
      ...f.bot,
      replyCard: async () => {
        throw new Error("卡片失败");
      },
    }),
    /卡片失败/,
  );
  assert.equal(f.starts, 1);
  const { session } = await f.sessions.resolve(f.message("om_b"), "claude", "developer");
  assert.equal(session.status, "active");
  assert.ok(f.activeRuns.has(session.id));
});

test("入口：schedule需求准备失败可重试，同消息并发仅启动一次", async () => {
  const f = fixture();
  const msg = f.message("om_schedule", "/schedule 每小时检查日志");
  await assert.rejects(
    f.handler(msg, {
      ...f.bot,
      replyCard: async () => {
        throw new Error("卡片失败");
      },
    }),
    /卡片失败/,
  );
  assert.equal(f.starts, 0);
  await Promise.all([f.handler(msg, f.bot), f.handler(msg, f.bot)]);
  assert.equal(f.starts, 1);
  await f.handler(msg, f.bot);
  assert.equal(f.starts, 1);
});

test("入口：直接命令副作用已发生，回复失败也不重复暂停任务", async () => {
  const f = fixture();
  const msg = f.message("om_pause", "/schedule pause job");
  await assert.rejects(
    f.handler(msg, {
      ...f.bot,
      reply: async () => {
        throw new Error("回复失败");
      },
    }),
    /回复失败/,
  );
  await f.handler(msg, f.bot);
  assert.equal(f.pauses, 1);
  assert.equal(f.starts, 0);
});

test("入口：准备卡片等待期间运行归属已替换，旧任务不能清理新运行", async () => {
  const f = fixture();
  await assert.rejects(
    f.handler(f.message("om_old"), {
      ...f.bot,
      replyCard: async () => {
        const { session } = await f.sessions.resolve(f.message("om_old"), "claude", "developer");
        await f.sessions.transition(session.id, "idle");
        await f.handler(f.message("om_new"), f.bot);
        throw new Error("旧卡片迟到的失败");
      },
    }),
    /旧卡片迟到的失败/,
  );
  const { session } = await f.sessions.resolve(f.message("om_new"), "claude", "developer");
  assert.equal(session.status, "active");
  assert.ok(f.activeRuns.has(session.id));
  assert.equal(f.starts, 1);
});

test("入口：准备期间close后卡片失败，保持closed并清理自己的ActiveRun", async () => {
  const f = fixture();
  await assert.rejects(
    f.handler(f.message("om_prepare_close"), {
      ...f.bot,
      replyCard: async () => {
        await f.handler(f.message("om_close", "/close"), f.bot);
        throw new Error("卡片失败");
      },
    }),
    /卡片失败/,
  );
  const { session } = await f.sessions.resolve(f.message("om_prepare_close"), "claude", "developer");
  assert.equal(session.status, "closed");
  assert.equal(f.activeRuns.has(session.id), false);
  assert.equal(f.starts, 0);
});

test("入口：正常CLI执行完成后回传结果、清理运行并恢复idle", async () => {
  const f = fixture();
  const msg = f.message("om_complete");
  await f.handler(msg, f.bot);
  const { session } = await f.sessions.resolve(msg, "claude", "developer");
  assert.equal(session.status, "active");
  assert.equal(f.activeRuns.size, 1);
  let settled;
  const finished = new Promise((resolve) => {
    settled = resolve;
  });
  const transition = f.sessions.transition.bind(f.sessions);
  f.sessions.transition = async (id, status) => {
    const updated = await transition(id, status);
    if (id === session.id && status === "idle") settled();
    return updated;
  };
  f.completions[0]({ answer: "日志检查完成，无异常", sessionId: "native_session" });
  await finished;
  assert.equal(f.sessions.get(session.id).status, "idle");
  assert.equal(f.sessions.get(session.id).cliSessionId, "native_session");
  assert.equal(f.activeRuns.size, 0);
  assert.ok(f.notifications.includes("任务已完成，请查看上方结果。"));
  await f.handler(msg, f.bot);
  assert.equal(f.starts, 1);
});
