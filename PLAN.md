# Server-Side Request Migration Plan

## 1. Goal

Move model requesting from the client runtime to the Node server so that:

- model API keys are only used on the server
- request orchestration can continue when the browser disconnects
- generation state can be persisted and resumed safely
- chat updates become server-owned instead of client-owned
- the browser becomes a thinner UI client instead of the main inference runtime

This plan is written for the current NodeOnly architecture in this repository.


## 2. Current State

Today, the project is not a true server-driven app. In Node mode:

- the server stores the canonical DB and assets
- the client still runs most chat logic
- the client still assembles prompts, chooses providers, performs streaming parsing, handles retries, and writes chat results back to storage

Important current files:

- client generation orchestration: `src/ts/process/index.svelte.ts`
- client request router: `src/ts/process/request/request.ts`
- provider implementations:
  - `src/ts/process/request/anthropic.ts`
  - `src/ts/process/request/openAI/requests.ts`
  - `src/ts/process/request/google.ts`
- client network layer: `src/ts/globalApi.svelte.ts`
- client Node storage adapter: `src/ts/storage/nodeStorage.ts`
- Node server entrypoint and storage/proxy routes: `server/node/server.cjs`
- existing server WebSocket job relay for local-network proxy streaming: `server/node/server.cjs`, `src/ts/network/proxyJobWs.ts`

This means features such as Claude batch polling are still client-owned even when the DB is stored on the server.


## 3. Target Architecture

The target architecture should have these properties:

- the Node server owns the full generation lifecycle
- the client sends an intent such as "generate a reply for chat X"
- the server loads canonical state, builds the prompt, calls the provider, handles tools/retries/fallbacks, and writes the final result to the DB
- the client receives streamed job events from the server and renders them
- disconnecting the browser does not stop provider polling or job completion
- reconnecting the browser can resume job observation from persisted server state

At the end state, the browser should still:

- render UI
- perform local UX state updates
- subscribe to generation events
- request refreshes from server storage

At the end state, the server should own:

- provider networking
- prompt assembly for canonical generation
- tool execution policy for server-safe tools
- retries and fallback model selection
- background jobs and batch polling
- final DB mutation


## 4. Non-Goals

This migration should not attempt all of the following at once:

- rewriting the entire server stack from CommonJS to TypeScript
- removing all client-side helper logic immediately
- making web-only mode fully equivalent to Node mode
- supporting every existing client-side plugin/tool on day one

Those can happen later. The first goal is correct server ownership of generation.


## 5. Constraints and Risks

### 5.1 Client-heavy code today

Current prompt construction and response handling are spread across many client modules and frequently depend on:

- `DBState.db`
- Svelte stores
- browser APIs
- local helper functions mixed into UI flow

This means code cannot simply be copied into the server unchanged.

### 5.2 Tool and plugin execution

The largest architectural risk is tool/plugin behavior.

Today, some model-side tool flows eventually call logic that assumes a client runtime. If generation moves server-side, each tool/plugin must be classified as one of:

- server-safe and runnable on the server
- client-only and callable through a client RPC bridge
- unsupported during server-owned generation

### 5.3 Canonical DB ownership

Right now the server stores the DB, but the client still acts like the main writer during generation. This creates race conditions if the server also starts writing generation results. A clear ownership model is required.

### 5.4 Platform scope

This migration plan assumes NodeOnly is the primary target. Web-only and Tauri can later be adapted, but should not drive the initial architecture.


## 6. Migration Principles

### 6.1 Move ownership, not just transport

Do not stop at "server proxies provider requests". That only centralizes secrets. The real goal is server ownership of:

- request lifecycle
- background continuity
- persistence
- cancellation
- idempotency

### 6.2 Preserve UX while changing internals

The UI should continue to feel stream-based. Internally, the server may use jobs plus WebSocket/SSE streams.

### 6.3 Keep an incremental rollout path

Introduce feature flags and parity checks so the project can migrate one layer at a time.

### 6.4 Extract pure logic before rewriting logic

Whenever possible, refactor reusable prompt or parsing logic into pure modules with no browser or Svelte dependency, then import those modules from the server.


## 7. Recommended End-State Flow

