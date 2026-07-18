# Project Workspace Redesign Plan

## Purpose

Redesign ReDDone from a project-card tracker with a disabled chat prototype into a **chat-first, project-scoped workspace**. Each project will have durable multi-threaded conversations where the owner can ask about canonical state, request safe changes, initiate existing workflows, and follow streamed agent progress.

The structured project views—overview, evidence, specification, builds, releases, and settings—remain the source of truth. Chat is a control surface over the same domain commands and workflows, not a competing data store.

The existing encrypted per-project secrets vault remains the sole secrets system. The workspace will surface a write-only, metadata-only secrets manager; secret values must never enter a chat transcript, agent context, event stream, or API response.

## Confirmed product decisions

| Decision | Direction |
| --- | --- |
| Conversation location | Per-project workspace at `/projects/[projectId]` |
| Project list | `/projects` remains the portfolio dashboard and project creation entry point |
| Conversation organization | Multiple named, durable threads per project |
| Secret display | Metadata only: name, version, state, grant status, and timestamps; never value or suffix |
| Change authority | Per-project modes: read-only, review, and policy-limited autopilot |

## Workspace information architecture

### Portfolio dashboard

Keep `/projects` as the portfolio-level view for search, attention queue, current blockers, project creation, and project status. Update project cards so their primary action opens that project’s workspace.

### Project workspace

Make `/projects/[projectId]` the primary workspace route. Desktop layout:

1. **Thread sidebar** — named conversations for the selected project, with active/responding indicators.
2. **Conversation canvas** — durable transcript, streaming response, composer, action proposal cards, and workflow reference cards.
3. **Context rail** — lifecycle stage, current blocker, pending approvals, active workflow, recent activity, and runtime-secret readiness.

On mobile, the transcript is the primary surface. Threads, project context, and secrets are opened in accessible sheets.

### Structured views

Move the current root `OverviewView` to `/projects/[projectId]/overview`. Keep existing evidence, specification, builds, releases, and settings routes. Add **Conversation** as the first `ProjectTabs` destination.

### Compatibility routes

- `/chat?projectId=<id>` redirects to the project workspace.
- `/chat` redirects to `/projects`.
- Keep the old chat API for one release as a delegating compatibility endpoint, then remove it once callers have migrated.

## Authority model

Chat has three project-level modes. Every mode is still subject to the current project, specification, workflow, budget, verification, approval, and secret constraints.

| Mode | Agent capabilities |
| --- | --- |
| **Read-only** | Reads canonical project state and answers questions. No project mutations. |
| **Review** | Creates a versioned proposal card with a before/after diff. The owner confirms before a command runs. |
| **Autopilot** | Automatically executes only policy-classified, reversible, low-risk commands. It records the outcome in the transcript and audit trail. |

The following boundaries cannot be bypassed by autopilot:

- No secret-value input, retrieval, reveal, or decryption.
- No secret grant/revocation approval through chat.
- No release, rollback, or other approval decisions through chat.
- No provider account changes.
- No bypass of approved ProductSpec, budget, verification, artifact, or release-approval requirements.
- No generic SQL, shell, HTTP, filesystem, vault, provider, or arbitrary Daytona tool.

## Durable conversation model

Add additive Prisma models and migration support in `prisma/schema.prisma`.

### `ProjectConversation`

A named conversation scoped to one workspace and project. It stores title, optional compact historical summary, optimistic version, archived state, and last-activity timestamp.

### `ConversationMessage`

Immutable owner, agent, and system messages with a monotonic per-conversation sequence, safe content hash, sanitized metadata, author identity, and timestamps.

### `ConversationTurn`

Represents a user message and its durable agent execution. Store status, version, idempotency key, authority mode at start, project version at start, model/prompt/toolset versions, bounded cost reservation, usage, partial response snapshot, cancellation state, and safe failure metadata.

### `ConversationTurnEvent`

Stores ordered semantic events and coalesced text deltas for replayable streaming. Persist final messages under transcript-retention policy, while expiring high-volume deltas on a short retention schedule.

### `ConversationAction`

Represents a typed proposed or executed domain command. Store command name/schema version, canonical payload/hash, expected project version, risk, expiration, status, result reference, and audit linkage.

### Related schema constraints

