import type { CliId } from "../cli/types.js";

export type CommandName = "close" | "status" | "help";

export interface SlashCommand {
  name: CommandName;
}

const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help)\s*$/;
const CLI_REQUEST_RE = /^(?:@\S+\s+)?\/(claude|codex)(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1] as CommandName };
}

export interface CliRequest {
  cliId: CliId;
  prompt: string;
}

export function parseCliRequest(text: string): CliRequest | undefined {
  const match = CLI_REQUEST_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? "").trim(),
  };
}
