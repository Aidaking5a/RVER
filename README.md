# RVER

A local personal AI assistant with browser chat, optional private Telegram access, persistent conversation history, explicit cross-chat memory, a recoverable task queue, and reviewed project edits.

RVER uses TypeScript, Fastify, Groq, and Redis. It runs on loopback for one trusted operator. It is not a hosted multi-user service or a container sandbox for arbitrary code execution.

## Start

Install Node **24.18 or later in the 24.x line**, Corepack/pnpm, and Docker Desktop (or Docker Engine with Compose).

```sh
corepack enable
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` and set `GROQ_API_KEY`. `TAVILY_API_KEY` enables web research. To use Telegram, set both `TELEGRAM_BOT_TOKEN` and your numeric `TELEGRAM_ALLOWED_USER_ID`.

```sh
pnpm run setup
pnpm run doctor --live
pnpm dev
```

Open [localhost:3000](http://localhost:3000). Sign in with `RVER_AUTH_TOKEN` from your local `.env`; setup generates it without replacing your provider credentials. Treat this access key as a password. Keep `.env` private.

`pnpm run setup` starts only the `rver` Redis Compose service, published at `127.0.0.1:6387`. Its named volume and append-only log retain data across restarts. `docker compose down` keeps the volume; `docker compose down -v` deletes it. Redis AOF uses a one-second fsync interval, so a sudden host failure can lose approximately the last second of writes. Back up the Redis volume for independent recovery.

Use `pnpm build` followed by `pnpm start` to run compiled code. Development uses `tsx` without automatic restart, so applying an edit does not restart a live task halfway through its work. Restart after a verified source change.

## Upgrade from the original prototype

The original code used Redis on port 6379 and keys such as `conversation:<id>`. The new environment uses port 6387 and a versioned key namespace. Stop the old gateway, keep its Redis data, then explicitly import the browser conversations you own:

```sh
pnpm run migrate --from redis://127.0.0.1:6379 --client <old-rver-client-id>
```

The old client ID is `rver-client-id` in the old browser's localStorage. For a specific conversation or Telegram chat, use `--session <old-session-id>` instead. The importer maps the selected history to the authenticated operator, preserves source keys, and is safe to rerun. It cannot recover turns already deleted by the old trimming logic. Back up the original Redis data before retiring it.

## Daily use

- **Chat:** history is preserved in Redis. The model receives a bounded view; earlier stored messages remain available through “Load earlier messages.” One active response per conversation is enforced by Redis.
- **Memory:** open Memory to explicitly save or forget notes. Notes are shared by your authenticated browser and permitted private Telegram user. The agent can search the latest 100 sessions (up to 1,000 recent events each); this is bounded recall, not unlimited or perfect memory. Up to 40 notes of 1,000 characters each are retained; at most 6,000 characters are included in a model request.
- **Project edits:** enable “Allow edit proposals,” then ask for a change. Review the exact replacement and choose Apply or Reject. The model has no direct file-write tool. Proposals expire after one hour. Applying checks ownership, the original file hash, and a unique matching snippet. Existing regular files up to 100 KB are supported; hidden paths, dependencies, credentials, traversal, and symlinks are blocked. External editor changes invalidate a stale proposal. File application uses an application lock; it is not a filesystem transaction against unrelated external writers.
- **Tasks:** queue read-only work in Tasks. The gateway processes one task at a time. A clarification pauses it for your answer. Interrupted tasks wait for an explicit Resume instead of automatically repeating actions. Closing the browser does not stop queued work; stopping the gateway does. Queued work cannot apply edits or create more queued tasks.
- **Run history:** inspect model-call counts, token usage reported by Groq, tool timing, and success/failure. Traces retain metadata for seven days; tool arguments, provider credentials, and raw model reasoning are not included.
- **Telegram:** start `pnpm telegram` in another terminal. Only the configured user in a private chat is admitted. `/new`, `/remember <note>`, `/queue <task>`, and `/tasks` use the same state and agent. Keep the web gateway running to process queued tasks. Bot credentials can be checked with `getMe`; the doctor never sends a Telegram message.

The currently supported model is configured by `GROQ_MODEL` (default `openai/gpt-oss-120b`). Changing it requires a Groq model that supports streaming and function calls; rerun the live doctor afterward. `MAX_MODEL_CALLS` and `RUN_TIMEOUT_MS` bound each invocation. Third-party API calls have additional 15-second timeouts.

## Verify and maintain

```sh
pnpm check
pnpm test
pnpm build
pnpm run doctor          # config + actual Redis round trip
pnpm run doctor --live   # actual Groq tool call, Tavily search/extract, weather, Telegram getMe
```

Tests use real Redis with unique disposable key prefixes. They cover history, ownership, concurrency locks, tool validation, cancellation, source reads, reviewed edits, API authentication/validation, streaming lifecycle, and queued-task clarification/recovery. Paid model and network boundaries are substituted in automated tests; `doctor --live` checks actual providers with small requests. Neither command promises end-to-end Telegram delivery or Internet deployment readiness.

The public CI starts its own Redis service and runs compilation, tests, and the build without provider keys. Keep documentation aligned with actual commands. Prefer shared runtime paths and focused regression tests to duplicated handlers. Runtime modules and operational scripts are deliberately small; no frontend framework, plugin scaffolding, or generated project reports are required.

Optional maintenance checks run temporarily, without installing project dependencies:

```sh
pnpm dlx knip@6.44.1
pnpm dlx jscpd@5.4.2 src public scripts --min-lines 12 --min-tokens 90 --reporters console --no-tips
```

## HTTP API

`POST /api/login` accepts `{ "token": "your-local-access-key" }` and sets a same-site HTTP-only cookie. Script clients may instead send `Authorization: Bearer <RVER_AUTH_TOKEN>`. Never put it in a URL. Mutating browser requests must have the gateway's own origin. Requests are schema-validated and rate-limited.

- `GET/POST /api/sessions`; `GET /api/sessions/:id/messages?before=<event-offset>`
- `POST /api/sessions/:id/chat` or `/stream` with `{ "message": "...", "mode": "inspect" }` (`edit` enables proposals)
- `GET/POST /api/memories`; `DELETE /api/memories/:id`
- `GET /api/sessions/:id/edits`; `POST /api/edits/:id` with `{ "action": "approve" }` or `reject`
- `GET/POST /api/tasks`; `POST /api/tasks/:id` with `resume`/`cancel` action and an optional clarification `answer`
- `GET /api/runs`; `GET /health`; `POST /api/logout`

Source sent to model tools and messages sent to the assistant are transmitted to Groq. Web queries and requested public URLs are transmitted to Tavily. Avoid submitting secrets. Markdown is sanitized using the installed DOMPurify package; both browser libraries are served locally with a restrictive content security policy.

## Design references

RVER borrows concepts, not source code, from [OpenClaw's permission boundaries](https://docs.openclaw.ai/gateway/security/tool-permissions), [Hermes's curated memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), and [Google's separation of durable state and working context](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/). Framework migration and multi-agent orchestration are deferred until a concrete need justifies them.

MIT licensed. See [LICENSE](LICENSE).
