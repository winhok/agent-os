export type CommandName = "close" | "status" | "help";

export interface SlashCommand {
  name: CommandName;
}

const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help)\s*$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1] as CommandName };
}
