import type { Bot, BotIdentity } from "../im/lark.js";
import type { ActiveRun } from "../core/task-abort.js";
import type { BotConfig } from "../core/bot-registry.js";
import type { CollaborationInbox } from "../core/collaboration.js";
import type { SessionManager } from "../core/session-manager.js";
import type { TeamRegistry } from "../core/team-registry.js";

export interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

export interface AppRuntime {
  sessions: SessionManager;
  teamRegistry: TeamRegistry;
  activeRuns: Map<string, ActiveRun>;
  contextWindows: Map<string, number>;
  botRuntimes: Map<string, BotRuntime>;
  processedCollaborationTurns: Set<string>;
  collaborationInbox: CollaborationInbox;
}
