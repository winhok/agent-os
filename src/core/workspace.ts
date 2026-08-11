import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export function resolveWorkspacePath(input: string, baseDirectory = process.cwd()): string {
  const value = input.trim();
  if (!value) throw new Error("工作目录不能为空");
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

export async function ensureWorkspaceDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`工作目录不存在: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹: ${path}`);
}