1. Client requests generation with chat target and options.
2. Server creates a persisted generation job.
3. Server loads canonical DB state from storage.
4. Server builds prompt from canonical state.
5. Server inserts or reserves a target message placeholder in DB.
6. Server runs provider request.
7. Server emits normalized events to subscribers.
8. Server writes incremental and final results to DB.
9. If the client disconnects, the job keeps running.
10. On reconnect, the client resubscribes or reloads chat state.


## 8. Proposed Server API

Introduce explicit generation APIs rather than routing generation through `/proxy2`.

### 8.1 Create generation

`POST /api/generations`

Request body example:

```json
{
  "characterId": "...",
  "chatId": "...",
  "mode": "model",
  "continue": false,
  "useStreaming": true,
  "overrideModel": null,
  "requestOptions": {
    "maxTokens": 4096,
    "temperature": 1,
    "previewPrompt": false
  }
}
```

Response example:

```json
{
  "jobId": "gen_...",
  "messageId": "msg_...",
  "status": "queued"
}
```

### 8.2 Subscribe to events

Choose one transport and standardize around it:

- preferred: WebSocket job stream, reusing the existing job-stream pattern
- acceptable: SSE for generation events

Suggested route:

- `GET /api/generations/:jobId/stream`

### 8.3 Poll status

- `GET /api/generations/:jobId`

### 8.4 Cancel job

- `POST /api/generations/:jobId/cancel`

### 8.5 Optional reconnect helpers

- `GET /api/generations/active`
- `GET /api/chats/:chatId/active-generation`


## 9. Normalized Server Event Model

Do not expose raw provider chunks to the browser. Normalize them first.

Suggested event types:

- `job_created`
- `status`
- `message_placeholder`
- `delta`
- `tool_call_started`
- `tool_call_finished`
- `provider_retry`
- `provider_warning`
- `completed`
- `failed`
- `canceled`

Example stream payloads:

```json
{ "type": "delta", "jobId": "gen_1", "text": "Hello" }
{ "type": "status", "jobId": "gen_1", "status": "waiting_for_batch_result" }
{ "type": "completed", "jobId": "gen_1", "messageId": "msg_1" }
```

This gives the client a stable interface even if provider logic changes later.


## 10. Persistent Job Model

Add server-side persistence for generation jobs. Since NodeOnly already uses SQLite, store job data in dedicated tables in the same server database.

Suggested tables:

### 10.1 `generation_jobs`

- `id`
- `chat_id`
- `character_id`
- `message_id`
- `status` (`queued`, `running`, `awaiting_batch`, `awaiting_tool`, `completed`, `failed`, `canceled`, `stale`)
- `provider`
- `model`
- `request_payload_json`
- `request_hash`
- `result_text`
- `error_json`
- `batch_id`
- `created_at`
- `updated_at`
- `completed_at`
- `owner_session_id` or equivalent auth identity metadata if needed

### 10.2 `generation_job_events`

- `id`
- `job_id`
- `seq`
- `type`
- `payload_json`
- `created_at`

### 10.3 Optional `generation_locks`

Use if needed to ensure only one active generation writes to a given chat/message target.

Why store events:

- reconnect support
- debugging
- idempotent replay
- operator visibility


## 11. DB Ownership Model

The migration only works cleanly if the server becomes the writer of generation-side chat updates.

Recommended rule:

- user edits may still originate from the client
- generation-created and generation-updated messages are server-owned
- the client should not directly write model output into the DB during a server-owned generation

That implies:

- the server must create or reserve the assistant message target
- the server must apply streamed updates to the canonical DB
- the client should re-read or patch local state from server events rather than treating local memory as authoritative

This is the key behavioral change required to make background completion reliable.


## 12. Workstreams

The migration should be split into parallel workstreams.

### 12.1 Workstream A: Server generation job framework

Add to `server/node/`:

- generation job registry
- SQLite-backed job persistence
- event publisher/subscriber transport
- cancellation handling
- reconnect support

This workstream can reuse ideas from the existing proxy stream job implementation in `server/node/server.cjs`.

### 12.2 Workstream B: Provider execution service

Create server provider modules such as:

