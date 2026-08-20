import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BotConfig } from "./bot-registry.js";

export interface MissingSkill {
  botId: string;
  skill: string;
  searchedPaths: string[];
}

export class TeamRegistry {
  private readonly configs = new Map<string, BotConfig>();

  constructor(
    readonly leaderBotId: string,
    configs: BotConfig[],
  ) {
    for (const config of configs) this.configs.set(config.id, config);
    if (!this.configs.has(leaderBotId)) {
      throw new Error(`Team Leader 不存在: ${leaderBotId}`);
    }
  }

  get leader(): BotConfig {
    return this.configs.get(this.leaderBotId)!;
  }

  get members(): BotConfig[] {
    return [...this.configs.values()];
  }

  get(botId: string): BotConfig | undefined {
    return this.configs.get(botId);
  }

  contextFor(currentBotId: string): string {
    const current = this.configs.get(currentBotId);
    if (!current) throw new Error(`团队成员不存在: ${currentBotId}`);
    const roster = this.members.map((member) => {
      const leader = member.id === this.leaderBotId ? "（Team Leader）" : "";
      const skills =
        member.skills.length > 0 ? `；Skills：${member.skills.map((skill) => `$${skill}`).join("、")}` : "";
      return `- ${member.id}${leader}：${member.role}${skills}`;
    });
    return [
      "你所在的 Agent 团队：",
      ...roster,
      `你当前以 ${current.id} 的身份工作。只处理交给你的职责；需要其他成员参与时，清楚说明希望交给谁以及期望结果。`,
      "团队名单中的成员都是真实的飞书 bot。CLI 内部子 Agent 适合处理临时分工，不能冒充这些长期团队成员。",
    ].join("\n");
  }

  async findMissingSkills(): Promise<MissingSkill[]> {
    const missing: MissingSkill[] = [];
    for (const config of this.members) {
      for (const skill of config.skills) {
        const searchedPaths = [
          join(config.workspaceDir, ".agents", "skills", skill, "SKILL.md"),
          join(config.workspaceDir, ".claude", "skills", skill, "SKILL.md"),
          join(homedir(), ".agents", "skills", skill, "SKILL.md"),
          join(homedir(), ".claude", "skills", skill, "SKILL.md"),
          join(homedir(), ".codex", "skills", skill, "SKILL.md"),
        ];
        if (!(await somePathExists(searchedPaths))) {
          missing.push({ botId: config.id, skill, searchedPaths });
        }
      }
    }
    return missing;
  }
}

async function somePathExists(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await access(path);
      return true;
    } catch {
      // 继续检查另一个项目级 Skill 目录。
    }
  }
  return false;
}
