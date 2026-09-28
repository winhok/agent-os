import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CliId } from "../cli/types.js";
import { resolveWorkspacePath } from "./workspace.js";

const ProductDeliveryModeSchema = z.enum(["local", "lark-doc"]);

export type ProductDeliveryMode = z.infer<typeof ProductDeliveryModeSchema>;

export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  role: string;
  skills: string[];
  systemPrompt: string;
  workspaceDir: string;
  collaborationMaxRounds: number;
}

export interface AgentOsConfig {
  teamLeaderId: string;
  defaultProductDeliveryMode: ProductDeliveryMode;
  bots: BotConfig[];
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "bot id 只能使用小写字母、数字、连字符和下划线"),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(["claude", "codex"]),
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(""),
  collaborationMaxRounds: z.number().int().min(1).max(32).optional().default(16),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  teamLeader: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  defaultProductDeliveryMode: ProductDeliveryModeSchema.optional().default("lark-doc"),
  bots: z.array(BotSchema).min(1),
});

export function parseAgentOsConfig(input: unknown, env: Environment, baseDirectory = process.cwd()): AgentOsConfig {
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
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        collaborationMaxRounds: bot.collaborationMaxRounds,
        workspaceDir: resolveWorkspacePath(
          bot.workspace ?? env.CLI_WORKDIR ?? env.CLAUDE_WORKDIR ?? ".",
          baseDirectory,
        ),
      };
    });
  if (configs.length === 0) throw new Error("至少需要启用一个 bot");
  const enabledIds = new Set(configs.map((config) => config.id));
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`);
  }
  return {
    teamLeaderId: parsed.teamLeader,
    defaultProductDeliveryMode: parsed.defaultProductDeliveryMode,
    bots: configs,
  };
}

export function parseBotConfigs(input: unknown, env: Environment, baseDirectory = process.cwd()): BotConfig[] {
  return parseAgentOsConfig(input, env, baseDirectory).bots;
}

export async function loadAgentOsConfig(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<AgentOsConfig> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`, {
        cause: error,
      });
    }
    throw error;
  }

  try {
    return parseAgentOsConfig(JSON.parse(content), env, baseDirectory);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`, { cause: error });
  }
}

export async function loadBotConfigs(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<BotConfig[]> {
  return (await loadAgentOsConfig(filePath, env, baseDirectory)).bots;
}

export function buildBotPrompt(
  config: Pick<BotConfig, "role" | "skills" | "systemPrompt">,
  prompt: string,
  teamContext = "",
  defaultProductDeliveryMode: ProductDeliveryMode = "lark-doc",
): string {
  const managesProductDocuments = config.skills.some((skill) => ["to-spec", "to-tickets", "lark-doc"].includes(skill));
  const productDeliveryPolicy = managesProductDocuments
    ? [
        "产品方案交付规则（仅在当前派发要求形成或更新待审批方案时适用）：",
        "- 按 CEO 本次派发的目标、范围和预期交付执行；解释、分析或补充说明完成后交回结果，不自行升级为方案编写或审批。",
        `- 当前默认交付方式：${defaultProductDeliveryMode}。`,
        "- 用户明确指定本地 Markdown 或飞书云文档时，以用户本次选择覆盖默认值。",
        "- 不要为了选择交付格式单独发起澄清。",
        "- 默认方式为 lark-doc 时，待审批阶段只使用 lark-doc 生成面向用户的产品文档；不要提前运行 to-spec 或 to-tickets，也不要提交本地路径。",
        "- 用户确认飞书产品文档后，如果收到生成 Agent 执行产物的后续任务，再使用 to-spec 与 to-tickets 生成本地 Spec/Tickets；这一步不再调用 request_spec_approval。",
        "- 方案产物完成后必须实际调用 request_spec_approval，并提交最终采用的 deliveryMode 与对应产物字段。",
        "- 不能只在普通回复中罗列 deliveryMode、documentUrl、specPath 或 ticketsPath。工具调用成功后停止本轮。",
      ].join("\n")
    : "";
  const feishuOutputPolicy = [
    "飞书输出规则（必须遵守）：",
    "- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。",
    "- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。",
    "- 详细产物写入当前工作区文件。回复只提供简短摘要和文件路径。",
  ].join("\n");
  const clarificationPolicy = config.skills.includes("grill-me")
    ? "需要用户决策时，必须调用 request_clarification 工具；不要用大段文字列出问题。工具调用后停止继续推断，等待用户回答。"
    : "";
  const sections = [
    `你的角色：${config.role}`,
    config.systemPrompt.trim(),
    teamContext.trim(),
    productDeliveryPolicy,
    config.skills.length > 0
      ? [
          "项目 Skill 加载规则（优先级不可颠倒）：",
          "- 配置中的 Skills 是角色可用能力，按当前派发要求选择适用项，不要求全部执行；已读且仍有效的内容可以复用。",
          "- 对当前适用的 Skill，先读取当前工作区 `.agents/skills/<skill>/SKILL.md`。",
          "- 上述路径不存在时，再读取当前工作区 `.claude/skills/<skill>/SKILL.md`。",
          "- 只有两个工作区路径都不存在时，才允许回退到用户级或全局同名 Skill；不得因全局 Skill 同名而跳过工作区版本。",
          `角色可用的项目 Skills：${config.skills.join("、")}`,
        ].join("\n")
      : "",
    feishuOutputPolicy,
    clarificationPolicy,
    `当前任务：${prompt}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}
