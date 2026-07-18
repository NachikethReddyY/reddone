# Architecture

PostgreSQL is the canonical product state. Durable workflow engines are executors, not a second state store. Every mutation records an idempotency key and every external side effect is reconciled before retry.

The runtime is split into:

1. Next.js control plane for authenticated UI and APIs.
2. PostgreSQL for projects, evidence, approvals, runs, leases, budgets, audit, and release state.
3. KMS-backed secret service and private content-addressed artifact storage.
4. Provider adapters for Kimi, approved Reddit access, Daytona, GitHub App, and Vercel OAuth.
5. Two isolated Daytona environments per build: mutable builder, then clean immutable verifier.

The verifier creates two independently hashed outputs from the same sealed source. The release output is a server-capable, standalone Vercel Build Output API v3 artifact and remains the only artifact eligible for release approval and runtime-secret grants. A second `PREVIEW_STATIC` artifact is generated with `REDDONE_STATIC_PREVIEW=1`, contains only static files, expires after 48 hours, and is the only artifact the signed preview route can serve.

Research and specification generation are deliberately separate durable intents. A research run validates one authorized packet, persists every unique ranked candidate with attributable evidence, and stops with `selectedFindingId = null`. The owner selects one workspace-scoped finding through an idempotent, `If-Match`-guarded mutation. A second fenced workflow, still represented by the public `research` run kind, is bound to that finding in the canonical hash-checked outbox payload and performs the Kimi ProductSpec call. This prevents inline provider work and prevents an unselected top-ranked model result from silently becoming the build basis.

The selection endpoints are:

- `POST /api/v1/projects/{projectId}/findings/{findingId}/select`
- `POST /api/v1/projects/{projectId}/findings/{findingId}/spec`

Vercel CLI builds use immutable, non-secret local project settings and `installCommand: true`, so the network-blocked snapshot never pulls project settings or packages. The trusted build invokes webpack explicitly, validates the exact Build Output configuration, validates every Vercel-generated link as relative and in-root, dereferences into a fresh bounded tree, and rejects any remaining link, hardlink, special file, unsupported configuration, or cap violation before hashing.

Release deployment does not spawn the Vercel CLI in the control plane. The release adapter inventories the verified `.vercel/output` tree, submits SHA-1 file references to the prebuilt Deployments API, uploads only provider-requested hashes with bounded concurrency and retry, re-submits the deployment, verifies its exact project and ownership metadata, performs the artifact-bound health check, and promotes it through the direct project promotion API.

The implementation includes deterministic demo adapters so the complete state machine can be exercised without external accounts. A demo result is always labeled and can never be promoted as a live release.
