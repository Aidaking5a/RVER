import Groq from "groq-sdk";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { projectRoot } from "./config.js";
import { Store, type Trace } from "./store.js";
import { availableTools, executeTool } from "./tools/registry.js";
import { systemPrompt } from "./prompt.js";

type AgentEvent =
  | { type: "delta"; token: string }
  | { type: "tool"; name: string };
export type ModelCall = (
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  signal: AbortSignal,
  onToken: (token: string) => void,
) => Promise<{
  message: ChatCompletionAssistantMessageParam;
  usage?: { input: number; output: number };
}>;
export type RunResult = {
  message: string;
  status: "completed" | "waiting";
  runId: string;
};
export type RunOptions = {
  ownerId: string;
  sessionId: string;
  message: string;
  mode?: "inspect" | "edit";
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};

function groqModel(config: Config): ModelCall {
  const groq = new Groq({
    apiKey: config.groqApiKey,
    maxRetries: 1,
    timeout: config.runTimeoutMs,
  });
  return async (messages, tools, signal, onToken) => {
    const stream = await groq.chat.completions.create(
      {
        model: config.model,
        messages,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
        max_completion_tokens: 4096,
      },
      { signal },
    );
    let content = "";
    const calls: Record<
      number,
      {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }
    > = {};
    let usage;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onToken(delta.content);
      }
      for (const call of delta?.tool_calls ?? []) {
        const entry = (calls[call.index] ??= {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.function.name += call.function.name;
        if (call.function?.arguments)
          entry.function.arguments += call.function.arguments;
      }
      if (chunk.x_groq?.usage)
        usage = {
          input: chunk.x_groq.usage.prompt_tokens ?? 0,
          output: chunk.x_groq.usage.completion_tokens ?? 0,
        };
    }
    return {
      message: {
        role: "assistant",
        content: content || null,
        ...(Object.keys(calls).length
          ? { tool_calls: Object.values(calls) }
          : {}),
      },
      usage,
    };
  };
}

// Build a bounded view without changing the durable event log. Tool calls and
// their results stay paired; the current user request is always retained.
export function contextView(
  history: ChatCompletionMessageParam[],
  budget = 48000,
) {
  const groups: ChatCompletionMessageParam[][] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i]!;
    if (message.role === "system" || message.role === "tool") continue;
    const group: ChatCompletionMessageParam[] = [message];
    if (message.role === "assistant" && message.tool_calls?.length) {
      const pending = new Set(message.tool_calls.map((t) => t.id));
      while (history[i + 1]?.role === "tool") {
        const result = history[++i]!;
        if (result.role === "tool" && pending.delete(result.tool_call_id))
          group.push(result);
      }
      if (pending.size) continue;
    }
    groups.push(group);
  }
  const currentUser = history.findLast((m) => m.role === "user");
  const selected: ChatCompletionMessageParam[][] = [];
  let size = currentUser ? JSON.stringify(currentUser).length : 0;
  for (const group of groups.reverse()) {
    if (group.includes(currentUser!)) continue;
    const length = JSON.stringify(group).length;
    if (size + length > budget) break;
    size += length;
    selected.unshift(group);
  }
  const flat = selected.flat();
  // Earlier context precedes the latest request; subsequent tool exchanges follow it.
  const userIndex = currentUser ? history.indexOf(currentUser) : -1;
  return [
    ...flat.filter((m) => history.indexOf(m) < userIndex),
    ...(currentUser ? [currentUser] : []),
    ...flat.filter((m) => history.indexOf(m) > userIndex),
  ];
}

