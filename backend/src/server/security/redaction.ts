import { AppError } from "../errors";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:^|[_-])(?:api[_-]?key|secret|token|password|passwd|credential|authorization|cookie|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)(?:$|[_-])/i;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:sk|pk|key|tok|api)[-_][A-Za-z0-9_-]{16,}\b/gi,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /((?:api[_-]?key|secret|token|password|credential|client[_-]?secret)\s*(?:is|:|=)\s*["']?)[^\s,"'}]{6,}/gi,
  /([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi,
];

function resetAndTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function containsSecretLikeText(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => resetAndTest(pattern, value));
}

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => {
    pattern.lastIndex = 0;
    if (pattern.source.startsWith("((?:") || pattern.source.startsWith("([?&]")) {
      return redacted.replace(pattern, `$1${REDACTED}`);
    }
    return redacted.replace(pattern, REDACTED);
  }, value);
}

export function containsSecretLikeValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return containsSecretLikeText(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) return value.some((item) => containsSecretLikeValue(item, seen));
  return Object.entries(value).some(
    ([key, item]) =>
      (isSensitiveKey(key) && item !== null && item !== undefined && item !== "") ||
      containsSecretLikeValue(item, seen),
  );
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) && item !== null && item !== undefined ? REDACTED : redactValue(item, seen);
  }
  return result;
}

export function assertNoSecretLikeInput(value: unknown): void {
  if (containsSecretLikeValue(value)) {
    throw new AppError("bad_request", "Secret-like input is not accepted here; use Connections instead", {
      safeDetails: { redirectTo: "/connections" },
    });
  }
}
