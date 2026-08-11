import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CliId } from "../cli/types.js";

export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  systemPrompt: string;
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "bot id 只能使用小写字母、数字、连字符和下划线"),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(["claude", "codex"]),
  systemPrompt: z.string().trim().optional().default(""),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  bots: z.array(BotSchema).min(1),
});

export function parseBotConfigs(input: unknown, env: Environment): BotConfig[] {
  const parsed = BotConfigFileSchema.parse(input);
  const ids = new Set<string>();
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`);
    ids.add(bot.id);
  }

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? "";
      const appSecret = env[bot.appSecretEnv]?.trim() ?? "";
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`);
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`);
      }
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        systemPrompt: bot.systemPrompt,
      };
    });
  if (configs.length === 0) throw new Error("至少需要启用一个 bot");
  return configs;
}

export async function loadBotConfigs(filePath: string, env: Environment = process.env): Promise<BotConfig[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`);
    }
    throw error;
  }

  try {
    return parseBotConfigs(JSON.parse(content), env);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`);
  }
}

export function buildBotPrompt(systemPrompt: string, prompt: string): string {
  const role = systemPrompt.trim();
  if (!role) return prompt;
  return `角色：${role}\n\n任务：${prompt}`;
}
