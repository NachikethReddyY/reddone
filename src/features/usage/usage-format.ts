export type UsageGranularity = "day" | "week";
export type UsageRunKind = "research" | "build" | "polish" | "release" | "rollback";
export type UsageMetric = "cost" | "tokens";
export type UsageRangePreset = "7d" | "30d" | "90d" | "custom";

export type UsageFilterState = {
  preset: UsageRangePreset;
  from: string;
  to: string;
  granularity: UsageGranularity;
  projectId: string;
  runKind: "" | UsageRunKind;
  operation: string;
  model: string;
};

const MICRODOLLARS_PER_DOLLAR = 1_000_000n;
const usageGranularities = ["day", "week"] as const;
const usageRunKinds = ["research", "build", "polish", "release", "rollback"] as const;
const usageRangePresets = ["7d", "30d", "90d", "custom"] as const;
const usagePageFilterKeys = ["preset", "from", "to", "granularity", "projectId", "runKind", "operation", "model"] as const;

type UsagePageSearchParams = URLSearchParams | Record<string, string | string[] | undefined>;

function decimalValue(value: string | number | bigint) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function dateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function startOfUtcWeek(date: Date) {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday;
}

function pageParam(searchParams: UsagePageSearchParams, key: string) {
  if (searchParams instanceof URLSearchParams) {
    const values = searchParams.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  }
  const value = searchParams[key];
  return typeof value === "string" ? value : undefined;
}

function isDateInputValue(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && dateInputValue(date) === value;
}

function pageFilterValue(value: string | undefined) {
  const hasControlCharacter = value ? [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) : false;
  if (value === undefined || value.length > 256 || hasControlCharacter) return "";
  return value;
}

export function createUsageFilters(now = new Date()): UsageFilterState {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return {
    preset: "30d",
    from: dateInputValue(from),
    to: dateInputValue(to),
    granularity: "day",
    projectId: "",
    runKind: "",
    operation: "",
    model: "",
  };
}

export function applyUsageRangePreset(filters: UsageFilterState, preset: Exclude<UsageRangePreset, "custom">, now = new Date()) {
  const days = Number.parseInt(preset, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return {
    ...filters,
    preset,
    from: dateInputValue(from),
    to: dateInputValue(to),
  };
}

export function validateUsageFilters(filters: UsageFilterState) {
  const from = new Date(`${filters.from}T00:00:00.000Z`);
  const to = addUtcDays(filters.to, 1);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "Choose a valid start and end date.";
  if (from >= to) return "The end date must be on or after the start date.";
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1_000) return "Usage ranges cannot exceed one year.";
  return "";
}

export function parseUsagePageSearchParams(searchParams: UsagePageSearchParams, now = new Date()): UsageFilterState {
  const fallback = createUsageFilters(now);
  const granularity = pageParam(searchParams, "granularity");
  const runKind = pageParam(searchParams, "runKind");
  const preset = pageParam(searchParams, "preset");
  const from = pageParam(searchParams, "from");
  const to = pageParam(searchParams, "to");
  const candidate: UsageFilterState = {
    ...fallback,
    granularity: usageGranularities.includes(granularity as UsageGranularity)
      ? granularity as UsageGranularity
      : fallback.granularity,
    runKind: usageRunKinds.includes(runKind as UsageRunKind) ? runKind as UsageRunKind : "",
    projectId: pageFilterValue(pageParam(searchParams, "projectId")),
    operation: pageFilterValue(pageParam(searchParams, "operation")),
    model: pageFilterValue(pageParam(searchParams, "model")),
  };

  if (isDateInputValue(from) && isDateInputValue(to)) {
    const range = {
      ...candidate,
      from,
      to,
      preset: usageRangePresets.includes(preset as UsageRangePreset)
        ? preset as UsageRangePreset
        : "custom" as const,
    };
    if (!validateUsageFilters(range)) return range;
  } else if (from === undefined && to === undefined && preset && preset !== "custom" && usageRangePresets.includes(preset as UsageRangePreset)) {
    return applyUsageRangePreset(candidate, preset as Exclude<UsageRangePreset, "custom">, now);
  }

  return candidate;
}

export function buildUsagePageSearchParams(filters: UsageFilterState, current = new URLSearchParams()) {
  const query = new URLSearchParams(current);
  for (const key of usagePageFilterKeys) query.delete(key);
  query.set("preset", filters.preset);
  query.set("from", filters.from);
  query.set("to", filters.to);
  query.set("granularity", filters.granularity);
  if (filters.projectId) query.set("projectId", filters.projectId);
  if (filters.runKind) query.set("runKind", filters.runKind);
  if (filters.operation) query.set("operation", filters.operation);
  if (filters.model) query.set("model", filters.model);
  return query;
}

export function buildUsageSearchParams(filters: UsageFilterState) {
  const query = new URLSearchParams({
    from: `${filters.from}T00:00:00.000Z`,
    to: addUtcDays(filters.to, 1).toISOString(),
    granularity: filters.granularity,
  });
  if (filters.projectId) query.set("projectId", filters.projectId);
  if (filters.runKind) query.set("runKind", filters.runKind);
  if (filters.operation) query.set("operation", filters.operation);
  if (filters.model) query.set("model", filters.model);
  return query;
}

export function formatMicrodollars(value: string | number | bigint) {
  const micros = decimalValue(value);
  const whole = micros / MICRODOLLARS_PER_DOLLAR;
  const fraction = (micros % MICRODOLLARS_PER_DOLLAR).toString().padStart(6, "0");
  const visibleFraction = micros === 0n ? "00" : fraction.replace(/0+$/, "").padEnd(2, "0");
  const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(whole);
  return `$${integer}.${visibleFraction}`;
}

export function formatMicrodollarsAccessible(value: string | number | bigint) {
  const formatted = formatMicrodollars(value).slice(1);
  return `${formatted} US dollars`;
}

export function formatTokens(value: string | number | bigint, compact = false) {
  const tokens = decimalValue(value);
  return new Intl.NumberFormat(undefined, compact
    ? { notation: "compact", maximumFractionDigits: 1 }
    : { maximumFractionDigits: 0 }).format(tokens);
}

export function formatProviderCalls(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function formatBucketDate(value: string, granularity: UsageGranularity, long = false) {
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return "Unknown date";
  const date = granularity === "week" ? startOfUtcWeek(parsedDate) : parsedDate;
  if (long) {
    const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date);
    return granularity === "week" ? `Week of ${formatted}` : formatted;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function formatTimestamp(value: string | null) {
  if (!value) return "In progress";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
