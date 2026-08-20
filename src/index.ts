import "dotenv/config";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { startBot, type Bot } from "./im/lark.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildClarificationCard,
  buildClarificationSupersededCard,
  buildCollaborationCard,
  buildSessionNoticeCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
  buildProductSpecApprovalCard,
} from "./im/card.js";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";
import { parseCliRequest, parseCommand } from "./core/command-parser.js";
import { SessionManager } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { TaskProgressTracker } from "./core/task-progress.js";
import type { ActiveRun } from "./core/task-abort.js";
import { ClarificationFlowStore, findClarificationRequest, formatClarificationMessage } from "./core/clarification.js";
import { findProductSpecRequest, ProductSpecFlowStore } from "./core/product-spec.js";
import { topicTaskId } from "./core/topic-task.js";
import { CollaborationInbox, collaborationTurnKey, type CollaborationMessage } from "./core/collaboration.js";
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
import type { AppRuntime, BotRuntime } from "./app/runtime.js";

const botConfigPath = resolve(process.env.BOTS_CONFIG ?? join("config", "bots.json"));
const agentOsConfig = await loadAgentOsConfig(botConfigPath);
const botConfigs = agentOsConfig.bots;
const teamRegistry = new TeamRegistry(agentOsConfig.teamLeaderId, botConfigs);
await Promise.all(botConfigs.map((config) => ensureWorkspaceDirectory(config.workspaceDir)));
for (const missing of await teamRegistry.findMissingSkills()) {
  console.warn(
    `[Skill] bot=${missing.botId} 找不到 ${missing.skill}，请安装到当前工作目录的 .agents/skills 或 .claude/skills`,
  );
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
const productSpecFlows = new ProductSpecFlowStore();
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

async function sendCollaborationMessage(options: {
  senderConfig: BotConfig;
  senderBot: Bot;
  replyToMessageId: string;
  targetBotId: string;
  taskId: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
}): Promise<void> {
  const target = botRuntimes.get(options.targetBotId);
  if (!target) throw new Error(`协作 bot 尚未就绪: ${options.targetBotId}`);
  const collaboration: CollaborationMessage = {
    dispatchId: randomUUID().replaceAll("-", "").slice(0, 12),
    taskId: options.taskId,
    fromBotId: options.senderConfig.id,
    toBotId: options.targetBotId,
    round: options.round,
    maxRounds: options.maxRounds,
    workspaceDir: options.workspaceDir,
    prompt: options.prompt,
  };
  collaborationInbox.register(collaboration);
  try {
    const cardMessageId = await options.senderBot.replyCard(
      options.replyToMessageId,
      buildCollaborationCard({
        senderName: botRuntimes.get(options.senderConfig.id)?.identity.name ?? options.senderConfig.id,
        targetName: target.identity.name,
        workspaceName: basename(options.workspaceDir),
        prompt: options.prompt,
        round: options.round,
        maxRounds: options.maxRounds,
      }),
      true,
    );
    if (!cardMessageId) throw new Error("飞书没有返回协作卡片 message_id");
    const mentionMessageId = await options.senderBot.replyMention(
      cardMessageId,
      target.identity,
      options.round === 1
        ? `新的代码审查任务（任务编号：${collaboration.dispatchId}），请查看上方卡片。`
        : `审查反馈已经返回（任务编号：${collaboration.dispatchId}），请查看上方卡片。`,
      true,
    );
    if (!mentionMessageId) throw new Error("飞书没有返回协作通知 message_id");
  } catch (error) {
    collaborationInbox.consume(collaboration.dispatchId, collaboration.toBotId);
    throw error;
  }
  console.log(
    `[协作] task=${options.taskId} ${options.senderConfig.id} -> ${options.targetBotId} round=${options.round}/${options.maxRounds}`,
  );
}

async function startConfiguredBot(config: BotConfig): Promise<void> {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,
    onCardAction: createCardActionHandler({ runtime, config }),
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
        const dispatchId = msg.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
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
          console.log(`[协作] 忽略重复消息 ${turnKey}`);
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
      const taskText = pendingClarification
        ? formatClarificationMessage(pendingClarification, cliRequest?.prompt ?? resolved)
        : (collaboration?.prompt ?? cliRequest?.prompt ?? resolved);
      const prompt = buildBotPrompt(config, taskText, teamRegistry.contextFor(config.id));
      const taskCardTitle = isCompacting ? "整理上下文" : cliAdapter.displayName;
      console.log(`[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
      console.log(`  原文: ${msg.text}`);
      console.log(`  还原: ${resolved}`);
      console.log(`  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`);
      console.log(`  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`);

      const commandOutcome = await handleSessionCommand({
        runtime,
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
        : executeCli(cliAdapter, prompt, session.workspaceDir, session.cliSessionId, run.signal, (event) => {
            if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "context") return;
            progress.accept(event);
            renderProgress();
          });

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
              ownerOpenId: msg.senderOpenId,
              ownerUnionId: msg.senderUnionId,
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
          const productSpecRequest =
            !isCompacting && config.skills.includes("to-spec") ? findProductSpecRequest(result.toolCalls) : undefined;
          if (productSpecRequest) {
            await assertProductSpecDocuments(session.workspaceDir, productSpecRequest);
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);
            const flow = productSpecFlows.create({
              taskId,
              botId: config.id,
              ownerOpenId: msg.senderOpenId,
              ownerUnionId: msg.senderUnionId,
              request: productSpecRequest,
            });
            await cardUpdater.finish(buildProductSpecApprovalCard(flow));
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: msg.senderOpenId, name: "" },
              text: "Spec 和 Tickets 已经落盘，请查看上方产物卡片。",
              replyInThread: hasThread,
            });
            console.log("[产品文档] 已展示待确认产物");
            return;
          }

          const snapshot = progress.snapshot();
          await cardUpdater.finish(
            isCompacting
              ? buildSessionNoticeCard({
                  title: result.answer ? "暂时无需整理" : "上下文已整理",
                  template: result.answer ? "grey" : "green",
                  detail:
                    result.answer ||
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
                  answer: result.answer,
                  stats: result.stats,
                }),
          );
          if (!isCompacting && answerNeedsContinuation(result.answer)) {
            for (const chunk of splitLongText(answerContinuation(result.answer))) {
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
          if (!isCompacting && !config.skills.includes("grill-me")) {
            try {
              if (collaboration && collaboration.round < collaboration.maxRounds) {
                await sendCollaborationMessage({
                  senderConfig: config,
                  senderBot: bot,
                  replyToMessageId: msg.messageId,
                  targetBotId: collaboration.fromBotId,
                  taskId: collaboration.taskId,
                  round: collaboration.round + 1,
                  maxRounds: collaboration.maxRounds,
                  workspaceDir: session.workspaceDir,
                  prompt: result.answer || "任务已完成，请检查当前工作目录。",
                });
              } else if (!collaboration && config.reviewBy) {
                await sendCollaborationMessage({
                  senderConfig: config,
                  senderBot: bot,
                  replyToMessageId: msg.messageId,
                  targetBotId: config.reviewBy,
                  taskId: randomUUID(),
                  round: 1,
                  maxRounds: config.collaborationMaxRounds,
                  workspaceDir: session.workspaceDir,
                  prompt: [
                    "请独立检查当前工作目录中刚完成的实现。",
                    `原始任务：${taskText}`,
                    "请直接读取代码和改动，指出明确问题；没有问题时说明检查通过。",
                  ].join("\n\n"),
                });
              } else if (collaboration && senderRuntime) {
                await sendResultNotification({
                  bot,
                  replyToMessageId: msg.messageId,
                  target: senderRuntime.identity,
                  text: "本轮协作已完成，请查看上方结果。",
                  replyInThread: hasThread,
                });
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
              target: senderRuntime?.identity ?? {
                openId: msg.senderOpenId,
                name: "",
              },
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
            target: senderRuntime?.identity ?? {
              openId: msg.senderOpenId,
              name: "",
            },
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
  console.log(`[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`);
}

await Promise.all(botConfigs.map(startConfiguredBot));
