import { runCli } from "../cli/runner.js";
import type { CliAdapter } from "../cli/types.js";

export function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  stopToolNames: string[],
  onEvent: Parameters<typeof runCli>[0]["onEvent"],
  env?: Record<string, string>,
) {
  return runCli({
    adapter,
    prompt,
    cwd: workspaceDir,
    sessionId,
    signal,
    stopToolNames,
    env,
    onEvent,
  });
}
