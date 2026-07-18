import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const IdSchema = z.string().trim().min(1).max(128);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 digest");
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const UrlSchema = z.string().url().max(2_048);
export const NonEmptyStringSchema = z.string().trim().min(1);
export const OptimisticVersionSchema = z.number().int().nonnegative();
export const MoneyMicrosSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TimeZoneSchema = z.string().trim().min(1).max(100).default("Asia/Singapore");

export const CursorPageQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(1_024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const MutationHeadersSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    optimisticVersion: OptimisticVersionSchema.optional(),
  })
  .strict();

export const SecretVersionRefSchema = z
  .object({
    secretVersionId: IdSchema,
    name: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
  })
  .strict();

export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;
export type MutationHeaders = z.infer<typeof MutationHeadersSchema>;
export type SecretVersionRef = z.infer<typeof SecretVersionRefSchema>;

