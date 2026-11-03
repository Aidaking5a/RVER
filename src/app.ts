import Fastify from "fastify";
import { createReadStream } from "node:fs";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createRequire } from "node:module";
import { projectRoot, type Config } from "./config.js";
import { Store, Fault } from "./store.js";
import type { Agent } from "./agent.js";
import type { TaskWorker } from "./tasks.js";
import { applyProjectEdit } from "./tools/code.js";

const require = createRequire(import.meta.url);
const ownerId = "operator";
const equal = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
const idParams = {
  type: "object",
  properties: { id: { type: "string", pattern: "^[a-f0-9-]{36}$" } },
  required: ["id"],
  additionalProperties: false,
};
const messageBody = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: 12000, pattern: "\\S" },
    mode: { type: "string", enum: ["inspect", "edit"] },
  },
  required: ["message"],
  additionalProperties: false,
};

export async function buildApp(
  config: Config,
  store: Store,
  agent: Agent,
  worker?: TaskWorker,
  logger = true,
) {
  const app = Fastify({
    logger: logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            'res.headers["set-cookie"]',
          ],
        }
      : false,
    bodyLimit: 64000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const rates = new Map<string, { count: number; until: number }>();
  const controllers = new Set<AbortController>();
  app.addHook("preClose", async () => {
    for (const controller of controllers) controller.abort();
  });
  const sign = (payload: string) =>
    createHmac("sha256", config.authToken).update(payload).digest("base64url");
  const validCookie = (cookie: string) => {
    const parts = cookie.split(".");
    return (
      parts.length === 3 &&
      Number(parts[0]) > Date.now() &&
      equal(parts[2]!, sign(parts.slice(0, 2).join(".")))
    );
  };
  app.addHook("onRequest", async (request, reply) => {
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(request.hostname))
      throw new Fault("Invalid host", 403);
    const origin = request.headers.origin;
    if (origin && !["GET", "HEAD"].includes(request.method)) {
      try {
        if (new URL(origin).host !== request.headers.host) throw new Error();
      } catch {
        throw new Fault("Cross-origin requests are not allowed", 403);
      }
    }
    if (!request.url.startsWith("/api/")) return;
    const key = `${request.ip}:${request.method === "GET" ? "read" : request.url === "/api/login" ? "login" : "write"}`;
    const time = Date.now();
    for (const [key, rate] of rates) if (rate.until <= time) rates.delete(key);
    const rate = rates.get(key) ?? { count: 0, until: time + 60000 };
    rate.count++;
    rates.set(key, rate);
    if (
      rate.count >
      (key.endsWith("login") ? 10 : request.method === "GET" ? 600 : 60)
    ) {
      reply.header("Retry-After", "60");
      throw new Fault("Too many requests; try again in a minute", 429);
    }
    if (request.url === "/api/login") return;
    const bearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : "";
    const cookie =
      request.headers.cookie
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("rver_session="))
        ?.slice(13) ?? "";
    if (!(bearer && equal(bearer, config.authToken)) && !validCookie(cookie))
      throw new Fault("Sign in with your local access key", 401);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as Error & { statusCode?: number };
    const code =
      typeof failure.statusCode === "number" ? failure.statusCode : 500;
    if (code >= 500)
      request.log.error({ name: failure.name, code }, "Request failed");
    reply
      .code(code)
      .send({
        error:
          code >= 500
            ? "The request could not be completed. Check the gateway and run history."
            : failure.message,
      });
  });
  // A fixed asset map avoids publishing arbitrary workspace/dependency paths.
  const assets = [
    [
      "/",
      path.join(projectRoot, "public/index.html"),
      "text/html; charset=utf-8",
    ],
    ...["app.js", "stream.js", "style.css"].map((name) => [
      `/${name}`,
      path.join(projectRoot, "public", name),
      name.endsWith(".css") ? "text/css" : "text/javascript",
    ]),
    ["/vendor/marked.js", require.resolve("marked"), "text/javascript"],
    [
      "/vendor/purify.js",
      path.join(path.dirname(require.resolve("dompurify")), "purify.min.js"),
      "text/javascript",
    ],
  ];
  for (const [url, file, mime] of assets)
    app.get(url!, (_request, reply) =>
      reply.type(mime!).send(createReadStream(file!)),
    );
  app.get("/health", async (_request, reply) => {
    const ready = store.redis.isReady && (!worker || worker.healthy);
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ok" : "unavailable" });
  });
  app.post<{ Body: { token: string } }>(
    "/api/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!equal(request.body.token, config.authToken))
        throw new Fault("Invalid access key", 401);
      const payload = `${Date.now() + 43200000}.${randomUUID()}`;
      reply.header(
        "Set-Cookie",
        `rver_session=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
      );
      return { ok: true };
    },
  );
  app.post("/api/logout", async (_request, reply) => {
    reply.header(
      "Set-Cookie",
      "rver_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    return { ok: true };
  });
  app.get("/api/me", async () => ({ ownerId }));
  app.get("/api/sessions", async () => ({
    sessions: await store.listSessions(ownerId),
  }));
  app.post("/api/sessions", async () => store.createSession(ownerId));
  app.get<{ Params: { id: string }; Querystring: { before?: number } }>(
    "/api/sessions/:id/messages",
    {
      schema: {
        params: idParams,
        querystring: {
          type: "object",
          properties: { before: { type: "string", pattern: "^\\d{1,9}$" } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      await store.session(request.params.id, ownerId);
      const count = Number(
        await store.redis.lLen(store.key(`messages:${request.params.id}`)),
      );
      const end = Math.min(count, Number(request.query.before ?? count));
      const start = Math.max(0, end - 200);
      const values: string[] = end
        ? await store.redis.lRange(
            store.key(`messages:${request.params.id}`),
            start,
            end - 1,
          )
        : [];
      return {
        messages: values
          .map((v) => JSON.parse(v))
          .filter(
            (m) =>
              ["user", "assistant"].includes(m.role) &&
              typeof m.content === "string",
          ),
        before: start || null,
      };
    },
  );
  app.post<{
    Params: { id: string };
    Body: { message: string; mode?: "inspect" | "edit" };
  }>(
    "/api/sessions/:id/chat",
    { schema: { params: idParams, body: messageBody } },
    async (request, reply) => {
      const controller = new AbortController();
      controllers.add(controller);
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      try {
        return await agent.run({
          ownerId,
          sessionId: request.params.id,
          ...request.body,
          signal: controller.signal,
        });
      } finally {
        controllers.delete(controller);
      }
    },
  );
  app.post<{
    Params: { id: string };
    Body: { message: string; mode?: "inspect" | "edit" };
  }>(
    "/api/sessions/:id/stream",
    { schema: { params: idParams, body: messageBody } },
    async (request, reply) => {
      await store.session(request.params.id, ownerId);
      const controller = new AbortController();
      controllers.add(controller);
      const send = (event: unknown) => {
        if (!reply.raw.destroyed)
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      try {
        const result = await agent.run({
          ownerId,
          sessionId: request.params.id,
          ...request.body,
          signal: controller.signal,
          onEvent: send,
        });
        send({ type: "done", ...result });
      } catch (error) {
        if (!controller.signal.aborted)
          send({
            type: "error",
            message:
              error instanceof Fault
                ? error.message
                : "The run stopped. Check its history before retrying.",
          });
      } finally {
        controllers.delete(controller);
        if (!reply.raw.destroyed) reply.raw.end();
      }
    },
  );
  app.get("/api/memories", async () => ({
    memories: await store.memories(ownerId),
  }));
  app.post<{ Body: { text: string } }>(
    "/api/memories",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            text: {
              type: "string",
              minLength: 1,
              maxLength: 1000,
              pattern: "\\S",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    (request) => store.remember(ownerId, request.body.text),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/memories/:id",
    { schema: { params: idParams } },
    async (request) => {
      await store.forget(ownerId, request.params.id);
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/edits",
    { schema: { params: idParams } },
    async (request) => ({
      edits: await store.edits(request.params.id, ownerId),
    }),
  );
  app.post<{ Params: { id: string }; Body: { action: "approve" | "reject" } }>(
    "/api/edits/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          properties: { action: { enum: ["approve", "reject"] } },
          required: ["action"],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const edit = await store.edit(request.params.id, ownerId);
      await store.lock(edit.sessionId, ownerId, edit.id, 30000);
      try {
        if (request.body.action === "reject") {
          await store.finishEdit(edit, "rejected");
          return { status: "rejected" };
        }
        return await applyProjectEdit(store, agent.root, edit.id, ownerId);
      } finally {
        await store.unlock(edit.sessionId, edit.id);
      }
    },
  );
  app.get("/api/tasks", async () => ({ tasks: await store.tasks(ownerId) }));
  app.post<{ Body: { message: string } }>(
    "/api/tasks",
    {
      schema: {
        body: {
          ...messageBody,
          properties: { message: messageBody.properties.message },
        },
      },
    },
    async (request) => {
      const session = await store.createSession(ownerId);
      return store.createTask(ownerId, session.id, request.body.message);
    },
  );
  app.post<{
    Params: { id: string };
    Body: { action: "resume" | "cancel"; answer?: string };
  }>(
    "/api/tasks/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          properties: {
            action: { enum: ["resume", "cancel"] },
            answer: { type: "string", maxLength: 12000 },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      if (request.body.action === "resume")
        return store.resumeTask(
          request.params.id,
          ownerId,
          request.body.answer,
        );
      if (worker) return worker.cancel(request.params.id, ownerId);
      throw new Fault("Task worker is not running", 503);
    },
  );
  app.get("/api/runs", async () => ({ runs: await store.traces(ownerId) }));
  return app;
}
