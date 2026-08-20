import type { CardAction, CardActionResponse } from "../im/lark.js";
import { buildClarificationCard, buildClarificationContinuingCard, buildResumeCard } from "../im/card.js";
import type { BotConfig } from "../core/bot-registry.js";
import { isClarificationOwner } from "../core/clarification.js";
import { requestTaskAbort } from "../core/task-abort.js";
import { getCliAdapter } from "../cli/registry.js";
import { listNativeCliSessions } from "../cli/native-sessions.js";
import { continueClarificationFlow } from "./clarification-runner.js";
import type { AppRuntime } from "./runtime.js";

export function createCardActionHandler(options: {
  runtime: AppRuntime;
  config: BotConfig;
}): (action: CardAction) => Promise<CardActionResponse | undefined> {
  const { runtime, config } = options;
  return async (action) => {
    if (action.value.action === "answer_clarification") {
      const flowToken = typeof action.value.flowToken === "string" ? action.value.flowToken : "";
      const questionId = typeof action.value.questionId === "string" ? action.value.questionId : "";
      const flow = runtime.clarificationFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: "error", content: "这组澄清问题已经失效。" } };
      }
      if (!isClarificationOwner(flow, action)) {
        return { toast: { type: "warning", content: "只有任务发起人可以回答。" } };
      }

      const question = flow.request.questions[flow.currentIndex];
      if (!question || question.id !== questionId) {
        return {
          toast: { type: "warning", content: "问题已经更新，请按当前卡片作答。" },
        };
      }

      const decisionMode =
        action.value.decisionMode === "current" || action.value.decisionMode === "remaining"
          ? action.value.decisionMode
          : undefined;
      let answered;
      if (decisionMode) {
        answered = runtime.clarificationFlows.answerWithRecommendation(flowToken, decisionMode === "remaining");
      } else {
        const custom = action.value.custom === true;
        const optionId = typeof action.value.optionId === "string" ? action.value.optionId : "";
        const selectedOption = question.options.find((option) => option.id === optionId);
        const customAnswer =
          typeof action.formValue.custom_answer === "string" ? action.formValue.custom_answer.trim() : "";
        const answer = custom ? customAnswer : (selectedOption?.label ?? "");
        if (!answer) {
          return {
            toast: {
              type: "warning",
              content: custom ? "请先输入你的答案。" : "这个选项已经失效。",
            },
          };
        }
        answered = runtime.clarificationFlows.answer(flowToken, questionId, answer);
      }
      if (!answered) {
        return { toast: { type: "warning", content: "答案没有保存，请重试。" } };
      }
      if (!answered.complete) {
        return {
          toast: { type: "success", content: "已记录，继续下一题。" },
          card: {
            type: "raw",
            data: buildClarificationCard({ flow: answered.flow }),
          },
        };
      }

      const session = runtime.sessions.get(answered.flow.sessionId);
      const botRuntime = runtime.botRuntimes.get(config.id);
      if (!session || !botRuntime || session.status === "closed") {
        return { toast: { type: "error", content: "对应的 CLI 会话已经失效。" } };
      }
      if (session.status === "active") {
        return {
          toast: { type: "warning", content: "当前会话仍在执行，请稍后重试。" },
        };
      }

      try {
        await runtime.sessions.transition(session.id, "active");
        const run = new AbortController();
        runtime.activeRuns.set(session.id, {
          controller: run,
          ownerOpenId: answered.flow.ownerOpenId,
        });
        runtime.clarificationFlows.delete(flowToken);
        queueMicrotask(() => {
          void continueClarificationFlow({
            runtime,
            bot: botRuntime.bot,
            config,
            flow: answered.flow,
            run,
          }).catch((error) => {
            console.error("[澄清] 继续执行失败:", (error as Error).message);
          });
        });
        return {
          toast: { type: "success", content: "答案已收到。" },
          card: {
            type: "raw",
            data: buildClarificationContinuingCard(answered.flow),
          },
        };
      } catch (error) {
        return { toast: { type: "error", content: (error as Error).message } };
      }
    }

    if (action.value.action === "resume_cli_session") {
      const agentSessionId = typeof action.value.agentSessionId === "string" ? action.value.agentSessionId : "";
      const cliSessionId = typeof action.value.cliSessionId === "string" ? action.value.cliSessionId : "";
      const session = runtime.sessions.get(agentSessionId);
      if (!session || session.botId !== config.id || !cliSessionId) {
        return { toast: { type: "error", content: "这条会话记录已经失效。" } };
      }
      if (session.status === "active") {
        return {
          toast: { type: "warning", content: "当前任务结束后才能切换会话。" },
        };
      }
      if (session.status === "closed") {
        return {
          toast: { type: "warning", content: "当前话题的会话已经关闭。" },
        };
      }
      try {
        const cliAdapter = getCliAdapter(session.cliId);
        const nativeSessions = await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
        });
        if (!nativeSessions.some((item) => item.id === cliSessionId)) {
          return {
            toast: {
              type: "error",
              content: "这个 CLI 会话已经不在当前工作目录中。",
            },
          };
        }
        const updated = await runtime.sessions.setCliSessionId(session.id, cliSessionId);
        return {
          toast: { type: "success", content: "已切换到选中的历史会话。" },
          card: {
            type: "raw",
            data: buildResumeCard({
              agentSessionId: updated.id,
              cliName: cliAdapter.displayName,
              currentCliSessionId: updated.cliSessionId,
              sessions: nativeSessions,
            }),
          },
        };
      } catch (error) {
        return { toast: { type: "error", content: (error as Error).message } };
      }
    }

    if (action.value.action !== "abort_task") return undefined;
    const sessionId = typeof action.value.sessionId === "string" ? action.value.sessionId : "";
    const outcome = requestTaskAbort(runtime.activeRuns, sessionId, action.operatorOpenId);
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
  };
}
