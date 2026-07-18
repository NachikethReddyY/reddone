# Operations runbook

## Production activation

1. Pin Node 24 and pnpm 11, install from the checked-in lockfile, and run all validation commands.
2. Apply the checked-in Prisma migration to an empty PostgreSQL database.
3. Generate a random setup token outside application logs; configure only its SHA-256 digest as `SETUP_TOKEN_HASH`.
4. Apply the reviewed Google Cloud IAM configuration with Workload Identity Federation subjects restricted to the exact console and preview Vercel projects and their production environments.
5. Build, attack-test, and publish the pinned Daytona builder/verifier snapshot. Record its immutable digest.
6. Configure GitHub and Vercel account authorization through **Connections**. Configure Kimi, Daytona, and approved Reddit access only in the server environment.
7. Keep Reddit disabled unless the authorization record explicitly covers the intended commercial and downstream AI processing.
8. Route a dedicated HTTPS, cookie-less preview hostname to the control plane, set `PREVIEW_ORIGIN` and an independent `PREVIEW_SIGNING_KEY`, and enforce an edge request limit on `/preview/*`. Do not reuse the console or auth hostname.
9. Complete the human sign-off in `THREAT-MODEL.md`, then set an explicit live mode: `APP_MODE=private` or `APP_MODE=hackathon`.

Required pre-deploy checks:

```sh
pnpm prisma:generate
pnpm exec prisma validate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Routine checks

- `/api/health` must return a healthy control-plane response.
- Preview URLs must use the dedicated host, expire after 15 minutes, return `no-store`, and stop resolving when the 48-hour `PREVIEW_STATIC` artifact expires. Alert on sustained preview-host 404/429 or object-store read spikes.
- Connections must show the expected GitHub/Vercel account, scopes, suffix, and a recent successful test.
- `/api/v1/providers/status` must report the expected redacted readiness for backend-managed Kimi, Daytona, and Reddit. It must never return credentials or suffixes.
- The workflow outbox must not contain old unpublished workflow events.
- Active leases must have a current heartbeat and expiry; expired leases require reconciliation before retry.
- Reserved budget must correspond to a queued/running run.
- Daytona must contain no orphaned `app=reddone` sandbox beyond its cleanup interval.
- The last-known-good Vercel deployment and GitHub commit must match the canonical database record.
- Daily retention must purge expired raw imports, static-preview index rows/objects, and events while retaining verified release artifacts needed for rollback. Cloud Storage lifecycle rules provide a 3-day preview-object and 30-day raw-import backstop.

## Incident actions

### Suspected credential exposure

1. Pause affected projects and provider work.
2. Revoke the credential at the provider first.
3. For GitHub/Vercel, disconnect the account in Connections. For Kimi, Daytona, or Reddit, rotate/remove the server environment secret and restart the backend. Reddit revocation must also trigger the content-purge procedure.
4. Rotate KMS/auth/webhook material if their boundary may be affected.
5. Search every leak surface listed in the threat model. Do not paste the value into tickets or chat.
6. Reconnect with a new version and test it before resuming schedules.

### Orphaned or stuck run

1. Inspect canonical run, lease, budget, outbox event, executor IDs, and Activity Events.
2. Request cancellation; the promotion barrier may legitimately reject a late cancellation.
3. Confirm every executor ID was canceled and every labeled Daytona sandbox was deleted.
4. Release only the matching reservation/lease. Never edit the run directly to “succeeded.”
5. Retry through the API so the parent chain and idempotency record are preserved.

### Partial release

1. Do not create a second repository/project manually.
2. Refresh Releases and reconcile using persisted provider IDs.
3. If the candidate is unhealthy, leave production on the last-known-good deployment.
4. Retry the same failed release run; provider side effects must reconcile before another write.
5. If production is unhealthy, create and approve a rollback to the exact recorded target.

### Reddit removal or authorization revocation

1. Disconnect Reddit immediately.
2. Confirm source state is `PURGED`, raw documents and retained excerpts are removed, derived specs are rejected/redacted, and affected projects are paused.
3. Delete any downstream copy that falls outside the automated workspace purge and preserve a non-content audit record.
4. Resume only with fixture/import mode or renewed written authorization.

## Backup and recovery

- Back up PostgreSQL with point-in-time recovery and test restoration into an isolated account.
- Keep the S3 bucket private and versioned. Current verified release artifacts do not receive the raw-data 30-day lifecycle expiration.
- KMS deletion uses a review window; never schedule deletion during an incident.
- Recovery order is database, KMS/OIDC access, artifacts, provider connections, then workflow reconciliation.
- After restore, disable cron and external mutations until outbox, leases, approvals, and deployments have been reconciled.
