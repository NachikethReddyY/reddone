import { z } from "zod";

import { ProviderSchema } from "@/contracts";
import { maskedSuffix } from "@/policy/secret-guard";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import {
  claimPublishedIdempotencyReceipt,
  completePublishedIdempotencyReceipt,
  secureIdempotencyFingerprint,
} from "@/server/published-idempotency";
import { disconnectProvider, saveProviderCredential } from "@/server/secret-vault";
import { purgeRedditOrigin } from "@/server/retention";
import {
  getConnection,
  readIdempotent,
  updateConnectionMetadata,
  writeIdempotent,
} from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId, route } from "@/workflows/http";

type Context = { params: Promise<{ provider: string }> };

const RedditCredentialSchema = z
  .object({
    clientId: z.string().trim().min(4).max(300),
    clientSecret: z.string().min(8).max(4_096),
    userAgent: z.string().trim().min(8).max(500),
  })
  .strict();

export async function GET(request: Request, { params }: Context) {
  const { provider: rawProvider } = await params;
  return route(request, async () => {
    const provider = ProviderSchema.parse(rawProvider);
    if (!isDemoMode()) {
      const owner = await (await import("@/workflows/http")).assertOwnerRequest(request);
      const record = await getDb().providerConnection.findUnique({
        where: { workspaceId_provider: { workspaceId: owner.workspaceId, provider: provider.toUpperCase() as Uppercase<typeof provider> } },
      });
      if (!record) throw new HttpError("not_found", "Connection not found.", 404);
      return {
        provider,
        mode: "live",
        health: record.health.toLowerCase(),
        accountId: record.accountExternalId,
        accountLabel: record.accountLabel,
        scopes: record.scopes,
        maskedSuffix: record.maskedSuffix,
        lastTestedAt: record.lastTestedAt?.toISOString() ?? null,
        failureCode: record.failureCode,
        failureMessage: record.failureMessage,
        optimisticVersion: record.optimisticVersion,
      };
    }
    const status = getConnection(provider);
    if (!status) throw new HttpError("not_found", "Connection not found.", 404);
    return status;
  });
}

