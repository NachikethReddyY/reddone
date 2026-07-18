import { createHash, timingSafeEqual } from "node:crypto";

import { ApprovalPayloadSchema, type ApprovalPayload } from "@/contracts";

import { canonicalJson } from "./canonical-json";

function normalizeApprovalPayload(payloadInput: ApprovalPayload): ApprovalPayload {
  const payload = ApprovalPayloadSchema.parse(payloadInput);
  const providerAccounts = [...payload.providerAccounts].sort((left, right) => {
    const providerOrder = left.provider.localeCompare(right.provider);
    return providerOrder === 0 ? left.accountId.localeCompare(right.accountId) : providerOrder;
  });
  if ("secretGrants" in payload) {
    const secretGrants = [...payload.secretGrants].sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder === 0 ? left.version - right.version : nameOrder;
    });
    return { ...payload, providerAccounts, secretGrants };
  }
  return { ...payload, providerAccounts };
}

export function canonicalizeApprovalPayload(payload: ApprovalPayload): string {
  return canonicalJson(normalizeApprovalPayload(payload));
}

export function hashApprovalPayload(payload: ApprovalPayload): string {
  return createHash("sha256").update(canonicalizeApprovalPayload(payload), "utf8").digest("hex");
}

export function verifyApprovalPayloadHash(payload: ApprovalPayload, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(hashApprovalPayload(payload), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface CanonicalApprovalRecord {
  payload: ApprovalPayload;
  payloadCanonical: string;
  payloadHash: string;
}

export function createCanonicalApprovalRecord(payloadInput: ApprovalPayload): CanonicalApprovalRecord {
  const payload = normalizeApprovalPayload(payloadInput);
  const payloadCanonical = canonicalJson(payload);
  const payloadHash = createHash("sha256").update(payloadCanonical, "utf8").digest("hex");
  return { payload, payloadCanonical, payloadHash };
}
