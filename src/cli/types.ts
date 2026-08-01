export type CliId = "claude";

export type CliEvent =
  | { type: "session"; sessionId: string }
  | { type: "result"; answer: string; sessionId?: string }
  | { type: "error"; message: string; sessionId?: string };

export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string): string[];
  buildResumeArgs(prompt: string, sessionId: string): string[];
  parseEvent(line: string): CliEvent | undefined;
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
}