- `server/node/generation/providers/anthropic.cjs`
- `server/node/generation/providers/openai.cjs`
- `server/node/generation/providers/google.cjs`

Responsibilities:

- provider HTTP calls
- streaming parsing
- retry rules
- timeout policy
- batch polling
- tool-call result conversion

### 12.3 Workstream C: Prompt assembly migration

Refactor client code into server-safe pure modules for:

- prompt formatting
- chat serialization
- lorebook context assembly
- memory selection
- model parameter application

This will likely require extracting logic from files like:

- `src/ts/process/index.svelte.ts`
- `src/ts/process/request/request.ts`
- `src/ts/process/request/shared.ts`
- prompt and model helper modules under `src/ts/process/`

### 12.4 Workstream D: Tool/plugin policy

Define a compatibility matrix:

- server-native tools
- client-bridged tools
- unsupported tools

Then implement only the first category in the initial rollout.

### 12.5 Workstream E: Client transport and UI changes

Replace direct provider requests with generation job APIs.

The client should:

- create jobs
- subscribe to event streams
- render deltas
- handle reconnects
- stop directly owning generation persistence


## 13. Phased Migration Plan

## Phase 0: Discovery and Instrumentation

Goal:

- map exactly which client modules are generation-critical
- add observability before behavior changes

Tasks:

- inventory all call sites of `requestChatData()`
- inventory all provider-specific request modules
- inventory all modules that mutate chat state during generation
- inventory all tool/plugin entry points triggered during generation
- add structured server logs for new generation jobs
- add client logs or metrics for parity comparison

Deliverables:

- architecture inventory document
- list of server-safe vs client-bound generation dependencies

Exit criteria:

- every current generation path is known
- every current persistence touchpoint is known


## Phase 1: Server Job Infrastructure

Goal:

- create a durable server-side generation framework before moving provider logic

Tasks:

- add SQLite tables for generation jobs and events
- add in-memory job runner with DB persistence
- add routes:
  - `POST /api/generations`
  - `GET /api/generations/:jobId`
  - `POST /api/generations/:jobId/cancel`
  - `GET /api/generations/:jobId/stream`
- implement job event broadcasting
- implement resume behavior for reconnecting clients
- add stale-job cleanup and retention policy

Suggested implementation detail:

- reuse the existing server-side job and WebSocket patterns from proxy stream jobs, but keep generation jobs as a separate subsystem

Exit criteria:

- server can create, persist, stream, cancel, and recover a no-op or mock generation job


## Phase 2: Provider Calls on the Server (Transport-Only Stage)

Goal:

- move provider HTTP calls to the server first while keeping prompt assembly client-side temporarily

Tasks:

- add server provider adapters that accept already-built request payloads
- move model API key usage to server provider adapters
- normalize streaming to server event format
- support at least:
  - Anthropic standard requests
  - OpenAI-compatible requests
  - Google/Gemini requests
- keep existing client request-building logic for now

Temporary architecture:

- client still assembles request payloads
- client sends payloads to the server
- server performs upstream calls and returns normalized events

Benefits of this step:

- secrets leave the browser
- server-controlled retries and timeouts become possible
- existing client behavior changes less at first

Limitations of this step:

- client still owns too much canonical generation logic
- background completion is only partial until DB writes also move

Exit criteria:

- direct browser-to-provider requests are no longer needed for supported providers in Node mode


## Phase 3: Client Event Consumption

Goal:

- make the client consume server generation events instead of provider streams

Tasks:

- add client API wrapper for generation jobs
- replace `requestChatData()` usage in main chat flow with job creation + event subscription
- adapt the message rendering loop in `src/ts/process/index.svelte.ts`
- stop parsing raw provider-specific chunks in the browser for migrated providers
- add reconnect behavior to resume event streams or reload latest job status

Recommended short-term behavior:

- the client may still update the currently visible message from stream events
- but it should treat those updates as server-originated, not locally authoritative

Exit criteria:

- the browser no longer needs provider-specific chunk parsing for migrated paths


## Phase 4: Prompt Assembly Migration

Goal:

- move prompt-building logic from the client to the server

Tasks:

- extract pure helpers from the client codebase into reusable modules
- create a server generation context builder that loads canonical state and computes:
  - selected character and chat
  - prompts and prompt toggles
  - lorebook injections
  - memory context
  - model parameters
  - fallback model chain
