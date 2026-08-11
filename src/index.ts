import "dotenv/config";
import { join, resolve } from "node:path";
import { startBot } from "./im/lark.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from "./im/card.js";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";
import { parseCliRequest, parseCommand } from "./core/command-parser.js";
import { SessionManager, type Session } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { TaskProgressTracker } from "./core/task-progress.js";
import { requestTaskAbort, type ActiveRun } from "./core/task-abort.js";
import { getCliAdapter, listCliAdapters, parseCliId } from "./cli/registry.js";
import type { CliAdapter } from "./cli/types.js";
import { runCli } from "./cli/runner.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;
const cliWorkdir = resolve(process.env.CLI_WORKDIR ?? process.env.CLAUDE_WORKDIR ?? process.cwd());
const defaultCliId = parseCliId(process.env.DEFAULT_CLI);

if (!appId || !appSecret) {
  console.error("缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env");
  process.exit(1);
}
console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(`[CLI] default=${defaultCliId}`);
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command} cwd=${cliWorkdir}`);
}

const sessions = await SessionManager.open({
  store: new JsonSessionStore(join("data", "sessions.json")),
});
console.log(`[会话] 已恢复 ${sessions.size} 个会话`);
const activeRuns = new Map<string, ActiveRun>();
const contextWindows = new Map<string, number>();

function executeCli(
  adapter: CliAdapter,
  prompt: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]["onEvent"],
) {
  return runCli({
    adapter,
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
  const adapter = getCliAdapter(session.cliId);

  return [
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
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
  onCardAction: async (action) => {
    if (action.value.action !== "abort_task") return undefined;
    const sessionId = typeof action.value.sessionId === "string" ? action.value.sessionId : "";
    const outcome = requestTaskAbort(activeRuns, sessionId, action.operatorOpenId);
    if (outcome === "not_found") {
      return {
        toast: { type: "info", content: "任务已经结束，无需再次停止。" },
      };
    }
    if (outcome === "forbidden") {
      return {
        toast: { type: "warning", content: "只有任务发起人可以停止它。" },
      };
    }
    if (outcome === "already_stopping") {
      return { toast: { type: "info", content: "正在停止任务，请稍候。" } };
    }
    return { toast: { type: "success", content: "已发送停止指令。" } };
  },
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions);
    const hasThread = !!msg.threadId || !!msg.rootId;
    const cliRequest = parseCliRequest(resolved);
    if (cliRequest && !cliRequest.prompt) {
      await bot.reply(
        msg.messageId,
        `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
        hasThread,
      );
      return;
    }
    const { session, isNew } = await sessions.resolve(msg, cliRequest?.cliId ?? defaultCliId);
    const cliAdapter = getCliAdapter(session.cliId);
    const prompt = cliRequest?.prompt ?? resolved;

    console.log(`[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
    console.log(`  原文: ${msg.text}`);
    console.log(`  还原: ${resolved}`);
    console.log(`  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`);
    console.log(`  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`);

    if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
      await bot.reply(
        msg.messageId,
        `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
        hasThread,
      );
      return;
    }

    const command = parseCommand(resolved);
    if (command?.name === "help") {
      await bot.reply(
        msg.messageId,
        [
          "/status 查看当前会话",
          "/close 关闭当前会话",
          "/help 查看命令",
          "/claude <任务> 新话题使用 Claude Code",
          "/codex <任务> 新话题使用 Codex",
        ].join("\n"),
        hasThread,
      );
      return;
    }
    if (command?.name === "status") {
      await bot.reply(msg.messageId, formatSessionStatus(session), hasThread);
      return;
    }
    if (command?.name === "close") {
      const active = activeRuns.get(session.id);
      if (active) {
        active.cancelMode = "close";
        active.controller.abort();
      }
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
    const activeRun: ActiveRun = {
      controller: run,
      ownerOpenId: msg.senderOpenId,
    };
    activeRuns.set(session.id, activeRun);

    // 图片/文件下载
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
          title: cliAdapter.displayName,
          status: "running",
          detail: "正在理解任务",
          abortSessionId: session.id,
        }),
        hasThread,
      );
    } catch (error) {
      if (activeRuns.get(session.id)?.controller === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      throw error;
    }

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新");
      if (activeRuns.get(session.id)?.controller === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      return;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

    const progress = new TaskProgressTracker(Date.now, contextWindows.get(session.id), !session.cliSessionId);
    const cardUpdater = new ThrottledCardUpdater((card) => bot.updateCard(cardId, card));
    const renderProgress = () => {
      const snapshot = progress.snapshot();
      cardUpdater.push(
        buildTaskCard({
          title: cliAdapter.displayName,
          status: "running",
          detail: snapshot.current,
          progress: snapshot,
          abortSessionId: session.id,
        }),
      );
    };
    const progressHeartbeat = setInterval(renderProgress, 1_000);
    progressHeartbeat.unref();

    void executeCli(cliAdapter, prompt, session.cliSessionId, run.signal, (event) => {
      if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "context") return;
      progress.accept(event);
      renderProgress();
    })
      .then(async (result) => {
        clearInterval(progressHeartbeat);
        if (result.sessionId && result.sessionId !== session.cliSessionId) {
          await sessions.setCliSessionId(session.id, result.sessionId);
        }
        if (result.stats?.contextWindowTokens) {
          contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        const snapshot = progress.snapshot();
        await cardUpdater.finish(
          buildTaskCard({
            title: cliAdapter.displayName,
            status: "success",
            detail: "执行完成",
            progress: snapshot,
            answer: result.answer,
            stats: result.stats,
            recipientOpenId: msg.senderOpenId,
          }),
        );
        if (answerNeedsContinuation(result.answer)) {
          for (const chunk of splitLongText(answerContinuation(result.answer))) {
            await bot.reply(msg.messageId, chunk, hasThread);
          }
        }
        console.log(`[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? "(无)"}`);
      })
      .catch(async (error) => {
        clearInterval(progressHeartbeat);
        if (run.signal.aborted) {
          console.log("[CLI] 任务已取消");
          await cardUpdater.finish(
            buildTaskCard({
              title: cliAdapter.displayName,
              status: "cancelled",
              detail:
                activeRun.cancelMode === "close"
                  ? "本次任务已停止，当前会话已经关闭。"
                  : "本次任务已停止。你可以继续在当前话题里提问。",
              progress: progress.snapshot(),
            }),
          );
          return;
        }
        const message = (error as Error).message;
        console.error("[CLI] 执行失败:", message);
        await cardUpdater.finish(
          buildTaskCard({
            title: cliAdapter.displayName,
            status: "failed",
            detail: "执行没有完成。你可以调整指令后，在当前话题里重试。",
            technicalDetail: message,
            progress: progress.snapshot(),
          }),
        );
      })
      .finally(async () => {
        clearInterval(progressHeartbeat);
        if (activeRuns.get(session.id)?.controller === run) {
          activeRuns.delete(session.id);
        }
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
