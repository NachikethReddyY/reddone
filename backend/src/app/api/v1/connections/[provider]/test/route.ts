import { z } from "zod";

import { ProviderSchema } from "@/contracts";
import { testDaytonaConnection } from "@/integrations/daytona";
import { IntegrationError, safeIntegrationMessage } from "@/integrations/errors";
import { testGitHubInstallation } from "@/integrations/github";
import { testKimiConnection } from "@/integrations/kimi";
import { testRedditConnection } from "@/integrations/reddit";
import { testVercelConnection } from "@/integrations/vercel";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import {
  claimPublishedIdempotencyReceipt,
  completePublishedIdempotencyReceipt,
  secureIdempotencyFingerprint,
  type PersistedIdempotencyError,
  type PublishedIdempotencyOutcome,
} from "@/server/published-idempotency";
import {
  markConnectionTest,
  ProviderCredentialTestReadError,
  readProviderCredentialForTest,
} from "@/server/secret-vault";
import { getConnection, readIdempotent, updateConnectionMetadata, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ provider: string }> };

const TestBodySchema = z.object({}).strict();
const ConnectionTestResultSchema = z
  .object({
    provider: ProviderSchema,
    health: z.string(),
    accountId: z.string().nullable(),
    accountLabel: z.string().nullable(),
    scopes: z.array(z.string()),
    maskedSuffix: z.string().nullable(),
    lastTestedAt: z.string().nullable(),
    latencyMs: z.number().int().nonnegative(),
    failureCode: z.null(),
    failureMessage: z.null(),
    replacementPending: z.boolean(),
    optimisticVersion: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();

function persistedProviderError(error: unknown): PersistedIdempotencyError {
  if (error instanceof HttpError) {
    return { code: error.code, message: error.message, status: error.status, retryable: error.retryable };
  }
  if (error instanceof IntegrationError) {
    return {
      code: "provider_unavailable",
      message: safeIntegrationMessage(error),
      status: error.status,
      retryable: error.retryable,
    };
  }
  if (error instanceof z.ZodError) {
    return { code: "bad_request", message: "The stored provider credential format is invalid.", status: 400, retryable: false };
  }
  if (error instanceof Error && /stale|changed/i.test(error.message)) {
    return { code: "conflict", message: error.message, status: 409, retryable: true };
  }
  return {
    code: "provider_unavailable",
    message: safeIntegrationMessage(error),
    status: 502,
    retryable: false,
  };
}

function replayedTestResult(outcome: PublishedIdempotencyOutcome) {
  if (!outcome.ok) {
    throw new HttpError(outcome.error.code, outcome.error.message, outcome.error.status, outcome.error.retryable);
  }
  return ConnectionTestResultSchema.parse({
    ...ConnectionTestResultSchema.parse(outcome.response),
    replayed: true,
  });
}

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { provider: rawProvider } = await params;
    const provider = ProviderSchema.parse(rawProvider);
    const body = TestBodySchema.parse(await request.json());

    if (!isDemoMode()) {
      const operation = `connection.test.${provider}`;
      const requestFingerprint = secureIdempotencyFingerprint(operation, {
        provider,
        body,
        expectedConnectionVersion: context.expectedVersion,
      });
      const receipt = await claimPublishedIdempotencyReceipt({
        workspaceId: context.owner.workspaceId,
        idempotencyKey: context.idempotencyKey,
        operation,
        requestFingerprint,
      });
      if (receipt.kind === "replay") return ok(replayedTestResult(receipt.outcome), context.requestId);
      if (receipt.kind === "in_progress") {
        throw new HttpError("conflict", "A provider test with this idempotency key is already in progress.", 409, true);
      }

      const startedAt = Date.now();
      let testedSecretVersionId: string | undefined;
      let connectionId: string | null = null;
      let providerCallSucceeded = false;
      try {
        const record = await getDb().providerConnection.findUnique({
          where: { workspaceId_provider: { workspaceId: context.owner.workspaceId, provider: provider.toUpperCase() as Uppercase<typeof provider> } },
        });
        if (!record) throw new HttpError("not_found", "Connection not found.", 404);
        if (record.optimisticVersion !== context.expectedVersion) {
          throw new HttpError("precondition_failed", "Connection version conflict.", 412);
        }
        connectionId = record.id;

        let accountId: string | undefined;
        let accountLabel: string | undefined;
        let scopes: string[] | undefined;
        if (provider === "kimi") {
          const selected = await readProviderCredentialForTest({ workspaceId: context.owner.workspaceId, provider });
          testedSecretVersionId = selected.secretVersionId;
          await testKimiConnection(selected.credential);
        } else if (provider === "daytona") {
          const selected = await readProviderCredentialForTest({ workspaceId: context.owner.workspaceId, provider });
          testedSecretVersionId = selected.secretVersionId;
          await testDaytonaConnection(selected.credential);
        } else if (provider === "vercel") {
          if (!record.accountExternalId) {
            throw new HttpError("feature_disabled", "The Vercel connection is missing its installed team ID.", 503);
          }
          const selected = await readProviderCredentialForTest({ workspaceId: context.owner.workspaceId, provider });
          testedSecretVersionId = selected.secretVersionId;
          const tested = await testVercelConnection(selected.credential, record.accountExternalId);
          accountId = tested.accountId;
          accountLabel = tested.account;
          scopes = ["project:write", "deployment:write", "env:write"];
        } else if (provider === "github") {
          const appId = process.env.GITHUB_APP_ID;
          const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n");
          if (!record.accountExternalId || !appId || !privateKey) {
            throw new HttpError("feature_disabled", "GitHub App configuration is incomplete.", 503);
          }
          const tested = await testGitHubInstallation({ appId, privateKey, installationId: record.accountExternalId });
          accountId = record.accountExternalId;
          accountLabel = tested.account;
          scopes = ["administration:write", "contents:write", "metadata:read"];
        } else {
          const selected = await readProviderCredentialForTest({ workspaceId: context.owner.workspaceId, provider });
          testedSecretVersionId = selected.secretVersionId;
          const parsed = z
            .object({ clientId: z.string(), clientSecret: z.string(), userAgent: z.string() })
            .strict()
            .parse(JSON.parse(selected.credential));
          await testRedditConnection({
            ...parsed,
            approvalReference: selected.authorizationReference ?? process.env.REDDIT_APPROVAL_REFERENCE ?? "",
          });
          scopes = ["read"];
        }

        providerCallSucceeded = true;
        let committedResult: z.infer<typeof ConnectionTestResultSchema> | null = null;
        await markConnectionTest({
          workspaceId: context.owner.workspaceId,
          provider,
          healthy: true,
          ...(testedSecretVersionId ? { testedSecretVersionId } : {}),
          ...(accountId ? { accountId } : {}),
          ...(accountLabel ? { accountLabel } : {}),
          ...(scopes ? { scopes } : {}),
          expectedConnectionVersion: context.expectedVersion!,
          idempotencyCompletion: {
            claim: receipt.claim,
            operation,
            requestFingerprint,
            outcome: (connection) => {
              committedResult = ConnectionTestResultSchema.parse({
                provider,
                health: connection.health.toLowerCase(),
                accountId: connection.accountExternalId,
                accountLabel: connection.accountLabel,
                scopes: connection.scopes,
                maskedSuffix: connection.maskedSuffix,
                lastTestedAt: connection.lastTestedAt?.toISOString() ?? null,
                latencyMs: Date.now() - startedAt,
                failureCode: null,
                failureMessage: null,
                replacementPending: Boolean(connection.pendingSecretVersionId),
                optimisticVersion: connection.optimisticVersion,
                replayed: false,
              });
              return { ok: true, response: committedResult };
            },
            audit: (connection) => ({
              actorUserId: context.owner.userId,
              action: "connection.test.succeeded",
              targetType: "provider_connection",
              targetId: connection.id,
              requestId: context.requestId,
              metadata: { provider, latencyMs: Date.now() - startedAt, scopes: connection.scopes },
            }),
          },
        });
        if (!committedResult) throw new Error("Connection test result was not committed.");
        return ok(committedResult, context.requestId);
      } catch (providerError) {
        if (providerCallSucceeded) throw providerError;
        if (providerError instanceof ProviderCredentialTestReadError) {
          testedSecretVersionId = providerError.secretVersionId;
        }
        const failure = persistedProviderError(providerError);
        let failureReceiptCompleted = false;
        if (connectionId) {
          try {
            await markConnectionTest({
              workspaceId: context.owner.workspaceId,
              provider,
              healthy: false,
              ...(testedSecretVersionId ? { testedSecretVersionId } : {}),
              expectedConnectionVersion: context.expectedVersion!,
              failureCode: "provider_test_failed",
              failureMessage: failure.message,
              idempotencyCompletion: {
                claim: receipt.claim,
                operation,
                requestFingerprint,
                outcome: () => ({ ok: false, error: failure }),
                audit: (connection) => ({
                  actorUserId: context.owner.userId,
                  action: "connection.test.failed",
                  targetType: "provider_connection",
                  targetId: connection.id,
                  requestId: context.requestId,
                  metadata: { provider, failureCode: failure.code, retryable: failure.retryable },
                }),
              },
            });
            failureReceiptCompleted = true;
          } catch (cleanupError) {
            if (!(cleanupError instanceof Error) || !/stale|changed|version conflict/i.test(cleanupError.message)) throw cleanupError;
          }
        }
        if (!failureReceiptCompleted) {
          await completePublishedIdempotencyReceipt({
            workspaceId: context.owner.workspaceId,
            claim: receipt.claim,
            operation,
            requestFingerprint,
            outcome: { ok: false, error: failure },
          });
        }
        throw new HttpError(failure.code, failure.message, failure.status, failure.retryable);
      }
    }

    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const connection = getConnection(provider);
    if (!connection) throw new HttpError("not_found", "Connection not found.", 404);
    if (provider === "reddit" && connection.status === "locked") {
      throw new HttpError("feature_disabled", "Reddit remains locked until authorization and live credentials are both verified.", 403);
    }
    const testedAt = new Date().toISOString();
    const status = updateConnectionMetadata(provider, {
      status: "healthy",
      lastTestedAt: testedAt,
      message: "Demo contract test passed. No external request was made.",
    }, context.expectedVersion!);
    const result = { ...status, testedAt, latencyMs: 12, externalCallMade: false };
    writeIdempotent(context.idempotencyKey, result);
    return ok(result, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
