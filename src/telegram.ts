import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { connectRedis } from "./redis.js";
import { Store } from "./store.js";
import { Agent } from "./agent.js";

const config = loadConfig();
const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);
if (!token || !Number.isSafeInteger(allowedId) || allowedId <= 0)
  throw new Error("Configure TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID");
const redis = await connectRedis(config.redisUrl);
const store = new Store(redis);
const agent = new Agent(store, config);
const bot = new Bot(token);
const pointer = store.key(`telegram:${allowedId}`);
const newSession = async () => {
  const session = await store.createSession("operator");
  await redis.set(pointer, session.id);
  return session.id;
};
const sessionId = async () =>
  ((await redis.get(pointer)) as string | null) ?? newSession();
const replyChunks = async (
  reply: (text: string) => Promise<unknown>,
  text: string,
) => {
  for (let i = 0; i < text.length; i += 3500)
    await reply(text.slice(i, i + 3500));
};

bot.use(async (ctx, next) => {
  if (ctx.from?.id === allowedId && ctx.chat?.type === "private") await next();
});
bot.command("start", (ctx) =>
  ctx.reply(
    "RVER is ready. /new starts a chat; /remember saves a note; /queue adds a read-only task; /tasks shows progress.",
  ),
);
bot.command("new", async (ctx) => {
  await newSession();
  await ctx.reply("Started a new conversation. Your saved memory is retained.");
});
bot.command("remember", async (ctx) => {
  try {
    await store.remember("operator", ctx.match);
    await ctx.reply("Memory saved. You can manage it in the web interface.");
  } catch (error) {
    await ctx.reply(
      error instanceof Error ? error.message : "Could not save memory",
    );
  }
});
bot.command("queue", async (ctx) => {
  if (!ctx.match.trim() || ctx.match.length > 12000) {
    await ctx.reply(
      "Use /queue followed by a task of up to 12,000 characters.",
    );
    return;
  }
  const session = await store.createSession("operator");
  const task = await store.createTask("operator", session.id, ctx.match);
  await ctx.reply(
    `Task queued: ${task.id}. Keep the web gateway running; use /tasks or the web interface to check it.`,
  );
});
bot.command("tasks", async (ctx) => {
  const tasks = (await store.tasks("operator"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  await replyChunks(
    (text) => ctx.reply(text),
    tasks
      .map(
        (t) => `${t.id}: ${t.status}\n${t.question ?? t.result ?? t.message}`,
      )
      .join("\n\n") || "No queued tasks.",
  );
});
bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  if (ctx.message.text.length > 12000) {
    await ctx.reply("Please keep the message under 12,000 characters.");
    return;
  }
  try {
    await ctx.replyWithChatAction("typing");
    const result = await agent.run({
      ownerId: "operator",
      sessionId: await sessionId(),
      message: ctx.message.text,
    });
    await replyChunks((text) => ctx.reply(text), result.message);
  } catch {
    await ctx.reply(
      "The request stopped. Check the web run history or try again after the current response ends.",
    );
  }
});
bot.catch(() =>
  console.error("Telegram request failed. No message content was logged."),
);
const stop = async () => {
  await bot.stop();
  if (redis.isOpen) await redis.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await bot.start({
  onStart: () =>
    console.log(
      "RVER Telegram bot is running for the configured private user.",
    ),
});
