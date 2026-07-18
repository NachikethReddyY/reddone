# Threat model

This document is a review input, not a security sign-off. Live mode must remain disabled until an independent human reviewer has validated the deployed infrastructure, provider scopes, Daytona snapshots, and these assumptions.

## Assets and trust boundaries

Highest-impact assets are the owner session, setup token, provider credentials, project secret versions, KMS key authority, private source/artifact objects, GitHub App installation, Vercel team, approval payloads, budget reservations, and the last-known-good deployment.

Untrusted inputs include Reddit/imported text, model output, generated source, webhook bodies, OAuth callback parameters, filenames, manifests, provider error text, and generated application behavior. None of those inputs become control-plane instructions.

The main boundaries are:

1. Browser to authenticated Next.js control plane.
2. Control plane to PostgreSQL, KMS, and private Cloud Storage.
3. Durable executor to external providers.
4. Constrained builder sandbox to clean verifier sandbox.
5. Verified artifact to private GitHub repository and prebuilt Vercel deployment.

## Required controls

| Threat | Required control | Residual risk / review evidence |
|---|---|---|
| Owner bootstrap takeover | One hashed setup token, persistent attempt lock, serializable consume-and-create transaction, registration disabled | Verify token delivery and expiry in the real deployment |
| CSRF or cross-workspace access | Secure DB session, same-origin mutations, workspace predicates and composite foreign keys | Run authenticated IDOR and origin tests against production routing |
| Secret disclosure | KMS envelope encryption with authenticated context; write-only APIs; centralized redaction; no sandbox credentials | Inspect browser, DB, logs, traces, prompts, artifacts, git, and Vercel output |
| Prompt injection | Source material is JSON data; research has no tools; builder uses a fixed system prompt and three allowlisted tools | Maintain adversarial evals for every prompt/model/schema change |
| Generated-code escape | Network-blocked builder, immutable toolchain, allowlisted writes, manifest hashes, second root-owned verifier, trusted commands | Build and attack the exact Daytona image; Docker-only checks are insufficient |
| Artifact traversal or substitution | Reject absolute/traversal/link/device/archive entries; size caps; content hashes before/after every gate; signed report | Test malformed manifests and Cloud Storage substitution in an isolated account |
| Duplicate spend/resources | Persistent idempotency for runs, approvals, connection tests and secret operations; outbox reconciliation; external-ID persistence | Chaos-test timeouts after successful GitHub/Vercel side effects |
| Approval tampering/staleness | Canonical discriminated payload, SHA-256 hash, full review UI, expiry, optimistic versions, exact account/artifact/report/grant target | Verify every decision-critical field is visible and copied exactly |
| OAuth/webhook spoofing | HMAC state + nonce cookie, team/account allowlists, signature window, replay receipt | Confirm provider-specific signatures and callback URLs in production |
| Denial of wallet | Workspace/project ceilings, reservation before provider work, one active build per project, sandbox concurrency cap | Reconcile recorded usage with provider invoices; alert on drift |
| Failed or malicious release | Private repositories, prebuilt verified output, candidate health check, promotion barrier, last-known-good rollback | Exercise repo-created/deploy-failed and health-failure recovery |
| Reddit policy breach/removal | Live mode requires a written reference; no scraping; revocation purges raw and derived Reddit-origin content | Legal owner must confirm commercial and downstream AI rights |

## Security sign-off evidence

Before live activation, preserve reviewer identity/date and attach:

- Daytona image digest, root-ownership checks, egress test, escape attempts, and cleanup evidence.
- KMS key policy, OIDC subject/audience claims, and Cloud Storage public-access/TLS evidence.
- GitHub App and Vercel integration scopes plus isolated test-account results.
- Setup/auth/CSRF/IDOR, webhook replay, approval tamper, path/link/archive, and secret-leak test results.
- A release chaos run showing reconciliation and a successful last-known-good rollback.
- Written Reddit authorization, or an explicit record that live Reddit remains disabled.

Any failed item keeps `APP_MODE=demo`.
