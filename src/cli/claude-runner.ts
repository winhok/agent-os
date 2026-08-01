import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ClaudeRunResult {
  answer: string;
  sessionId?: string;
}

export interface RunClaudeOptions {
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
}

interface ClaudeResultEvent {
  type: "result";
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

function isResultEvent(value: unknown): value is ClaudeResultEvent {
  if (!value || typeof value !== "object") return false;
  return (value as { type?: unknown }).type === "result";
}

export function runClaude(options: RunClaudeOptions): Promise<ClaudeRunResult> {
  const args = ["-p", options.prompt, "--output-format", "stream-json", "--verbose"];

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let finalResult: ClaudeRunResult | undefined;
    let resultError: Error | undefined;
    let stderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    lines.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!isResultEvent(event)) return;
      if (event.is_error) {
        resultError = new Error(event.result || "Claude Code 执行失败");
        return;
      }
      if (typeof event.result === "string") {
        finalResult = {
          answer: event.result,
          sessionId: event.session_id,
        };
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (options.signal?.aborted) {
        fail(new Error("Claude Code 执行已取消"));
        return;
      }
      fail(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (options.signal?.aborted) {
        return fail(new Error("Claude Code 执行已取消"));
      }
      if (resultError) return fail(resultError);
      if (code !== 0) {
        return fail(new Error(stderr.trim() || `Claude Code 退出，状态码 ${code}`));
      }
      if (!finalResult) {
        return fail(new Error("Claude Code 没有返回最终结果"));
      }
      settled = true;
      resolve(finalResult);
    });
  });
}
