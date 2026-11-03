import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connectRedis } from "../src/redis.js";
import { Store } from "../src/store.js";
import { Agent } from "../src/agent.js";
import { TaskWorker } from "../src/tasks.js";

test("queued work pauses for clarification, resumes, and excludes a second worker", async () => {
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6387";
  const redis = await connectRedis(redisUrl);
  const prefix = `rver:test:${randomUUID()}:`;
  const store = new Store(redis, prefix);
  let calls = 0;
  const agent = new Agent(
    store,
    {
      host: "127.0.0.1",
      port: 3000,
      authToken: "x".repeat(40),
      redisUrl,
      model: "test",
      groqApiKey: "test",
      maxModelCalls: 3,
      runTimeoutMs: 3000,
    },
    process.cwd(),
    async () => ({
      message:
        ++calls === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "ask-one",
                  type: "function",
                  function: {
                    name: "ask_user",
                    arguments: JSON.stringify({ question: "Which file?" }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Task finished after clarification" },
    }),
  );
  const worker = new TaskWorker(store, agent);
  const waitFor = async (id: string, status: string) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const task = await store.task(id, "operator");
      if (task.status === status) return task;
      await delay(20);
    }
    throw new Error(`Task did not reach ${status}`);
  };
  try {
    const session = await store.createSession("operator");
    const task = await store.createTask("operator", session.id, "Inspect it");
    await worker.start();
    await assert.rejects(
      new TaskWorker(store, agent).start(),
      /already running/,
    );
    assert.equal((await waitFor(task.id, "waiting")).question, "Which file?");
    await assert.rejects(store.resumeTask(task.id, "operator"), /Answer/);
    await store.resumeTask(task.id, "operator", "Inspect src/agent.ts");
    assert.equal(
      (await waitFor(task.id, "completed")).result,
      "Task finished after clarification",
    );
    assert.equal(calls, 2);
    assert.equal(
      (await store.messages(session.id, "operator")).filter(
        (m) => m.role === "user",
      ).length,
      2,
    );
  } finally {
    await worker.stop();
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(keys);
    await redis.close();
  }
});
