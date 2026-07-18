const RETURN_TO_BASE = "https://return-to.invalid";
export const MAX_RETURN_TO_LENGTH = 2_048;

/**
 * Accepts only same-origin relative application paths and preserves their query/hash.
 * Absolute, protocol-relative, backslash-based, and control-character redirects fail closed.
 */
export function validateReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > MAX_RETURN_TO_LENGTH || value !== value.trim()) return null;
  if (
    !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("\\")
    || /%5c/i.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }

  try {
    const parsed = new URL(value, RETURN_TO_BASE);
    if (
      parsed.origin !== RETURN_TO_BASE
      || !parsed.pathname.startsWith("/")
      || parsed.pathname.startsWith("//")
      || parsed.pathname.includes("\\")
      || /%5c/i.test(parsed.pathname)
    ) {
      return null;
    }
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return null;
  }
}

export function safeReturnTo(
  value: string | null | undefined,
  fallback = "/projects",
): string {
  return validateReturnTo(value) ?? validateReturnTo(fallback) ?? "/projects";
}
