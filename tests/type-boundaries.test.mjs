import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeAdapter } from "../src/cli/claude-adapter.ts";
import { CodexAdapter } from "../src/cli/codex-adapter.ts";
import { extractResourceKeys, parseMentions, resolveMentions } from "../src/im/message-parser.ts";
import {
  JsonScheduleStore,
  ScheduleStore,
  ScheduledTaskSchema as StoreTaskSchema,
} from "../src/core/schedule-store.ts";
import { ScheduledTaskSchema } from "../src/core/schedule.ts";
import { Scheduler } from "../src/app/scheduler.ts";

const taskOptions = {
  creatorOpenId: "owner",
  chatId: "chat",
  targetBotId: "bot",
  prompt: "sample task",
  rule: { kind: "interval", everyMs: 60_000 },
};

for (const adapter of [new ClaudeAdapter(), new CodexAdapter()]) {
  test(`${adapter.id}: malformed JSON and non-object frames are ignored`, () => {
    for (const line of ["{", "null", "[]", "[{}]", '"text"', "42", "true", "{}"]) {
      assert.deepEqual(adapter.parseEvents(line), [], line);
    }
  });
}

test("valid session and tool events retain their normalized payloads", () => {
  const claude = new ClaudeAdapter();
  const codex = new CodexAdapter();
  assert.deepEqual(claude.parseEvents('{"type":"system","subtype":"init","session_id":"session"}'), [
    { type: "session", sessionId: "session" },
  ]);
  assert.deepEqual(codex.parseEvents('{"type":"thread.started","thread_id":"session"}'), [
    { type: "session", sessionId: "session" },
  ]);
  const input = { title: "Clarify", questions: [] };
  const events = claude.parseEvents(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call", name: "mcp__agent_os__request_clarification", input }] },
    }),
  );
  assert.deepEqual(
    events.find((event) => event.type === "tool_call"),
    {
      type: "tool_call",
      toolUseId: "call",
      toolName: "request_clarification",
      input,
    },
  );
});

test("mentions validate string fields and preserve valid names and IDs", () => {
  for (const value of [undefined, null, {}, "mentions"]) assert.deepEqual(parseMentions(value), []);
  const mentions = parseMentions([
    null,
    { key: 1, id: { open_id: 2 } },
    { key: "" },
    { key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } },
    { key: "@_user_2", name: 3, id: { open_id: 4 } },
  ]);
  assert.deepEqual(mentions, [
    { key: "@_user_1", name: "Bot", openId: "ou_bot" },
    { key: "@_user_2", name: "", openId: "" },
  ]);
  assert.equal(resolveMentions("Hello @_user_1", mentions), "Hello @Bot");
});

test("resource parsing ignores malformed shapes and invalid key types", () => {
  for (const content of ["{", "null", "[]", "42", '{"image_key":123}', '{"image_key":""}']) {
    assert.deepEqual(extractResourceKeys("image", content), []);
  }
  assert.deepEqual(extractResourceKeys("file", '{"file_key":"file","file_name":123}'), [{ type: "file", key: "file" }]);
  assert.deepEqual(extractResourceKeys("post", '{"content":{}}'), []);
  assert.deepEqual(
    extractResourceKeys(
      "post",
      JSON.stringify({
        content: [null, { tag: "img", image_key: "wrong-paragraph" }, [null, { tag: "img", image_key: 123 }]],
      }),
    ),
    [],
  );
});

test("valid image, file and rich-text resources remain downloadable", () => {
  assert.deepEqual(extractResourceKeys("image", '{"image_key":"image"}'), [{ type: "image", key: "image" }]);
  assert.deepEqual(extractResourceKeys("file", '{"file_key":"file","file_name":"report.pdf"}'), [
    { type: "file", key: "file", fileName: "report.pdf" },
  ]);
  assert.deepEqual(
    extractResourceKeys(
      "post",
      JSON.stringify({
        content: [
          [
            { tag: "text", text: "Hi" },
            { tag: "img", image_key: "image" },
          ],
        ],
      }),
    ),
    [{ type: "image", key: "image" }],
  );
});

test("task updates reject immutable fields and invalid required fields without mutating memory", () => {
  const store = new ScheduleStore();
  const task = store.create(taskOptions);
  const original = structuredClone(task);
  for (const patch of [
    { id: "changed" },
    { createdAt: "changed" },
    { updatedAt: "changed" },
    { rule: undefined },
    { prompt: undefined },
    { status: undefined },
    { chatId: undefined },
    { prompt: "" },
    { status: "invalid" },
    { rule: { kind: "interval", everyMs: 1 } },
  ]) {
    assert.throws(() => store.update(task.id, patch));
    assert.deepEqual(store.get(task.id), original);
  }
});

test("valid updates preserve identity, support timezone defaults and clear optional runtime timestamps", () => {
  assert.equal(StoreTaskSchema, ScheduledTaskSchema);
  const store = new ScheduleStore();
  const task = store.create(taskOptions);
  const updated = store.update(task.id, {
    prompt: "updated",
    status: "paused",
    rule: { kind: "cron", expression: "0 9 * * *" },
    nextRunAt: "2026-10-01T01:00:00Z",
    lastRunAt: "2026-09-29T01:00:00Z",
  });
  assert.equal(updated.id, task.id);
  assert.equal(updated.createdAt, task.createdAt);
  assert.equal(updated.prompt, "updated");
  assert.equal(updated.rule.timezone, "Asia/Shanghai");
  const cleared = store.update(task.id, { nextRunAt: undefined });
  assert.equal(cleared.nextRunAt, undefined);
  assert.equal(cleared.lastRunAt, "2026-09-29T01:00:00Z");
  assert.equal(ScheduledTaskSchema.safeParse(cleared).success, true);
});

test("rejected updates preserve JSON on disk and valid changes survive reload", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-os-schedule-types-"));
  try {
    const path = join(directory, "schedules.json");
    const store = new JsonScheduleStore(path);
    const task = store.create(taskOptions);
    const original = readFileSync(path, "utf8");
    assert.throws(() => store.update(task.id, { rule: undefined }));
    assert.equal(readFileSync(path, "utf8"), original);
    assert.deepEqual(new JsonScheduleStore(path).get(task.id), task);
    store.update(task.id, { prompt: "persisted", status: "paused" });
    assert.equal(new JsonScheduleStore(path).get(task.id).prompt, "persisted");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Scheduler rejects runtime timestamp patches and still reschedules valid updates", () => {
  const store = new ScheduleStore();
  const task = store.create(taskOptions);
  const scheduler = new Scheduler({
    scheduleStore: store,
    runtime: {},
    runStore: {},
    defaultProductDeliveryMode: "local",
  });
  try {
    assert.throws(() => scheduler.update(task.id, { nextRunAt: "forged" }));
    assert.throws(() => scheduler.update(task.id, { rule: undefined }));
    assert.equal(store.get(task.id).nextRunAt, undefined);
    const updated = scheduler.update(task.id, { prompt: "scheduled" });
    assert.equal(updated.prompt, "scheduled");
    assert.equal(typeof store.get(task.id).nextRunAt, "string");
    assert.equal(scheduler.pause(task.id).status, "paused");
    assert.equal(scheduler.resume(task.id).status, "active");
  } finally {
    scheduler.stop();
  }
});
