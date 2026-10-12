import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { z } from "zod";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Known fields come from validation; unrecognized persisted fields remain opaque data.
export function preserveJsonFields<T>(original: unknown, validated: T): T {
  if (Array.isArray(original) && Array.isArray(validated)) {
    return validated.map((value, index) => preserveJsonFields(original[index], value)) as T;
  }
  if (!isObject(original) || !isObject(validated)) return validated;
  return Object.fromEntries([
    ...Object.entries(original),
    ...Object.entries(validated).map(([key, value]) => [key, preserveJsonFields(original[key], value)]),
  ]) as T;
}

// Preserve the exact source before excluding damaged records from live state.
export function readJsonState<T>(
  content: string,
  filePath: string,
  label: string,
  schema: z.ZodType<T>,
  options: {
    keys: (record: T) => string[];
    migrated?: (row: unknown) => boolean;
  },
): { records: T[]; changed: boolean } {
  let backupPath: string | undefined;
  const report = (detail: string) => {
    if (!backupPath) {
      backupPath = `${filePath}.corrupt-${randomUUID()}.bak`;
      writeFileSync(backupPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    console.error(`[状态恢复] ${label} ${filePath} ${detail}；已跳过，请检查。原始文件备份：${backupPath}`);
  };
  let rows: unknown;
  try {
    rows = JSON.parse(content);
  } catch {
    report("不是合法 JSON");
    return { records: [], changed: true };
  }
  if (!Array.isArray(rows)) {
    report("顶层必须是数组");
    return { records: [], changed: true };
  }
  const records: T[] = [];
  let changed = false;
  const seen = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const result = schema.safeParse(row);
    if (!result.success) {
      report(
        `第 ${index + 1} 条不合法：${result.error.issues.map((issue) => issue.path.join(".") || "记录").join("、")}`,
      );
      changed = true;
      continue;
    }
    const keys = options.keys(result.data);
    const duplicate = keys.find((key) => seen.has(key));
    if (duplicate !== undefined) {
      report(`第 ${index + 1} 条标识重复，与第 ${seen.get(duplicate)} 条冲突，保留首次有效记录`);
      changed = true;
      continue;
    }
    for (const key of keys) seen.set(key, index + 1);
    records.push(preserveJsonFields(row, result.data));
    if (options.migrated?.(row)) changed = true;
  }
  return { records, changed };
}
