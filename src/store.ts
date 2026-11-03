import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import type { Redis } from "./redis.js";

export class Fault extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export type Session = {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
export type Memory = { id: string; text: string; createdAt: string };
export type Edit = {
  id: string;
  ownerId: string;
  sessionId: string;
  path: string;
  oldText: string;
  newText: string;
  hash: string;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
};
export type Task = {
  id: string;
  ownerId: string;
  sessionId: string;
  message: string;
  continuation?: string;
  attemptId?: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "interrupted"
    | "completed"
    | "failed"
    | "cancelled";
  result?: string;
  question?: string;
  createdAt: string;
  updatedAt: string;
};
export type Trace = {
  id: string;
  ownerId: string;
  sessionId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  calls: number;
  tools: { name: string; durationMs: number; success: boolean }[];
  usage: { input: number; output: number };
};
const now = () => new Date().toISOString();

export class Store {
  constructor(
    public readonly redis: Redis,
    public readonly prefix = "rver:v1:",
  ) {}
  key(name: string) {
    return this.prefix + name;
  }
  private async get<T>(name: string): Promise<T | null> {
    const data = await this.redis.get(this.key(name));
    return data ? (JSON.parse(data) as T) : null;
  }

  async createSession(ownerId: string): Promise<Session> {
    const session = {
      id: randomUUID(),
      ownerId,
      title: "New chat",
      createdAt: now(),
      updatedAt: now(),
    };
    await this.redis
      .multi()
      .set(this.key(`session:${session.id}`), JSON.stringify(session))
      .zAdd(this.key(`sessions:${ownerId}`), {
        score: Date.now(),
        value: session.id,
      })
      .exec();
    return session;
  }
  async session(id: string, ownerId: string): Promise<Session> {
    const session = await this.get<Session>(`session:${id}`);
    if (!session || session.ownerId !== ownerId)
      throw new Fault("Session not found", 404);
    return session;
  }
  async listSessions(ownerId: string): Promise<Session[]> {
    const ids: string[] = await this.redis.zRange(
      this.key(`sessions:${ownerId}`),
      0,
      99,
      { REV: true },
    );
    return Promise.all(ids.map((id) => this.session(id, ownerId)));
  }
  async messages(
    id: string,
    ownerId: string,
    limit = 200,
  ): Promise<ChatCompletionMessageParam[]> {
    await this.session(id, ownerId);
    const values: string[] = await this.redis.lRange(
      this.key(`messages:${id}`),
      -limit,
      -1,
    );
    return values.map((v) => JSON.parse(v));
  }
  async append(
    id: string,
    ownerId: string,
    messages: ChatCompletionMessageParam[],
  ) {
    const session = await this.session(id, ownerId);
    const firstUser = messages.find(
      (m) => m.role === "user" && typeof m.content === "string",
    );
    if (
      !(await this.redis.lLen(this.key(`messages:${id}`))) &&
      firstUser &&
      typeof firstUser.content === "string"
    )
      session.title = firstUser.content.slice(0, 60);
    session.updatedAt = now();
    await this.redis
      .multi()
      .rPush(
        this.key(`messages:${id}`),
        messages.map((m) => JSON.stringify(m)),
      )
      .set(this.key(`session:${id}`), JSON.stringify(session))
      .zAdd(this.key(`sessions:${ownerId}`), { value: id, score: Date.now() })
      .exec();
  }
  async lock(id: string, ownerId: string, token: string, ttl: number) {
    await this.session(id, ownerId);
    const acquired = await this.redis.set(this.key(`lock:${id}`), token, {
      NX: true,
      PX: ttl,
    });
    if (!acquired)
      throw new Fault(
        "This conversation is busy. Stop or wait for its current response.",
        409,
      );
  }
  async unlock(id: string, token: string) {
    // Compare-and-delete prevents a late request from unlocking a newer run.
    await this.redis.eval(
      'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) end return 0',
      { keys: [this.key(`lock:${id}`)], arguments: [token] },
    );
  }
  async remember(ownerId: string, text: string): Promise<Memory> {
    text = text.trim();
    if (!text || text.length > 1000)
      throw new Fault("Memory must contain 1–1000 characters");
    const memory = { id: randomUUID(), text, createdAt: now() };
    const result = await this.redis.eval(
      'if redis.call("HLEN",KEYS[1]) >= 40 then return 0 end redis.call("HSET",KEYS[1],ARGV[1],ARGV[2]); return 1',
      {
        keys: [this.key(`memory:${ownerId}`)],
        arguments: [memory.id, JSON.stringify(memory)],
      },
    );
    if (!result)
      throw new Fault("Memory is full. Remove an old note first.", 409);
    return memory;
  }
  async memories(ownerId: string): Promise<Memory[]> {
    return Object.values(
      (await this.redis.hGetAll(this.key(`memory:${ownerId}`))) as Record<
        string,
        string
      >,
    ).map((v) => JSON.parse(v));
  }
  async forget(ownerId: string, id: string) {
    await this.redis.hDel(this.key(`memory:${ownerId}`), id);
  }
  async search(ownerId: string, query: string) {
    const matches: { sessionId: string; title: string; excerpt: string }[] = [];
    for (const session of await this.listSessions(ownerId)) {
      const messages = await this.messages(session.id, ownerId, 1000);
      for (const message of messages) {
        if (
          !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string"
        )
          continue;
        const index = message.content
          .toLowerCase()
          .indexOf(query.toLowerCase());
        if (index < 0) continue;
        matches.push({
          sessionId: session.id,
          title: session.title,
          excerpt: message.content.slice(Math.max(0, index - 100), index + 500),
        });
        break;
      }
      if (matches.length === 5) break;
    }
    return matches;
  }
  async propose(
    edit: Omit<Edit, "id" | "status" | "createdAt">,
  ): Promise<Edit> {
    await this.session(edit.sessionId, edit.ownerId);
    const proposal: Edit = {
      ...edit,
      id: randomUUID(),
      status: "pending",
      createdAt: now(),
    };
    await this.redis
      .multi()
      .set(this.key(`edit:${proposal.id}`), JSON.stringify(proposal), {
        EX: 3600,
      })
      .sAdd(this.key(`edits:${edit.sessionId}`), proposal.id)
      .expire(this.key(`edits:${edit.sessionId}`), 3600)
      .exec();
    return proposal;
  }
  async edit(id: string, ownerId: string): Promise<Edit> {
    const edit = await this.get<Edit>(`edit:${id}`);
    if (!edit || edit.ownerId !== ownerId)
      throw new Fault("Edit not found or expired", 404);
    return edit;
  }
  async edits(sessionId: string, ownerId: string): Promise<Edit[]> {
    await this.session(sessionId, ownerId);
    const ids: string[] = await this.redis.sMembers(
      this.key(`edits:${sessionId}`),
    );
    const edits = await Promise.all(
      ids.map((id) => this.get<Edit>(`edit:${id}`)),
    );
    return edits.filter(
      (edit): edit is Edit =>
        !!edit && edit.ownerId === ownerId && edit.status === "pending",
    );
  }
  async finishEdit(edit: Edit, status: Edit["status"]) {
    const changed = await this.redis.eval(
      'local data = redis.call("GET",KEYS[1]); if not data then return 0 end local edit = cjson.decode(data); if edit.status ~= "pending" then return 0 end edit.status = ARGV[1]; redis.call("SET",KEYS[1],cjson.encode(edit),"EX",3600); return 1',
      { keys: [this.key(`edit:${edit.id}`)], arguments: [status] },
    );
    if (!changed)
      throw new Fault("This edit was already resolved or expired", 409);
  }
  async trace(trace: Trace) {
    await this.redis
      .multi()
      .set(this.key(`run:${trace.id}`), JSON.stringify(trace), { EX: 604800 })
      .zAdd(this.key(`runs:${trace.ownerId}`), {
        value: trace.id,
        score: Date.now(),
      })
      .expire(this.key(`runs:${trace.ownerId}`), 604800)
      .exec();
  }
  async traces(ownerId: string): Promise<Trace[]> {
    const ids: string[] = await this.redis.zRange(
      this.key(`runs:${ownerId}`),
      0,
      49,
      { REV: true },
    );
    const runs = await Promise.all(
      ids.map((id) => this.get<Trace>(`run:${id}`)),
    );
    return runs.filter((run): run is Trace => !!run && run.ownerId === ownerId);
  }
  async createTask(
    ownerId: string,
    sessionId: string,
    message: string,
  ): Promise<Task> {
    await this.session(sessionId, ownerId);
    const task: Task = {
      id: randomUUID(),
      ownerId,
      sessionId,
      message,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
    };
    await this.redis
      .multi()
      .set(this.key(`task:${task.id}`), JSON.stringify(task))
      .sAdd(this.key(`tasks:${ownerId}`), task.id)
      .rPush(this.key("queue"), task.id)
      .exec();
    return task;
  }
  async task(id: string, ownerId: string): Promise<Task> {
    const task = await this.get<Task>(`task:${id}`);
    if (!task || task.ownerId !== ownerId)
      throw new Fault("Task not found", 404);
    return task;
  }
  async tasks(ownerId: string) {
    const ids: string[] = await this.redis.sMembers(
      this.key(`tasks:${ownerId}`),
    );
    return Promise.all(ids.map((id) => this.task(id, ownerId)));
  }
  async claimTask(workerToken: string): Promise<Task | null> {
    // Claim and running receipt must commit together, or a crash could lose work.
    const data = await this.redis.eval(
      `
      if redis.call('GET', KEYS[3]) ~= ARGV[3] then return nil end
      local id = redis.call('LPOP', KEYS[1]); if not id then return nil end
      local data = redis.call('GET', ARGV[1]..'task:'..id); if not data then return nil end
      local task = cjson.decode(data); if task.status ~= 'queued' then return nil end
      task.status = 'running'; task.updatedAt = ARGV[2]; task.attemptId = ARGV[4]; local updated = cjson.encode(task)
      redis.call('SET', ARGV[1]..'task:'..id, updated); redis.call('SADD', KEYS[2], id); return updated
    `,
      {
        keys: [this.key("queue"), this.key("running"), this.key("worker")],
        arguments: [this.prefix, now(), workerToken, randomUUID()],
      },
    );
    return typeof data === "string" ? JSON.parse(data) : null;
  }
  async finishTask(task: Task, workerToken: string) {
    task.updatedAt = now();
    // Both the process lease and this exact attempt must still own the receipt.
    // An old worker cannot overwrite a recovery, cancellation, or resumed task.
    return await this.redis.eval(
      `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
      local data = redis.call('GET',KEYS[2]); if not data then return 0 end
      local current = cjson.decode(data); if current.status ~= 'running' or current.attemptId ~= ARGV[2] then return 0 end
      redis.call('SET',KEYS[2],ARGV[3]); redis.call('SREM',KEYS[3],ARGV[4]); return 1`,
      {
        keys: [
          this.key("worker"),
          this.key(`task:${task.id}`),
          this.key("running"),
        ],
        arguments: [
          workerToken,
          task.attemptId ?? "",
          JSON.stringify(task),
          task.id,
        ],
      },
    );
  }
  async recoverTasks(workerToken: string) {
    // Interrupted work needs explicit resume; do not blindly replay side effects.
    for (const id of await this.redis.sMembers(this.key("running"))) {
      await this.redis.eval(
        `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
        local data = redis.call('GET',KEYS[2]); if data then local task = cjson.decode(data);
        if task.status == 'running' then task.status = 'interrupted'; redis.call('SET',KEYS[2],cjson.encode(task)) end end
        redis.call('SREM',KEYS[3],ARGV[2]); return 1`,
        {
          keys: [
            this.key("worker"),
            this.key(`task:${id}`),
            this.key("running"),
          ],
          arguments: [workerToken, id],
        },
      );
    }
  }
  async resumeTask(id: string, ownerId: string, answer?: string) {
    const task = await this.task(id, ownerId);
    if (!["interrupted", "waiting", "failed"].includes(task.status))
      throw new Fault("Task cannot be resumed in its current state", 409);
    if (task.status === "waiting" && !answer?.trim())
      throw new Fault("Answer the pending question before resuming");
    const continuation = answer
      ? `User clarification: ${answer}`
      : "Continue using the recorded progress.";
    const changed = await this.redis.eval(
      `local data = redis.call('GET',KEYS[1]); if not data then return 0 end
      local task = cjson.decode(data); if task.status ~= 'interrupted' and task.status ~= 'waiting' and task.status ~= 'failed' then return 0 end
      if task.status == 'waiting' and ARGV[4] == '' then return 0 end
      task.continuation = ARGV[1]; task.status = 'queued'; task.question = nil; task.updatedAt = ARGV[3];
      redis.call('SET',KEYS[1],cjson.encode(task)); redis.call('RPUSH',KEYS[2],ARGV[2]); return 1`,
      {
        keys: [this.key(`task:${id}`), this.key("queue")],
        arguments: [continuation, id, now(), answer?.trim() ?? ""],
      },
    );
    if (!changed) throw new Fault("Task state changed before resume", 409);
    return this.task(id, ownerId);
  }
  async cancelTask(id: string, ownerId: string) {
    await this.task(id, ownerId);
    await this.redis.eval(
      `local data = redis.call('GET',KEYS[1]); if not data then return 0 end
      local task = cjson.decode(data); if task.status == 'completed' or task.status == 'cancelled' then return 0 end
      task.status = 'cancelled'; task.updatedAt = ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(task));
      redis.call('LREM',KEYS[2],0,ARGV[1]); redis.call('SREM',KEYS[3],ARGV[1]); return 1`,
      {
        keys: [this.key(`task:${id}`), this.key("queue"), this.key("running")],
        arguments: [id, now()],
      },
    );
    return this.task(id, ownerId);
  }
  async importConversation(
    ownerId: string,
    sourceId: string,
    messages: ChatCompletionMessageParam[],
  ) {
    const firstUser = messages.find(
      (m) => m.role === "user" && typeof m.content === "string",
    );
    const session: Session = {
      id: randomUUID(),
      ownerId,
      title:
        typeof firstUser?.content === "string"
          ? firstUser.content.slice(0, 60)
          : "Imported conversation",
      createdAt: now(),
      updatedAt: now(),
    };
    // Mapping, history and index commit atomically. Retrying after a crash cannot
    // create a duplicate session, and the source keys are never modified.
    const result = await this.redis.eval(
      `local existing = redis.call('GET',KEYS[1]); if existing then return existing end
      redis.call('SET',KEYS[2],ARGV[1]); local messages = cjson.decode(ARGV[2]);
      for _, message in ipairs(messages) do redis.call('RPUSH',KEYS[3],message) end
      redis.call('ZADD',KEYS[4],ARGV[3],ARGV[4]); redis.call('SET',KEYS[1],ARGV[4]); return ARGV[4]`,
      {
        keys: [
          this.key(`import:${sourceId}`),
          this.key(`session:${session.id}`),
          this.key(`messages:${session.id}`),
          this.key(`sessions:${ownerId}`),
        ],
        arguments: [
          JSON.stringify(session),
          JSON.stringify(messages.map((m) => JSON.stringify(m))),
          String(Date.now()),
          session.id,
        ],
      },
    );
    return { id: String(result), imported: result === session.id };
  }
}
