import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startScheduleApi } from "../src/app/schedule-api.ts";
import { Scheduler } from "../src/app/scheduler.ts";
import { JsonSessionStore } from "../src/core/session-store.ts";
import { JsonScheduleStore, ScheduleStore } from "../src/core/schedule-store.ts";
import { JsonScheduleRunStore, ScheduleRunStore } from "../src/core/schedule-run-store.ts";
import { JsonApprovalFlowStore } from "../src/core/approval-store.ts";
import { JsonProductSpecFlowStore } from "../src/core/product-spec-store.ts";

const taskOptions = {
  creatorOpenId: "owner",
  chatId: "chat",
  targetBotId: "bot",
  prompt: "task",
  rule: { kind: "interval", everyMs: 60_000 },
};

function setup(now = () => new Date()) {
  const store = new ScheduleStore();
  const runs = new ScheduleRunStore();
  const scheduler = new Scheduler({
    runtime: {},
    scheduleStore: store,
    runStore: runs,
    defaultProductDeliveryMode: "local",
    now,
  });
  return { store, runs, scheduler };
}

test("API works without an optional token on loopback", async () => {
  const { store, runs, scheduler } = setup();
  const server = startScheduleApi({ scheduler, scheduleStore: store, runStore: runs, port: 0 });
  await once(server, "listening");
  try {
    const address = server.address();
    assert.equal(address.address, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/schedules/manage`, {
      method: "POST",
      body: JSON.stringify({ request: { action: "list" }, chatId: "chat", creatorOpenId: "owner" }),
    });
    assert.equal(response.status, 200);
  } finally {
    scheduler.stop();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("API binds loopback, authenticates and validates complete request bodies", async () => {
  const { store, runs, scheduler } = setup();
  const server = startScheduleApi({ scheduler, scheduleStore: store, runStore: runs, port: 0, token: "test-token" });
  assert.ok(server);
  await once(server, "listening");
  const address = server.address();
  assert.equal(address.address, "127.0.0.1");
  const url = `http://127.0.0.1:${address.port}/api/schedules`;
  const post = (body, path = "/manage") =>
    fetch(url + path, { method: "POST", headers: { "x-api-token": "test-token" }, body });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { "x-api-token": "wrong" } })).status, 401);
    assert.equal((await post("{")).status, 400);
    assert.equal((await post("null")).status, 400);
    assert.equal(
      (await post(JSON.stringify({ request: { action: "list" }, chatId: 42, creatorOpenId: {} }))).status,
      400,
    );
    assert.equal((await post("x".repeat(512 * 1024 + 1))).status, 413);
    assert.equal(
      (await post(JSON.stringify({ request: { action: "list" }, chatId: "chat", creatorOpenId: "owner" }))).status,
      200,
    );
    assert.equal((await post(JSON.stringify(taskOptions), "")).status, 201);
    assert.equal(store.list().length, 1);
    assert.equal(
      (
        await fetch(url + "/" + store.list()[0].id, {
          method: "PATCH",
          headers: { "x-api-token": "test-token" },
          body: "null",
        })
      ).status,
      400,
    );
  } finally {
    scheduler.stop();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("API accepts full prompt batches and enforces business and byte limits separately", async () => {
  const { store, runs, scheduler } = setup();
  const server = startScheduleApi({ scheduler, scheduleStore: store, runStore: runs, port: 0 });
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/schedules/manage`;
  const post = (body) => fetch(url, { method: "POST", body });
  const batch = (prompt, count = 20) => ({
    request: {
      action: "addMany",
      schedules: Array.from({ length: count }, () => ({
        targetBotId: "bot",
        prompt,
        rule: taskOptions.rule,
      })),
    },
    chatId: "chat",
    creatorOpenId: "owner",
  });
  try {
    const prompt = "中".repeat(2_000);
    const body = JSON.stringify(batch(prompt));
    assert.ok(Buffer.byteLength(body) > 64 * 1024);
    assert.equal((await post(body)).status, 200);
    assert.equal(store.list().length, 20);
    assert.ok(store.list().every((task) => task.prompt === prompt));

    // Equivalent JSON may encode each Chinese character using six ASCII bytes.
    const escaped = body.replaceAll("中", "\\u4e2d");
    assert.ok(Buffer.byteLength(escaped) > 240_000);
    assert.equal((await post(escaped)).status, 200);
    assert.equal(store.list().length, 40);
    assert.ok(store.list().every((task) => task.prompt === prompt));

    assert.equal((await post(JSON.stringify(batch("中".repeat(2_001))))).status, 400);
    assert.equal((await post(JSON.stringify(batch(prompt, 21)))).status, 400);
    assert.equal(store.list().length, 40);

    // JSON trailing whitespace exercises the transport limit without changing its meaning.
    const list = JSON.stringify({ request: { action: "list" }, chatId: "chat", creatorOpenId: "owner" });
    const atLimit = list + " ".repeat(512 * 1024 - Buffer.byteLength(list));
    assert.equal(Buffer.byteLength(atLimit), 512 * 1024);
    assert.equal((await post(atLimit)).status, 200);
    assert.equal((await post(atLimit + " ")).status, 413);
    assert.equal(store.list().length, 40);
  } finally {
    scheduler.stop();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("long once and sparse cron waits are chunked without firing early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-01-01T00:00:00Z") });
  const waits = [];
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    waits.push(delay);
    return setTimer(callback, delay, ...args);
  });
  for (const rule of [
    { kind: "once", runAt: "2026-02-10T00:00:00Z" },
    { kind: "cron", expression: "0 0 10 2 *", timezone: "UTC" },
  ]) {
    const { store, scheduler } = setup();
    let executions = 0;
    scheduler.trigger = async () => {
      executions++;
    };
    const task = scheduler.create({ ...taskOptions, rule });
    assert.equal(store.get(task.id).nextRunAt, "2026-02-10T00:00:00.000Z");
    t.mock.timers.tick(2_147_483_647);
    assert.equal(executions, 0);
    assert.equal(store.get(task.id).nextRunAt, "2026-02-10T00:00:00.000Z");
    t.mock.timers.tick(40 * 86400000 - 2_147_483_647);
    await Promise.resolve();
    assert.equal(executions, 1);
    assert.ok(waits.every((delay) => delay > 0 && delay <= 2_147_483_647));
    scheduler.stop();
    t.mock.timers.setTime(Date.parse("2026-01-01T00:00:00Z"));
  }
});

test("completion cannot overwrite edits, pause/resume or deletion made during a run", async () => {
  for (const change of [
    (s, id) => s.update(id, { rule: { kind: "interval", everyMs: 60000 } }),
    (s, id) => s.update(id, { rule: { kind: "once", runAt: new Date(Date.now() + 86400000).toISOString() } }),
    (s, id) => s.pause(id),
    (s, id) => {
      s.pause(id);
      s.resume(id);
    },
    (s, id) => s.delete(id),
  ]) {
    const { store, scheduler } = setup();
    const task = scheduler.create({
      ...taskOptions,
      rule: { kind: "once", runAt: new Date(Date.now() + 60000).toISOString() },
    });
    let release;
    scheduler.trigger = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const due = scheduler.onDue(task);
    change(scheduler, task.id);
    const edited = structuredClone(store.get(task.id));
    release();
    await due;
    assert.deepEqual(store.get(task.id), edited);
    scheduler.stop();
  }
});

test("normal once completion and interval rescheduling still work", async () => {
  for (const rule of [taskOptions.rule, { kind: "once", runAt: new Date(Date.now() + 60000).toISOString() }]) {
    const { store, scheduler } = setup();
    const task = scheduler.create({ ...taskOptions, rule });
    scheduler.trigger = async () => {
      store.update(task.id, { lastRunAt: new Date().toISOString() });
    };
    await scheduler.onDue(task);
    assert.equal(store.get(task.id).status, rule.kind === "once" ? "completed" : "active");
    assert.ok(store.get(task.id).lastRunAt);
    scheduler.stop();
  }
});

test("revision survives reload, advances for plan changes and rejects caller patches", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-os-revision-"));
  try {
    const path = join(directory, "schedules.json");
    const store = new JsonScheduleStore(path);
    const task = store.create(taskOptions);
    assert.equal(task.revision, 0);
    store.update(task.id, { lastRunAt: "now" });
    assert.equal(store.get(task.id).revision, 0);
    store.update(task.id, { prompt: "edited" });
    assert.equal(new JsonScheduleStore(path).get(task.id).revision, 1);
    assert.throws(() => store.update(task.id, { revision: 99 }));
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy[0].revision;
    writeFileSync(path, JSON.stringify(legacy));
    assert.equal(new JsonScheduleStore(path).get(task.id).revision, 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8"))[0].revision, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid rows are reported and backed up while valid state and migrations load", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const directory = mkdtempSync(join(tmpdir(), "agent-os-corrupt-"));
  try {
    const session = {
      id: "session",
      botId: "bot",
      threadId: "thread",
      chatId: "chat",
      cliId: "codex",
      workspaceDir: "/tmp",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const path = join(directory, "sessions.json");
    const original = JSON.stringify([session, { ...session, id: "bad", cliId: "invalid" }]);
    writeFileSync(path, original);
    const sessions = new JsonSessionStore(path);
    assert.equal((await sessions.load())[0].status, "idle");
    assert.ok(logs.some((log) => log.includes(path) && /第 2 条.*cliId/.test(log)));
    const backups = () => readdirSync(directory).filter((name) => name.includes(".corrupt-"));
    const originalBackup = backups().find((name) => readFileSync(join(directory, name), "utf8") === original);
    assert.ok(originalBackup);
    await sessions.save([]);
    assert.equal(readFileSync(join(directory, originalBackup), "utf8"), original);
    for (const Store of [JsonScheduleStore, JsonScheduleRunStore, JsonApprovalFlowStore, JsonProductSpecFlowStore]) {
      writeFileSync(path, "[{}]");
      assert.doesNotThrow(() => new Store(path));
      assert.ok(logs.some((log) => log.includes(path) && /第 1 条/.test(log)));
      assert.ok(backups().some((name) => readFileSync(join(directory, name), "utf8") === "[{}]"));
      for (const damaged of ["{", "{}"]) {
        writeFileSync(path, damaged);
        assert.doesNotThrow(() => new Store(path));
        assert.ok(backups().some((name) => readFileSync(join(directory, name), "utf8") === damaged));
      }
    }
    for (const damaged of ["{", "{}"]) {
      writeFileSync(path, damaged);
      assert.deepEqual(await new JsonSessionStore(path).load(), []);
      assert.ok(backups().some((name) => readFileSync(join(directory, name), "utf8") === damaged));
    }
    const schedulesPath = join(directory, "schedules.json");
    const seed = new JsonScheduleStore(schedulesPath);
    const task = seed.create(taskOptions);
    const damagedSchedules = JSON.stringify([task, { id: "bad" }]);
    writeFileSync(schedulesPath, damagedSchedules);
    const recoveredStore = new JsonScheduleStore(schedulesPath);
    assert.equal(recoveredStore.list().length, 1);
    recoveredStore.update(task.id, { prompt: "updated" });
    assert.equal(new JsonScheduleStore(schedulesPath).get(task.id).prompt, "updated");
    assert.ok(backups().some((name) => readFileSync(join(directory, name), "utf8") === damagedSchedules));
    writeFileSync(path, JSON.stringify([session]));
    assert.equal((await new JsonSessionStore(path).load())[0].status, "idle");
    const legacy = { ...session };
    delete legacy.botId;
    delete legacy.workspaceDir;
    writeFileSync(path, JSON.stringify([legacy]));
    const migrated = (await new JsonSessionStore(path, "bot", { bot: "/tmp/project" }).load())[0];
    assert.equal(migrated.workspaceDir, "/tmp/project");
    assert.equal(migrated.botId, "bot");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
