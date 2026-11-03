import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectRedis } from "../src/redis.js";
import { Store } from "../src/store.js";
import { Agent } from "../src/agent.js";
import { buildApp } from "../src/app.js";

test("HTTP authentication, validation, ownership, streaming, and memories use the real gateway", async () => {
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6387";
  const redis = await connectRedis(redisUrl);
  const prefix = `rver:test:${randomUUID()}:`;
  const store = new Store(redis, prefix);
  const config = {
    host: "127.0.0.1",
    port: 3000,
    authToken: "test-access-key-with-at-least-32-characters",
    redisUrl,
    model: "test",
    groqApiKey: "test",
    maxModelCalls: 3,
    runTimeoutMs: 3000,
  };
  const agent = new Agent(store, config, process.cwd(), async () => ({
    message: { role: "assistant", content: "Verified answer" },
  }));
  const app = await buildApp(config, store, agent, undefined, false);
  const headers = { authorization: `Bearer ${config.authToken}` };
  try {
    assert.equal((await app.inject("/api/sessions")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: "/api/login",
          method: "POST",
          headers: { origin: "https://other.example" },
          payload: { token: config.authToken },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { token: config.authToken },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.match(cookie, /^rver_session=/);
    assert.equal(
      (await app.inject({ url: "/api/me", headers: { cookie } })).statusCode,
      200,
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers,
    });
    assert.equal(created.statusCode, 200);
    const id = created.json().id as string;
    for (const payload of [
      { message: 123 },
      { message: "   " },
      { message: "ok", unexpected: true },
      {},
    ]) {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/sessions/${id}/chat`,
            headers,
            payload,
          })
        ).statusCode,
        400,
      );
    }
    const stranger = await store.createSession("other-owner");
    assert.equal(
      (
        await app.inject({
          url: `/api/sessions/${stranger.id}/messages`,
          headers,
        })
      ).statusCode,
      404,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/chat`,
      headers,
      payload: { message: "First question" },
    });
    assert.equal(response.json().message, "Verified answer");
    const stream = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/stream`,
      headers,
      payload: { message: "Second question" },
    });
    assert.match(stream.body, /"type":"delta","token":"Verified answer"/);
    assert.match(stream.body, /"type":"done"/);
    const history = (
      await app.inject({ url: `/api/sessions/${id}/messages`, headers })
    ).json();
    assert.equal(history.messages.length, 4);
    assert.equal(history.messages[0].content, "First question");
    const memory = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers,
      payload: { text: "Prefer concise answers" },
    });
    assert.equal(memory.statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/memories", headers })).json().memories
        .length,
      1,
    );
    assert.equal((await app.inject("/vendor/marked.js")).statusCode, 200);
    assert.equal((await app.inject("/vendor/purify.js")).statusCode, 200);
  } finally {
    await app.close();
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(keys);
    await redis.close();
  }
});
