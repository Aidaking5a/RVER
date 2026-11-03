import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { Store } from "../src/store.js";

test("Redis preserves full history, ownership, locks, memory, and recoverable tasks", async () => {
  const redis = createClient({
    url: process.env.REDIS_URL ?? "redis://127.0.0.1:6387",
  });
  await redis.connect();
  const prefix = `rver:test:${randomUUID()}:`;
  const store = new Store(redis, prefix);
  try {
    const session = await store.createSession("alice");
    await assert.rejects(store.session(session.id, "bob"), /not found/i);
    for (let i = 0; i < 4; i++) {
      await store.append(session.id, "alice", [
        { role: "user", content: `Question ${i}` },
        { role: "assistant", content: `Answer ${i}` },
      ]);
    }
    assert.equal((await store.messages(session.id, "alice")).length, 8);
    assert.equal((await store.listSessions("alice"))[0]?.title, "Question 0");
    assert.equal((await store.listSessions("bob")).length, 0);
    await store.lock(session.id, "alice", "run-one", 10000);
    await assert.rejects(
      store.lock(session.id, "alice", "run-two", 10000),
      /busy/i,
    );
    await store.unlock(session.id, "wrong-run");
    await assert.rejects(
      store.lock(session.id, "alice", "run-three", 10000),
      /busy/i,
    );
    await store.unlock(session.id, "run-one");
    await store.lock(session.id, "alice", "run-two", 10000);
    await store.unlock(session.id, "run-two");
    await store.remember("alice", "Use TypeScript for RVER");
    const reopened = new Store(redis, prefix);
    assert.equal(
      (await reopened.memories("alice"))[0]?.text,
      "Use TypeScript for RVER",
    );
    assert.equal((await reopened.memories("bob")).length, 0);
    const task = await store.createTask(
      "alice",
      session.id,
      "Inspect the architecture",
    );
    assert.equal(task.status, "queued");
    await redis.set(store.key("worker"), "first-worker", { PX: 10000 });
    const claimed = await reopened.claimTask("first-worker");
    assert.equal(claimed?.id, task.id);
    assert.equal((await reopened.task(task.id, "alice")).status, "running");
    await redis.set(store.key("worker"), "replacement-worker", { PX: 10000 });
    await reopened.recoverTasks("replacement-worker");
    assert.equal((await store.task(task.id, "alice")).status, "interrupted");
    await assert.rejects(store.task(task.id, "bob"), /not found/i);
    await store.resumeTask(task.id, "alice");
    assert.equal(
      (await store.task(task.id, "alice")).message,
      "Inspect the architecture",
    );
    const replacement = await store.claimTask("replacement-worker");
    assert.equal(replacement?.id, task.id);
    if (!claimed || !replacement) throw new Error("Task claim missing");
    claimed.status = "completed";
    assert.equal(await store.finishTask(claimed, "first-worker"), 0);
    assert.equal(
      (await store.task(task.id, "alice")).attemptId,
      replacement.attemptId,
    );
    assert.equal((await store.task(task.id, "alice")).status, "running");
    const old = [
      { role: "user" as const, content: "Original legacy question" },
      { role: "assistant" as const, content: "Original legacy answer" },
    ];
    const imported = await store.importConversation(
      "alice",
      "old-client-session",
      old,
    );
    assert.equal(imported.imported, true);
    assert.equal(
      (await store.importConversation("alice", "old-client-session", old))
        .imported,
      false,
    );
    assert.deepEqual(await store.messages(imported.id, "alice"), old);
  } finally {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(keys);
    await redis.close();
  }
});
