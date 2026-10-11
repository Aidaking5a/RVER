
import { Bot } from "grammy";
import dotenv from "dotenv";
import { runAgent } from "./agent.js";

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing from .env");
}

const bot = new Bot(token);

const allowedUserId = Number(
    process.env.TELEGRAM_ALLOWED_USER_ID
);

if (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) {
    throw new Error("A valid TELEGRAM_ALLOWED_USER_ID is required");
}

bot.use(async (ctx, next) => {
    if (ctx.from?.id !== allowedUserId) {
        console.warn("Blocked unauthorized Telegram user.");
        return;
    }

    await next();
});

bot.command("start", async (ctx) => {
    await ctx.reply(
        "Hello! I'm RVER, your AI assistant. Send me a message to get started."
    );
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    console.log("Telegram user ID:", ctx.from?.id, "Message:", text);

    if (text.startsWith("/")) {
        return;
    }

    await ctx.replyWithChatAction("typing");

    try {
        const sessionId = `telegram:${ctx.chat.id}`;

        const response = await runAgent(sessionId, text);

        await ctx.reply(
            response.message || "I couldn't generate a response."
        );
    } catch (error) {
        console.error("RVER agent error:", error);

        await ctx.reply(
            "Sorry, I couldn't process that message. Please try again."
        );
    }
});

bot.catch((error) => {
    console.error("Telegram bot error:", error.message);
});

bot.start({
    onStart: (botInfo) => {
        console.log(`Telegram bot @${botInfo.username} is running.`);
    },
});