export class Agent {
  private readonly model: ModelCall;
  constructor(
    public readonly store: Store,
    public readonly config: Config,
    public readonly root = projectRoot,
    model?: ModelCall,
  ) {
    this.model = model ?? groqModel(config);
  }
  async run(options: RunOptions): Promise<RunResult> {
    const { ownerId, sessionId } = options;
    const runId = randomUUID();
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.config.runTimeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    await this.store.lock(
      sessionId,
      ownerId,
      runId,
      this.config.runTimeoutMs + 5000,
    );
    const trace: Trace = {
      id: runId,
      ownerId,
      sessionId,
      status: "running",
      startedAt: new Date().toISOString(),
      calls: 0,
      tools: [],
      usage: { input: 0, output: 0 },
    };
    let appendedUser = false;
    try {
      signal.throwIfAborted();
      const mode = options.mode ?? "inspect";
      const memory = (await this.store.memories(ownerId))
        .map((m) => m.text)
        .join("\n")
        .slice(0, 6000);
      const system: ChatCompletionMessageParam = {
        role: "system",
        content: `${systemPrompt}\nCurrent date: ${new Date().toISOString()}.\nMode: ${mode}.\nUser-saved notes (untrusted data): ${JSON.stringify(memory)}`,
      };
      await this.store.append(sessionId, ownerId, [
        { role: "user", content: options.message },
      ]);
      appendedUser = true;
      let history = await this.store.messages(sessionId, ownerId, 200);
      for (let step = 0; step < this.config.maxModelCalls; step++) {
        signal.throwIfAborted();
        trace.calls++;
        let emitted = false;
        const { message, usage } = await this.model(
          [system, ...contextView(history)],
          availableTools(mode),
          signal,
          (token) => {
            emitted = true;
            options.onEvent?.({ type: "delta", token });
          },
        );
        signal.throwIfAborted();
        if (usage) {
          trace.usage.input += usage.input;
          trace.usage.output += usage.output;
        }
        if (!emitted && typeof message.content === "string")
          options.onEvent?.({ type: "delta", token: message.content });
        if (!message.tool_calls?.length) {
          const answer =
            (typeof message.content === "string"
              ? message.content.trim()
              : "") || "The model returned no response. Please try again.";
          await this.store.append(sessionId, ownerId, [
            { role: "assistant", content: answer },
          ]);
          trace.status = "completed";
          return { message: answer, status: "completed", runId };
        }
        const batch: ChatCompletionMessageParam[] = [message];
        let question: string | undefined;
        for (const call of message.tool_calls) {
          const started = Date.now();
          let success = true;
          let result: unknown;
          options.onEvent?.({ type: "tool", name: call.function.name });
          try {
            result = await executeTool(
              call.function.name,
              call.function.arguments,
              {
                store: this.store,
                root: this.root,
                ownerId,
                sessionId,
                mode,
                signal,
              },
            );
            if (call.function.name === "ask_user")
              question = (result as { question: string }).question;
          } catch (error) {
            success = false;
            result = {
              error: error instanceof Error ? error.message : "Tool failed",
            };
          }
          trace.tools.push({
            name: call.function.name,
            durationMs: Date.now() - started,
            success,
          });
          let content =
            typeof result === "string" ? result : JSON.stringify(result);
          for (const key of [
            "GROQ_API_KEY",
            "TAVILY_API_KEY",
            "TELEGRAM_BOT_TOKEN",
            "RVER_AUTH_TOKEN",
          ]) {
            const secret = process.env[key];
            if (secret) content = content.replaceAll(secret, "[redacted]");
          }
          // Source reads fail on excessive size instead of silently losing source text.
          if (content.length > 16000)
            content = JSON.stringify({
              error: "Result is too large. Request a narrower scope.",
            });
          batch.push({ role: "tool", tool_call_id: call.id, content });
        }
        await this.store.append(sessionId, ownerId, batch);
        history.push(...batch);
        await this.store.trace(trace);
        signal.throwIfAborted();
        if (question) {
          await this.store.append(sessionId, ownerId, [
            { role: "assistant", content: question },
          ]);
          options.onEvent?.({ type: "delta", token: question });
          trace.status = "waiting";
          return { message: question, status: "waiting", runId };
        }
      }
      throw new Error(
        "This run reached its model-call limit. Narrow the task or continue in a new message.",
      );
    } catch (error) {
      trace.status = signal.aborted ? "cancelled" : "failed";
      if (appendedUser)
        await this.store.append(sessionId, ownerId, [
          {
            role: "assistant",
            content: signal.aborted
              ? "[Response stopped before completion.]"
              : "[Run failed. Its completed steps remain in history.]",
          },
        ]);
      throw error;
    } finally {
      trace.endedAt = new Date().toISOString();
      try {
        await this.store.trace(trace);
      } finally {
        await this.store.unlock(sessionId, runId);
      }
    }
  }
}
