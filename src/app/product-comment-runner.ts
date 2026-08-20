import { getCliAdapter } from "../cli/registry.js";
import type { ProductSpecFlow } from "../core/product-spec.js";
import type { Bot, IncomingDocumentComment } from "../im/lark.js";
import { executeCli } from "./cli-execution.js";
import { markSessionIdle } from "./session-view.js";
import type { AppRuntime } from "./runtime.js";

export async function runProductDocumentComment(options: {
  runtime: AppRuntime;
  bot: Bot;
  flow: ProductSpecFlow;
  comment: IncomingDocumentComment;
}): Promise<void> {
  const { runtime, bot, flow, comment } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session || session.status === "closed") {
    throw new Error("评论对应的产品会话已经失效");
  }
  if (session.status !== "idle") {
    throw new Error("评论对应的产品会话仍在执行其他任务");
  }
  if (!session.cliSessionId) {
    throw new Error("评论对应的产品 CLI 会话不存在");
  }

  const run = new AbortController();
  await runtime.sessions.transition(session.id, "active");
  runtime.activeRuns.set(session.id, {
    controller: run,
    ownerOpenId: flow.ownerOpenId,
  });

  try {
    const adapter = getCliAdapter(session.cliId);
    const result = await executeCli(
      adapter,
      documentCommentPrompt(flow, comment),
      session.workspaceDir,
      session.cliSessionId,
      run.signal,
      () => undefined,
    );
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }
    await bot.replyToDocumentComment(comment, result.answer || "已按评论更新原文档，请复查。");
  } finally {
    if (runtime.activeRuns.get(session.id)?.controller === run) {
      runtime.activeRuns.delete(session.id);
    }
    await markSessionIdle(runtime.sessions, session.id);
  }
}

function documentCommentPrompt(flow: ProductSpecFlow, comment: IncomingDocumentComment): string {
  if (flow.request.deliveryMode !== "lark-doc") {
    throw new Error("本地产品方案不能处理飞书文档评论");
  }
  return [
    "用户在待确认的飞书产品方案中通过评论明确提及了你。",
    `文档 URL：${flow.request.documentUrl}`,
    `文档类型：${comment.fileType}`,
    `评论 ID：${comment.commentId}`,
    comment.replyId ? `触发回复 ID：${comment.replyId}` : "",
    "使用 lark-drive 读取这一条评论、完整回复和正文位置，再使用 lark-doc 精确修改原文档。",
    "修改成功后，最终回答只写一段给评论者看的简短说明，讲清楚具体改了什么。Agent OS 会把最终回答写回原评论。",
    "不要调用评论回复或解决接口，评论是否解决由用户复查后决定。",
    "不要调用 request_spec_approval，不要生成新的确认卡；原待确认卡继续有效。",
  ]
    .filter(Boolean)
    .join("\n\n");
}