- remove server dependence on client-assembled request payloads

Important requirement:

- the server must not depend on browser APIs or Svelte store globals for prompt construction

Recommended approach:

- add a shared pure logic layer for generation under a new folder such as `src/common/generation/` or another server-importable location
- keep UI-bound code in `src/ts/`

Exit criteria:

- the server can generate a provider request starting only from canonical DB state and a generation command


## Phase 5: Server-Owned DB Mutation

Goal:

- make the server the canonical writer for generation results

Tasks:

- define stable message IDs if not already present everywhere needed
- when a job starts, the server inserts or reserves the assistant message target
- during streaming, the server updates the message text in canonical storage
- on completion, the server commits the final message state and metadata
- on failure or cancellation, the server records the correct terminal state

Concurrency rules to define:

- what happens if the user edits the chat while generation is running
- what happens if multiple tabs try to generate simultaneously
- what happens if a target message was deleted while a job was active

Recommended policy:

- one active assistant generation per chat target by default
- rejected or queued concurrent requests for the same target
- stale-job detection if the underlying chat state changes incompatibly

Exit criteria:

- disconnecting the client no longer loses the final model result


## Phase 6: Batch, Retry, and Disconnect Reliability

Goal:

- ensure all long-running provider flows survive client disconnects

Tasks:

- move Claude batch creation, polling, cancel, and result fetch to the server
- persist `batch_id` and status transitions in `generation_jobs`
- ensure cancellation rules are explicit and idempotent
- ensure reconnecting clients can discover active jobs and render their current state
- add background polling for jobs with no active subscribers

This phase fixes the specific class of problem discussed earlier: remote provider work continues even when the original client session disappears.

Exit criteria:

- long-running Anthropic batch jobs complete and update DB without an active browser session


## Phase 7: Tool and Plugin Support

Goal:

- recover functional parity for advanced tool and plugin workflows

Tasks:

- classify every generation-time tool/plugin path
- implement server-native execution for safe tools
- design a client RPC bridge for explicitly client-only tools if needed
- expose tool lifecycle through server event streams
- add guardrails for unsupported plugin APIs

Recommended rollout order:

1. text-only generation
2. server-safe tool calling
3. optional client-bridged tools
4. full plugin parity if justified

Exit criteria:

- supported tool categories behave predictably under server-owned generation


## Phase 8: Cleanup and Deletion of Legacy Paths

Goal:

- remove duplicated client generation code after parity is proven

Tasks:

- deprecate migrated branches in `src/ts/process/request/*`
- simplify `src/ts/globalApi.svelte.ts` where provider networking is no longer needed client-side
- remove obsolete client retry/stream parsing code
- narrow `requestChatData()` into either:
  - a client wrapper around server generation APIs, or
  - a server-only internal module if no client usage remains

Exit criteria:

- one canonical generation path exists for Node mode


## 14. Detailed Module Change Plan

### 14.1 Client modules to shrink or replace

- `src/ts/process/index.svelte.ts`
  - remove direct provider request ownership
  - keep UI orchestration and event rendering

- `src/ts/process/request/request.ts`
  - replace provider routing with server generation client
  - keep compatibility wrapper temporarily if needed

- `src/ts/process/request/anthropic.ts`
  - split reusable request-shaping helpers from client-only flow
  - move provider execution to server module

- `src/ts/process/request/openAI/requests.ts`
  - same pattern as Anthropic

- `src/ts/process/request/google.ts`
  - same pattern as Anthropic

- `src/ts/globalApi.svelte.ts`
  - generation-related provider networking becomes unnecessary for migrated paths
  - keep storage/auth/general fetch utilities

### 14.2 Server modules to add

- `server/node/generation/jobs.cjs`
- `server/node/generation/events.cjs`
- `server/node/generation/providers/anthropic.cjs`
- `server/node/generation/providers/openai.cjs`
- `server/node/generation/providers/google.cjs`
- `server/node/generation/promptBuilder.cjs`
- `server/node/generation/toolRunner.cjs`
- `server/node/generation/dbWriter.cjs`
- `server/node/generation/routes.cjs`

