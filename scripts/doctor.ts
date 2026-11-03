import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { connectRedis } from "../src/redis.js";
import { Store } from "../src/store.js";
import { Agent } from "../src/agent.js";
import { searchWeb } from "../src/tools/search.js";
import { extractPages } from "../src/tools/extract.js";
import { getWeather } from "../src/tools/weather.js";

const config = loadConfig();
let failures = 0;
async function check(name: string, operation: () => Promise<void>) {
  try {
    await operation();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    // Provider errors may include authenticated URLs or request bodies. Print
    // only status codes, never the raw exception, response, or credential.
    const status = (error as { status?: number })?.status;
    console.error(
      `FAIL ${name}${status ? ` (HTTP ${status})` : ""}. Check configuration and connectivity.`,
    );
  }
}
console.log(
  `Environment: Node ${process.versions.node}, ${config.host}:${config.port}, model ${config.model}`,
);
await check("Redis read/write round trip", async () => {
  const redis = await connectRedis(config.redisUrl);
  try {
    const key = `rver:doctor:${randomUUID()}`;
    await redis.set(key, "verified", { EX: 30 });
    if ((await redis.get(key)) !== "verified") throw new Error();
    await redis.del(key);
  } finally {
    await redis.close();
  }
});
if (process.argv.includes("--live")) {
  await check(
    "Groq streamed completion and actual calculator tool call",
    async () => {
      const redis = await connectRedis(config.redisUrl);
      const prefix = `rver:doctor:${randomUUID()}:`;
      const store = new Store(redis, prefix);
      try {
        const session = await store.createSession("doctor");
        const result = await new Agent(store, config).run({
          ownerId: "doctor",
          sessionId: session.id,
          message:
            "Use the calculate tool to multiply 19 by 23. Then reply with the result.",
        });
        const traces = await store.traces("doctor");
        if (
          !result.message.includes("437") ||
          !traces[0]?.tools.some((t) => t.name === "calculate" && t.success)
        )
          throw new Error("Tool use was not confirmed");
      } finally {
        const keys = await redis.keys(`${prefix}*`);
        if (keys.length) await redis.del(keys);
        await redis.close();
      }
    },
  );
  await check("Tavily search", async () => {
    const data = JSON.parse(
      await searchWeb("site:redis.io Redis persistence documentation"),
    );
    if (!data.some((item: { url?: string }) => item.url)) throw new Error();
  });
  await check("Tavily page extraction", async () => {
    const data = JSON.parse(
      await extractPages([
        "https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/",
      ]),
    );
    if (!data[0]?.content) throw new Error();
  });
  await check("Open-Meteo geocoding and current weather", async () => {
    const data = JSON.parse(await getWeather("Luxembourg"));
    if (typeof data.temperature !== "number") throw new Error();
  });
  if (process.env.TELEGRAM_BOT_TOKEN)
    await check("Telegram getMe (no messages sent)", async () => {
      const response = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`,
        { signal: AbortSignal.timeout(15000) },
      );
      const data = (await response.json()) as {
        ok?: boolean;
        result?: { is_bot?: boolean };
      };
      if (!response.ok || !data.ok || !data.result?.is_bot)
        throw { status: response.status };
    });
  else console.log("SKIP Telegram: no bot token configured");
} else
  console.log(
    "Use pnpm run doctor --live to make small external API requests (provider usage may be charged).",
  );
if (failures) process.exitCode = 1;
