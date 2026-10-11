import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import dotenv from "dotenv";
import { runAgent, runAgentStream } from "./agent.js";
import redis from "./redis.js";

dotenv.config();

const app = Fastify({
    logger: true,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await app.register(fastifyStatic, {
    root: path.join(__dirname, "../public"),
});

app.get("/", async (request, reply) => {
    return reply.sendFile("index.html");
    
});

app.get("/health", async (request, reply) => {
    return {
        status: "ok",
        redis: redis.isReady,
    };
});

app.post("/chat", async (request, reply) => {
    try {
        const body = request.body as {
            message: string;
        };

        const sessionId = request.headers["x-session-id"];

        if (!sessionId || Array.isArray(sessionId)) {
            return reply.code(400).send({
                error: "Missing x-session-id header",
            });
        }

        if (!body.message) {
            return reply.code(400).send({
                error: "Missing message",
            });
        }

        return await runAgent(
            sessionId,
            body.message
        );

    } catch (error) {
        console.error("Chat error:", error);

        return reply.code(500).send({
            error: "The agent could not process your request.",
        });
    }
});

app.post("/chat/stream", async (request, reply) => {
    const body = request.body as {
        message?: string;
    } | undefined;

    const sessionId = request.headers["x-session-id"];

    if (!sessionId || Array.isArray(sessionId)) {
        return reply.code(400).send({
            error: "Missing x-session-id header",
        });
    }

    if (!body?.message?.trim()) {
        return reply.code(400).send({
            error: "Missing message",
        });
    }
    
    const clientId = request.headers["x-client-id"];

    if (
        !clientId ||
        Array.isArray(clientId) ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(clientId)
    ) {
        return reply.code(400).send({
            error: "Missing or invalid x-client-id header",
        });
    }

    await redis.sAdd(
        `client:${clientId}:conversations`,
        sessionId
    );

    const controller = new AbortController();
    reply.hijack();


    reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    });

    reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) {
            controller.abort();
        }
    });

    try {
        await runAgentStream(
            sessionId,
            body.message,
            (token) => {
                reply.raw.write(
                    `data: ${JSON.stringify({ token })}\n\n`
                );
            },
            controller.signal
        );

        reply.raw.write(
            `data: ${JSON.stringify({ done: true })}\n\n`
        );
    } catch (error) {
        if (!controller.signal.aborted) {
            request.log.error(error, "Streaming chat error");

            if (!reply.raw.destroyed) {
                reply.raw.write(
                    `data: ${JSON.stringify({
                        error: "The agent could not complete the request.",
                    })}\n\n`
                );
            }
        }
    } finally {
        if (!reply.raw.destroyed) {
            reply.raw.end();
        }
    }
});


app.get("/chat/history", async (request, reply) => {
    const sessionId = request.headers["x-session-id"];

    if (!sessionId || Array.isArray(sessionId)) {
        return reply.code(400).send({
            error: "Missing x-session-id header",
        });
    }

    try {
        const data = await redis.get(
            `conversation:${sessionId}`
        );

        if (!data) {
            return { messages: [] };
        }

        const conversation = JSON.parse(data);

        const messages = conversation
            .filter((item: { role: string; content?: unknown }) =>
                (item.role === "user" ||
                 item.role === "assistant") &&
                typeof item.content === "string"
            )
            .map((item: { role: string; content: string }) => ({
                role: item.role,
                content: item.content,
            }));

        return { messages };
    } catch (error) {
        request.log.error(error, "Could not load chat history");

        return reply.code(500).send({
            error: "Could not load conversation history.",
        });
    }
});


app.get("/chat/conversations", async (request, reply) => {
    const clientId = request.headers["x-client-id"];

    if (
        !clientId ||
        Array.isArray(clientId) ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(clientId)
    ) {
        return reply.code(400).send({
            error: "Missing or invalid x-client-id header",
        });
    }

    try {
        const sessionIds = await redis.sMembers(
            `client:${clientId}:conversations`
        );

        const conversations = [];

        for (const sessionId of sessionIds) {
            const data = await redis.get(
                `conversation:${sessionId}`
            );

            if (!data) continue;

            const messages = JSON.parse(data);

            const firstUserMessage = messages.find(
                (item: { role: string; content?: unknown }) =>
                    item.role === "user" &&
                    typeof item.content === "string"
            );

            if (!firstUserMessage) continue;

            conversations.push({
                id: sessionId,
                title: firstUserMessage.content.slice(0, 45),
            });
        }

        return { conversations };
    } catch (error) {
        request.log.error(error, "Could not list conversations");

        return reply.code(500).send({
            error: "Could not load conversations.",
        });
    }
});



app.listen({ port: 3000 }, (err, address) => {
    if (err) {
        app.log.error(err);
        process.exit(1);
    }

    console.log(`Server running at ${address}`);
});