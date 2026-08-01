import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliAdapter, CliRunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const { adapter, prompt, cwd, sessionId, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const args = sessionId ? adapter.buildResumeArgs(prompt, sessionId) : adapter.buildArgs(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(adapter.command, args, {
      cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let finalResult: CliRunResult | undefined;
    let resultError: Error | undefined;
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const finish = () => clearTimeout(timer);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };

    lines.on("line", (line) => {
      const event = adapter.parseEvent(line);
      if (!event) return;

      if (event.sessionId) observedSessionId = event.sessionId;

      if (event.type === "error") {
        resultError = new Error(event.message);
        return;
      }

      if (event.type === "result") {
        finalResult = {
          answer: event.answer,
          sessionId: event.sessionId ?? observedSessionId,
        };
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      if (timedOut) return fail(new Error(`${adapter.displayName} 执行超时`));
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      fail(error);
    });

    child.once("close", (code) => {
      if (settled) return;
      if (timedOut) return fail(new Error(`${adapter.displayName} 执行超时`));
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      if (resultError) return fail(resultError);
      if (code !== 0) {
        return fail(new Error(stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`));
      }
      if (!finalResult) {
        return fail(new Error(`${adapter.displayName} 没有返回最终结果`));
      }

      settled = true;
      finish();
      resolve(finalResult);
    });
  });
}
