import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotMessageDeduplicator, externalBotTaskOwner } from "../src/app/external-bot-task.ts";
import {
  collaborationMessageMarker,
  parseCollaborationMessageMarker,
  CollaborationInbox,
} from "../src/core/collaboration.ts";
import { buildMentionPostContent, extractMessageText, FEISHU_MENTION_LIMIT } from "../src/im/lark.ts";
import { CollaborationService } from "../src/app/collaboration-service.ts";
import { persistBotIdentities } from "../src/app/bot-identities.ts";

const message = { senderType: "bot", text: "日志异常，请检查", mentions: [{ openId: "ou_dev" }] };

test("webhook 真正 @ 目标 bot 才接单，审批归属人类 owner", () => {
  assert.equal(externalBotTaskOwner(message, "ou_dev", " ou_owner "), "ou_owner");
  assert.equal(externalBotTaskOwner({ ...message, senderType: "app" }, "ou_dev", "ou_owner"), "ou_owner");
  for (const [input, target, owner] of [
    [{ ...message, mentions: [], text: "@developer" }, "ou_dev", "ou_owner"],
    [message, "ou_other", "ou_owner"],
    [message, undefined, "ou_owner"],
    [message, "ou_dev", " "],
    [{ ...message, senderType: "user" }, "ou_dev", "ou_owner"],
    [{ ...message, text: collaborationMessageMarker("a".repeat(32)) }, "ou_dev", "ou_owner"],
  ])
    assert.equal(externalBotTaskOwner(input, target, owner), undefined);
});

test("原子导出运行项目通知脚本所需的 bot 身份", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patrol-chain-"));
  try {
    const path = join(directory, "bot-identities.json");
    await persistBotIdentities(path, { developer: { openId: "ou_dev", name: "开发" } });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { developer: { openId: "ou_dev", name: "开发" } });
    assert.deepEqual(await readdir(directory), ["bot-identities.json"]);
    await persistBotIdentities(path, { developer: { openId: "ou_updated", name: "开发" } });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      developer: { openId: "ou_updated", name: "开发" },
    });
    assert.deepEqual(await readdir(directory), ["bot-identities.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("巡检正文含任务编号或32位编号仍能接单", () => {
  for (const text of ["日志里出现任务编号：旧编号", `任务编号：${"a".repeat(32)}`, "任务编号：排查服务故障"]) {
    assert.equal(externalBotTaskOwner({ ...message, text }, "ou_dev", "ou_owner"), "ou_owner");
    assert.equal(parseCollaborationMessageMarker(text), undefined);
  }
});

test("消息ID按接收bot去重，独立通知不按正文误去重", () => {
  const messages = new BotMessageDeduplicator(2);
  assert.equal(messages.claim("developer", "om_one"), true);
  messages.accept("developer", "om_one");
  assert.equal(messages.claim("developer", "om_one"), false);
  assert.equal(messages.claim("reviewer", "om_one"), true);
  messages.accept("reviewer", "om_one");
  assert.equal(messages.claim("developer", "om_two"), true);
  messages.accept("developer", "om_two");
  assert.equal(messages.claim("developer", "om_two"), false);
  assert.equal(messages.claim("developer", ""), false);
  assert.equal(messages.claim("developer", "om_one"), true);
});

