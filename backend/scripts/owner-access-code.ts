import "dotenv/config";

import { randomBytes } from "node:crypto";

import { creditCodeSuffix, hashCreditCode } from "../src/server/credit-codes";
import { disconnectDb, getDb } from "../src/server/db";
import { getRuntimeConfig } from "../src/server/env";

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

function generateCode() {
  const token = randomBytes(24).toString("hex").toUpperCase();
  return `OWNER-${token.match(/.{1,6}/g)!.join("-")}`;
}

async function main() {
  const credits = BigInt(positiveInteger(option("credits"), "credits", 1_000_000));
  const maxRedemptions = positiveInteger(option("max-redemptions"), "max-redemptions", 1);
  const validDays = positiveInteger(option("valid-days"), "valid-days", 30);
  const label = option("label")?.trim() || "Owner complimentary access";
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60_000);
  const config = getRuntimeConfig();
  const hashSecret = config.auth.ownerAccessCodePepper;
  if (!hashSecret) throw new Error("OWNER_ACCESS_CODE_PEPPER is required.");

  const code = generateCode();
  await getDb().creditCode.create({
    data: {
      codeHash: hashCreditCode(code, hashSecret),
      displaySuffix: creditCodeSuffix(code),
      label: label.slice(0, 120),
      grantCredits: credits,
      maxRedemptions,
      expiresAt,
    },
  });

  process.stdout.write(`${JSON.stringify({
    code,
    label,
    credits: credits.toString(),
    maxRedemptions,
    expiresAt: expiresAt.toISOString(),
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Owner access code generation failed."}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
