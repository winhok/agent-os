# agent-os

飞书是操作界面，Claude Code / Codex 是执行引擎；本项目实现中间的个人生产系统指挥层。一个话题 = 一个 CLI 会话；bot 之间可以互相 @ 协作；cron 定时巡检；本地 Dashboard 管理任务。

## 运行

pnpm start（watch 模式）/ pnpm start:once（单次启动）

## 模块地图（随开发生长，只列已存在的）

- src/index.ts — 应用入口：编排飞书消息、会话、命令、资源下载与 Claude Code 执行回传
- src/im/lark.ts — 飞书接入：WS 收消息，REST 回复、卡片更新与资源下载
- src/im/card.ts — 任务状态卡片构建与节流更新
- src/im/message-parser.ts — @提及还原与图片/文件资源提取
- src/core/command-parser.ts — 话题内 `/status`、`/close`、`/help` 命令解析
- src/core/session-manager.ts — 飞书话题到 CLI 会话的映射与状态流转
- src/core/session-store.ts — 会话 JSON 持久化、启动恢复与串行原子写入
- src/cli/types.ts — CLI 适配器、事件与执行结果的公共类型
- src/cli/claude-adapter.ts — Claude Code 参数构建、续接与 stream-json 事件解析
- src/cli/runner.ts — CLI 子进程执行、超时/取消控制与最终结果收集
- src/probe-cli.ts — Claude Code / Codex JSONL 事件流的独立调试查看器

## 约定

- ESM only，Node 22+，pnpm
- 凭证只放 .env（已 gitignore），绝不硬编码、绝不提交
- 下载的图片和文件统一放在 data/downloads/，不提交 Git
- 测试话题群 chat_id 见 `.env`
- 执行入口始终调用真实 `claude` 命令
- `CLAUDE_WORKDIR` 指向 Claude Code 实际处理任务的项目目录

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。

- pnpm v11 默认拒绝依赖的构建脚本（esbuild 装完不可用）→ 在 `pnpm-workspace.yaml` 写 `allowBuilds: { esbuild: true }` 放行
