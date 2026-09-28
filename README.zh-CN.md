# Agent OS

以飞书为操作界面、Claude Code / Codex 为执行引擎的个人生产系统指挥层。

在飞书话题中提出目标，由不同角色的机器人（bot）完成需求澄清、产品方案、开发与结果汇总。你可以在同一话题中持续沟通，通过卡片回答问题、确认方案，也可以安排定时任务。任务执行在你自己的机器与项目目录中进行。

## 核心能力

- **持续对话**：在同一话题中继续任务，支持新建、恢复、整理上下文和关闭会话。
- **两种执行引擎**：支持 Claude Code 与 Codex，各 bot 可配置默认引擎。
- **团队协作**：向团队负责人提出目标，由其安排成员分工并汇总结果。
- **卡片交互**：通过飞书卡片回答澄清问题、确认产品方案和审批高风险操作。
- **方案确认**：支持飞书文档与本地方案两种交付方式，可通过飞书文档评论提出修改意见。
- **定时执行**：支持一次性、间隔和 Cron 任务，提供暂停、恢复、立即执行与运行记录。
- **本地保存**：会话记录、审批和定时计划保存在运行机器上。

## 快速开始

### 1. 准备环境

- Node.js **22.13+（22.x）或 24+**。
- pnpm，版本以 `package.json` 的 `packageManager` 为准，当前为 **12.6.0**。
- 至少一个已安装、完成认证且能在目标目录运行的 CLI：`claude` 或 `codex`。
- 飞书自建应用及机器人能力；每个启用的 bot 对应自己的应用凭证。
- 使用示例产品交付流程时，需要另行准备配置中声明的 Skills，以及飞书文档操作所需的 `lark-cli` 和用户授权。配置 Skills 名称不会自动安装它们。

在仓库根目录执行：

```bash
pnpm install
cp -n .env.example .env
cp -n config/bots.example.json config/bots.json
```

### 2. 配置 bot 与工作目录

编辑 `.env`，填写启用 bot 对应的 App ID 和 App Secret；变量名由 `config/bots.json` 中的 `appIdEnv`、`appSecretEnv` 指定。

示例配置包含三个角色：

| bot ID          | 职责                                          |
| --------------- | --------------------------------------------- |
| `ceo-assistant` | 理解目标、派发任务、汇总结果                  |
| `product`       | 澄清需求、编写产品文档与执行产物              |
| `developer`     | 实现已确认方案，按配置的 Skill 完成验证与审查 |

`teamLeader` 指定负责给其他成员分配任务的 bot，必须选择已启用的角色。可以通过 `enabled: false` 禁用暂不使用的角色；禁用角色无需填写凭证。

配置中的主要字段：

| 字段                         | 说明                                             |
| ---------------------------- | ------------------------------------------------ |
| `defaultCli`                 | `claude` 或 `codex`                              |
| `workspace`                  | bot 默认工作目录，相对路径基于应用启动目录解析   |
| `role` / `systemPrompt`      | 角色职责与执行要求                               |
| `skills`                     | 角色可用的 Skill 名称                            |
| `collaborationMaxRounds`     | 协作轮次上限，1–32，默认 16                      |
| `defaultProductDeliveryMode` | 顶层配置，`lark-doc` 或 `local`，默认 `lark-doc` |

**工作目录优先使用 bot 的 `workspace`，未配置时才使用 `CLI_WORKDIR`。** 示例为每个 bot 设置了 `workspace: "."`，因此仅修改 `.env` 中的 `CLI_WORKDIR` 不会改变这些 bot 的工作目录。请将 `workspace` 改为目标项目路径，或移除该字段后统一设置 `CLI_WORKDIR`。

Skill 优先从目标工作区 `.agents/skills/<name>/SKILL.md` 加载，其次是 `.claude/skills/<name>/SKILL.md`，两者均不存在时才回退到用户级或全局同名 Skill。

### 3. 接入飞书

为每个启用的应用配置机器人能力、可用范围与所需权限，并将机器人加入工作群。接收事件时选择**长连接**方式。

按需配置以下事件与回调；使用飞书文档评论功能时，需要文档评论事件：

| 事件 / 回调                   | 用途             |
| ----------------------------- | ---------------- |
| `im.message.receive_v1`       | 接收任务消息     |
| `card.action.trigger`         | 处理交互卡片操作 |
| `drive.notice.comment_add_v1` | 处理产品文档评论 |

根据使用的功能开通消息收发、卡片更新、消息资源读取以及文档评论相关权限。飞书文档交付还需要执行端具备创建和编辑文档的能力，并让相关用户与 bot 能访问对应文档。具体权限标识和应用发布要求以飞书后台为准。

### 4. 启动并发送第一条任务

```bash
pnpm build
pnpm start
```

`pnpm start` 会在配置或程序文件变化时自动重启。希望持续在后台运行时，参见下方“后台运行与更新”。

在飞书中 @ 团队负责人发送 `/help` 查看命令，再新建话题发送一个简单任务，例如“介绍一下当前项目能做什么”。你会在话题中收到进度卡片和最终回复。

## 在飞书中使用

在新话题中 @ bot 提出任务，同一话题内继续补充要求以续接会话。可以用以下前缀选择新话题的执行引擎：

```text
/codex 分析当前项目结构，并说明启动方式
/claude 检查当前改动，列出需要修复的问题
```

任务交给其他成员后，该成员使用自己配置的默认引擎。

