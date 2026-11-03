import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Agent, contextView, type ModelCall } from "../src/agent.js";
import { connectRedis } from "../src/redis.js";
import { Store } from "../src/store.js";
import type { Config } from "../src/config.js";

export const testConfig: Config = {
  host: "127.0.0.1",
  port: 3000,
  authToken: "test-access-key-with-at-least-32-characters",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6387",
  model: "test-model",
  groqApiKey: "unused-test-key",
  maxModelCalls: 3,
  runTimeoutMs: 3000,
};
const call = (name: string, args: unknown) => ({
  role: "assistant" as const,
  content: null,
  tool_calls: [
    {
      id: randomUUID(),
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

test("agent preserves turns and tool errors, rejects writes, bounds calls, and releases cancelled runs", async () => {
  const redis = await connectRedis(testConfig.redisUrl);
  const prefix = `rver:test:${randomUUID()}:`;
  const store = new Store(redis, prefix);
  try {
    const session = await store.createSession("alice");
    let round = 0;
    const model: ModelCall = async (messages, tools) => {
      assert.equal(
        tools.some((t) => t.function?.name === "propose_project_edit"),
        false,
      );
      if (round++ === 0)
        return {
          message: call("write_project_file", {
            path: "test.py",
            content: "no",
          }),
        };
      assert.match(JSON.stringify(messages.at(-1)), /not permitted/);
      return {
        message: { role: "assistant", content: "I can inspect the code." },
      };
    };
    const agent = new Agent(store, testConfig, process.cwd(), model);
    assert.equal(
      (
        await agent.run({
          ownerId: "alice",
          sessionId: session.id,
          message: "Inspect only",
        })
      ).status,
      "completed",
    );
    const echo = new Agent(store, testConfig, process.cwd(), async () => ({
      message: { role: "assistant", content: "Second answer" },
    }));
    await echo.run({
      ownerId: "alice",
      sessionId: session.id,
      message: "Second question",
    });
    const messages = await store.messages(session.id, "alice");
    assert.equal(messages.filter((m) => m.role === "user").length, 2);
    assert.equal(messages.filter((m) => m.role === "tool").length, 1);
    assert.equal((await store.listSessions("alice"))[0]?.title, "Inspect only");
    let calls = 0;
    const loop = new Agent(store, testConfig, process.cwd(), async () => {
      calls++;
      return { message: call("get_time", {}) };
    });
    await assert.rejects(
      loop.run({ ownerId: "alice", sessionId: session.id, message: "loop" }),
      /limit/,
    );
    assert.equal(calls, 3);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      echo.run({
        ownerId: "alice",
        sessionId: session.id,
        message: "cancelled",
        signal: controller.signal,
      }),
    );
    await echo.run({
      ownerId: "alice",
      sessionId: session.id,
      message: "lock is free",
    });
    const question = new Agent(store, testConfig, process.cwd(), async () => ({
      message: call("ask_user", { question: "Which file should I inspect?" }),
    }));
    assert.equal(
      (
        await question.run({
          ownerId: "alice",
          sessionId: session.id,
          message: "Inspect it",
        })
      ).status,
      "waiting",
    );
    assert.ok(
      (await store.traces("alice")).some(
        (t) => t.status === "failed" && t.calls === 3,
      ),
    );
    assert.equal((await store.traces("bob")).length, 0);
  } finally {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(keys);
    await redis.close();
  }
});

test("context selection keeps the current request and complete tool pairs without mutating history", () => {
  const tool = call("get_time", {});
  const history = [
    { role: "user" as const, content: "old".repeat(10000) },
    { role: "assistant" as const, content: "old answer" },
    { role: "user" as const, content: "current" },
    tool,
    {
      role: "tool" as const,
      tool_call_id: tool.tool_calls[0]!.id,
      content: "12:00",
    },
  ];
  const context = contextView(history, 1000);
  assert.equal(
    context.some((m) => m.content === "current"),
    true,
  );
  assert.equal(
    context.some((m) => m.role === "tool"),
    true,
  );
  assert.equal(
    context.some((m) => m.content === history[0]!.content),
    false,
  );
  assert.equal(history.length, 5);
});