- Bind every row to workspace and project through composite foreign keys.
- Keep per-conversation message/event sequences unique and indexed for cursor reads.
- Enforce turn/action idempotency.
- Use a partial index so only one turn can be active in a conversation at a time.
- Generalize usage and budget reservations so each record belongs to exactly one `WorkflowRun` or `ConversationTurn`.
- Create conversations lazily for existing projects; no legacy chat data needs migration because the current chat is browser-memory-only.

## API and streaming design

Add strict Zod contracts in `src/contracts/conversation.ts` and project-scoped endpoints under `src/app/api/v1/projects/[projectId]/conversation/`.

| Endpoint | Purpose |
| --- | --- |
| `GET /` | List project conversations and selected-thread metadata. |
| `POST /` | Create a named conversation. |
| `GET /[conversationId]` | Return cursor-paginated messages, active turn, and pending actions. |
| `POST /[conversationId]/turns` | Persist an owner message, queue durable agent work, and return `202` plus a stream URL. |
| `GET /[conversationId]/turns/[turnId]/events` | Authenticated SSE with cursor replay via `Last-Event-ID`. |
| `POST /[conversationId]/turns/[turnId]/cancel` | Request durable cancellation and cleanup. |
| `POST /[conversationId]/actions/[actionId]/execute` | Execute a valid, authorized, non-stale action. |
| `POST /[conversationId]/actions/[actionId]/dismiss` | Dismiss an action proposal. |
| `GET /activity` | Return cursor-paginated canonical project activity for the context rail. |

Reuse `mutationContext`, same-origin validation, `Idempotency-Key`, and optimistic `If-Match` protections from `src/workflows/http.ts` for every mutation.

### SSE events

Only emit typed, safe events:

- `turn.started`
- `agent.status`
- `tool.started`
- `tool.completed`
- `assistant.delta`
- `action.proposed`
- `assistant.completed`
- `turn.failed`
- `turn.canceled`
- `turn.completed`

Never stream raw model-provider objects, tool arguments, raw tool results, Daytona IDs, stack traces, secret metadata, ciphertext/envelope fields, or secret suffixes.

SSE connections remain bounded in duration. The durable turn continues after a browser disconnect; clients reconnect with `Last-Event-ID` and replay persisted events.

## Agent and Daytona architecture

### Durable execution

Create:

- `src/workflows/conversation-agent.ts` — claims turns, builds context, executes the bounded tool loop, sanitizes/finalizes the agent message, records usage, and handles terminal state.
- `src/workflows/conversation-dispatch.ts` — dispatches/reconciles conversation outbox events and cancellation recovery.
- `src/server/conversation-repository.ts` — persists threads, messages, turns, and pagination.
- `src/server/conversation-events.ts` — safely coalesces and serializes stream events.
- `src/server/conversation-actions.ts` — creates, validates, executes, dismisses, expires, and audits actions.

### Agent tools

Define a static typed registry under `src/server/project-agent/`. Every tool has strict input/output Zod schemas, a byte limit, and trusted project/workspace context.

Initial read tools:

- Project summary and lifecycle
- Findings and evidence
- ProductSpec
- Runs and run activity
- Approvals and schedules
- Runtime-secret metadata
- Provider readiness

Initial proposal/command families:

- Project metadata update
- Pause/resume
- Schedule updates
- Finding selection
- ProductSpec updates
- Start/cancel/retry runs

Commands must reuse shared server command modules, not call internal HTTP routes. Extract route-handler logic into `project-commands.ts`, `spec-commands.ts`, and `schedule-commands.ts` as needed. Existing `finding-selection`, `production-run`, and cancellation services remain canonical.

### Daytona workspace sandbox

Add `src/integrations/daytona-agent.ts` and a pinned `DAYTONA_AGENT_SNAPSHOT` configuration.

The project-agent sandbox is separate from the current builder/verifier sandboxes and must be:

- Private and ephemeral
- Network-blocked
- Created with an empty environment
- Credential-free
- Bounded by strict context byte/file/path limits
- Labeled for cleanup reconciliation
- Verified destroyed after completion, failure, or cancellation

Only a sanitized, bounded project-context package may be supplied to it. Kimi, KMS, owner-session, provider, and runtime-secret credentials remain in the trusted server process. Never expose the builder’s `read_file`, `write_file`, `search_text`, shell, network, or provider surfaces to conversation tools.

### Kimi conversation adapter

