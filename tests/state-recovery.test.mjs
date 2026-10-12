import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonScheduleStore } from "../src/core/schedule-store.ts";
import { JsonSessionStore } from "../src/core/session-store.ts";
import { JsonScheduleRunStore } from "../src/core/schedule-run-store.ts";
import { JsonApprovalFlowStore } from "../src/core/approval-store.ts";
import { JsonProductSpecFlowStore } from "../src/core/product-spec-store.ts";

const task = {
  id: "task",
  creatorOpenId: "owner",
  chatId: "chat",
  targetBotId: "bot",
  prompt: "first",
  rule: { kind: "interval", everyMs: 60000, extra: { keep: true } },
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  extra: { nested: [1, { keep: true }] },
};
const session = {
  id: "session",
  threadId: "thread",
  chatId: "chat",
  cliId: "codex",
  status: "active",
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  extra: task.extra,
};

test("legacy migrations and subsequent saves retain opaque fields without rewriting current data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-preserve-"));
  try {
    const path = join(dir, "schedules.json");
    writeFileSync(path, JSON.stringify([task]));
    const store = new JsonScheduleStore(path);
    assert.equal(JSON.parse(readFileSync(path))[0].revision, 0);
    store.update(task.id, { prompt: "edited", nextRunAt: undefined });
    const saved = JSON.parse(readFileSync(path))[0];
    assert.deepEqual(saved.extra, task.extra);
    assert.deepEqual(saved.rule.extra, task.rule.extra);
    assert.equal(saved.prompt, "edited");
    assert.equal(saved.revision, 1);
    assert.equal("nextRunAt" in saved, false);
    // Different key ordering and extra fields alone must not trigger migration writes.
    const reordered = JSON.stringify([{ extra: task.extra, ...saved }]);
    writeFileSync(path, reordered);
    new JsonScheduleStore(path);
    assert.equal(readFileSync(path, "utf8"), reordered);
    const sessionPath = join(dir, "sessions.json");
    writeFileSync(sessionPath, JSON.stringify([session]));
    const sessions = new JsonSessionStore(sessionPath, "bot", { bot: "/tmp/project" });
    const loaded = await sessions.load();
    assert.equal(loaded[0].botId, "bot");
    assert.equal(loaded[0].status, "idle");
    await sessions.save(loaded.map((row) => ({ ...row, status: "closed" })));
    assert.deepEqual(JSON.parse(readFileSync(sessionPath))[0].extra, session.extra);
    assert.equal(
      readdirSync(dir).some((name) => name.endsWith(".bak")),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all stores back up duplicate identities, log positions and keep the first valid record", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-duplicates-"));
  const logs = [];
  t.mock.method(console, "error", (message) => logs.push(message));
  const flow = {
    token: "private-token",
    taskId: "task",
    botId: "bot",
    sessionId: "session",
    ownerOpenId: "owner",
    status: "pending",
    extra: task.extra,
  };
  const approval = {
    ...flow,
    originalMessageId: "message",
    replyInThread: true,
    expiresAt: task.createdAt,
    request: { operation: "test", detail: "detail", impact: "impact", rollback: "rollback" },
  };
  const spec = {
    ...flow,
    request: {
      deliveryMode: "local",
      title: "title",
      summary: "summary",
      specPath: "spec.md",
      ticketsPath: "tickets.md",
    },
  };
  const run = {
    id: "run",
    scheduleId: "task",
    scheduledFor: task.createdAt,
    startedAt: task.createdAt,
    status: "running",
    extra: task.extra,
  };
  const fixtures = [
    [
      "schedule",
      task,
      { ...task, prompt: "second" },
      (p) => new JsonScheduleStore(p),
      (s) => s.get("task"),
      (s) => s.update("task", { prompt: "updated" }),
    ],
    [
      "approval",
      approval,
      approval,
      (p) => new JsonApprovalFlowStore(p),
      (s) => s.get(flow.token),
      (s) => s.resolve(flow.token, "rejected"),
    ],
    [
      "spec",
      spec,
      spec,
      (p) => new JsonProductSpecFlowStore(p),
      (s) => s.get(flow.token),
      (s) => s.approve(flow.token),
    ],
    ["run", run, run, (p) => new JsonScheduleRunStore(p), (s) => s.list("task")[0], (s) => s.markFailed("run", "test")],
    [
      "run-scope",
      run,
      { ...run, id: "other-run" },
      (p) => new JsonScheduleRunStore(p),
      (s) => s.list("task")[0],
      (s) => s.markFailed("run", "test"),
    ],
  ];
  try {
    for (const [name, first, duplicate, open, get, mutate] of fixtures) {
      const path = join(dir, name + ".json");
      const original = JSON.stringify([first, duplicate]);
      writeFileSync(path, original);
      const store = open(path);
      assert.deepEqual(get(store).extra, first.extra);
      assert.ok(logs.some((message) => message.includes(path) && /第 2 条.*第 1 条/.test(message)));
      mutate(store);
      assert.equal(JSON.parse(readFileSync(path)).length, 1);
      const backup = readdirSync(dir).find((file) => file.startsWith(name + ".json.corrupt-"));
      assert.equal(readFileSync(join(dir, backup), "utf8"), original);
    }
    for (const duplicate of [
      { ...session, threadId: "other" },
      { ...session, id: "other" },
    ]) {
      const path = join(dir, "sessions-" + duplicate.id + ".json");
      const original = JSON.stringify([session, duplicate]);
      writeFileSync(path, original);
      const loaded = await new JsonSessionStore(path, "bot", { bot: "/tmp/project" }).load();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, session.id);
      assert.ok(logs.some((message) => message.includes(path) && /第 2 条.*第 1 条/.test(message)));
      const backup = readdirSync(dir).find((file) => file.startsWith("sessions-" + duplicate.id + ".json.corrupt-"));
      assert.equal(readFileSync(join(dir, backup), "utf8"), original);
    }
    assert.ok(logs.every((message) => !message.includes(flow.token)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