### 14.3 Shared modules to extract

Extract pure, environment-agnostic logic from `src/ts/` into a shared location. Candidate categories:

- request parameter normalization
- chat-to-provider message serialization
- prompt assembly helpers
- tool-call encoding/decoding where browser APIs are not required
- response block normalization


## 15. Compatibility Strategy

Use feature flags so the migration can ship incrementally.

Suggested flags:

- `serverGenerationEnabled`
- `serverGenerationPromptBuildEnabled`
- `serverGenerationDbWritesEnabled`
- `serverGenerationAnthropicBatchEnabled`
- `serverGenerationToolsEnabled`

Recommended rollout path:

1. internal/dev only
2. opt-in per server config
3. opt-in per user or model family
4. default on for stable providers
5. remove old path once parity is confirmed


## 16. Data Consistency and Idempotency

This must be designed early.

Rules to implement:

- every generation request gets a unique job ID
- every target assistant message gets a stable message ID
- server writes must be idempotent by job ID and message ID
- replaying a terminal event must not duplicate message insertion
- cancel requests must be safe to repeat
- reconnect subscriptions must be safe to repeat

Recommended technique:

- keep a `last_applied_event_seq` or equivalent per job/message target
- append events before applying external side effects where useful


## 17. Security Changes

Benefits of the migration:

- provider API keys no longer need to leave the server
- server can enforce allowed upstream hosts
- server can centralize timeout, retry, and rate-limiting policies

Additional requirements:

- ensure generation routes use the same auth/session checks as storage routes
- ensure stored request payloads do not leak secrets into logs or DB tables
- sanitize debug payloads before persistence
- gate admin or debug inspection routes carefully


## 18. Testing Strategy

### 18.1 Unit tests

- provider response normalization
- event sequencing
- cancellation transitions
- idempotent DB write logic
- prompt assembly parity against current client behavior

### 18.2 Integration tests

- create generation and stream deltas
- reconnect during active generation
- cancel active generation
- complete Anthropic batch after client disconnect
- tool call success/failure paths
- fallback model retry behavior

### 18.3 Regression tests

- compare old client-generated request payloads with new server-generated payloads for the same DB snapshot
- compare final outputs where deterministic stubs are possible

### 18.4 Manual scenarios

- browser refresh during generation
- mobile reconnection after sleep
- multi-tab same chat generation attempts
- edit chat while generation is in flight
- server restart during queued or active jobs


## 19. Observability

Add operator visibility before broad rollout.

Recommended logs and metrics:

- job creation count
- active job count
- provider latency
- stream duration
- cancel count
- retry count
- batch wait duration
- resume-after-disconnect count
- failed DB write count

Recommended debug views:

- server route to inspect active jobs
- NodeOnly admin UI panel for recent jobs and failures


## 20. Suggested Delivery Order

The safest practical order is:

1. build server job infrastructure
2. move provider transport to server
3. switch client to server event consumption
4. migrate prompt construction to server
5. move DB writes to server ownership
6. migrate Anthropic batch/background handling
7. migrate tool/plugin support
8. delete obsolete client request paths

Do not start with tool/plugin parity. That is the highest-complexity area and should come after the basic server generation pipeline is stable.


## 21. Acceptance Criteria for Completion

The migration is complete when all of the following are true in Node mode:

- the browser no longer calls model providers directly
- provider API keys remain server-side
- the server can generate from canonical DB state without client-built provider payloads
- the server writes generation results into the canonical DB
- disconnecting the browser does not lose long-running generation results
- reconnecting the browser can observe or reload active/completed generation state
- at least Anthropic, OpenAI-compatible, and Google paths run through the new pipeline
- advanced tool/plugin support has an explicit supported/unsupported policy
- legacy client-owned generation paths are removed or disabled for migrated providers


## 22. Recommendation

Do this as a staged migration, not a rewrite.

The best first milestone is not full prompt migration. The best first milestone is:

- server generation jobs
- server provider transport
- normalized event streaming

That gets immediate wins in secret handling, background continuity, and architectural direction while keeping prompt parity risk lower.

After that, move prompt assembly and DB mutation to the server, which is the real point where the application becomes genuinely server-driven.
