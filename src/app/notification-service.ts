import type { Bot, BotIdentity } from "../im/lark.js";

export async function sendResultNotification(options: {
  bot: Bot;
  replyToMessageId: string;
  target: BotIdentity;
  text: string;
  replyInThread: boolean;
}): Promise<void> {
  try {
    await options.bot.replyMention(options.replyToMessageId, options.target, options.text, options.replyInThread);
  } catch (error) {
    console.error("[通知] 结果通知发送失败:", (error as Error).message);
  }
}