Add `src/integrations/kimi-conversation.ts`. Use the existing Kimi configuration with:

- A bounded, non-parallel tool-selection loop.
- Safe tool-progress events.
- Streaming only for final natural-language output.
- Usage ledger and cost reservation recording.
- Context, message, tool-turn, token, time, concurrency, and cost limits.

Treat all evidence, imports, and model output as untrusted data. Canonical project state must come from repositories, never a transcript summary.

## UI implementation

Refactor the dormant `src/features/chat/chat-panel.tsx` into a project-scoped `ProjectConversationWorkspace`. It must no longer keep messages in local React state or select projects internally.

Add:

- `conversation-queries.ts` for React Query keys, message pagination, turns, actions, and invalidation.
- `use-turn-stream.ts` for SSE reconnect, sequence deduplication, cancellation, and local partial-render state.
- Thread list, message, action-card, composer, context-rail, and mobile-sheet components.

Reuse existing `ProjectHeader`, `ProjectTabs`, `ui.tsx` components, React Query patterns, `normalizeProjectView`, `projectLifecycleFor`, run queries, and activity-event infrastructure.

Required UI behavior:

- Loading, empty, error, retry, disconnect, and running-turn states.
- Visible keyboard focus and a keyboard-safe composer.
- Stop-generation control.
- Cursor-paginated history.
- Accessible action cards showing risk, source state version, diff, and expiry.
- Buffered live-region announcements for streaming text.
- Query invalidation after terminal turns/actions rather than client-side recreation of domain state.
- Responsive layouts without mobile horizontal overflow.

## Secure secrets-manager design

### Reuse the current vault

The KMS-encrypted `SecretVersion` and `ProjectSecretGrant` system remains canonical. Preserve envelope encryption, approval-bound grants, and Vercel’s `reconcileSensitiveRuntimeVariables` path. Do not create a separate chat secret store.

Refactor `src/features/project-detail/project-secrets-settings.tsx` so the Settings tab, workspace secrets drawer, and mobile sheet reuse one write-only controller/presentation implementation.

### Metadata-only workspace display

Create a dedicated safe metadata serializer in `src/server/secret-vault.ts` that exposes only:

- Name
- Version
- Active/revoked/latest state
- Grant state
- Created/revoked timestamps

Do not expose plaintext, suffixes, ciphertext, envelope data, context hashes, KMS key IDs, logical keys, or provider credentials to the workspace agent or secret drawer.

### Transcript protection

Consolidate `src/policy/secret-guard.ts` and `src/server/security/redaction.ts` around a shared pure detector and server-only recursive redactor.

Reject secret-like content before it reaches:

- Composer message state
- API persistence
- Idempotency fingerprints
- Agent prompts
- Tool inputs/outputs
- Action payloads
- Logs, audit rows, and outbox events

Intercept paste and drop in the chat composer. Keep secrets typed into the drawer only in local component state and clear it after save, cancellation, unmount, project switch, or authentication loss.

Apply rolling cross-chunk scanning to agent output. If output resembles a credential, fail closed before it is streamed or committed.

### Vault hardening

- Expand the control-plane environment registry so every confidential value in `RuntimeEnvSchema` is protected from project-secret name/value copying.
- Use a dedicated secret/idempotency fingerprint key rather than the auth key where configuration permits.
- Replace broadly available identifier-based `readProjectSecretVersion` usage with a short-lived, release-bound decrypt capability.
- Validate workspace/project, exact secret version/grant, approval, artifact/report hash, deployment target, expiry, and nonce at the vault boundary.
- Ensure only release workflows can obtain/decrypt with this capability.
- Add revocation/reconciliation outbox work that updates managed Vercel runtime variables, verifies convergence, and records metadata only.
- Keep approval expiration distinct from optional active-grant TTL. Do not introduce automatic secret expiry without an explicit product configuration and clear outage warning.
- Ensure secret scanners never echo matching source lines or values in logs.

## Delivery phases

### 1. Foundation

1. Add shared secret detection and redaction boundaries.
2. Add project authority contracts/settings.
3. Extract reusable domain commands from route handlers.
4. Add conversation contracts and regression tests for existing REST behavior.

### 2. Durable threads

1. Add schema/migration, repositories, thread/message/turn/action APIs, and usage/budget expansion.
2. Add transcript retention and deterministic demo/fake-agent support.
3. Add ownership, idempotency, versioning, and secret-rejection tests.

