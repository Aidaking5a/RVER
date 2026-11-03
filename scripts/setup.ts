import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";
import { projectRoot } from "../src/config.js";

const destination = path.join(projectRoot, ".env");
let content = await readFile(destination, "utf8").catch(() => "");
const existing = dotenv.parse(content);
const defaults: Record<string, string> = {
  RVER_AUTH_TOKEN: randomBytes(32).toString("hex"),
  REDIS_URL: "redis://127.0.0.1:6387",
  HOST: "127.0.0.1",
  PORT: "3000",
  GROQ_MODEL: "openai/gpt-oss-120b",
  MAX_MODEL_CALLS: "10",
  RUN_TIMEOUT_MS: "120000",
};
for (const [key, value] of Object.entries(defaults)) {
  if (existing[key]) continue;
  const line = new RegExp(`^${key}=.*$`, "m");
  if (line.test(content)) content = content.replace(line, `${key}=${value}`);
  else
    content += `${content.endsWith("\n") || !content ? "" : "\n"}${key}=${value}\n`;
}
await writeFile(destination, content, { mode: 0o600 });
console.log(
  "Local configuration is ready. The local access key is RVER_AUTH_TOKEN in .env. External API credentials were preserved.",
);
if (!existing.GROQ_API_KEY) {
  console.error("Add GROQ_API_KEY to .env before starting RVER.");
  process.exitCode = 1;
}
if (!process.argv.includes("--no-docker")) {
  const result = spawnSync("docker", ["compose", "up", "-d", "--wait"], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.error(
      "Redis setup failed. Check Docker Desktop and run docker compose up -d --wait.",
    );
    process.exitCode = 1;
  }
}
