# Agent OS

**A self-hosted command layer for running Claude Code and Codex through Feishu (Lark).**

Give a bot a goal in a Feishu thread. Agent OS keeps the CLI session tied to that thread, routes work between configured bot roles, and brings questions, plans, approvals, progress, and results back to Feishu. The work runs on your own machine in the project directory you configure.

[简体中文](README.zh-CN.md)

## What it does

- **Thread-based sessions:** Continue a task in the same thread, start a new session, resume an earlier one, compact context, or switch project directories.
- **Two CLI engines:** Configure Claude Code or Codex as each bot's default engine, or choose one when starting a thread.
- **Team coordination:** A designated team leader can assign work to other configured bots and summarize their results.
- **Decisions in Feishu:** Answer clarification questions, review product plans, and respond to operation approval cards.
- **Product handoff:** Review a Feishu document or a local plan before implementation. With Feishu document delivery, comments can drive revisions to the same document.
- **Scheduled work:** Create one-time, interval, or Cron tasks, then pause, resume, run, or delete them.
- **Local state:** Session metadata, approvals, schedules, and run records stay on the host running Agent OS.

## Get started

### Prerequisites

- Node.js 22+ and pnpm (use the version in [`package.json`](package.json), currently 12.0.0).
- At least one installed and authenticated CLI, `claude` or `codex`, that can run in the target project directory.
- A Feishu custom app with bot capability for each enabled bot. You need its App ID and App Secret.
- For the example product delivery workflow: install the Skills named in the bot configuration separately. Feishu document delivery also requires `lark-cli` and the appropriate user authorization. Listing a Skill in the configuration does not install it.

From the repository root:

```bash
pnpm install
cp -n .env.example .env
cp -n config/bots.example.json config/bots.json
```

### Configure bots and workspaces

Edit `.env` with the App ID and App Secret for each enabled bot. The variable names come from `appIdEnv` and `appSecretEnv` in `config/bots.json`.

The example configuration defines three bots:

| Bot ID          | Role                                                     |
| --------------- | -------------------------------------------------------- |
| `ceo-assistant` | Understand goals, assign work, and summarize results     |
| `product`       | Clarify requirements and prepare the product plan        |
| `developer`     | Implement an approved plan and run its configured checks |

`teamLeader` must name an enabled bot. Set `enabled: false` for a bot you are not using; disabled bots do not need credentials.

| Setting                      | Purpose                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `defaultCli`                 | `claude` or `codex`                                                                 |
| `workspace`                  | Bot's project directory; relative paths resolve from the Agent OS startup directory |
| `role` / `systemPrompt`      | Bot responsibilities and instructions                                               |
| `skills`                     | Names of Skills available to the bot                                                |
| `collaborationMaxRounds`     | Maximum coordination rounds, 1–32 (default: 16)                                     |
| `defaultProductDeliveryMode` | Top-level setting: `lark-doc` or `local` (default: `lark-doc`)                      |

**A bot's `workspace` takes precedence over `CLI_WORKDIR`.** Every example bot has `workspace: "."`, which points to the Agent OS startup directory. Set each bot's `workspace` to your project path, or remove those fields and set `CLI_WORKDIR` for all bots.

Agent OS looks for a named Skill in the target workspace's `.agents/skills/<name>/SKILL.md`, then `.claude/skills/<name>/SKILL.md`, and finally the corresponding user-level or global Skill.

### Connect Feishu

Enable bot capability and the required permissions for each app, set its availability, and add the bots to your group. Select **long connection** for event delivery.

Configure the events and callbacks needed by the features you use:

| Event or callback             | Purpose                           |
| ----------------------------- | --------------------------------- |
| `im.message.receive_v1`       | Receive task messages             |
| `card.action.trigger`         | Handle interactive card actions   |
| `drive.notice.comment_add_v1` | Receive product document comments |

Grant the permissions needed for messaging, card updates, message resources, and document comments. Document delivery also needs the ability to create and edit documents, with access for the relevant users and bots. Check the Feishu developer console for the exact permissions and app publishing requirements.

### Start and try a task

```bash
pnpm build
pnpm start
```

