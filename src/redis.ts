import { createClient } from "redis";

export async function connectRedis(url: string) {
  const redis = createClient({
    url,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  redis.on("error", () =>
    console.error("Redis connection failed. Check pnpm run doctor."),
  );
  await redis.connect();
  return redis;
}
export type Redis = Awaited<ReturnType<typeof connectRedis>>;
