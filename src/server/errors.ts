export type AppErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "precondition_required"
  | "precondition_failed"
  | "insufficient_credits"
  | "rate_limited"
  | "provider_unavailable"
  | "database_unavailable"
  | "feature_disabled"
  | "internal_error";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_required: 428,
  precondition_failed: 412,
  insufficient_credits: 402,
  rate_limited: 429,
  provider_unavailable: 503,
  database_unavailable: 503,
  feature_disabled: 503,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly safeDetails: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: AppErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      safeDetails?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? false;
    this.safeDetails = options.safeDetails;
  }
}

export class InsufficientCreditsError extends AppError {
  readonly required: bigint;
  readonly spendable: bigint;
  readonly frozen: bigint;

  constructor(input: { required: bigint; spendable: bigint; frozen: bigint }) {
    super("insufficient_credits", "The workspace does not have enough spendable credits for this operation", {
      safeDetails: {
        required: input.required.toString(),
        spendable: input.spendable.toString(),
        frozen: input.frozen.toString(),
      },
    });
    this.name = "InsufficientCreditsError";
    this.required = input.required;
    this.spendable = input.spendable;
    this.frozen = input.frozen;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("internal_error", "An unexpected error occurred", { cause: error });
}

