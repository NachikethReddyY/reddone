FROM node:24.18.0-bookworm AS seal-helper

COPY infrastructure/daytona/seal-generated.c /tmp/seal-generated.c
RUN cc -O2 -Wall -Wextra -Werror -o /seal-generated /tmp/seal-generated.c

FROM node:24.18.0-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /workspace
COPY templates/generated-next-app/ /workspace/
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm audit --prod --audit-level high \
    && pnpm exec playwright install --with-deps chromium

COPY infrastructure/daytona/verify/ /opt/reddone/verify/
COPY --from=seal-helper /seal-generated /opt/reddone/bin/seal-generated
RUN set -eu; \
    mkdir -p \
      src/app/generated \
      src/components/generated \
      src/content \
      public/generated \
      .next \
      .vercel/output \
      .vercel/preview-output \
      .reddone-runtime; \
    find . \
      \( -path './node_modules' \
         -o -path './src/app/generated' \
         -o -path './src/components/generated' \
         -o -path './src/content' \
         -o -path './public/generated' \
         -o -path './.next' \
         -o -path './.vercel/output' \
         -o -path './.vercel/preview-output' \
         -o -path './.reddone-runtime' \) -prune \
      -o -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum > /opt/reddone/immutable.sha256; \
    touch /opt/dependency-audit-passed; \
    chmod -R a-w /workspace; \
    chown -R node:node \
      /workspace/src/app/generated \
      /workspace/src/components/generated \
      /workspace/src/content \
      /workspace/public/generated \
      /workspace/.next \
      /workspace/.vercel/output \
      /workspace/.vercel/preview-output \
      /workspace/.reddone-runtime; \
    chmod -R u+rwX,go-rwx \
      /workspace/src/app/generated \
      /workspace/src/components/generated \
      /workspace/src/content \
      /workspace/public/generated \
      /workspace/.next \
      /workspace/.vercel/output \
      /workspace/.vercel/preview-output \
      /workspace/.reddone-runtime; \
    chmod 1777 /workspace/.vercel; \
    chmod 0555 /workspace; \
    chmod 0555 /opt/reddone/verify/*; \
    chmod 0444 /opt/reddone/immutable.sha256 /opt/dependency-audit-passed; \
    chmod -R a-w /opt/reddone; \
    chown root:root /opt/reddone/bin/seal-generated; \
    chmod 4555 /opt/reddone/bin/seal-generated

USER node
CMD ["sleep", "infinity"]