`pnpm start` watches `.env`, `config/*.json`, and source changes and restarts the app. For a background process, see [Run in the background](#run-in-the-background).

In Feishu, mention the team leader and send `/help`. Then start a new thread with a small task, such as “Explain what this project does.” The thread will receive a progress card and a final reply.

## Use it in Feishu

Mention a bot in a new thread to start a task. Reply in the same thread to continue its session. To choose the engine for a new thread, prefix the task:

```text
/codex Analyze this project's structure and explain how to start it
/claude Review the current changes and list issues to fix
```

A bot receiving delegated work uses its own configured default engine.

| Command                   | Action                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `/help`                   | Show available commands                                     |
| `/status`                 | Show the current session status                             |
| `/team`                   | Show team members and capabilities                          |
| `/new`                    | Start a new CLI session; the previous one remains available |
| `/resume`                 | Select a previous session in the current workspace          |
| `/compact [instructions]` | Compact the current session context                         |
| `/cd [path]`              | Show or change the workspace                                |
| `/close`                  | Close the current session                                   |
| `/schedules`              | List scheduled tasks                                        |
| `/schedule <request>`     | Manage scheduled tasks in natural language                  |

After changing the workspace, the next task starts a new session. To continue an earlier task, switch back to its workspace and use `/resume`.

### Review a product plan

The default `lark-doc` workflow is:

```text
Your goal → team leader assigns work → product bot prepares a Feishu document
→ you comment and approve → product bot creates local Spec/Tickets from the approved version
→ developer bot implements → team leader summarizes
```

Comment on the Feishu product document and approve the final plan there. The local Spec/Tickets generated afterward are for the bots to execute and do not require a second approval. Explanation and analysis tasks do not require a product plan approval.

With `local` delivery, the product bot creates local Spec/Tickets before requesting plan approval. You can also specify a delivery mode in your task to override the default.

### Schedule a task

For example, send:

```text
/schedule Every weekday at 9 AM, ask ceo-assistant to summarize this project's open tasks
/schedules
```

Scheduled tasks run in the selected bot's workspace. Agent OS must be running when a task is due, and the bot's CLI must be available. Use the ID shown by `/schedules` to manage a task:

```text
/schedule pause <id>
/schedule resume <id>
/schedule run <id>
/schedule delete <id>
```

## Configuration reference

See [`.env.example`](.env.example) for the full environment variable template.

| Variable                                  | Purpose                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `BOTS_CONFIG`                             | Bot configuration file (default: `config/bots.json`)                          |
| `FEISHU_*_APP_ID` / `FEISHU_*_APP_SECRET` | Example credential variables; actual names come from the bot configuration    |
| `CLI_WORKDIR`                             | Workspace used when a bot has no `workspace`                                  |
| `CLAUDE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS`  | Per-CLI timeout in milliseconds; the template sets both to 7,200,000          |
| `CLI_TIMEOUT_MS`                          | Fallback when a per-CLI timeout is unset                                      |
| `SCHEDULE_API_PORT`                       | Schedule management API port (default: 3101)                                  |
| `SCHEDULE_API_TOKEN`                      | If set, requests must include it in `x-api-token`; empty means no token check |

## Run in the background

You can use PM2 to run the compiled application:

```bash
npm install -g pm2
pnpm agent-os doctor
pnpm build
pnpm agent-os start
pnpm agent-os status
```

`doctor` checks CLI versions and the presence of configuration files; it does not verify CLI authentication or a Feishu connection.

After updating Agent OS, build before restarting:

```bash
pnpm build
pnpm agent-os restart
```

`start` builds automatically only if `dist/index.js` is missing. `restart` does not build. For process logs and shutdown:

```bash
pnpm agent-os logs
pnpm agent-os stop
```

You can also run `pnpm start:prod` after building to start `dist/index.js` directly.

## Permissions and backups

Agent OS starts Claude Code and Codex without their per-action permission prompts. They can edit files and run commands within the operating system account's access. Feishu approval cards are part of the workflow; they do not replace operating system access controls. Run Agent OS under an appropriate account and point bots only at projects you intend them to work on.

Restrict access to the schedule management port and set `SCHEDULE_API_TOKEN` in `.env`, especially if the port can be reached from another machine.

Back up these locations when moving to another host:

- `.env` and `config/bots.json`: credentials and bot settings. Keep them private.
- `data/`: sessions, approvals, schedules, run records, and downloaded attachments in `data/downloads/`.
- Each bot's workspace: documents, code, and other task outputs.

Restoring old conversations also depends on the sessions stored by Claude Code or Codex. Copying only Agent OS's `data/` is not enough to migrate conversation history.

## Troubleshooting

**The bot still works in the old directory after changing `CLI_WORKDIR`.** Check its `workspace`; that setting takes precedence. The example's `workspace: "."` is the Agent OS startup directory.

**The old version still runs after an update.** Run `pnpm build`, then `pnpm agent-os restart`. Restarting alone does not recompile the application.

**Will a task finish automatically after a restart?** A restart does not imply completion. Check `/status`, the bot's replies, and the actual outputs before continuing in the original thread.

**A task card has stopped updating.** Check `pnpm agent-os status` and `pnpm agent-os logs`. The task may have finished even if the result card failed to send. Check replies and outputs before retrying to avoid duplicate work.
