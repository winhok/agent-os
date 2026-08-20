import { createHash } from "node:crypto";

export interface TopicAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export function topicIdOf(message: TopicAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

export function topicTaskId(message: TopicAddress): string {
  return createHash("sha256")
    .update(`${message.chatId}:${topicIdOf(message)}`)
    .digest("hex")
    .slice(0, 24);
}
