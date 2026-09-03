# agent-os

飞书是操作界面，Claude Code / Codex 是执行引擎；本项目实现中间的个人生产系统指挥层。一个话题对应一个 CLI 会话，bot 可以互相 @ 协作，产品方案、操作审批与定时任务通过结构化工具进入确定性闭环。

## 常用命令

- `pnpm start`：监听 `.env` 与 `config/*.json`，以 watch 模式启动
- `pnpm start:once`：单次启动应用
- `pnpm start:prod`：运行已编译的 `dist/index.js`
- `pnpm agent-os doctor|start|stop|restart|status|logs`：检查本地环境并通过 PM2 管理生产进程
- `pnpm build`：执行 TypeScript 编译，也是提交前的基础验证
- `pnpm probe:cli`：查看 Claude Code / Codex JSONL 事件流
- `pnpm probe:tool`：调试应用 MCP 工具调用

仓库当前没有独立的 lint 或 test 脚本；不要把 `pnpm build` 描述成真实飞书、浏览器或外部 CLI 的端到端验收。

## 配置与运行

- Node.js 22+、pnpm，项目仅使用 ESM。
- 从 `.env.example` 创建本地 `.env`，从 `config/bots.example.json` 创建 `config/bots.json`；两者都不得提交。
- bot 凭证由配置中的 `appIdEnv` / `appSecretEnv` 间接引用，禁止在源码或示例配置中写真实凭证。
- `teamLeader` 必须指向已启用的 bot；只有该 bot 可以调用 `dispatch_task`。`defaultProductDeliveryMode` 只支持 `local` 与 `lark-doc`。
- `CLI_WORKDIR` 决定 AI 编程 CLI 的默认工作目录；bot 的 `workspace` 可以覆盖它。
- `CLAUDE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS` 分别控制 CLI 执行超时，未设置时回退到 `CLI_TIMEOUT_MS`。
- `collaborationMaxRounds` 控制协作链最大轮数，取值为 1–32，默认 16；不要重新引入静态 `reviewBy` 路由。
- bot 声明的 Skill 优先从工作区 `.agents/skills/`、`.claude/skills/` 加载，缺失时才回退到用户级或全局同名 Skill。
- `SCHEDULE_API_PORT` / `SCHEDULE_API_TOKEN` 配置本机定时任务管理接口；MCP 子进程通过当前会话上下文调用它，不要把写操作绕过 `Scheduler` 直接落盘。
- 下载文件放在 `data/downloads/`，会话、流程、定时任务及运行记录放在 `data/`，日志放在 `logs/`；这些运行产物不提交 Git。

## 模块地图

### 顶层入口与配置

- `src/index.ts`：应用入口，加载配置与持久化状态，装配飞书 bot、CLI 会话、协作/澄清/方案/审批流程、Scheduler、管理 API 与文件监听
- `src/deploy-cli.ts`：本地生产部署入口，负责环境检查、构建与 PM2 进程管理
- `src/probe-cli.ts`、`src/probe-app-tool.ts`：CLI JSONL 与应用 MCP 工具的独立调试入口
- `config/bots.example.json`：可公开提交的 bot 拓扑示例；本地真实配置使用 `config/bots.json`
- `.env.example`：运行环境变量模板，只写变量名与占位值，不保存真实凭证
- `package.json`、`pnpm-lock.yaml`：命令、Node/pnpm 版本与依赖锁定
- `pnpm-workspace.yaml`：pnpm 安装策略与依赖构建脚本白名单
- `tsconfig.json`：ESM TypeScript 编译边界，源码从 `src/` 输出到 `dist/`
- `.prettierrc.json`、`.prettierignore`：格式化规则与排除范围
- `.gitignore`：隔离本地配置、构建结果和运行产物
- `AGENTS.md`：仓库唯一的指导文档；`CLAUDE.md` 是指向它的相对软链接

### 应用编排 `src/app/`

- `runtime.ts`：聚合 bot、会话、活动任务、上下文窗口、流程 Store 与协作收件箱的运行时依赖
- `command-handler.ts`、`session-view.ts`：处理斜杠命令并展示、切换、压缩或关闭 CLI 会话
- `cli-execution.ts`：封装已有 CLI 会话的续接执行
- `card-action-handler.ts`：路由澄清、方案确认、审批、会话恢复与任务停止等卡片动作
- `clarification-runner.ts`、`approval-runner.ts`：把用户决定续接回原 CLI 会话并收束运行状态
- `product-spec-submission.ts`、`product-spec-documents.ts`、`product-comment-runner.ts`：校验方案提交、关联本地或飞书产物，并通过文档评论续接原任务
- `collaboration-service.ts`：确定性派发团队任务、发送协作卡片并持久化待消费消息
- `notification-service.ts`：统一发送任务结果和 @ 通知
- `scheduler.ts`：注册计时器、触发任务、去重运行、记录结果并恢复中断状态
- `schedule-manage-service.ts`、`schedule-api.ts`：执行结构化定时任务操作，并向 MCP 子进程提供本机管理接口
- `schedule-watcher.ts`：监听计划文件变化并把外部声明同步到 Scheduler
- `scheduled-task-dispatcher.ts`、`scheduled-task-runner.ts`：把到期计划解析为目标 bot 的独立 CLI 会话并执行