| 命令               | 用途                               |
| ------------------ | ---------------------------------- |
| `/help`            | 查看帮助                           |
| `/status`          | 查看当前会话状态                   |
| `/team`            | 查看团队成员与能力                 |
| `/new`             | 开启新 CLI 会话，旧会话仍可恢复    |
| `/resume`          | 选择并恢复当前工作目录中的历史会话 |
| `/compact [要求]`  | 压缩当前会话上下文                 |
| `/cd [路径]`       | 查看或切换工作目录                 |
| `/close`           | 关闭当前会话                       |
| `/schedules`       | 查看定时任务                       |
| `/schedule <要求>` | 用自然语言管理定时任务             |

切换工作目录后，下一条任务会开启新会话。需要继续旧任务时，先切回原目录，再使用 `/resume` 选择对应会话。

### 产品方案交付

默认 `lark-doc` 流程：

```text
用户提出目标 → CEO 派发 → 产品 bot 澄清并编写飞书产品文档
→ 用户评论与审批 → 产品 bot 根据已批准版本生成本地 Spec/Tickets
→ 开发 bot 执行 → CEO 汇总结果
```

你只需在飞书产品文档中提出意见，并确认最终方案。确认后，产品 bot 会将方案整理成本地需求说明和任务清单（Spec/Tickets），供开发 bot 执行，无需再次审批。单纯的解释、分析任务不要求走方案审批流程。

选择 `local` 时，产品 bot 生成本地 Spec/Tickets 后提交方案确认。用户在任务中明确指定交付方式时，可覆盖默认配置。

### 定时任务

例如发送：

```text
/schedule 每个工作日上午 9 点，让 ceo-assistant 汇总当前项目待办
/schedules
```

定时任务在指定 bot 的工作目录中执行。到期时需要保持 Agent OS 运行，并确保所用 CLI 可正常执行任务。可以使用以下命令管理已有计划，将 `<id>` 替换为 `/schedules` 中显示的任务 ID：

```text
/schedule pause <id>
/schedule resume <id>
/schedule run <id>
/schedule delete <id>
```

以上命令依次用于暂停、恢复、立即执行和删除计划。

## 环境变量

完整模板见 [.env.example](.env.example)。

| 变量                                      | 说明                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `BOTS_CONFIG`                             | bot 注册文件，默认 `config/bots.json`          |
| `FEISHU_*_APP_ID` / `FEISHU_*_APP_SECRET` | 示例凭证变量；实际名称由 bot 配置指定          |
| `CLI_WORKDIR`                             | 未设置 bot `workspace` 时使用的工作目录        |
| `CLAUDE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS`  | 各 CLI 执行超时，单位毫秒；模板设置为 7200000  |
| `CLI_TIMEOUT_MS`                          | 未设置对应 CLI 专用超时时的回退值              |
| `SCHEDULE_API_PORT`                       | 定时任务管理 API 端口，默认 3101               |
| `SCHEDULE_API_TOKEN`                      | 设置后要求请求携带 `x-api-token`；留空时不校验 |

## 后台运行与更新

可通过 PM2 托管编译后的程序：

```bash
npm install -g pm2
pnpm agent-os doctor
pnpm build
pnpm agent-os start
pnpm agent-os status
```

`doctor` 检查命令版本和配置文件是否存在，不验证 CLI 登录凭证或飞书连接。

更新 Agent OS 后，重新编译并重启：

```bash
pnpm build
pnpm agent-os restart
```

`start` 仅在缺少 `dist/index.js` 时自动编译；`restart` 不执行构建。

```bash
pnpm agent-os logs
pnpm agent-os stop
```

也可以在构建后使用 `pnpm start:prod` 直接运行 `dist/index.js`。

## 运行权限与数据备份

Agent OS 启动的 Claude Code / Codex 会跳过自身的逐次权限确认，可以在运行账户的权限范围内修改文件和执行命令。飞书审批流程不能替代系统权限隔离；请使用合适的运行账户，并将机器人配置到你允许它操作的项目目录。

定时任务管理端口可能被其他机器访问。请限制该端口的网络访问，并在 `.env` 中设置 `SCHEDULE_API_TOKEN`。

迁移机器或备份时，重点保存以下内容：

- `.env`、`config/bots.json`：应用凭证和角色配置，备份时妥善保管，不要公开分享。
- `data/`：会话记录、审批记录和定时计划等数据；下载的附件位于 `data/downloads/`。
- 各 bot 的工作目录：任务生成的文档、代码和其他成果。

恢复历史对话还依赖 Claude Code / Codex 自身保存的会话数据，仅复制 Agent OS 的 `data/` 不足以完整迁移历史对话。

## 常见问题

**修改 `CLI_WORKDIR` 后，机器人仍在原目录执行？**

检查该 bot 的 `workspace`。它会优先于 `CLI_WORKDIR` 生效；示例中的 `workspace: "."` 表示 Agent OS 的启动目录。

**更新后仍然运行旧版本？**

先执行 `pnpm build`，再执行 `pnpm agent-os restart`。仅重启不会重新编译程序。

**重启后，之前的任务会自动完成吗？**

重启不代表任务完成。先通过 `/status`、任务回复和实际产物确认进度，再在原话题中补充要求继续处理。

**任务卡片一直没有更新？**

用 `pnpm agent-os status` 查看进程状态，再用 `pnpm agent-os logs` 查看日志。任务可能已完成，但结果卡片发送失败；重新执行前先检查回复和产物，避免重复操作。