### 3. Streaming transport

1. Add outbox-backed conversation workflows.
2. Persist safe semantic events and coalesced deltas.
3. Implement SSE replay, bounded connections, cancellation, and cleanup reconciliation.

### 4. Chat-first workspace

1. Move the existing overview to `/overview`.
2. Make the project root conversation-first.
3. Add thread navigation, context rail, proposal cards, responsive sheets, and compatibility redirects.

### 5. Real read-only agent

1. Add Daytona agent sandbox/readiness and sanitized context packages.
2. Add Kimi read-tool loop, streaming final output, and cost/concurrency controls.
3. Enable only when Kimi, Daytona, database, pricing, and pinned snapshot checks all pass.

### 6. Mutation modes

1. Add action families incrementally: metadata, pause/resume, schedules, findings, specs, then run controls.
2. Enable review mode before autopilot.
3. Preserve non-bypassable approval and secrets boundaries in all modes.

### 7. Secrets drawer and hardening

1. Reuse vault UI in the workspace.
2. Remove suffixes from workspace-facing DTOs.
3. Add capability-bound decryption and Vercel revocation reconciliation.
4. Add adversarial no-leak tests.

### 8. Rollout

1. Deploy additive schema first.
2. Create project threads lazily.
3. Feature-flag the workspace.
4. Enable read-only production agent before mutation modes.
5. Retire the legacy chat endpoint only after migration telemetry confirms no active callers.

## Verification plan

### Backend and schema

- Workspace/project isolation and IDOR attempts.
- Thread naming, optimistic versioning, message/event ordering, and active-turn exclusion.
- Idempotency replay/conflict behavior.
- Authority mode and action expiry enforcement.
- Usage/budget records tied to exactly one run or conversation turn.
- Archive and retention behavior.

### API and streams

- Authentication, same-origin, and `If-Match` enforcement.
- No persistence when secret-like input is submitted.
- SSE reconnect/replay with `Last-Event-ID`.
- Event deduplication, terminal state, timeout, error, and cancellation handling.
- Stale action supersession.

### Agent and Daytona policy

- Static tool allowlist and schema validation.
- No shell, raw HTTP, SQL, builder-write, provider, or vault tool exposure.
- Prompt injection in evidence remains inert data.
- Tool result/context limits and cost/concurrency limits.
- Exact Daytona sandbox flags, empty environment, network block, context sealing, and cleanup on success/failure/cancel.

### Secrets

- Write-only API and UI behavior.
- No secret value or suffix in transcript, agent context, stream, logs, audits, errors, or DTOs.
- Control-plane credential copy rejection.
- Capability-bound decrypt, approval/grant/artifact staleness, rotation, and revocation reconciliation.
- Scanner behavior that never discloses a match.

### UI and end-to-end

- React Testing Library coverage for threads, history, stream/reconnect, actions, authority modes, keyboard navigation, and secure secrets drawer cleanup.
- Playwright coverage for desktop/mobile workspace layouts, workflow activity cards, approved changes reflected in overview, write-only secret creation, rejected chat paste, separate approval flow, no overflow, light/dark themes, and no browser/HTTP errors.
- Run typecheck, lint, unit tests, build, Playwright, and the existing ReDDone verification workflow after each milestone.
- Before production mutation/autopilot enablement, complete disposable PostgreSQL, GCP KMS, Vercel, and Daytona acceptance testing.

## Critical implementation files

- `prisma/schema.prisma` and new Prisma migrations
- `src/app/(console)/projects/[projectId]/page.tsx` and a new `overview/page.tsx`
- `src/features/chat/chat-panel.tsx` and new conversation feature modules
- `src/components/project-tabs.tsx`, `src/features/project-detail/project-chrome.tsx`, and `src/components/app-shell.tsx`
- `src/app/api/v1/projects/[projectId]/conversation/**`
- `src/contracts/conversation.ts`, `src/server/conversation-*.ts`, and `src/server/project-agent/**`
- `src/workflows/conversation-agent.ts` and `src/workflows/conversation-dispatch.ts`
- `src/integrations/kimi-conversation.ts` and `src/integrations/daytona-agent.ts`
- `src/server/secret-vault.ts`, `src/policy/secret-guard.ts`, and `src/server/security/redaction.ts`
- Component, core, integration, and end-to-end test suites
