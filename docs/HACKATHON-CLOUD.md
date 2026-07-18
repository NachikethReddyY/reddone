# Hackathon cloud deployment

This mode is a bounded event deployment, not a substitute for the private production acceptance gates. Set `APP_MODE=hackathon`; production refuses an absent mode and never falls back to demo access.

## Deployment shape

- Console: `https://reddone.vercel.app` (subject to Vercel name availability).
- Preview: a second Vercel project on a distinct generated `*.vercel.app` hostname, with the same revision and artifact configuration but no console cookie origin. It reads PostgreSQL and private artifacts, so it needs its own production Workload Identity binding and runtime configuration.
- State: Neon PostgreSQL using its pooled `DATABASE_URL`.
- Secrets/artifacts: private Google Cloud Storage and Cloud KMS accessed from Vercel through Workload Identity Federation. Do not create a Google service-account JSON key.
- Identity: GitHub OAuth sign-in. Each participant gets one workspace. The separate ReDDone GitHub App installation is later used only to create that participant's private repository.
- Automation: schedules are disabled; Vercel cron runs the bounded daily recovery/retention path only.

## Values to collect outside source control

Enter these through Vercel environment variables, never chat or committed files:

```text
APP_MODE=hackathon
NEXT_PUBLIC_APP_URL=https://reddone.vercel.app
AUTH_TRUSTED_ORIGIN=https://reddone.vercel.app
DATABASE_URL=<Neon pooled PostgreSQL URL>
BETTER_AUTH_SECRET=<32+ random bytes>
VERIFICATION_SIGNING_KEY=<independent 32+ random bytes>
VERIFICATION_SIGNING_KEY_ID=application-hmac-v1
PREVIEW_ORIGIN=https://<distinct-preview-project>.vercel.app
PREVIEW_SIGNING_KEY=<independent 32+ random bytes>
CRON_SECRET=<32+ random bytes>
GITHUB_AUTH_CLIENT_ID=<GitHub OAuth App client ID>
GITHUB_AUTH_CLIENT_SECRET=<GitHub OAuth App client secret>
HACKATHON_REGISTRATION_CODE=<random 32+ character event code>
HACKATHON_REGISTRATION_PEPPER=<independent 32+ random bytes>
GITHUB_APP_ID=<ReDDone GitHub App ID>
GITHUB_APP_SLUG=<ReDDone GitHub App slug>
GITHUB_APP_PRIVATE_KEY=<GitHub App private key>
GITHUB_WEBHOOK_SECRET=<GitHub webhook secret>
VERCEL_INTEGRATION_CLIENT_ID=<Vercel integration client ID>
VERCEL_INTEGRATION_CLIENT_SECRET=<Vercel integration client secret>
VERCEL_INTEGRATION_SLUG=<Vercel integration slug>
VERCEL_WEBHOOK_SECRET=<Vercel webhook secret>
GCP_PROJECT_ID=<project ID>
GCP_PROJECT_NUMBER=<project number>
GCP_SERVICE_ACCOUNT_EMAIL=<Vercel runtime service account>
GCP_WORKLOAD_IDENTITY_POOL_ID=vercel
GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID=vercel
GCP_KMS_KEY_NAME=projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>
GCP_ARTIFACT_BUCKET=<private bucket>
GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT=<dedicated signer service account>
```

GitHub OAuth callback URL: `https://reddone.vercel.app/api/auth/callback/github`.

The supplied project values may use a global Cloud KMS key, for example:

```text
GCP_PROJECT_ID=reddone
GCP_KMS_KEY_NAME=projects/reddone/locations/global/keyRings/software-key-ring/cryptoKeys/storage-key
```

`GCP_ARTIFACT_BUCKET=reddone` is valid only if that globally shared Cloud Storage bucket name is available. Confirm it during provisioning and choose a unique suffix if it is not. Never create or upload a service-account key: this deployment uses Workload Identity Federation instead.

There is deliberately no `GOOGLE_APPLICATION_CREDENTIALS` or `GCP_SERVICE_ACCOUNT_KEY` variable. Set `GCP_SERVICE_ACCOUNT_EMAIL` to the deployment's runtime account and `GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT` to a different, signing-only account; the application rejects identical values. The application exchanges Vercel's request-scoped OIDC identity for temporary Google credentials.

## GCP minimum IAM boundary

Configure separate Vercel OIDC bindings for the exact production subject of the console project and the exact production subject of the preview project. Never trust an entire Vercel team, all projects, preview deployments, or wildcard environments. The console runtime service account needs only:

- Cloud KMS encrypt/decrypt on the one configured key.
- Object create/read/delete on the one private artifact bucket.
- `iam.serviceAccounts.signBlob` on the dedicated signer account.

Use a separate preview runtime account where possible: it needs artifact read access only, and its Neon database credential should be read-only. The signer account needs no storage or KMS permissions. Private uploads/downloads use a URL signed for one object, one method, and at most fifteen minutes; uploads include a create-only object-generation precondition. The application validates the uploaded object metadata, length, and SHA-256 before any artifact can be used.

## Participant limits

Before public registration, set strict server-side caps for workspace count, projects per workspace, builds/releases per workspace, concurrent runs, artifact files/bytes, and storage retention. Missing quota state must reject work. The current migration has schedules disabled; direct manual research/build/release remains approval-gated.
