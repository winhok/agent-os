import "dotenv/config";
import { join, resolve } from "node:path";
import { startBot, type Bot, type IncomingDocumentComment } from "./im/lark.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildClarificationCard,
  buildProductSpecApprovalCard,
  buildClarificationSupersededCard,
  buildSessionNoticeCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from "./im/card.js";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";
import { parseCliRequest, parseCommand } from "./core/command-parser.js";
import { SessionManager } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { TaskProgressTracker } from "./core/task-progress.js";
import type { ActiveRun } from "./core/task-abort.js";
import { ClarificationFlowStore, findClarificationRequest, formatClarificationMessage } from "./core/clarification.js";
import type { ProductSpecRequest } from "./core/product-spec.js";
import { JsonProductSpecFlowStore } from "./core/product-spec-store.js";
import { JsonScheduleStore } from "./core/schedule-store.js";
import { JsonScheduleRunStore } from "./core/schedule-run-store.js";
import { topicTaskId } from "./core/topic-task.js";
import {
  CollaborationInbox,
  buildCollaborationPrompt,
  collaborationOrigin,
  collaborationTurnKey,
  findDispatchTaskRequest,
  type CollaborationMessage,
} from "./core/collaboration.js";
import { ensureWorkspaceDirectory } from "./core/workspace.js";
import { buildBotPrompt, loadAgentOsConfig, type BotConfig } from "./core/bot-registry.js";
import { TeamRegistry } from "./core/team-registry.js";
import { getCliAdapter, listCliAdapters } from "./cli/registry.js";
import { compactCliSession } from "./cli/native-compact.js";
import { createCardActionHandler } from "./app/card-action-handler.js";
import { assertProductSpecDocuments } from "./app/product-spec-documents.js";
import { executeCli } from "./app/cli-execution.js";
import { handleSessionCommand } from "./app/command-handler.js";
import { sendResultNotification } from "./app/notification-service.js";
import { markSessionIdle } from "./app/session-view.js";
import { runProductDocumentComment } from "./app/product-comment-runner.js";
import { ensureProductSpecSubmission } from "./app/product-spec-submission.js";
import { CollaborationService } from "./app/collaboration-service.js";
import { Scheduler } from "./app/scheduler.js";
import { startScheduleApi } from "./app/schedule-api.js";
import { startScheduleFileWatcher } from "./app/schedule-watcher.js";
import type { AppRuntime, BotRuntime } from "./app/runtime.js";

const botConfigPath = resolve(process.env.BOTS_CONFIG ?? join("config", "bots.json"));
const agentOsConfig = await loadAgentOsConfig(botConfigPath);
const botConfigs = agentOsConfig.bots;
const teamRegistry = new TeamRegistry(agentOsConfig.teamLeaderId, botConfigs);
await Promise.all(botConfigs.map((config) => ensureWorkspaceDirectory(config.workspaceDir)));
for (const missing of await teamRegistry.findMissingSkills()) {
  console.warn(`[Skill] bot=${missing.botId} 找不到 ${missing.skill}，请安装到工作区或用户级 Skills 目录`);
}
const defaultWorkspaces = Object.fromEntries(botConfigs.map((config) => [config.id, config.workspaceDir]));
const sessions = await SessionManager.open({
  store: new JsonSessionStore(join("data", "sessions.json"), botConfigs[0]?.id, defaultWorkspaces),
});
const activeRuns = new Map<string, ActiveRun>();
const contextWindows = new Map<string, number>();
const botRuntimes = new Map<string, BotRuntime>();
const processedCollaborationTurns = new Set<string>();
const collaborationInbox = new CollaborationInbox();
const clarificationFlows = new ClarificationFlowStore();
const productSpecFlows = new JsonProductSpecFlowStore(join("data", "product-spec-flows.json"));
const processedDocumentCommentEvents = new Set<string>();
const documentCommentQueues = new Map<string, Promise<void>>();
const MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS = 1_000;
const runtime: AppRuntime = {
  sessions,
  teamRegistry,
  activeRuns,
  contextWindows,
  botRuntimes,
  processedCollaborationTurns,
  collaborationInbox,
  clarificationFlows,
  productSpecFlows,
};
const collaborationService = new CollaborationService(runtime);
const scheduleFilePath = join("data", "schedules.json");
const scheduleStore = new JsonScheduleStore(scheduleFilePath);
const scheduleRunStore = new JsonScheduleRunStore(join("data", "schedule-runs.json"));
const scheduler = new Scheduler({
  runtime,
  scheduleStore,
  runStore: scheduleRunStore,
  defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
});

