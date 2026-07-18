import { createHmac } from "node:crypto";

import { AppError } from "./errors";

const CREDIT_CODE_MIN_LENGTH = 12;
const CREDIT_CODE_MAX_LENGTH = 128;

export function normalizeCreditCode(code: string): string {
  const normalized = code.trim().toUpperCase().replaceAll(" ", "");
  if (
    normalized.length < CREDIT_CODE_MIN_LENGTH
    || normalized.length > CREDIT_CODE_MAX_LENGTH
    || !/^[A-Z0-9-]+$/.test(normalized)
  ) {
    throw new AppError("bad_request", "The access code is invalid or unavailable");
  }
  return normalized;
}

export function hashCreditCode(code: string, hashSecret: string): string {
  if (Buffer.byteLength(hashSecret, "utf8") < 32) {
    throw new RangeError("Credit code hashing requires at least 32 bytes of secret material.");
  }
  return createHmac("sha256", hashSecret).update(normalizeCreditCode(code), "utf8").digest("hex");
}

export function creditCodeSuffix(code: string): string {
  return normalizeCreditCode(code).replaceAll("-", "").slice(-6);
}
