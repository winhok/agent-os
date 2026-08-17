import type { CliId } from "../cli/types.js";

export type SlashCommand =
  | { name: "close" | "status" | "help" | "new" | "resume" | "team" }
  | { name: "compact"; instructions?: string }
  | { name: "cd"; path?: string };

const COMMAND_RE = /^(?:@.+?\s+)?\/(close|status|help|new|resume|team)\s*$/;
const CD_RE = /^(?:@.+?\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@.+?\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const CLI_REQUEST_RE = /^(?:@.+?\s+)?\/(claude|codex)(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim();
  const cdMatch = CD_RE.exec(value);
  if (cdMatch) return { name: "cd", path: cdMatch[1]?.trim() || undefined };
  const compactMatch = COMPACT_RE.exec(value);
  if (compactMatch) {
    return {
      name: "compact",
      instructions: compactMatch[1]?.trim() || undefined,
    };
  }
  const match = COMMAND_RE.exec(value);
  if (!match) return undefined;
  return {
    name: match[1] as "close" | "status" | "help" | "new" | "resume" | "team",
  };
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
