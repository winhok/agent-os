# agent-os

飞书是操作界面，Claude Code / Codex 是执行引擎；本项目实现中间的个人生产系统指挥层。一个话题 = 一个 CLI 会话；bot 之间可以互相 @ 协作；cron 定时巡检；本地 Dashboard 管理任务。

## 运行

pnpm start（watch 模式）/ pnpm start:once（单次启动）

## 模块地图（随开发生长，只列已存在的）

- src/index.ts — 入口：解析消息、下载资源并在话题内回复
- src/im/lark.ts — 飞书接入：WS 收消息、REST 回复与资源下载
- src/im/message-parser.ts — @提及还原与图片/文件资源提取
- src/probe-cli.ts — AI CLI 事件流解析器

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
