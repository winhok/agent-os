import { cac } from "cac";
import { existsSync } from "node:fs";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

const cli = cac("agent-os");

function runCommandSync(command: string, args: string[], options: SpawnSyncOptions = {}) {
  if (process.platform === "win32") {
    return spawnSync(command, args, { ...options, shell: true });
  }
  return spawnSync(command, args, options);
}

function run(parts: string[]): void {
  const result = runCommandSync(parts[0], parts.slice(1), { stdio: "inherit" });
  if (result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status}`;
    console.error(`[agent-os] 命令执行失败: ${parts[0]} ${reason}`);
    process.exit(result.status ?? 1);
  }
}

function output(parts: string[]): string {
  const result = runCommandSync(parts[0], parts.slice(1), { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

function ensureBuild(): void {
  if (existsSync("dist/index.js")) return;
  console.log("[agent-os] 未找到 dist/index.js，先执行 pnpm build");
  run(["pnpm", "build"]);
}

function requirePm2(): void {
  if (!output(["pm2", "-v"])) {
    console.error("[agent-os] pm2 未安装，请先执行 npm install -g pm2");
    process.exit(1);
  }
}

function requireConfig(): void {
  const missing: string[] = [];
  if (!existsSync(".env")) missing.push(".env");
  if (!existsSync("config/bots.json")) missing.push("config/bots.json");
  if (missing.length) {
    console.error(`[agent-os] 缺少运行配置: ${missing.join(", ")}`);
    console.error("[agent-os] 请先从开发环境复制 .env 和 config/bots.json 到当前目录");
    process.exit(1);
  }
}

function localDoctor(): void {
  const checks: Array<[string, string[]]> = [
    ["node", ["-v"]],
    ["pnpm", ["-v"]],
    ["pm2", ["-v"]],
    ["claude", ["--version"]],
    ["codex", ["--version"]],
  ];
  for (const [name, checkArgs] of checks) {
    const value = output([name, ...checkArgs]);
    console.log(`${name}: ${value || "未安装"}`);
  }
  console.log(`.env: ${existsSync(".env") ? "存在" : "缺失"}`);
  console.log(`config/bots.json: ${existsSync("config/bots.json") ? "存在" : "缺失"}`);
}

function localStart(): void {
  requirePm2();
  requireConfig();
  ensureBuild();
  const running = runCommandSync("pm2", ["describe", "agent-os"], { stdio: "ignore" }).status === 0;
  if (running) {
    run(["pm2", "restart", "agent-os"]);
  } else {
    run(["pm2", "start", "dist/index.js", "--name", "agent-os"]);
  }
  run(["pm2", "save"]);
}

cli.command("doctor", "检查本地环境与 CLI 凭证").action(localDoctor);
cli.command("start", "本地生产启动").action(localStart);
cli.command("stop", "停止本地进程").action(() => {
  requirePm2();
  run(["pm2", "stop", "agent-os"]);
});
cli.command("restart", "重启本地进程").action(() => {
  requirePm2();
  run(["pm2", "restart", "agent-os"]);
});
cli.command("status", "查看本地进程状态").action(() => {
  requirePm2();
  run(["pm2", "status"]);
});
cli.command("logs", "查看本地进程日志").action(() => {
  requirePm2();
  run(["pm2", "logs", "agent-os"]);
});

cli.help();
cli.parse();
