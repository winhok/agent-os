import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { LocalProductSpecRequest } from "../core/product-spec.js";

export async function assertProductSpecDocuments(
  workspaceDir: string,
  request: LocalProductSpecRequest,
): Promise<void> {
  const missing: string[] = [];

  try {
    const info = await stat(resolve(workspaceDir, request.specPath));
    if (!info.isFile()) missing.push(`Spec: ${request.specPath}`);
  } catch {
    missing.push(`Spec: ${request.specPath}`);
  }

  try {
    const ticketsDir = resolve(workspaceDir, request.ticketsPath);
    const info = await stat(ticketsDir);
    const entries = info.isDirectory() ? await readdir(ticketsDir, { withFileTypes: true }) : [];
    const hasTicket = entries.some((entry) => entry.isFile() && entry.name.endsWith(".md"));
    if (!info.isDirectory() || !hasTicket) {
      missing.push(`Tickets: ${request.ticketsPath}`);
    }
  } catch {
    missing.push(`Tickets: ${request.ticketsPath}`);
  }

  if (missing.length) {
    throw new Error(["产品方案尚未完整写入工作区，不能展示。", ...missing.map((item) => `- ${item}`)].join("\n"));
  }
}
