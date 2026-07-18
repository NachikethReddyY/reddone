import { z } from "zod";

import { JsonValueSchema } from "./common";

export const ApiErrorCodeSchema = z.enum([
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_required",
  "precondition_failed",
  "insufficient_credits",
  "rate_limited",
  "provider_unavailable",
  "database_unavailable",
  "feature_disabled",
  "internal_error",
]);

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1).max(1_000),
        requestId: z.string().min(1).max(200),
        retryable: z.boolean(),
        details: JsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const createApiSuccessSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data, requestId: z.string().min(1).max(200) }).strict();

export type ApiError = z.infer<typeof ApiErrorSchema>;
