import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./canonical-json";

function signatureFor(reportHash: string, key: string) {
  return createHmac("sha256", key).update(reportHash).digest("base64url");
}

export function verifyVerificationSignature(input: { reportHash: string; signature: string; key: string | undefined }) {
  if (!/^[a-f0-9]{64}$/i.test(input.reportHash) || !input.key || input.key.length < 32 || !input.signature) return false;
  const expected = Buffer.from(signatureFor(input.reportHash, input.key));
  const supplied = Buffer.from(input.signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function hashVerificationReport(report: unknown) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Verification report is invalid.");
  const unsigned = { ...(report as Record<string, unknown>) };
  delete unsigned.reportHash;
  delete unsigned.signature;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

export function verifySignedVerificationReport(input: {
  report: unknown;
  reportHash: string;
  signature: string;
  key: string | undefined;
}) {
  let actualHash: string;
  try {
    actualHash = hashVerificationReport(input.report);
  } catch {
    return false;
  }
  const actual = Buffer.from(actualHash, "hex");
  const expected = Buffer.from(input.reportHash, "hex");
  return actual.length === expected.length
    && timingSafeEqual(actual, expected)
    && verifyVerificationSignature(input);
}
