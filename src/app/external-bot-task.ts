import type { IncomingMessage } from "../im/lark.js";
import { parseCollaborationMessageMarker } from "../core/collaboration.js";

/** Structured collaboration messages must never fall back to external tasks. */
export function externalBotTaskOwner(
  message: IncomingMessage,
  targetOpenId: string | undefined,
  ownerOpenId: string | undefined,
): string | undefined {
  if (message.senderType !== "app" && message.senderType !== "bot") return undefined;
  if (!targetOpenId || !message.mentions.some((mention) => mention.openId === targetOpenId)) return undefined;
  if (parseCollaborationMessageMarker(message.text)) return undefined;
  return ownerOpenId?.trim() || undefined;
}

/** Claim synchronously before awaiting execution, scoped to the receiving bot. */
export class BotMessageDeduplicator {
  private readonly messages = new Set<string>();
  private readonly processing = new Set<string>();

  constructor(private readonly capacity = 10_000) {}

  claim(botId: string, messageId: string): boolean {
    if (!messageId) return false;
    const key = JSON.stringify([botId, messageId]);
    if (this.messages.has(key) || this.processing.has(key)) return false;
    this.processing.add(key);
    return true;
  }

  accept(botId: string, messageId: string): void {
    const key = JSON.stringify([botId, messageId]);
    if (!this.processing.delete(key)) return;
    this.messages.add(key);
    if (this.messages.size > this.capacity) {
      const oldest = this.messages.values().next().value;
      if (oldest !== undefined) this.messages.delete(oldest);
    }
  }

  release(botId: string, messageId: string): void {
    this.processing.delete(JSON.stringify([botId, messageId]));
  }
}
