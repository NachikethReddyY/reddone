export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("Canonical JSON cannot contain a non-finite number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new CanonicalJsonError(`Canonical JSON cannot contain ${typeof value}`);
  }
  if (typeof value === "bigint") throw new CanonicalJsonError("Canonical JSON cannot contain bigint values");
  if (value instanceof Date) throw new CanonicalJsonError("Convert Date instances to ISO strings before canonicalization");
  if (typeof value !== "object") throw new CanonicalJsonError("Unsupported canonical JSON value");
  if (seen.has(value)) throw new CanonicalJsonError("Canonical JSON cannot contain circular references");

  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => serialize(item, seen)).join(",")}]`;

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError("Canonical JSON only accepts plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet());
}
