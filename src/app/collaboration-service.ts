import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Bot } from "../im/lark.js";
import { buildCollaborationCard } from "../im/card.js";
import type { BotConfig } from "../core/bot-registry.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import type { AppRuntime } from "./runtime.js";

export interface CollaborationDispatch {
  senderConfig: BotConfig;
  senderBot: Bot;
  replyToMessageId: string;
  targetBotId: string;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  reportToBotId: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
}

export class CollaborationService {
  constructor(private readonly runtime: AppRuntime) {}

  async dispatch(options: CollaborationDispatch): Promise<void> {
    const target = this.runtime.botRuntimes.get(options.targetBotId);
    if (!target) throw new Error(`协作 bot 尚未就绪: ${options.targetBotId}`);
    const reportTo = this.runtime.botRuntimes.get(options.reportToBotId);
    if (!reportTo) throw new Error(`结果接收 bot 尚未就绪: ${options.reportToBotId}`);

    const collaboration: CollaborationMessage = {
      dispatchId: randomUUID().replaceAll("-", ""),
      taskId: options.taskId,
      ownerOpenId: options.ownerOpenId,
      ownerUnionId: options.ownerUnionId,
      fromBotId: options.senderConfig.id,
      toBotId: options.targetBotId,
      reportToBotId: options.reportToBotId,
      objective: options.objective,
      instruction: options.instruction,
      expectedOutput: options.expectedOutput,
      round: options.round,
      maxRounds: options.maxRounds,
      workspaceDir: options.workspaceDir,
    };
    this.runtime.collaborationInbox.register(collaboration);

    try {
      const cardMessageId = await options.senderBot.replyCard(
        options.replyToMessageId,
        buildCollaborationCard({
          senderName: this.runtime.botRuntimes.get(options.senderConfig.id)?.identity.name ?? options.senderConfig.id,
          targetName: target.identity.name,
          reportToName: reportTo.identity.name,
          workspaceName: basename(options.workspaceDir),
          objective: options.objective,
          instruction: options.instruction,
          expectedOutput: options.expectedOutput,
          round: options.round,
          maxRounds: options.maxRounds,
        }),
        true,
      );
      if (!cardMessageId) {
        throw new Error("飞书没有返回协作卡片 message_id");
      }
      const mentionMessageId = await options.senderBot.replyMention(
        cardMessageId,
        target.identity,
        options.round === 1
          ? `新的协作任务：${options.objective}（任务编号：${collaboration.dispatchId}），请查看上方卡片。`
          : `协作结果已经返回（任务编号：${collaboration.dispatchId}），请查看上方卡片。`,
        true,
      );
      if (!mentionMessageId) {
        throw new Error("飞书没有返回协作通知 message_id");
      }
    } catch (error) {
      this.runtime.collaborationInbox.consume(collaboration.dispatchId, collaboration.toBotId);
      throw error;
    }
    console.log(
      `[协作] task=${options.taskId} ${options.senderConfig.id} -> ${options.targetBotId} round=${options.round}/${options.maxRounds}`,
    );
  }
}
