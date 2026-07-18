import "dotenv/config";

import { randomBytes } from "node:crypto";

import { disconnectDb, getDb } from "../src/server/db";
import { hackathonCreditCodeSuffix, hashHackathonCreditCode } from "../src/server/credits";
import { getRuntimeConfig } from "../src/server/env";

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, name: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

function generateCode() {
  const token = randomBytes(15).toString("base64url").toUpperCase().replaceAll("_", "A").replaceAll("-", "B");
  return `RDDN-${token.slice(0, 5)}-${token.slice(5, 10)}-${token.slice(10, 15)}-${token.slice(15, 20)}`;
}

async function main() {
  const count = positiveInteger(option("count"), "count", 1);
  const credits = BigInt(positiveInteger(option("credits"), "credits"));
  const maxRedemptions = positiveInteger(option("max-redemptions"), "max-redemptions", 1);
  const label = option("label")?.trim() || "Hackathon credit grant";
  const expiresAt = new Date(option("expires") ?? "");
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new Error("--expires must be a future ISO-8601 timestamp.");
  }
  if (count > 1_000) throw new Error("--count cannot exceed 1000 per batch.");

  const config = getRuntimeConfig();
  const hashSecret = config.auth.registrationPepper;
  if (!hashSecret) throw new Error("HACKATHON_REGISTRATION_PEPPER is required.");

  const db = getDb();
  const issued: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const code = generateCode();
    await db.creditCode.create({
      data: {
        codeHash: hashHackathonCreditCode(code, hashSecret),
        displaySuffix: hackathonCreditCodeSuffix(code),
        label: label.slice(0, 120),
        grantCredits: credits,
        maxRedemptions,
        expiresAt,
      },
    });
    issued.push(code);
  }

  process.stdout.write(`${JSON.stringify({ label, credits: credits.toString(), maxRedemptions, expiresAt: expiresAt.toISOString(), codes: issued }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Credit code generation failed."}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