### 核心状态与协议 `src/core/`

- `bot-registry.ts`、`team-registry.ts`：校验 bot 配置、解析工作目录、生成角色提示词并维护团队成员能力
- `workspace.ts`、`topic-task.ts`、`command-parser.ts`：解析工作目录、话题/任务标识和用户命令
- `session-manager.ts`、`session-store.ts`：管理以 bot、话题和工作目录为边界的会话状态与 JSON 持久化
- `clarification.ts`：定义结构化问题、答案、所有者校验与澄清流程状态
- `product-spec.ts`、`product-spec-store.ts`：定义唯一产品方案产物、确认状态与 JSON 持久化
- `approval.ts`、`approval-store.ts`：定义高风险操作审批、超时/拒绝语义与 JSON 持久化
- `collaboration.ts`：定义 `dispatch_task` 协议、协作来源、轮次去重键与持久化收件箱
- `schedule.ts`、`schedule-store.ts`：定义一次性/间隔/Cron 计划及其原子持久化
- `schedule-run-store.ts`：记录每次计划运行的状态、结果与重启恢复依据
- `task-abort.ts`、`task-progress.ts`：管理活动任务取消授权与流式进度快照

### CLI 适配 `src/cli/`

- `types.ts`、`registry.ts`：定义统一 CLI 事件、运行结果、适配器协议与实例注册
- `claude-adapter.ts`、`codex-adapter.ts`：构造各自命令参数，并把原生 JSONL 归一化为统一事件
- `runner.ts`、`spawn-cli.ts`：管理子进程、提示词输入、超时/取消、环境变量与逐行事件消费
- `native-sessions.ts`、`native-compact.ts`：发现原生 CLI 会话，并按 Claude/Codex 各自协议执行上下文压缩
- `app-tools.ts`：集中声明 Agent OS MCP 工具名称与 CLI 启动参数

### 飞书与结构化工具

- `src/im/lark.ts`：封装飞书 WS/REST、消息/卡片回复、文档评论订阅与资源下载
- `src/im/message-parser.ts`：解析文本、富文本、附件和 @ 提及
- `src/im/card.ts`：渲染任务进度、澄清、方案、审批、协作、会话和定时任务卡片
- `src/mcp/app-tools-server.ts`：注册 `request_clarification`、`request_spec_approval`、`dispatch_task`、`schedule_manage` 与 `request_approval`

## 修改约定

- 先沿真实运行调用链检查改动，不要只凭类型检查推断飞书、浏览器或外部 CLI 行为。
- 保持 CLI 无关的核心状态与协议在 `src/core/` / `src/app/`，Claude 与 Codex 差异留在各自适配器内。
- 更改结构化工具或卡片协议时，同时检查 MCP 注册、Claude/Codex 事件归一化、提交解析、状态持久化、续接逻辑、授权边界和用户可见反馈。
- 更改 bot 配置字段时，同步检查 Zod schema、示例配置、团队展示和启动时校验。
- 会话以 bot、话题和工作目录为边界；切换工作目录时必须清除旧 CLI 会话绑定，恢复会话前必须校验 CLI 类型、原生会话 ID 与当前工作目录。
- 协作任务必须由 `dispatch_task` 进入确定性派发链：目标只能是已注册且非自身的 bot，工作目录与原始用户身份随任务传递，澄清/方案确认后仍需回到原协作链，并受轮次上限和重复消费保护。
- 高风险操作必须由 `request_approval` 建立审批流；审批卡只能接受可识别操作者的决定，拒绝、超时或续接失败都不能被当作已获授权。
- 定时任务的持久化由 Store 负责，创建、修改、删除、暂停、恢复与立即执行统一经过 `Scheduler`；执行时保留创建者身份、会话与目标 bot，并使用目标 bot 的工作目录，通用派发链不得误消费 `schedule_manage`。
- JSON 状态继续使用临时文件加原子重命名写入；进程重启后把中断的 `creating` / `active` 会话恢复为 `idle`，不要把内存中的运行态当作可持久化事实。
- 提交前至少运行 `pnpm build` 与 `git diff --check`，并确认没有暂存 `.env`、`config/bots.json`、`data/` 或 `logs/`。

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。只记录可复用、非显而易见的问题。

- pnpm v11 默认拒绝依赖的构建脚本 → 在 `pnpm-workspace.yaml` 的 `allowBuilds` 中仅放行确实需要执行脚本的依赖。
- TypeScript 编译通过 → 只证明静态结构成立；真实飞书连接、卡片回调、CLI 恢复和浏览器验收仍需单独验证。
- `schedule_manage` 在 MCP 子进程中拿不到主进程状态 → 不能直接读写 JSON；通过带会话上下文的本机管理接口交给 `Scheduler`。
