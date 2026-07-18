# ReDDone backend

This folder is a standalone backend handoff package. It contains the Next.js API
routes, server/domain code, workflows, provider integrations, Prisma migrations,
and Railway deployment configuration. The original full-stack app remains at the
repository root.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The API health check is available at `/api/health`.

## Deploy to Railway

Railway reads `railway.json` in this folder. Add a PostgreSQL service, connect
its `DATABASE_URL` to this service, configure the production environment
variables, then deploy from this folder as the service root.

Use `APP_MODE=demo` for a no-provider demonstration. For `private`,
`hackathon`, or `public` production modes, the environment checks require the
database, HTTPS origins, independent signing keys, and mode-specific providers.
See the root project's `docs/RAILWAY.md` for the complete deployment checklist.
