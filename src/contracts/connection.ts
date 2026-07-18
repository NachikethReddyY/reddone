import { z } from "zod";

import { IdSchema, IsoDateTimeSchema } from "./common";

export const ProviderSchema = z.enum(["kimi", "daytona", "reddit", "github", "vercel"]);
export const CredentialProviderSchema = z.enum(["kimi", "daytona", "reddit"]);
export const OAuthProviderSchema = z.enum(["github", "vercel"]);
export const ConnectionHealthSchema = z.enum([
  "disconnected",
  "pending",
  "healthy",
  "degraded",
  "revoked",
  "misconfigured",
]);

/** Inbound-only. Never use this type as an API response or persistence payload. */
export const ConnectionCredentialInputSchema = z
  .object({
    provider: CredentialProviderSchema,
    credential: z.string().min(8).max(16_384),
    accountLabel: z.string().trim().min(1).max(120).optional(),
    redditAuthorizationReference: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.provider === "reddit" && !input.redditAuthorizationReference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redditAuthorizationReference"],
        message: "Written Reddit authorization must be recorded before credentials are accepted",
      });
    }
  });

export const ConnectionStatusSchema = z
  .object({
    id: IdSchema,
    provider: ProviderSchema,
    health: ConnectionHealthSchema,
    accountId: z.string().max(256).nullable(),
    accountLabel: z.string().max(256).nullable(),
    scopes: z.array(z.string().max(200)).max(100),
    maskedSuffix: z.string().regex(/^.{0,4}$/).nullable(),
    lastTestedAt: IsoDateTimeSchema.nullable(),
    lastHealthyAt: IsoDateTimeSchema.nullable(),
    failureCode: z.string().max(100).nullable(),
    failureMessage: z.string().max(500).nullable(),
    connectedAt: IsoDateTimeSchema.nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const ConnectionTestResultSchema = z
  .object({
    provider: ProviderSchema,
    health: ConnectionHealthSchema,
    accountId: z.string().max(256).nullable(),
    accountLabel: z.string().max(256).nullable(),
    scopes: z.array(z.string().max(200)).max(100),
    testedAt: IsoDateTimeSchema,
    latencyMs: z.number().int().nonnegative().max(120_000),
    failureCode: z.string().max(100).nullable(),
    failureMessage: z.string().max(500).nullable(),
  })
  .strict();

export const OAuthCallbackResultSchema = z
  .object({
    provider: OAuthProviderSchema,
    outcome: z.enum([
      "connected",
      "consent_canceled",
      "insufficient_scopes",
      "wrong_account",
      "callback_expired",
      "provider_error",
    ]),
    connection: ConnectionStatusSchema.optional(),
    message: z.string().max(500).optional(),
  })
  .strict();

export type Provider = z.infer<typeof ProviderSchema>;
export type ConnectionCredentialInput = z.infer<typeof ConnectionCredentialInputSchema>;
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

