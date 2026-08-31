import type { Bot } from "../im/lark.js";
import { buildTaskCard, ThrottledCardUpdater } from "../im/card.js";
import type { BotConfig } from "../core/bot-registry.js";
import { formatApprovalDecision, type ApprovalFlow } from "../core/approval.js";
import { TaskProgressTracker } from "../core/task-progress.js";
import { getCliAdapter } from "../cli/registry.js";
import { executeCli } from "./cli-execution.js";
import { sendResultNotification } from "./notification-service.js";
import { markSessionIdle } from "./session-view.js";
import type { AppRuntime } from "./runtime.js";
import { CliEvent } from "../cli/types.js";

export async function continueApprovalFlow(options: {
  runtime: AppRuntime;
  bot: Bot;
  config: BotConfig;
  flow: ApprovalFlow;
  run: AbortController;
}): Promise<void> {
  const { bot, config, flow, run, runtime } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session) throw new Error("审批对应的会话已经失效");

  const adapter = getCliAdapter(session.cliId);
  const progress = new TaskProgressTracker(Date.now, runtime.contextWindows.get(session.id), false);
  const progressCardMessageId = await bot.replyCard(
    flow.originalMessageId,
    buildTaskCard({
      title: adapter.displayName,
      status: "running",
      detail: flow.status === "approved" ? "审批已通过，正在继续执行" : "审批未通过，正在收束任务",
      progress: progress.snapshot(),
      abortSessionId: session.id,
    }),
    flow.replyInThread,
  );
  if (!progressCardMessageId) {
    throw new Error("飞书没有返回审批执行进度卡片的 message_id");
  }

  const cardUpdater = new ThrottledCardUpdater((card) => bot.updateCard(progressCardMessageId, card));
  const renderProgress = () => {
    const snapshot = progress.snapshot();
    cardUpdater.push(
      buildTaskCard({
        title: adapter.displayName,
        status: "running",
        detail: snapshot.current || "正在处理审批结果",
        progress: snapshot,
        abortSessionId: session.id,
      }),
    );
  };
  const heartbeat = setInterval(renderProgress, 1_000);
  heartbeat.unref();

  try {
    const result = await executeCli(
      adapter,
      formatApprovalDecision(flow),
      session.workspaceDir,
      session.cliSessionId,
      run.signal,
      [],
      (event: CliEvent) => {
        if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "context") return;
        progress.accept(event);
        renderProgress();
      },
    );
    clearInterval(heartbeat);
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }
    await cardUpdater.finish(
      buildTaskCard({
        title: adapter.displayName,
        status: "success",
        detail: flow.status === "approved" ? "审批通过，操作已继续并完成" : "审批未通过，任务已安全收束",
        progress: progress.snapshot(),
        answer: result.answer,
        stats: result.stats,
      }),
    );
    await sendResultNotification({
      bot,
      replyToMessageId: flow.originalMessageId,
      target: { openId: flow.ownerOpenId, name: "" },
      text: flow.status === "approved" ? "审批已通过，开发者已继续执行。" : "审批未通过，开发者已停止该操作。",
      replyInThread: flow.replyInThread,
    });
  } catch (error) {
    clearInterval(heartbeat);
    const aborted = run.signal.aborted;
    await cardUpdater.finish(
      buildTaskCard({
        title: adapter.displayName,
        status: aborted ? "cancelled" : "failed",
        detail: aborted ? "审批结果处理已停止。" : "审批结果处理没有完成。",
        technicalDetail: aborted ? undefined : (error as Error).message,
        progress: progress.snapshot(),
      }),
    );
  } finally {
    clearInterval(heartbeat);
    if (runtime.activeRuns.get(session.id)?.controller === run) {
      runtime.activeRuns.delete(session.id);
    }
    await markSessionIdle(runtime.sessions, session.id);
  }
}