export async function PUT(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { provider: rawProvider } = await params;
    const provider = ProviderSchema.parse(rawProvider);
    if (provider === "github" || provider === "vercel") {
      throw new HttpError("bad_request", `${provider === "github" ? "GitHub" : "Vercel"} must be connected through its installation flow.`, 400);
    }
    const body = z
      .object({
        credential: z.string().min(8).max(16_384),
        accountLabel: z.string().trim().min(1).max(120).optional(),
        redditAuthorizationReference: z.string().trim().min(1).max(500).optional(),
      })
      .strict()
      .parse(await request.json());
    if (provider === "reddit" && !body.redditAuthorizationReference) {
      throw new HttpError("feature_disabled", "A written Reddit authorization reference is required.", 403);
    }
    let credential = body.credential;
    let maskedValue: string | undefined;
    if (provider === "reddit") {
      let parsed: z.infer<typeof RedditCredentialSchema>;
      try {
        parsed = RedditCredentialSchema.parse(JSON.parse(body.credential));
      } catch {
        throw new HttpError("bad_request", "Reddit credentials must include a valid client ID, client secret, and descriptive user agent.", 400);
      }
      credential = JSON.stringify(parsed);
      maskedValue = parsed.clientSecret;
    }
    if (!isDemoMode()) {
      const saved = await saveProviderCredential({
        workspaceId: context.owner.workspaceId,
        provider,
        credential,
        ...(maskedValue ? { maskedValue } : {}),
        ...(body.accountLabel ? { accountLabel: body.accountLabel } : {}),
        ...(body.redditAuthorizationReference ? { authorizationReference: body.redditAuthorizationReference } : {}),
        expectedConnectionVersion: context.expectedVersion!,
        createdByUserId: context.owner.userId,
        idempotencyKey: context.idempotencyKey,
        requestId: context.requestId,
      });
      const status = {
        provider,
        mode: "live",
        health: saved.connection.health.toLowerCase(),
        accountId: saved.connection.accountExternalId,
        accountLabel: saved.connection.accountLabel,
        scopes: saved.connection.scopes,
        maskedSuffix: saved.connection.maskedSuffix,
        lastTestedAt: saved.connection.lastTestedAt,
        secretVersion: saved.secretVersion.version,
        replacementPending: saved.connection.replacementPending,
        pendingMaskedSuffix: saved.pendingMaskedSuffix,
        optimisticVersion: saved.connection.optimisticVersion,
        replayed: saved.replayed,
      };
      return ok(status, context.requestId, { status: 201 });
    }
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const status = updateConnectionMetadata(provider, {
      mode: "demo",
      status: provider === "reddit" ? "locked" : "untested",
      account: body.accountLabel ?? "Saved for demo validation",
      maskedSuffix: maskedSuffix(maskedValue ?? credential),
      message:
        provider === "reddit"
          ? "Authorization reference recorded in demo mode; no Reddit call was made."
          : "Credential accepted for demo UX and immediately discarded; no plaintext was persisted.",
    }, context.expectedVersion!);
    writeIdempotent(context.idempotencyKey, status);
    return ok(status, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { provider: rawProvider } = await params;
    const provider = ProviderSchema.parse(rawProvider);
    if (!isDemoMode()) {
      const operation = `connection.disconnect.${provider}`;
      const requestFingerprint = secureIdempotencyFingerprint(operation, {
        provider,
        expectedConnectionVersion: context.expectedVersion,
      });
      const claim = await claimPublishedIdempotencyReceipt({
        workspaceId: context.owner.workspaceId,
        idempotencyKey: context.idempotencyKey,
        operation,
        requestFingerprint,
      });
      if (claim.kind === "replay") {
        if (!claim.outcome.ok) {
          throw new HttpError(claim.outcome.error.code, claim.outcome.error.message, claim.outcome.error.status, claim.outcome.error.retryable);
        }
        return ok(claim.outcome.response, context.requestId);
      }
      if (claim.kind === "in_progress") throw new HttpError("conflict", "This disconnect request is already in progress.", 409, true);
      const record = await disconnectProvider({
        workspaceId: context.owner.workspaceId,
        provider,
        expectedConnectionVersion: context.expectedVersion!,
        allowRecoveredVersion: claim.claim.fencingVersion > 1,
      });
      const purge = provider === "reddit" ? await purgeRedditOrigin(context.owner.workspaceId) : null;
      const result = {
        provider,
        mode: "live",
        health: record.health.toLowerCase(),
        accountLabel: record.accountLabel,
        scopes: record.scopes,
        maskedSuffix: null,
        lastTestedAt: record.lastTestedAt?.toISOString() ?? null,
        optimisticVersion: record.optimisticVersion,
        purge,
      };
      await completePublishedIdempotencyReceipt({
        workspaceId: context.owner.workspaceId,
        claim: claim.claim,
        operation,
        requestFingerprint,
        outcome: { ok: true, response: result },
        audit: {
          actorUserId: context.owner.userId,
          action: "connection.disconnected",
          targetType: "provider_connection",
          targetId: record.id,
          requestId: context.requestId,
          metadata: { provider, purge },
        },
      });
      return ok(result, context.requestId);
    }
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const status = updateConnectionMetadata(provider, {
      mode: provider === "reddit" ? "disabled" : "live",
      status: provider === "reddit" ? "locked" : "disconnected",
      account: null,
      scopes: [],
      maskedSuffix: null,
      lastTestedAt: null,
      message: provider === "reddit" ? "Live Reddit remains locked; fixture/import mode is available." : "Disconnected.",
    }, context.expectedVersion!);
    writeIdempotent(context.idempotencyKey, status);
    return ok(status, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
