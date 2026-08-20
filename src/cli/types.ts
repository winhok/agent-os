export type CliId = "claude" | "codex";

export type CliPromptInput = "argument" | "stdin";

export function promptInputForPlatform(platform: NodeJS.Platform): CliPromptInput {
  return platform === "win32" ? "stdin" : "argument";
}

export type CliCompactPlan =
  | {
      protocol: "claude-stream-json";
      command: string;
      args: string[];
      prompt: string;
    }
  | {
      protocol: "codex-app-server";
      command: string;
      args: string[];
      sessionId: string;
    };

export interface CliRunStats {
  durationMs?: number;
  turns?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export type CliEvent =
  | { type: "session"; sessionId: string }
  | {
      type: "tool_start";
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
    }
  | { type: "tool_end"; toolUseId: string; failed: boolean }
  | { type: "context"; usedTokens: number }
  | {
      type: "tool_call";
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "result"; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: "error"; message: string; sessionId?: string };

export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string, promptInput: CliPromptInput): string[];
  buildResumeArgs(prompt: string, sessionId: string, promptInput: CliPromptInput): string[];
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan;
  parseEvents(line: string): CliEvent[];
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
  toolCalls?: Array<{
    toolUseId: string;
    toolName: string;
    input: unknown;
  }>;
}

export interface CliSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}
