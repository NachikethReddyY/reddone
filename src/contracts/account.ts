import { z } from "zod";

import { createApiSuccessSchema } from "./api";
import { IdSchema, IsoDateTimeSchema } from "./common";

const AccountTimeZoneSchema = z.string().trim().min(1).max(100);
const StoredAvatarImageSchema = z.string().max(200_000).refine(
  (value) => /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) || /^https:\/\/[^\s]+$/.test(value),
  { message: "Profile images must be a stored image or a secure remote URL." },
);
const AvatarUploadDataSchema = z.string().min(32).max(700_000).regex(
  /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/,
  "Upload a JPEG, PNG, or WebP image.",
);

export const AccountProfileSchema = z.object({
  user: z.object({
    id: IdSchema,
    name: z.string().min(1).max(120),
    image: StoredAvatarImageSchema.nullable(),
    email: z.string().email().max(320),
    emailVerified: z.boolean(),
    createdAt: IsoDateTimeSchema,
  }).strict(),
  workspace: z.object({
    id: IdSchema,
    name: z.string().min(1).max(120),
    timeZone: AccountTimeZoneSchema,
    status: z.enum(["active", "paused", "archived"]),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  }).strict(),
  capabilities: z.object({
    canChangePassword: z.boolean(),
    emailDeliveryAvailable: z.boolean(),
  }).strict(),
}).strict();

export const AccountUpdateInputSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  workspaceName: z.string().trim().min(2).max(120).optional(),
  timeZone: AccountTimeZoneSchema.optional(),
}).strict().refine(
  (value) => value.name !== undefined || value.workspaceName !== undefined || value.timeZone !== undefined,
  { message: "Provide at least one account field to update." },
);

export const AccountAvatarUpdateInputSchema = z.object({
  image: AvatarUploadDataSchema.nullable(),
}).strict();

export const AccountSessionSchema = z.object({
  id: IdSchema,
  current: z.boolean(),
  ipAddress: z.string().max(100).nullable(),
  userAgent: z.string().max(1_000).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
}).strict();

export const AccountSessionListSchema = z.object({
  items: z.array(AccountSessionSchema).max(200),
}).strict();

export const RevokeAccountSessionInputSchema = z.object({
  sessionId: IdSchema,
}).strict();

export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
  revokeOtherSessions: z.boolean().default(true),
}).strict();

export const AccountProfileResponseSchema = createApiSuccessSchema(AccountProfileSchema);
export const AccountSessionListResponseSchema = createApiSuccessSchema(AccountSessionListSchema);
export const AccountMutationResponseSchema = createApiSuccessSchema(z.object({ success: z.literal(true) }).strict());

export type AccountProfile = z.infer<typeof AccountProfileSchema>;
export type AccountUpdateInput = z.infer<typeof AccountUpdateInputSchema>;
export type AccountAvatarUpdateInput = z.infer<typeof AccountAvatarUpdateInputSchema>;
export type AccountSession = z.infer<typeof AccountSessionSchema>;
export type AccountSessionList = z.infer<typeof AccountSessionListSchema>;
export type RevokeAccountSessionInput = z.infer<typeof RevokeAccountSessionInputSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
