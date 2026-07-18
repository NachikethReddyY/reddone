# ReDDone

![Node.js](https://img.shields.io/badge/Node.js-24.18-green?logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11-4a8fd7?logo=pnpm&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-336791?logo=postgresql&logoColor=white)
![License](https://img.shields.io/badge/License-UNLICENSED-red)

ReDDone is a private, approval-gated control plane that turns authorized market evidence into a verified Next.js application, private GitHub repository, and prebuilt Vercel deployment.

The repository ships in **demo mode by default**. Demo mode exercises the same contracts, approval states, and UI without making external calls or pretending mock resources are live.

## How to Use

### Getting Started with ReDDone

![ReDDone Hero](docs/reddone-hero.png)

The ReDDone workflow is designed for evidence-backed product development. Here's how to get started:

1. **Access your account** - Use your invite code to unlock account creation
2. **Enter your workspace** - Access the main ReDDone console
3. **Manage approvals** - Review and approve specifications and releases
4. **Deploy verified builds** - Push approved projects to GitHub and Vercel

![ReDDone Invite Flow](docs/reddone-invite.png)

**Two ways to get started:**
- **Have an invite?** Redeem your code for immediate access
- **No invite yet?** Join the waitlist to get early beta access and stay updated on launches

## Overview

ReDDone serves as an approval-gated control plane for creating, verifying, and deploying applications. It provides:

- **Demo Mode**: Safe, local-only testing with no external dependencies
- **Private Mode**: Full integration with GitHub, Vercel, and model providers
- **Hackathon Mode**: Cloud-based workspace isolation for events

## Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | 24.18.x LTS | Required for backend |
| pnpm | 11 | Package manager |
| PostgreSQL | 17 | For live-mode state (Docker Compose included) |
| | | Or Neon PostgreSQL for hackathon mode |

## Quick Start

### Demo Mode (Default)

```bash
pnpm install
pnpm dev  # Opens http://localhost:3000
```

Demo mode is the fail-safe default and needs no database or provider credentials. The console is populated with the LatePay Copilot scenario and makes no live provider calls.

**Demo Workflow:**
1. Approve the fixture specification in **Approvals**
2. Open the project’s **Builds** tab and start a verified build
3. Approve the newly created first-release payload

The demo creates no external resources and labels that fact explicitly.

### Local Database Setup

To validate the checked-in PostgreSQL migration:

```bash
cp .env.example .env.local
# Update development values in .env.local
docker compose up -d postgres
pnpm db:deploy
pnpm db:seed
```

### Live Provider Configuration

For local live-provider testing, keep secrets in `.env.local` (gitignored) and configure:

- `AIAND_API_KEY` to use ai&'s OpenAI-compatible gateway. Each manual research, ProductSpec, or build launch can select `zai-org/glm-5.2` or `moonshotai/kimi-k2.7-code`; selected model IDs are retained with the run and reused on retry. Keep the existing `KIMI_*_COST_MICROS_PER_MILLION` limits configured at least as high as the selected model's ai& rates so the provider-cost ceiling remains conservative. `KIMI_API_KEY` (or legacy `MOONSHOT_API_KEY`) remains supported for the existing Moonshot route.
- `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and the pinned builder/verifier snapshot names.
- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, a descriptive `REDDIT_USER_AGENT`, and the written `REDDIT_APPROVAL_REFERENCE` for the approved OAuth browse endpoints.
- `OXYLABS_ENDPOINT`, `OXYLABS_PORT`, `OXYLABS_USERNAME`, and `OXYLABS_PASSWORD` for the approved residential-proxy Reddit web collector. The collector also requires the same descriptive `REDDIT_USER_AGENT` and written `REDDIT_APPROVAL_REFERENCE`; all values remain server-only.
- `LOCAL_VAULT_DERIVE_FROM_AUTH=true` only on localhost so GitHub/Vercel account tokens do not require cloud OIDC. Production rejects this option.

The **Connections** screen is only for owner-authorized GitHub and Vercel accounts. Kimi, Daytona, Reddit OAuth, and Oxylabs residential proxy access are backend infrastructure and never have browser credential forms. The UI sees only redacted readiness booleans from `/api/v1/providers/status`.

When Oxylabs residential collection is configured, the Live Reddit web scrape source in the new-project flow lets an owner choose one subreddit, optional keywords, post sort, time frame, document cap, and one to eight bounded collection agents. The page cursor is collected serially, then the agents independently re-read their assigned public post pages through the proxy. The exact scope is stored with the project and reused by scheduled research; it cannot be supplied from the browser at run time.

## Private production activation

Private mode is intentionally fail-closed. Before setting `APP_MODE=private`:

1. Apply the checked-in PostgreSQL migration and create the one-time hashed setup token.
2. Configure the Google Cloud KMS/artifact vault with a Vercel OIDC subject narrowed to the production project and environment.
3. Build and publish the pinned Daytona snapshot from `infrastructure/daytona/Dockerfile` after a human security review.
4. Register the least-privilege GitHub App and Vercel integration, configure signed webhooks, and test isolated accounts through **Connections**.
5. Configure Kimi, Daytona, Reddit, and—when using website collection—Oxylabs as server-only environment secrets. Record a separate Reddit written-authorization reference before enabling any live Reddit source, and use the collector only for access permitted by your Reddit and Oxylabs agreements.
6. Configure `PREVIEW_ORIGIN` on a dedicated HTTPS, cookie-less hostname (different from the console/auth origin), set an independent `PREVIEW_SIGNING_KEY`, and apply an edge rate limit to `/preview/*`.
7. Set independent verification-signing credentials and current positive Kimi input/output price rates; live mode refuses unpriced provider calls.
8. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`, then complete the threat-model and brand/legal gates documented under `docs/`.

GitHub/Vercel account authorization and project runtime secrets are managed through the web UI. Kimi, Daytona, and Reddit credentials stay in the backend environment. Control-plane secrets are categorically ungrantable; project secrets require exact-version approval and are attached only to an approved release target.

## Security model

- Kimi, Daytona, and Reddit secrets belong only in the backend environment; GitHub/Vercel accounts belong in **Connections**. Never paste secrets into chat.
- Saved values are write-only and never returned by APIs.
- Production secret encryption uses Google Cloud KMS through Vercel OIDC.
- Generated code runs only in isolated Daytona builder and verifier sandboxes.
- Verification signs the source, server-capable release output, and separate static-only preview output. The console serves only the static preview through a short-lived, artifact-bound URL.
- Live Reddit mode remains disabled unless an explicit approval reference is configured.
- GitHub repositories are private and Vercel releases are approval-gated.

See [`docs/IMPLEMENTATION-STATUS.md`](docs/IMPLEMENTATION-STATUS.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), and [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for implementation boundaries, human review gates, and incident procedures.

## Hackathon cloud mode

`APP_MODE=hackathon` is a separate, fail-closed event mode: GitHub-only participant sign-in, one isolated workspace per participant, private Google Cloud Storage/Cloud KMS through Vercel OIDC, and per-workspace GitHub/Vercel connections. It disables schedules so it can run within Vercel Hobby's daily-cron limit. See [`docs/HACKATHON-CLOUD.md`](docs/HACKATHON-CLOUD.md) for the required provider setup and environment-variable names.
