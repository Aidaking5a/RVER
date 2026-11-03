import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { connectRedis } from "../src/redis.js";
import { Store } from "../src/store.js";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";

const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const sourceUrl = option("--from");
const client = option("--client");
const session = option("--session");
if (
  !sourceUrl ||
  (!client && !session) ||
  (client && !/^[a-zA-Z0-9-]{1,100}$/.test(client))
) {
  console.error(
    "Usage: pnpm run migrate --from redis://127.0.0.1:6379 --client <old-client-id> (or --session <old-session-id>)",
  );
  process.exitCode = 1;
} else {
  const source = await connectRedis(sourceUrl);
  const destination = await connectRedis(loadConfig().redisUrl);
  try {
    const store = new Store(destination);
    const ids: string[] = session
      ? [session]
      : await source.sMembers(`client:${client}:conversations`);
    let imported = 0;
    let skipped = 0;
    for (const id of ids) {
      const raw = await source.get(`conversation:${id}`);
      if (!raw) {
        skipped++;
        continue;
      }
      if (Buffer.byteLength(raw) > 1000000)
        throw new Error(
          "Legacy conversation exceeds 1 MB; inspect it before importing",
        );
      const messages: unknown = JSON.parse(raw);
      if (
        !Array.isArray(messages) ||
        messages.some(
          (m) =>
            !m ||
            !["system", "user", "assistant", "tool", "function"].includes(
              m.role,
            ),
        )
      )
        throw new Error("Invalid legacy message data");
      const sourceId = createHash("sha256")
        .update(`${sourceUrl}\n${id}`)
        .digest("hex");
      const result = await store.importConversation(
        "operator",
        sourceId,
        messages as ChatCompletionMessageParam[],
      );
      if (result.imported) imported++;
      else skipped++;
    }
    console.log(
      `Imported ${imported} conversations; skipped ${skipped} missing or previously imported records. Original Redis keys were preserved.`,
    );
  } finally {
    await source.close();
    await destination.close();
  }
}