console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，Team Leader=${teamRegistry.leaderBotId}，已恢复 ${sessions.size} 个会话`,
);
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
}
for (const config of botConfigs) {
  console.log(`[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} workspace=${config.workspaceDir}`);
}

async function startConfiguredBot(config: BotConfig, collaborationService: CollaborationService): Promise<void> {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,
    onCardAction: createCardActionHandler({
      runtime,
      config,
      collaborationService,
      defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
    }),
    onDocumentComment: config.skills.includes("lark-drive")
      ? async (comment, bot) => scheduleDocumentComment(config, bot, comment)
      : undefined,
    onMessage: async (msg, bot) => {
      const resolved = resolveMentions(msg.text, msg.mentions);
      const taskId = topicTaskId(msg);
      let senderRuntime: BotRuntime | undefined;
      let collaboration: CollaborationMessage | undefined;
      if (msg.senderType === "app" || msg.senderType === "bot") {
        const currentRuntime = botRuntimes.get(config.id);
        const mentionedCurrentBot = currentRuntime
          ? msg.mentions.some((mention) => mention.openId === currentRuntime.identity.openId)
          : false;
        const dispatchId = msg.text.match(/任务编号：([a-f0-9]{32})/)?.[1];
        const pending =
          msg.messageType === "post" && mentionedCurrentBot && dispatchId
            ? collaborationInbox.consume(dispatchId, config.id)
            : undefined;
        if (!pending) {
          console.log(`[协作] 忽略非目标 bot 消息 sender=${msg.senderOpenId} target=${config.id}`);
          return;
        }
        senderRuntime = botRuntimes.get(pending.fromBotId);
        if (!senderRuntime) {
          console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`);
          return;
        }
        const turnKey = collaborationTurnKey(pending);
        if (processedCollaborationTurns.has(turnKey)) {
          console.log(
            `[协作] 忽略重复消息 dispatch=${pending.dispatchId} task=${pending.taskId} round=${pending.round}/${pending.maxRounds} target=${pending.toBotId}`,
          );
          return;
        }
        processedCollaborationTurns.add(turnKey);
        collaboration = pending;
      }
      const hasThread = !!msg.threadId || !!msg.rootId;
      const command = parseCommand(resolved);
      const cliRequest = parseCliRequest(resolved);
      if (cliRequest && !cliRequest.prompt) {
        await bot.reply(
          msg.messageId,
          `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
          hasThread,
        );
        return;
      }
      const pendingClarification =
        msg.senderType !== "app" && msg.senderType !== "bot" && !command
          ? clarificationFlows.findForTask(taskId, config.id)
          : undefined;
      const resolvedSession = await sessions.resolve(
        msg,
        cliRequest?.cliId ?? config.defaultCliId,
        config.id,
        collaboration?.workspaceDir ?? config.workspaceDir,
      );
      let { session } = resolvedSession;
      const { isNew } = resolvedSession;
      if (command && isNew && session.status === "creating") {
        session = await sessions.transition(session.id, "idle");
      }
      const cliAdapter = getCliAdapter(session.cliId);
      const isCompacting = command?.name === "compact";
      let taskText = pendingClarification
        ? formatClarificationMessage(pendingClarification, cliRequest?.prompt ?? resolved)
        : collaboration
          ? buildCollaborationPrompt(collaboration)
          : (cliRequest?.prompt ?? resolved);
      if (command?.name === "schedule" && command.request) {
        taskText = [
          "用户想创建一个定时任务。",
          `需求：${command.request}`,
          "请使用 schedule_manage 工具，action=add 创建：targetBotId 选择团队中合适的成员，prompt 保留完整需求，rule 根据需求选择合适的调度规则。",
        ].join("\n\n");
      }
      const prompt = buildBotPrompt(
        config,
        taskText,
        teamRegistry.contextFor(config.id),
        agentOsConfig.defaultProductDeliveryMode,
      );
      const taskCardTitle = isCompacting ? "整理上下文" : cliAdapter.displayName;
      console.log(`[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
      console.log(`  原文: ${msg.text}`);
      console.log(`  还原: ${resolved}`);
      console.log(`  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`);
      console.log(`  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`);

      const commandOutcome = await handleSessionCommand({
        runtime,
        scheduler,
        config,
        msg,
        bot,
        session,
        cliAdapter,
        command,
        cliRequest,
        isNew,
        hasThread,
      });
      if (commandOutcome === "handled") return;

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

      if (pendingClarification) {
        clarificationFlows.delete(pendingClarification.token);
        if (pendingClarification.cardMessageId) {
          try {
            await bot.updateCard(
              pendingClarification.cardMessageId,
              buildClarificationSupersededCard(pendingClarification),
            );
          } catch (error) {
            console.warn("[澄清] 旧卡片更新失败，继续处理用户的新消息:", (error as Error).message);
          }
        }
      }

      if (collaboration && session.workspaceDir !== collaboration.workspaceDir) {
        await ensureWorkspaceDirectory(collaboration.workspaceDir);
        session = await sessions.setWorkspaceDir(session.id, collaboration.workspaceDir);
      }

      await sessions.transition(session.id, "active");
      const run = new AbortController();
      const activeRun: ActiveRun = {
        controller: run,
        ownerOpenId: collaboration?.ownerOpenId ?? msg.senderOpenId,
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
            title: taskCardTitle,
            status: "running",
            detail: isCompacting
              ? cliAdapter.id === "codex" && command?.instructions
                ? "Codex 正在使用原生默认策略整理上下文"
                : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
              : "正在理解任务",
            abortSessionId: session.id,
          }),
          hasThread,
        );
      } catch (error) {
        if (activeRuns.get(session.id)?.controller === run) activeRuns.delete(session.id);
        await markSessionIdle(sessions, session.id);
        throw error;
      }

      if (!cardId) {
        console.error("[卡片] 响应里没有 message_id，无法继续更新");
        if (activeRuns.get(session.id)?.controller === run) activeRuns.delete(session.id);
        await markSessionIdle(sessions, session.id);
        return;
      }
      console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

      const progress = new TaskProgressTracker(Date.now, contextWindows.get(session.id), !session.cliSessionId);
      const cardUpdater = new ThrottledCardUpdater((card) => bot.updateCard(cardId, card));
      const renderProgress = () => {
        const snapshot = progress.snapshot();
        cardUpdater.push(
          buildTaskCard({
            title: taskCardTitle,
            status: "running",
            detail: isCompacting ? `正在调用 ${cliAdapter.displayName} 原生上下文整理` : snapshot.current,
            ...(!isCompacting ? { progress: snapshot } : {}),
            abortSessionId: session.id,
          }),
        );
      };
      const progressHeartbeat = setInterval(renderProgress, 1_000);
      progressHeartbeat.unref();

      const cliEnv = {
        AGENT_OS_CHAT_ID: msg.chatId,
        AGENT_OS_OWNER_OPEN_ID: collaboration?.ownerOpenId ?? msg.senderOpenId,
      };

      const execution = isCompacting
        ? compactCliSession({
            adapter: cliAdapter,
            sessionId: session.cliSessionId!,
            cwd: session.workspaceDir,
            instructions: command.instructions,
            signal: run.signal,
          }).then((result) => ({
            answer: result.message ?? "",
            sessionId: result.sessionId,
            stats: undefined,
            toolCalls: undefined,
          }))
        : executeCli(
            cliAdapter,
            prompt,
            session.workspaceDir,
            session.cliSessionId,
            run.signal,
            (event) => {
              if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "context") return;
              progress.accept(event);
              renderProgress();
            },
            cliEnv,
          );

      void execution
        .then(async (result) => {
          clearInterval(progressHeartbeat);
          if (!isCompacting && result.sessionId) {
            await sessions.setCliSessionId(session.id, result.sessionId);
          }
          if (!isCompacting && result.stats?.contextWindowTokens) {
            contextWindows.set(session.id, result.stats.contextWindowTokens);
          }
          const clarificationRequest =
            !isCompacting && config.skills.includes("grill-me")
              ? findClarificationRequest(result.toolCalls)
              : undefined;
          if (clarificationRequest) {
            const flow = clarificationFlows.create({
              taskId,
              botId: config.id,
              sessionId: session.id,
              ownerOpenId: collaboration?.ownerOpenId ?? msg.senderOpenId,
              ownerUnionId: collaboration?.ownerUnionId ?? msg.senderUnionId,
              collaboration: collaboration ? collaborationOrigin(collaboration) : undefined,
              originalMessageId: msg.messageId,
              cardMessageId: cardId,
              replyInThread: hasThread,
              request: clarificationRequest,
            });
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);
            await cardUpdater.finish(buildClarificationCard({ flow }));
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: flow.ownerOpenId, name: "" },
              text: `需要你确认 ${clarificationRequest.questions.length} 个问题，请在上方卡片中选择。`,
              replyInThread: hasThread,
            });
            console.log(`[澄清] 已发送交互卡片 questions=${clarificationRequest.questions.length}`);
            return;
          }
          let finalResult = result;
          let productSpecRequest: ProductSpecRequest | undefined;
          const managesProductSpec =
            !isCompacting && (config.skills.includes("to-spec") || config.skills.includes("lark-doc"));
          if (managesProductSpec) {
            const submission = await ensureProductSpecSubmission({
              result,
              defaultDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
              retry: (retryPrompt, resultSessionId) =>
                executeCli(
                  cliAdapter,
                  retryPrompt,
                  session.workspaceDir,
                  resultSessionId ?? session.cliSessionId,
                  run.signal,
                  (event) => {
                    if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "context") return;
                    progress.accept(event);
                    renderProgress();
                  },
                  cliEnv,
                ),
            });
            finalResult = submission.result;
            productSpecRequest = submission.request;
            if (finalResult.sessionId) {
              await sessions.setCliSessionId(session.id, finalResult.sessionId);
            }
            if (finalResult.stats?.contextWindowTokens) {
              contextWindows.set(session.id, finalResult.stats.contextWindowTokens);
            }
          }
          const dispatchRequest = !isCompacting ? findDispatchTaskRequest(finalResult.toolCalls) : undefined;
          if (dispatchRequest) {
            if (config.id !== agentOsConfig.teamLeaderId) {
              throw new Error("只有 CEO 助理可以调用 dispatch_task 派发团队任务");
            }
            const dispatchTarget = teamRegistry.get(dispatchRequest.targetBotId);
            if (!dispatchTarget) {
              throw new Error(`团队成员未注册或未启用: ${dispatchRequest.targetBotId}`);
            }
            if (dispatchRequest.targetBotId === config.id) {
              throw new Error(`不能把团队任务派发给当前 bot: ${config.id}`);
            }
            if (collaboration && collaboration.round >= collaboration.maxRounds) {
              throw new Error(`协作任务已达到轮次上限 ${collaboration.maxRounds}，不能继续派发`);
            }
          }
          if (productSpecRequest && dispatchRequest) {
            throw new Error("不能同时提交产品方案和派发团队任务");
          }
          if (productSpecRequest) {
            if (productSpecRequest.deliveryMode === "local") {
              await assertProductSpecDocuments(session.workspaceDir, productSpecRequest);
            }
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);
            const flow = productSpecFlows.create({
              taskId,
              botId: config.id,
              sessionId: session.id,
              ownerOpenId: collaboration?.ownerOpenId ?? msg.senderOpenId,
              ownerUnionId: collaboration?.ownerUnionId ?? msg.senderUnionId,
              collaboration: collaboration ? collaborationOrigin(collaboration) : undefined,
              request: productSpecRequest,
            });
            await cardUpdater.finish(buildProductSpecApprovalCard(flow));
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: {
                openId: collaboration?.ownerOpenId ?? msg.senderOpenId,
                name: "",
              },
              text: "产品方案已生成，请查看上方确认卡。",
              replyInThread: hasThread,
            });
            console.log("[产品文档] 已展示待确认产物");
            return;
          }

          const snapshot = progress.snapshot();
          await cardUpdater.finish(
            isCompacting
              ? buildSessionNoticeCard({
                  title: finalResult.answer ? "暂时无需整理" : "上下文已整理",
                  template: finalResult.answer ? "grey" : "green",
                  detail:
                    finalResult.answer ||
                    [
                      `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                      "CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。",
                    ].join("\n\n"),
                })
              : buildTaskCard({
                  title: taskCardTitle,
                  status: "success",
                  detail: "执行完成",
                  progress: snapshot,
                  answer: finalResult.answer,
                  stats: finalResult.stats,
                }),
          );
          if (!isCompacting && answerNeedsContinuation(finalResult.answer)) {
            for (const chunk of splitLongText(answerContinuation(finalResult.answer))) {
              await bot.reply(msg.messageId, chunk, hasThread);
            }
          }
          console.log(`[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? "(无)"}`);
          if (!collaboration) {
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: msg.senderOpenId, name: "" },
              text: isCompacting ? "上下文整理已完成，请查看上方结果。" : "任务已完成，请查看上方结果。",
              replyInThread: hasThread,
            });
          }
          if (!isCompacting) {
            try {
              if (dispatchRequest) {
                await collaborationService.dispatch({
                  senderConfig: config,
                  senderBot: bot,
                  replyToMessageId: msg.messageId,
                  targetBotId: dispatchRequest.targetBotId,
                  taskId,
                  ownerOpenId: collaboration?.ownerOpenId ?? msg.senderOpenId,
                  ownerUnionId: collaboration?.ownerUnionId ?? msg.senderUnionId,
                  reportToBotId: collaboration?.reportToBotId ?? config.id,
                  objective: dispatchRequest.objective,
                  instruction: dispatchRequest.instruction,
                  expectedOutput: dispatchRequest.expectedOutput,
                  round: collaboration ? collaboration.round + 1 : 1,
                  maxRounds: collaboration?.maxRounds ?? config.collaborationMaxRounds,
                  workspaceDir: session.workspaceDir,
                });
                if (!collaboration) {
                  const targetName =
                    botRuntimes.get(dispatchRequest.targetBotId)?.identity.name ?? dispatchRequest.targetBotId;
                  await sendResultNotification({
                    bot,
                    replyToMessageId: msg.messageId,
                    target: { openId: msg.senderOpenId, name: "" },
                    text: `任务已交给 ${targetName}，请查看上方协作消息。`,
                    replyInThread: hasThread,
                  });
                }
              } else if (collaboration) {
                if (collaboration.reportToBotId === config.id) {
                  await sendResultNotification({
                    bot,
                    replyToMessageId: msg.messageId,
                    target: { openId: collaboration.ownerOpenId, name: "" },
                    text: `协作任务“${collaboration.objective}”已经完成，请查看上方结果。`,
                    replyInThread: hasThread,
                  });
                } else if (collaboration.round >= collaboration.maxRounds) {
                  await sendResultNotification({
                    bot,
                    replyToMessageId: msg.messageId,
                    target: { openId: collaboration.ownerOpenId, name: "" },
                    text: `协作任务“${collaboration.objective}”已达到 ${collaboration.maxRounds} 轮上限，请查看上方结果并决定下一步。`,
                    replyInThread: hasThread,
                  });
                } else {
                  await collaborationService.dispatch({
                    senderConfig: config,
                    senderBot: bot,
                    replyToMessageId: msg.messageId,
                    targetBotId: collaboration.reportToBotId,
                    taskId: collaboration.taskId,
                    ownerOpenId: collaboration.ownerOpenId,
                    ownerUnionId: collaboration.ownerUnionId,
                    reportToBotId: collaboration.reportToBotId,
                    objective: collaboration.objective,
                    instruction: [
                      `${botRuntimes.get(config.id)?.identity.name ?? config.id} 已完成当前协作任务，下面是它的结果：`,
                      finalResult.answer,
                      "请基于这份结果继续组织后续工作：仍需其他成员参与时使用 dispatch_task 继续派发；已经可以交付时，直接向用户汇总结论。",
                    ].join("\n\n"),
                    expectedOutput: "继续推进原任务，或在已经完成时向用户给出最终结论。",
                    round: collaboration.round + 1,
                    maxRounds: collaboration.maxRounds,
                    workspaceDir: session.workspaceDir,
                  });
                }
              }
            } catch (error) {
              const message = (error as Error).message;
              console.error("[协作] 派发失败:", message);
              await bot.reply(msg.messageId, `协作派发失败：${message}`, hasThread);
            }
          }
        })
        .catch(async (error) => {
          clearInterval(progressHeartbeat);
          if (run.signal.aborted) {
            console.log("[CLI] 任务已取消");
            await cardUpdater.finish(
              buildTaskCard({
                title: taskCardTitle,
                status: "cancelled",
                detail:
                  activeRun.cancelMode === "close"
                    ? "本次任务已停止，当前会话已经关闭。"
                    : isCompacting
                      ? "整理已停止，当前 CLI 会话没有改变。"
                      : "本次任务已停止。你可以继续在当前话题里提问。",
                progress: progress.snapshot(),
              }),
            );
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: senderRuntime?.identity ?? { openId: msg.senderOpenId, name: "" },
              text: "任务已停止，请查看上方状态。",
              replyInThread: hasThread,
            });
            return;
          }
          const message = (error as Error).message;
          console.error("[CLI] 执行失败:", message);
          await cardUpdater.finish(
            buildTaskCard({
              title: taskCardTitle,
              status: "failed",
              detail: isCompacting
                ? "上下文整理失败，当前 CLI 会话没有改变。"
                : "执行没有完成。你可以调整指令后，在当前话题里重试。",
              technicalDetail: message,
              progress: progress.snapshot(),
            }),
          );
          await sendResultNotification({
            bot,
            replyToMessageId: msg.messageId,
            target: senderRuntime?.identity ?? { openId: msg.senderOpenId, name: "" },
            text: "任务执行失败，请查看上方错误信息。",
            replyInThread: hasThread,
          });
        })
        .finally(async () => {
          clearInterval(progressHeartbeat);
          if (activeRuns.get(session.id)?.controller === run) {
            activeRuns.delete(session.id);
          }
          try {
            await markSessionIdle(sessions, session.id);
          } catch (error) {
            console.error("[会话] 保存空闲状态失败:", (error as Error).message);
          }
        })
        .catch((error) => {
          console.error("[任务] 回传或收尾失败:", (error as Error).message);
        });
    },
  });
  const identity = await startedBot.getIdentity();
  const botRuntime = { config, bot: startedBot, identity };
  botRuntimes.set(config.id, botRuntime);
  if (config.skills.includes("lark-drive")) {
    await startedBot.subscribeToDocumentComments();
  }
  console.log(`[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`);
}

function scheduleDocumentComment(config: BotConfig, bot: Bot, comment: IncomingDocumentComment): void {
  if (!comment.mentionedBot) return;
  const flow = productSpecFlows.findPendingByDocument(config.id, comment.fileToken);
  if (!flow) {
    console.log(`[产品评论] 忽略未关联待确认方案的评论 file=${comment.fileToken}`);
    return;
  }

  const eventKey = comment.eventId || [comment.fileToken, comment.commentId, comment.replyId].join(":");
  if (processedDocumentCommentEvents.has(eventKey)) return;
  rememberDocumentCommentEvent(eventKey);

  const workingReaction = bot
    .setDocumentCommentWorking(comment, true)
    .then(() => true)
    .catch((error) => {
      console.warn("[产品评论] 添加处理中表情失败，继续执行:", (error as Error).message);
      return false;
    });
  const previous = documentCommentQueues.get(flow.sessionId) ?? Promise.resolve();
  const queued = Promise.all([previous.catch(() => undefined), workingReaction]).then(async ([, reactionAdded]) => {
    try {
      await runProductDocumentComment({
        runtime,
        bot,
        flow,
        comment,
      });
    } finally {
      if (reactionAdded) {
        await bot.setDocumentCommentWorking(comment, false).catch((error) => {
          console.warn("[产品评论] 移除处理中表情失败:", (error as Error).message);
        });
      }
    }
  });
  documentCommentQueues.set(flow.sessionId, queued);
  void queued
    .catch((error) => {
      console.error("[产品评论] 处理失败:", (error as Error).message);
      return bot
        .replyToDocumentComment(comment, `这条评论暂时没有处理完成：${(error as Error).message}`)
        .catch((replyError) => {
          console.error("[产品评论] 回写失败:", (replyError as Error).message);
        });
    })
    .finally(() => {
      if (documentCommentQueues.get(flow.sessionId) === queued) {
        documentCommentQueues.delete(flow.sessionId);
      }
    });
}

function rememberDocumentCommentEvent(eventKey: string): void {
  processedDocumentCommentEvents.add(eventKey);
  if (processedDocumentCommentEvents.size <= MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS) return;
  const oldest = processedDocumentCommentEvents.values().next().value;
  if (oldest) processedDocumentCommentEvents.delete(oldest);
}

await Promise.all(botConfigs.map((config) => startConfiguredBot(config, collaborationService)));

await scheduler.start();
startScheduleFileWatcher({ scheduler, filePath: scheduleFilePath });
startScheduleApi({
  scheduler,
  scheduleStore,
  runStore: scheduleRunStore,
  port: Number(process.env.SCHEDULE_API_PORT ?? 3101),
  token: process.env.SCHEDULE_API_TOKEN,
});
