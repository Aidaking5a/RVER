import { loadConfig } from "./config.js";
import { connectRedis } from "./redis.js";
import { Store } from "./store.js";
import { Agent } from "./agent.js";
import { TaskWorker } from "./tasks.js";
import { buildApp } from "./app.js";

let cleanup = async () => {};
try {
  const config = loadConfig();
  const redis = await connectRedis(config.redisUrl);
  cleanup = async () => {
    if (redis.isOpen) await redis.close();
  };
  const store = new Store(redis);
  const agent = new Agent(store, config);
  const worker = new TaskWorker(store, agent);
  const app = await buildApp(config, store, agent, worker);
  app.addHook("onClose", async () => {
    await worker.stop();
    if (redis.isOpen) await redis.close();
  });
  cleanup = () => app.close();
  await worker.start();
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (!closing) {
      closing = true;
      await app.close();
    }
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
} catch (error) {
  await cleanup();
  console.error(
    error instanceof Error ? error.message : "RVER could not start",
  );
  process.exitCode = 1;
}
