import { describe, expect, it } from "vitest";

import {
  completedPublishedIdempotencyReceiptData,
  parsePublishedIdempotencyReceipt,
  secureIdempotencyFingerprint,
} from "@/server/published-idempotency";
import {
  decideProviderCredentialTest,
  failedProviderCredentialConnectionUpdate,
  stagedProviderCredentialConnectionUpdate,
} from "@/server/secret-vault";

describe("provider credential replacement safety", () => {
  it("keeps a healthy active version when its pending replacement fails", () => {
    expect(decideProviderCredentialTest({
      activeSecretVersionId: "active-v1",
      pendingSecretVersionId: "candidate-v2",
      testedSecretVersionId: "candidate-v2",
      healthy: false,
    })).toBe("reject_pending_preserve_active");

    expect(decideProviderCredentialTest({
      activeSecretVersionId: null,
      pendingSecretVersionId: "candidate-v1",
      testedSecretVersionId: "candidate-v1",
      healthy: false,
    })).toBe("reject_pending_without_active");

    expect(failedProviderCredentialConnectionUpdate({
      activeUsable: true,
      failureCode: "provider_test_failed",
      failureMessage: "Candidate rejected",
      testedAt: new Date("2026-07-11T00:00:00.000Z"),
    })).toEqual({ pendingSecretVersionId: null });
  });

  it("stages a replacement without overwriting active display or health metadata", () => {
    expect(stagedProviderCredentialConnectionUpdate({
      pendingSecretVersionId: "candidate-v2",
      pendingMaskedSuffix: "2222",
      hasActiveCredential: true,
      accountLabel: "Different candidate account",
      accountExternalId: "candidate-account",
      scopes: ["candidate:scope"],
      authorizationReference: "candidate-authorization",
    })).toEqual({ pendingSecretVersionId: "candidate-v2" });
  });

  it("promotes only the exact candidate that was tested", () => {
    expect(decideProviderCredentialTest({
      activeSecretVersionId: "active-v1",
      pendingSecretVersionId: "candidate-v2",
      testedSecretVersionId: "candidate-v2",
      healthy: true,
    })).toBe("promote_pending");

    expect(decideProviderCredentialTest({
      activeSecretVersionId: "active-v1",
      pendingSecretVersionId: "candidate-v3",
      testedSecretVersionId: "candidate-v2",
      healthy: true,
    })).toBe("stale");

    expect(decideProviderCredentialTest({
      activeSecretVersionId: "active-v1",
      pendingSecretVersionId: "candidate-v2",
      testedSecretVersionId: "active-v1",
      healthy: true,
    })).toBe("update_active");
  });
});

describe("published production idempotency receipts", () => {
  const signingKey = "test-signing-key-that-is-long-enough";
  const operation = "connection.credential.put.kimi";
  const request = { provider: "kimi", credential: "sk-sensitive-value", accountLabel: "Workspace" };

  it("HMAC-binds canonical request input without persisting the input", () => {
    const fingerprint = secureIdempotencyFingerprint(operation, request, signingKey);
    const reordered = secureIdempotencyFingerprint(operation, {
      accountLabel: "Workspace",
      credential: "sk-sensitive-value",
      provider: "kimi",
    }, signingKey);
    const changed = secureIdempotencyFingerprint(operation, { ...request, credential: "sk-other-value" }, signingKey);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(reordered);
    expect(fingerprint).not.toBe(changed);
    expect(fingerprint).not.toContain("sensitive");
  });

  it("replays the stored response only for the matching fingerprint and verifies integrity", () => {
    const requestFingerprint = secureIdempotencyFingerprint(operation, request, signingKey);
    const data = completedPublishedIdempotencyReceiptData({
      workspaceId: "workspace-1",
      idempotencyKey: "connection-kimi-request-1",
      operation,
      requestFingerprint,
      outcome: { ok: true, response: { provider: "kimi", health: "healthy", maskedSuffix: "1234" } },
    });
    const event = { eventType: data.eventType, payload: data.payload, payloadHash: data.payloadHash };

    expect(parsePublishedIdempotencyReceipt(event, { operation, requestFingerprint })).toMatchObject({
      state: "completed",
      outcome: { ok: true, response: { provider: "kimi", health: "healthy", maskedSuffix: "1234" } },
    });
    expect(() => parsePublishedIdempotencyReceipt(event, {
      operation,
      requestFingerprint: secureIdempotencyFingerprint(operation, { ...request, credential: "different" }, signingKey),
    })).toThrow(/different request input/i);
    expect(() => parsePublishedIdempotencyReceipt({
      ...event,
      payload: { ...(data.payload as Record<string, unknown>), response: { provider: "kimi", health: "degraded" } },
    }, { operation, requestFingerprint })).toThrow(/integrity/i);
  });
});
