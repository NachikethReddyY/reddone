import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

import { IntegrationError } from "@/integrations/errors";
import { createDemoOwnerContext, type OwnerContext } from "@/server/auth";
import { getOwnerSession } from "@/server/better-auth";
import { isDemoMode } from "@/server/env";
import { AppError } from "@/server/errors";
import { IdempotencyKeySchema } from "@/server/idempotency";

export interface MutationContext {
  requestId: string;
  idempotencyKey: string;
  expectedVersion: number | null;
  owner: OwnerContext;
}

export function requestId(request: Request) {
  return request.headers.get("x-request-id")?.slice(0, 200) || randomUUID();
}

export function ok<T>(data: T, requestIdValue: string, init?: ResponseInit) {
  const safeData = JSON.parse(
    JSON.stringify(data, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
  ) as unknown;
  return NextResponse.json({ data: safeData, requestId: requestIdValue }, init);
}

export function apiError(
  requestIdValue: string,
  code: string,
  message: string,
  status: number,
  retryable = false,
  details?: unknown,
) {
  return NextResponse.json(
    { error: { code, message, requestId: requestIdValue, retryable, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

export async function parseJson<T>(request: Request, schema: ZodType<T>) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError("bad_request", "Request body must be valid JSON.", 400);
  }
  return schema.parse(value);
}

export class HttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function assertOwnerRequest(request: Request) {
  if (isDemoMode()) return createDemoOwnerContext();
  const owner = await getOwnerSession(request);
  if (!owner) throw new HttpError("unauthenticated", "Owner authentication is required.", 401);
  return owner;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    if (!isDemoMode()) throw new HttpError("forbidden", "A trusted request origin is required.", 403);
    return;
  }
  let actualOrigin: string;
  let expectedOrigin: string;
  try {
    actualOrigin = new URL(origin).origin;
    expectedOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? request.url).origin;
  } catch {
    throw new HttpError("forbidden", "A trusted request origin is required.", 403);
  }
  if (request.headers.get("sec-fetch-site") === "cross-site" || actualOrigin !== expectedOrigin) {
    throw new HttpError("forbidden", "Cross-origin mutation rejected.", 403);
  }
}

export function parseMutationIdempotencyKey(value: string | null) {
  const parsed = IdempotencyKeySchema.safeParse(value?.trim());
  if (!parsed.success) {
    throw new HttpError("precondition_required", "A valid Idempotency-Key header is required.", 428);
  }
  return parsed.data;
}

export function parseMutationExpectedVersion(value: string | null, required: boolean) {
  if (value === null) {
    if (required) throw new HttpError("precondition_required", "An If-Match optimistic version is required.", 428);
    return null;
  }
  const match = /^(?:W\/)?"?(0|[1-9]\d*)"?$/.exec(value.trim());
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new HttpError("precondition_required", "An If-Match optimistic version is required.", 428);
  }
  return version;
}

export async function mutationContext(request: Request, options: { requireVersion?: boolean } = {}): Promise<MutationContext> {
  const owner = await assertOwnerRequest(request);
  assertSameOrigin(request);
  const idempotencyKey = parseMutationIdempotencyKey(request.headers.get("idempotency-key"));
  const expectedVersion = parseMutationExpectedVersion(request.headers.get("if-match"), options.requireVersion ?? false);
  return { requestId: requestId(request), idempotencyKey, expectedVersion, owner };
}

export function handleRouteError(error: unknown, requestIdValue: string) {
  if (error instanceof HttpError) {
    return apiError(requestIdValue, error.code, error.message, error.status, error.retryable, error.details);
  }
  if (error instanceof AppError) {
    return apiError(requestIdValue, error.code, error.message, error.status, error.retryable, error.safeDetails);
  }
  if (error instanceof IntegrationError) {
    return apiError(requestIdValue, "provider_unavailable", error.message, error.status, error.retryable);
  }
  if (error instanceof ZodError) {
    return apiError(requestIdValue, "bad_request", "Request validation failed.", 400, false, error.flatten());
  }
  const message = error instanceof Error ? error.message : "Unexpected request failure.";
  const precondition = /optimistic|version (?:does not match|conflict)|if-match/i.test(message);
  const conflict = /conflict|already|active run|stale/i.test(message);
  const missing = /not found/i.test(message);
  return apiError(
    requestIdValue,
    precondition ? "precondition_failed" : conflict ? "conflict" : missing ? "not_found" : "bad_request",
    message,
    precondition ? 412 : conflict ? 409 : missing ? 404 : 400,
  );
}

export async function route<T>(request: Request, handler: (id: string) => Promise<T> | T) {
  const id = requestId(request);
  try {
    await assertOwnerRequest(request);
    return ok(await handler(id), id);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