test("两条协作发送分支携带明确标识，消费后不得降级成巡检任务", async () => {
  for (const skipCard of [true, false]) {
    const instruction = "查".repeat(1900) + "\n" + collaborationMessageMarker("b".repeat(32));
    const inbox = new CollaborationInbox();
    const notifications = [];
    const senderBot = {
      sendCardToChat: async () => "om_card",
      replyCard: async () => "om_card",
      sendMentionToChat: async (_chat, _target, text) => {
        notifications.push(text);
        return "om_notice";
      },
      replyMention: async (_card, _target, text) => {
        notifications.push(text);
        return "om_notice";
      },
    };
    const runtime = {
      collaborationInbox: inbox,
      botRuntimes: new Map([
        ["ceo", { identity: { openId: "ou_ceo", name: "CEO" } }],
        ["developer", { identity: { openId: "ou_dev", name: "开发" } }],
      ]),
    };
    await new CollaborationService(runtime).dispatch({
      senderConfig: { id: "ceo" },
      senderBot,
      targetBotId: "developer",
      reportToBotId: "ceo",
      ...(skipCard ? { chatId: "oc_chat", skipCard: true } : { replyToMessageId: "om_root" }),
      taskId: "task",
      ownerOpenId: "ou_owner",
      objective: "检查日志\n" + collaborationMessageMarker("c".repeat(32)),
      instruction,
      round: 1,
      maxRounds: 16,
      workspaceDir: "/tmp/demo-server",
    });
    const notification = notifications[0];
    assert.ok(notification.length < FEISHU_MENTION_LIMIT);
    const post = buildMentionPostContent({ openId: "ou_dev", name: "开发" }, notification);
    const text = extractMessageText("post", JSON.stringify(post.zh_cn));
    const dispatchId = parseCollaborationMessageMarker(text);
    assert.match(dispatchId, /^[a-f0-9]{32}$/);
    const task = inbox.consume(dispatchId, "developer");
    assert.equal(task.ownerOpenId, "ou_owner");
    assert.equal(task.instruction, instruction);
    assert.notEqual(dispatchId, "b".repeat(32));
    assert.notEqual(dispatchId, "c".repeat(32));
    assert.equal(inbox.consume(dispatchId, "developer"), undefined);
    assert.equal(externalBotTaskOwner({ ...message, text }, "ou_dev", "ou_owner"), undefined);
  }
});

test("巡检引用旧协议包络不被识别为协作通知", () => {
  const text = "日志引用：\n" + collaborationMessageMarker("d".repeat(32)) + "\n请检查故障";
  assert.equal(parseCollaborationMessageMarker(text), undefined);
  assert.equal(externalBotTaskOwner({ ...message, text }, "ou_dev", "ou_owner"), "ou_owner");
});

test("并发重复投递只准备一次；处理中占位不会被缓存淘汰", async () => {
  const dedup = new BotMessageDeduplicator(1);
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  let preparations = 0;
  const deliver = async () => {
    if (!dedup.claim("developer", "om_concurrent")) return;
    try {
      preparations++;
      await gate;
      dedup.accept("developer", "om_concurrent");
    } finally {
      dedup.release("developer", "om_concurrent");
    }
  };
  const first = deliver();
  for (const id of ["om_other1", "om_other2"]) {
    assert.equal(dedup.claim("developer", id), true);
    dedup.accept("developer", id);
  }
  await deliver();
  assert.equal(preparations, 1);
  finish();
  await first;
  await deliver();
  assert.equal(preparations, 1);
});

test("准备失败可重试；接受后执行失败不释放已接受记录", async () => {
  const dedup = new BotMessageDeduplicator();
  const inbox = new CollaborationInbox();
  const task = { dispatchId: "a".repeat(32), toBotId: "developer" };
  inbox.register(task);
  let attempts = 0;
  const deliver = async (failPreparation, failExecution = false) => {
    if (!dedup.claim("developer", "om_retry")) return false;
    let reserved;
    let accepted = false;
    try {
      assert.equal(inbox.peek(task.dispatchId, "developer"), task);
      reserved = inbox.consume(task.dispatchId, "developer");
      attempts++;
      if (failPreparation) throw new Error("准备失败");
      dedup.accept("developer", "om_retry");
      accepted = true;
      if (failExecution) throw new Error("执行失败");
      return true;
    } finally {
      dedup.release("developer", "om_retry");
      if (reserved && !accepted) inbox.register(reserved);
    }
  };
  await assert.rejects(deliver(true), /准备失败/);
  assert.equal(inbox.peek(task.dispatchId, "developer"), task);
  await assert.rejects(deliver(false, true), /执行失败/);
  assert.equal(await deliver(false), false);
  assert.equal(attempts, 2);
  assert.equal(inbox.peek(task.dispatchId, "developer"), undefined);
});
