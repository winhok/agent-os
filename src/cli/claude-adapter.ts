import type { CliAdapter, CliEvent } from "./types.js";

interface ClaudeEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
}

function outputArgs(prompt: string): string[] {
  return ["-p", prompt, "--output-format", "stream-json", "--verbose"];
}

export class ClaudeAdapter implements CliAdapter {
  readonly id = "claude" as const;
  readonly command = "claude";
  readonly displayName = "Claude Code";

  buildArgs(prompt: string): string[] {
    return outputArgs(prompt);
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["--resume", sessionId, ...outputArgs(prompt)];
  }

  parseEvent(line: string): CliEvent | undefined {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      return undefined;
    }

    const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;

    if (event.type === "system" && event.subtype === "init" && sessionId) {
      return { type: "session", sessionId };
    }

    if (event.type !== "result") return undefined;

    if (event.is_error) {
      return {
        type: "error",
        message: typeof event.result === "string" ? event.result : "Claude Code 执行失败",
        ...(sessionId ? { sessionId } : {}),
      };
    }

    if (typeof event.result !== "string") return undefined;

    return {
      type: "result",
      answer: event.result,
      ...(sessionId ? { sessionId } : {}),
    };
  }
}
