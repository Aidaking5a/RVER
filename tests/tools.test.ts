import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { connectRedis } from "../src/redis.js";
import { Store } from "../src/store.js";
import {
  readProjectFile,
  proposeProjectEdit,
  applyProjectEdit,
} from "../src/tools/code.js";
import { executeTool } from "../src/tools/registry.js";

test("source windows remain complete and proposed edits require explicit, fresh, owner-bound approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rver-test-"));
  const redis = await connectRedis(
    process.env.REDIS_URL ?? "redis://127.0.0.1:6387",
  );
  const prefix = `rver:test:${randomUUID()}:`;
  const store = new Store(redis, prefix);
  try {
    const session = await store.createSession("alice");
    const original = Array.from(
      { length: 150 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    await writeFile(path.join(root, "source.ts"), original);
    const read = await readProjectFile(root, "source.ts", 100, 10);
    assert.equal(
      read.content,
      Array.from({ length: 10 }, (_, i) => `line ${i + 100}`).join("\n"),
    );
    assert.equal(read.totalLines, 150);
    await assert.rejects(readProjectFile(root, "../outside"), /allowed/);
    await assert.rejects(readProjectFile(root, ".env"), /allowed/);
    await assert.rejects(readProjectFile(root, "source.ts:stream"), /allowed/);
    const args = {
      path: "source.ts",
      old_text: "line 100",
      new_text: "changed 100",
      hash: read.hash,
    };
    const edit = await proposeProjectEdit(
      store,
      root,
      "alice",
      session.id,
      args,
    );
    assert.equal(
      await readFile(path.join(root, "source.ts"), "utf8"),
      original,
    );
    await assert.rejects(
      applyProjectEdit(store, root, edit.id, "bob"),
      /not found/,
    );
    await applyProjectEdit(store, root, edit.id, "alice");
    assert.equal(
      await readFile(path.join(root, "source.ts"), "utf8"),
      original.replace("line 100", "changed 100"),
    );
    await assert.rejects(
      applyProjectEdit(store, root, edit.id, "alice"),
      /already/,
    );
    await assert.rejects(store.finishEdit(edit, "rejected"), /already/);
    assert.equal((await store.edit(edit.id, "alice")).status, "applied");
    await assert.rejects(
      proposeProjectEdit(store, root, "alice", session.id, args),
      /changed/,
    );
    const ctx = {
      store,
      root,
      ownerId: "alice",
      sessionId: session.id,
      mode: "inspect" as const,
      signal: new AbortController().signal,
    };
    await assert.rejects(
      executeTool("propose_project_edit", JSON.stringify(args), ctx),
      /not permitted/,
    );
    await assert.rejects(
      executeTool(
        "calculate",
        JSON.stringify({ a: 2, b: 0, operation: "divide" }),
        ctx,
      ),
      /zero/,
    );
    await assert.rejects(
      executeTool("get_time", '{"unexpected":1}', ctx),
      /argument/,
    );
    await assert.rejects(
      executeTool("calculate", '{"a":"2","b":1,"operation":"add"}', ctx),
      /argument/,
    );
  } finally {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(keys);
    await redis.close();
    await rm(root, { recursive: true, force: true });
  }
});
