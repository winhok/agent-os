import type { CliAdapter, CliEvent, CliRunStats } from "./types.js";

interface ClaudeEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
  message?: unknown;
}

interface ClaudeContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

const TOOL_LABELS: Record<string, string> = {
  Agent: "启动子任务",
  Bash: "运行命令",
  Edit: "修改文件",
  Glob: "查找文件",
  Grep: "搜索代码",
  Read: "读取文件",
  Task: "启动子任务",
  TaskOutput: "等待子任务完成",
  WebFetch: "读取网页",
  WebSearch: "搜索资料",
  Write: "写入文件",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shortPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(normalized.startsWith("/") ? -2 : -3).join("/");
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toolDetail(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (["Read", "Edit", "Write"].includes(name)) {
    return shortPath(input.file_path);
  }
  if (name === "Glob") return shortText(input.pattern);
  if (name === "Grep") return shortText(input.pattern);
  if (name === "Bash") return shortText(input.description);
  if (name === "Agent" || name === "Task") return shortText(input.description);
  if (name === "WebSearch") return shortText(input.query);
  return undefined;
}

function messageBlocks(message: unknown): ClaudeContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function usageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const values = [
    asNumber(usage.input_tokens),
    asNumber(usage.output_tokens),
    asNumber(usage.cache_read_input_tokens),
    asNumber(usage.cache_creation_input_tokens),
  ].filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function contextWindowTokens(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const windows = Object.values(modelUsage)
    .filter(isRecord)
    .map((usage) => asNumber(usage.contextWindow))
    .filter((value): value is number => value !== undefined && value > 0);
  return windows.length ? Math.max(...windows) : undefined;
}

function parseStats(event: ClaudeEvent): CliRunStats | undefined {
  const usage = isRecord(event.usage) ? event.usage : {};
  const totalTokens = usageTokens(usage);
  const windowTokens = contextWindowTokens(event.modelUsage);
  const stats: CliRunStats = {
    durationMs: asNumber(event.duration_ms),
    turns: asNumber(event.num_turns),
    totalTokens,
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    contextWindowTokens: windowTokens,
  };
  return Object.values(stats).some((value) => value !== undefined) ? stats : undefined;
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
    return this.parseEvents(line)[0];
  }

  parseEvents(line: string): CliEvent[] {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      return [];
    }

    const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;

    if (event.type === "system" && event.subtype === "init" && sessionId) {
      return [{ type: "session", sessionId }];
    }

    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : {};
      const usedTokens = usageTokens(message.usage);
      const contextEvent: CliEvent[] = usedTokens === undefined ? [] : [{ type: "context", usedTokens }];
      const toolEvents = messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") return [];
        const detail = toolDetail(block.name, block.input);
        return [
          {
            type: "tool_start",
            toolUseId: block.id,
            toolName: block.name,
            label: TOOL_LABELS[block.name] ?? `调用 ${block.name}`,
            ...(detail ? { detail } : {}),
          },
        ];
      });
      return [...contextEvent, ...toolEvents];
    }

    if (event.type === "user") {
      return messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
          return [];
        }
        return [
          {
            type: "tool_end",
            toolUseId: block.tool_use_id,
            failed: block.is_error === true,
          },
        ];
      });
    }

    if (event.type !== "result") return [];

    if (event.is_error) {
      return [
        {
          type: "error",
          message: typeof event.result === "string" ? event.result : "Claude Code 执行失败",
          ...(sessionId ? { sessionId } : {}),
        },
      ];
    }

    if (typeof event.result !== "string") return [];

    const stats = parseStats(event);

    return [
      {
        type: "result",
        answer: event.result,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
      },
    ];
  }
}
