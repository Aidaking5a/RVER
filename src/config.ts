import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  const token = env.RVER_AUTH_TOKEN ?? "";
  if (token.length < 32)
    throw new Error(
      "RVER_AUTH_TOKEN must contain at least 32 characters. Run pnpm run setup.",
    );
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is required in .env");
  const host = env.HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("RVER must bind to a loopback address.");
  return {
    host,
    port: integer("PORT", 3000, 1, 65535),
    authToken: token,
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6387",
    model: env.GROQ_MODEL ?? "openai/gpt-oss-120b",
    groqApiKey: env.GROQ_API_KEY,
    maxModelCalls: integer("MAX_MODEL_CALLS", 10, 1, 30),
    runTimeoutMs: integer("RUN_TIMEOUT_MS", 120000, 1000, 600000),
  };
}
export type Config = ReturnType<typeof loadConfig>;
