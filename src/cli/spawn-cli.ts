import { spawn, type ChildProcess, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export function killCli(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform !== "win32") {
    child.kill(signal);
    return;
  }
  spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ["ignore", "pipe", "pipe"] },
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: SpawnOptions["stdio"] },
): ChildProcessByStdio<any, any, any> {
  if (process.platform !== "win32") {
    return spawn(command, args, options);
  }
  return spawn(command, args, {
    ...options,
    shell: true,
    windowsHide: true,
  });
}
