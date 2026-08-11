import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Session } from "./session-manager.js";

export interface SessionStore {
  load(): Promise<Session[]>;
  save(sessions: Session[]): Promise<void>;
}

const SessionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  cliId: z.enum(["claude", "codex"]),
  cliSessionId: z.string().min(1).optional(),
  status: z.enum(["creating", "active", "idle", "closed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function recoverInterruptedSession(session: Session): Session {
  if (session.status !== "creating" && session.status !== "active") return session;
  return { ...session, status: "idle" };
}

export class JsonSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<Session[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`会话文件格式错误: ${this.filePath}`);
    }

    const sessions: Session[] = [];
    let needsCleanup = false;
    for (const row of rows) {
      const result = SessionSchema.safeParse(row);
      if (!result.success) {
        needsCleanup = true;
        continue;
      }

      const recovered = recoverInterruptedSession(result.data);
      if (recovered.status !== result.data.status) needsCleanup = true;
      sessions.push(recovered);
    }
    if (needsCleanup) await this.save(sessions);
    return sessions;
  }

  save(sessions: Session[]): Promise<void> {
    const snapshot = JSON.stringify(sessions, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${snapshot}\n`, "utf8");
      await rename(tempPath, this.filePath);
    };

    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
