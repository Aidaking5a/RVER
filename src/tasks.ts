import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Agent } from "./agent.js";
import { Store, type Task } from "./store.js";

export class TaskWorker {
  private stopping = false;
  private active?: { task: Task; controller: AbortController };
  private running?: Promise<void>;
  private readonly token = randomUUID();
  constructor(
    private readonly store: Store,
    private readonly agent: Agent,
  ) {}
  async start() {
    if (this.running) return;
    const key = this.store.key("worker");
    if (!(await this.store.redis.set(key, this.token, { NX: true, PX: 15000 })))
      throw new Error("Another RVER task worker is already running");
    await this.store.recoverTasks(this.token);
    this.stopping = false;
    this.running = this.loop(key).catch(() => {
      this.stopping = true;
      console.error(
        "Task worker stopped. Restart the gateway to recover interrupted work.",
      );
    });
  }
  private async loop(key: string) {
    try {
      while (!this.stopping) {
        const renewed = await this.store.redis.eval(
          'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE",KEYS[1],15000) end return 0',
          { keys: [key], arguments: [this.token] },
        );
        if (!renewed) throw new Error("Task worker ownership was lost");
        const task = await this.store.claimTask(this.token);
        if (!task) {
          await delay(500);
          continue;
        }
        const controller = new AbortController();
        this.active = { task, controller };
        // Keep the worker lease alive during a long model call. A second gateway
        // must never "recover" a task that this worker is still executing.
        const heartbeat = setInterval(() => {
          void this.store.redis
            .eval(
              'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE",KEYS[1],15000) end return 0',
              { keys: [key], arguments: [this.token] },
            )
            .then((ok: unknown) => {
              if (!ok) controller.abort();
            })
            .catch(() => controller.abort());
        }, 4000);
        try {
          const message = task.continuation
            ? `Original task: ${task.message}\n${task.continuation}`
            : task.message;
          const result = await this.agent.run({
            ownerId: task.ownerId,
            sessionId: task.sessionId,
            message,
            mode: "inspect",
            signal: controller.signal,
          });
          task.status = result.status;
          task.result = result.message;
          if (result.status === "waiting") task.question = result.message;
        } catch {
          task.status = this.stopping
            ? "interrupted"
            : controller.signal.aborted
              ? "cancelled"
              : "failed";
          task.result = this.stopping
            ? "Gateway stopped. Resume this task to continue."
            : "The task stopped. Check its conversation and run history.";
        } finally {
          clearInterval(heartbeat);
          await this.store.finishTask(task, this.token);
          this.active = undefined;
        }
      }
    } finally {
      await this.store.redis.eval(
        'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) end return 0',
        { keys: [key], arguments: [this.token] },
      );
    }
  }
  async cancel(id: string, ownerId: string) {
    const task = await this.store.cancelTask(id, ownerId);
    if (this.active?.task.id === id) this.active.controller.abort();
    return task;
  }
  async stop() {
    this.stopping = true;
    this.active?.controller.abort();
    await this.running;
    this.running = undefined;
  }
  get healthy() {
    return !!this.running && !this.stopping;
  }
}
