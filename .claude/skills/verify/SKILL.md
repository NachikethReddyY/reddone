# Verify ReDDone web surfaces

1. Build with `pnpm build`.
2. Launch an isolated production server with `pnpm exec next start -p <unused-port>`; shell environment variables override `.env.local` for deployment-mode checks.
3. Drive the UI with Playwright from `@playwright/test`. Use `domcontentloaded`, not `networkidle`, because the console shell polls.
4. Verify `/`, `/pricing`, protected-route redirects, auth form request payloads, `/account`, and `/settings` redirects. Capture desktop/mobile and light/dark screenshots.
5. Public mode needs the complete live environment, including distinct signing keys, GCP fields, preview origin, provider price rates, and webhook email delivery. A database connection is not needed when auth requests are intercepted in Playwright.
