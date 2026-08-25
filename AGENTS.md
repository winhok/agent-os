# agent-os

飞书是操作界面，Claude Code / Codex 是执行引擎；本项目实现中间的个人生产系统指挥层。一个话题对应一个 CLI 会话，bot 可以互相 @ 协作，产品方案通过结构化工具进入确认与反馈闭环。

## 常用命令

- `pnpm start`：监听 `.env` 与 `config/*.json`，以 watch 模式启动
- `pnpm start:once`：单次启动应用
- `pnpm build`：执行 TypeScript 编译，也是提交前的基础验证
- `pnpm probe:cli`：查看 Claude Code / Codex JSONL 事件流
- `pnpm probe:tool`：调试应用 MCP 工具调用

仓库当前没有独立的 lint 或 test 脚本；不要把 `pnpm build` 描述成真实飞书、浏览器或外部 CLI 的端到端验收。

## 配置与运行

- Node.js 22+、pnpm，项目仅使用 ESM。
- 从 `.env.example` 创建本地 `.env`，从 `config/bots.example.json` 创建 `config/bots.json`；两者都不得提交。
- bot 凭证由配置中的 `appIdEnv` / `appSecretEnv` 间接引用，禁止在源码或示例配置中写真实凭证。
- `CLI_WORKDIR` 决定 AI 编程 CLI 的默认工作目录；bot 的 `workspace` 可以覆盖它。
- bot 声明的 Skill 优先从工作区 `.agents/skills/`、`.claude/skills/` 加载，缺失时才回退到用户级或全局同名 Skill。
- 下载文件放在 `data/downloads/`，运行状态放在 `data/`，日志放在 `logs/`；这些运行产物不提交 Git。

## 模块地图

- `src/index.ts`：应用入口，装配飞书连接、会话、产品工作流、任务执行与结果回传
- `src/app/`：消息和卡片用例编排，包括命令、澄清、产品方案提交、文档评论续接与通知
- `src/core/`：bot/team 注册、话题任务、会话持久化、协作状态、产品方案状态与工作区解析
- `src/cli/`：Claude Code / Codex 适配器、原生会话、子进程生命周期、事件归一化与取消
- `src/im/`：飞书 WS/REST 接入、消息解析和交互卡片渲染
- `src/mcp/`：Agent OS 应用工具服务
- `src/probe-cli.ts`、`src/probe-app-tool.ts`：CLI 与 MCP 的独立调试入口
- `config/bots.example.json`：可公开提交的 bot 拓扑示例；本地真实配置使用 `config/bots.json`

## 修改约定

- 先沿真实运行调用链检查改动，不要只凭类型检查推断飞书、浏览器或外部 CLI 行为。
- 保持 CLI 无关的核心状态与协议在 `src/core/` / `src/app/`，Claude 与 Codex 差异留在各自适配器内。
- 更改结构化工具或卡片协议时，同时检查提交解析、状态持久化、续接逻辑和用户可见反馈。
- 更改 bot 配置字段时，同步检查 Zod schema、示例配置、团队展示和启动时校验。
- 提交前至少运行 `pnpm build` 与 `git diff --check`，并确认没有暂存 `.env`、`config/bots.json`、`data/` 或 `logs/`。

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。只记录可复用、非显而易见的问题。

- pnpm v11 默认拒绝依赖的构建脚本 → 在 `pnpm-workspace.yaml` 的 `allowBuilds` 中仅放行确实需要执行脚本的依赖。
- TypeScript 编译通过 → 只证明静态结构成立；真实飞书连接、卡片回调、CLI 恢复和浏览器验收仍需单独验证。
