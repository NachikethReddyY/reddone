# Railway deployment

The repository is configured for Railway's Railpack builder. A deployment builds a
Next.js standalone server, applies checked-in Prisma migrations before release,
and waits for `GET /api/health` to return `200`.

## Set up the project

1. Create a Railway project and add a PostgreSQL service.
2. Add this repository as a service. Railway reads the root `railway.json`.
3. In the application service, add a reference variable for the Postgres
   service's `DATABASE_URL`. Set `DIRECT_URL` only if you use a separate
   non-pooled connection for migrations.
4. Generate the Railway public domain before the first production build, then
   set `NEXT_PUBLIC_APP_URL` and `AUTH_TRUSTED_ORIGIN` to its HTTPS origin.
   `NEXT_PUBLIC_APP_URL` is compiled into the client bundle, so rebuild after it
   changes.
5. Copy the remaining production variables into Railway's Variables UI. Never
   upload or commit `.env` files.

## Required production posture

Set `NODE_ENV=production` and an explicit `APP_MODE` (`private`, `hackathon`,
or `public`). The application rejects an implicit production mode. Its existing
environment validation requires independent signing keys, an HTTPS app origin,
database credentials, and the mode-specific provider configuration.

For live modes, `PREVIEW_ORIGIN` must be a separate HTTPS, cookie-less origin;
do not point it at the Railway application domain. In public production mode,
configure webhook email delivery as required by `src/server/env.ts`.

## Deployment behavior

- Build: `pnpm build`
- Pre-deploy migration: `pnpm db:deploy`
- Start: `pnpm start` (honors Railway's `PORT` through Next's standalone server)
- Health check: `/api/health`, with a 180-second readiness window

In live modes the health endpoint verifies database connectivity before it
returns `200`. It fails closed after five seconds with `503` for database
outages, without exposing connection details.
