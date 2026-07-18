export type IntegrationErrorCode =
  | "not_configured"
  | "not_authorized"
  | "invalid_response"
  | "insufficient_scope"
  | "rate_limited"
  | "timeout"
  | "provider_error";

/** A deliberately safe provider error. Raw provider bodies must never reach the UI. */
export class IntegrationError extends Error {
  constructor(
    public readonly code: IntegrationErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export function safeIntegrationMessage(error: unknown): string {
  if (error instanceof IntegrationError) return error.message;
  return "The provider did not complete the request. No credentials were exposed.";
}
