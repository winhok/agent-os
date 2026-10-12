import { readJsonState } from "./json-state-reader.js";
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
  botId: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  cliId: z.enum(["claude", "codex"]),
  cliSessionId: z.string().min(1).optional(),
  workspaceDir: z.string().min(1),
  status: z.enum(["creating", "active", "idle", "closed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function recoverInterruptedSession(session: Session): Session {
  if (session.status !== "creating" && session.status !== "active") return session;
  return { ...session, status: "idle" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function migrateLegacySession(
  row: unknown,
  legacyBotId: string,
  defaultWorkspaces: Readonly<Record<string, string>>,
): { candidate: unknown; migrated: boolean } {
  if (!isRecord(row)) return { candidate: row, migrated: false };

  const needsBotId = !("botId" in row);
  const needsWorkspace = !("workspaceDir" in row);
  if (!needsBotId && !needsWorkspace) {
    return { candidate: row, migrated: false };
  }

  const candidate: Record<string, unknown> = { ...row };
  if (needsBotId) candidate.botId = legacyBotId;
  const botId = typeof candidate.botId === "string" ? candidate.botId : legacyBotId;
  if (needsWorkspace) {
    candidate.workspaceDir = defaultWorkspaces[botId] ?? process.cwd();
  }
  return { candidate, migrated: true };
}

export class JsonSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly legacyBotId = "default",
    private readonly defaultWorkspaces: Readonly<Record<string, string>> = {},
  ) {}

  async load(): Promise<Session[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const schema = z.preprocess(
      (row) => migrateLegacySession(row, this.legacyBotId, this.defaultWorkspaces).candidate,
      SessionSchema,
    );
    const loaded = readJsonState(content, this.filePath, "会话状态文件", schema, {
      keys: (record) => [`id:${record.id}`, "scope:" + JSON.stringify([record.botId, record.chatId, record.threadId])],
      migrated: (row) => migrateLegacySession(row, this.legacyBotId, this.defaultWorkspaces).migrated,
    });
    const sessions = loaded.records.map(recoverInterruptedSession);
    const recovered = sessions.some((session, index) => session.status !== loaded.records[index]?.status);
    if (loaded.changed || recovered) await this.save(sessions);
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
