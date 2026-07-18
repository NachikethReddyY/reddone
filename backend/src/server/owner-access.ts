import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { creditCodeSuffix } from "./credit-codes";
import { ensurePromotionalGrant, redeemCreditCode } from "./credits";
import { getDb } from "./db";
import { getRuntimeConfig } from "./env";
import { AppError } from "./errors";
import { withSerializableTransaction } from "./transactions";

export const OwnerAccessRegistrationSchema = z
  .object({
    code: z.string().min(12).max(512),
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(12).max(200),
  })
  .strict();

export async function registerOwnerWithAccessCode(input: z.input<typeof OwnerAccessRegistrationSchema> & {
  requestId: string;
  ipAddress?: string;
}) {
  const config = getRuntimeConfig();
  if (config.deploymentMode !== "public" || !config.auth.ownerAccessCodePepper) {
    throw new AppError("feature_disabled", "Owner access is not configured for this deployment");
  }
  const parsed = OwnerAccessRegistrationSchema.parse({
    code: input.code,
    name: input.name,
    email: input.email,
    password: input.password,
  });
  const passwordHash = await hashPassword(parsed.password);
  const ownerName = parsed.name.trim().slice(0, 80);

  try {
    return await withSerializableTransaction(getDb(), async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: parsed.email }, select: { id: true } });
      if (existing) throw new AppError("conflict", "An account already exists for this email. Sign in instead");

      const workspace = await tx.workspace.create({
        data: {
          name: `${ownerName} workspace`,
          timeZone: config.timeZone,
          maxConcurrentSandboxes: 2,
          monthlyBudgetMicros: 0,
        },
        select: { id: true },
      });
      await ensurePromotionalGrant(tx, { workspaceId: workspace.id });

      const userId = randomUUID();
      const user = await tx.user.create({
        data: {
          id: userId,
          workspaceId: workspace.id,
          name: parsed.name,
          email: parsed.email,
          emailVerified: true,
        },
        select: { id: true, email: true },
      });
      await tx.account.create({
        data: {
          id: randomUUID(),
          userId,
          accountId: userId,
          providerId: "credential",
          password: passwordHash,
        },
      });

      const grant = await redeemCreditCode(tx, {
        workspaceId: workspace.id,
        userId,
        code: parsed.code,
        hashSecret: config.auth.ownerAccessCodePepper!,
        purpose: "owner",
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: workspace.id,
          actorUserId: userId,
          action: "owner.access_code.redeemed",
          targetType: "credit_code_redemption",
          targetId: grant.redemption.id,
          requestId: input.requestId,
          ipHash: input.ipAddress ? createHash("sha256").update(input.ipAddress).digest("hex") : null,
          metadata: {
            displaySuffix: creditCodeSuffix(parsed.code),
            grantCredits: grant.redemption.grantCredits.toString(),
          },
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        },
      });

      return {
        created: true as const,
        userId: user.id,
        workspaceId: workspace.id,
        email: user.email,
        emailVerified: true as const,
        grantCredits: grant.redemption.grantCredits,
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      throw new AppError("conflict", "An account already exists for this email. Sign in instead");
    }
    throw error;
  }
}
