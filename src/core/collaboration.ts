export interface CollaborationMessage {
  dispatchId: string;
  taskId: string;
  fromBotId: string;
  toBotId: string;
  workspaceDir: string;
  prompt: string;
}

export function collaborationTurnKey(message: CollaborationMessage): string {
  return `${message.taskId}:${message.toBotId}`;
}

export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>();

  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message);
  }

  consume(dispatchId: string, toBotId: string): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    if (!message || message.toBotId !== toBotId) return undefined;
    this.messages.delete(dispatchId);
    return message;
  }
}
