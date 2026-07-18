# Implementation status

The repository contains the production-shaped ReDDone MVP and a deterministic, clearly labeled demo vertical slice. Demo mode can be evaluated without a database or credentials. Live mode is fail-closed and is not considered production-accepted until the external and human gates below are complete.

## Implemented

- Owner bootstrap and Better Auth session boundary, workspace-scoped PostgreSQL/Prisma schema, checked-in migrations, Zod contracts, optimistic versions, CSRF/same-origin checks, and durable idempotency receipts.
- Owner-account Connections for GitHub App and Vercel OAuth, plus backend-only Kimi, Daytona, and approved Reddit configuration with a redacted readiness endpoint. Persisted account tokens use envelope encryption and private Google Cloud Storage artifact interfaces.
- Fixture and authorized-import research, explicit finding selection, separate structured ProductSpec generation, editable versioned specs, and canonical approvals.
- Budget reservation/usage accounting, outbox/inbox delivery, fenced leases, durable cancellation, deadlines, retry, retention, and coalesced fixed schedules.
- Network-blocked Daytona builder, second clean verifier, immutable toolchain, bounded manifests, security/quality gates, signed source/release/preview hashes, and short-lived static previews.
- Reconciled private GitHub repository creation, exact runtime-secret grants, direct Vercel prebuilt deployment, artifact-bound health checks, promotion, last-known-good state, and rollback approvals.
- Desktop and compact command-center UI covering Projects, Evidence, ProductSpec, Builds, Releases, Connections, Approvals, Chat, Schedules, and Settings.

## External acceptance gates

- Supply isolated Kimi, Daytona, GitHub App, Vercel integration, Google Cloud OIDC/KMS/Storage, PostgreSQL, auth, webhook, preview, verification, and cron configuration through the documented trusted interfaces. Do not paste secrets into chat or source control.
- Build, attack-test, and publish the Daytona snapshot; execute the real two-sandbox cleanup/egress tests.
- Apply and review the Google Cloud workload-identity/KMS/Storage configuration in the target account and run PostgreSQL integration, replay, and chaos suites against disposable infrastructure.
- Record written Reddit authorization covering the intended commercial use and downstream AI processing before enabling live Reddit.
- Complete the human security/threat-model review and ReDDone name/mark legal review.
- Run the documented clean live journey through real Kimi, Daytona, GitHub, and Vercel accounts. Until then, demo URLs and provider records are simulations and are labeled as such.
