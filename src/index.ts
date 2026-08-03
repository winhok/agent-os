import "dotenv/config";
import { join, resolve } from "node:path";
import { startBot } from "./im/lark.js";
import { buildTaskCard } from "./im/card.js";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";
import { parseCommand } from "./core/command-parser.js";
import { SessionManager, type Session } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { TaskProgressTracker } from "./core/task-progress.js";
import { ClaudeAdapter } from "./cli/claude-adapter.js";
import { runCli } from "./cli/runner.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;
const cliWorkdir = resolve(process.env.CLAUDE_WORKDIR ?? process.cwd());
const cliAdapter = new ClaudeAdapter();

if (!appId || !appSecret) {
  console.error("缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env");
  process.exit(1);
}

console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(`[CLI] command=${cliAdapter.command} cwd=${cliWorkdir}`);

const sessions = await SessionManager.open({
  store: new JsonSessionStore(join("data", "sessions.json")),
});
console.log(`[会话] 已恢复 ${sessions.size} 个会话`);
const activeRuns = new Map<string, AbortController>();

function executeCli(
  prompt: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]["onEvent"],
) {
  return runCli({
    adapter: cliAdapter,
    prompt,
    cwd: cliWorkdir,
    sessionId,
    signal,
    onEvent,
  });
}

const STATUS_LABELS: Record<Session["status"], string> = {
  creating: "创建中",
  active: "执行中",
  idle: "空闲",
  closed: "已关闭",
};

function formatSessionStatus(session: Session): string {
  return [
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${session.cliId}`,
    `CLI 会话：${session.cliSessionId ?? "(尚未建立)"}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n");
}

async function markSessionIdle(sessionId: string): Promise<void> {
  if (sessions.get(sessionId)?.status !== "active") return;
  await sessions.transition(sessionId, "idle");
  console.log(`[会话] id=${sessionId} status=idle`);
}

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions);
    const hasThread = !!msg.threadId || !!msg.rootId;
    const { session, isNew } = await sessions.resolve(msg);
    console.log(`[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
    console.log(`  原文: ${msg.text}`);
    console.log(`  还原: ${resolved}`);
    console.log(`  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`);
    console.log(`  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`);

    const command = parseCommand(resolved);

    if (command?.name === "help") {
      await bot.reply(
        msg.messageId,
        ["/status 查看当前会话", "/close 关闭当前会话", "/help 查看命令"].join("\n"),
        hasThread,
      );
      return;
    }

    if (command?.name === "status") {
      await bot.reply(msg.messageId, formatSessionStatus(session), hasThread);
      return;
    }

    if (command?.name === "close") {
      activeRuns.get(session.id)?.abort();
      if (session.status !== "closed") await sessions.transition(session.id, "closed");
      await bot.reply(msg.messageId, "当前会话已关闭。需要继续时，请新开一个话题。", hasThread);
      return;
    }

    if (session.status === "closed") {
      await bot.reply(msg.messageId, "这个话题的会话已经关闭，请新开一个话题继续。", hasThread);
      return;
    }

    if (!isNew && session.status === "creating") {
      await bot.reply(msg.messageId, "当前会话正在准备，请稍后再追问。", hasThread);
      return;
    }

    if (session.status === "active") {
      await bot.reply(msg.messageId, "当前会话还在执行，请等任务结束后再追问。", hasThread);
      return;
    }

    await sessions.transition(session.id, "active");
    const run = new AbortController();
    activeRuns.set(session.id, run);

    const resources = extractResourceKeys(msg.messageType, msg.rawContent);
    for (const res of resources) {
      try {
        const savePath = await bot.downloadResource(
          msg.messageId,
          res.key,
          res.type,
          join("data", "downloads"),
          res.fileName,
        );
        console.log(`  [下载] ${res.type} → ${savePath}`);
      } catch (e) {
        console.error(`  [下载失败] ${res.key}:`, (e as Error).message);
      }
    }

    let cardId: string | undefined;
    try {
      cardId = await bot.replyCard(
        msg.messageId,
        buildTaskCard({
          title: "Claude Code 任务",
          status: "running",
          progress: 0,
          detail: "正在启动执行引擎",
        }),
        hasThread,
      );
    } catch (error) {
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      throw error;
    }

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新");
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      return;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

    const progress = new TaskProgressTracker();

    void executeCli(resolved, session.cliSessionId, run.signal, (event) => {
      if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "context") return;
      const snapshot = progress.accept(event);
      const currentDetail = snapshot.currentDetail ? ` detail=${snapshot.currentDetail}` : "";
      const context = snapshot.contextUsedTokens === undefined ? "" : ` context=${snapshot.contextUsedTokens}`;
      console.log(
        `[进度] ${snapshot.current}${currentDetail} tools=${snapshot.completedCount}/${snapshot.toolCount}${context}`,
      );
    })
      .then(async (result) => {
        if (result.sessionId && result.sessionId !== session.cliSessionId) {
          await sessions.setCliSessionId(session.id, result.sessionId);
        }

        await bot.updateCard(
          cardId,
          buildTaskCard({
            title: "Claude Code 任务",
            status: "success",
            progress: 100,
            detail: "执行完成",
          }),
        );
        await bot.reply(msg.messageId, result.answer, hasThread);
        console.log(`[CLI] 完成 session_id=${result.sessionId ?? "(无)"}`);
      })
      .catch(async (error) => {
        if (run.signal.aborted) {
          console.log("[CLI] 任务已取消");
          return;
        }
        const message = (error as Error).message;
        console.error("[CLI] 执行失败:", message);
        await bot.updateCard(
          cardId,
          buildTaskCard({
            title: "Claude Code 任务",
            status: "failed",
            progress: 0,
            detail: message,
          }),
        );
        await bot.reply(msg.messageId, `Claude Code 执行失败：${message}`, hasThread);
      })
      .finally(async () => {
        if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
        try {
          await markSessionIdle(session.id);
        } catch (error) {
          console.error("[会话] 保存空闲状态失败:", (error as Error).message);
        }
      })
      .catch((error) => {
        console.error("[任务] 回传或收尾失败:", (error as Error).message);
      });
  },
});
