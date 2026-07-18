# Railway: ai& environment configuration

Use Railway’s service-variable UI for ai& credentials. Do not upload an `.env` file or commit credentials to Git.

## 1. Create an ai& API key

1. Sign in to <https://console.aiand.com>.
2. Create an API key and copy it immediately; ai& shows it once.
3. Keep it in a password manager until it is saved in Railway.

## 2. Add variables in Railway

1. Open the Railway project and select the ReDDone service.
2. Open **Variables**.
3. Select the target environment, normally **Production**. Add the same values to **Staging** only if that environment should make real provider calls.
4. Add these variables as sealed service variables:

| Variable | Value | Notes |
| --- | --- | --- |
| `AIAND_API_KEY` | ai& `sk-...` key | Required; keep secret. |
| `KIMI_INPUT_COST_MICROS_PER_MILLION` | `1000000` | Conservative $1.00/1M input-token budget rate. |
| `KIMI_OUTPUT_COST_MICROS_PER_MILLION` | `4000000` | Conservative $4.00/1M output-token budget rate. |
| `AIAND_BASE_URL` | `https://api.aiand.com/v1` | Optional; the app uses this default when `AIAND_API_KEY` exists. Set it only to override the gateway URL. |

Use the GLM-5.2 rates for the budget variables because they are higher than Kimi K2.7 Code’s published ai& rates. This keeps the project’s provider-cost ceiling conservative for either model selected in the UI.

Do not set `KIMI_API_KEY`, `MOONSHOT_API_KEY`, or `KIMI_BASE_URL` in the same Railway environment unless you intentionally want the legacy direct-Moonshot route instead of ai&.

## 3. Required existing production variables

ai& does not replace the rest of the live deployment configuration. Keep the existing production variables required by this application, including the database, authentication, vault, Daytona, Reddit, GitHub/Vercel, and verification-signing configuration. See [Railway deployment notes](./RAILWAY.md) and the root README for the full production checklist.

## 4. Deploy the migration

The model selector persists the chosen model on each workflow run. Apply the included migration before enabling live workflows:

```bash
pnpm db:deploy
```

If Railway runs database migrations in a release command, add this command there before the application starts. Otherwise run it from a secure CI/CD job that has the production `DATABASE_URL`; do not run development migrations against production.

## 5. Redeploy and verify

After saving variables, trigger a Railway deployment. Then:

1. Sign in to the app and open a project.
2. Confirm that the Research, ProductSpec, and Build controls show **GLM-5.2** and **Kimi K2.7 Code**.
3. Start a small, bounded research workflow with the desired model.
4. Confirm the run’s usage/audit data names the selected model.
5. If the run is rejected, verify the ai& key and call `GET https://api.aiand.com/v1/models` with the key to confirm that the organization can access both model IDs.

## Key rotation

1. Create a new key in ai&.
2. Replace `AIAND_API_KEY` in Railway.
3. Redeploy the service.
4. Verify one bounded workflow with the new key.
5. Revoke the old ai& key only after verification succeeds.

Never print the key in Railway build logs, application logs, support tickets, or chat.
