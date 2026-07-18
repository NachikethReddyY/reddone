import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { IntegrationError } from "./errors";

const REDDIT_OAUTH_ORIGIN = "https://oauth.reddit.com";
const REDDIT_TOKEN_ENDPOINT = "https://www.reddit.com/api/v1/access_token";
const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export const RedditStoredCredentialSchema = z
  .object({
    clientId: z.string().trim().min(4).max(300),
    clientSecret: z.string().min(8).max(4_096),
    userAgent: z.string().trim().min(8).max(500),
  })
  .strict();

export interface RedditCredentials extends z.infer<typeof RedditStoredCredentialSchema> {
  approvalReference: string;
}

export type RedditListingSort = "hot" | "new" | "top" | "rising";
export type RedditSearchSort = "relevance" | "hot" | "top" | "new" | "comments";
export type RedditTimeRange = "hour" | "day" | "week" | "month" | "year" | "all";

export interface RedditRateLimit {
  used: number | null;
  remaining: number | null;
  resetSeconds: number | null;
}

export interface RedditPost {
  id: string;
  fullname: string;
  title: string;
  body: string;
  permalink: string;
  externalUrl: string | null;
  score: number;
  commentCount: number;
  createdAt: string;
  sourceLabel: string;
  attribution: string;
  over18: boolean;
}

export interface RedditComment {
  id: string;
  fullname: string;
  parentId: string;
  body: string;
  permalink: string | null;
  score: number;
  createdAt: string;
  depth: number;
}

export interface RedditPage<T> {
  items: T[];
  after: string | null;
  rateLimit: RedditRateLimit;
}

const redditPostDataSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    title: z.string(),
    selftext: z.string().nullish().default(""),
    permalink: z.string(),
    url: z.string().url().optional(),
    score: z.number().default(0),
    num_comments: z.number().int().nonnegative().default(0),
    created_utc: z.number(),
    subreddit: z.string(),
    over_18: z.boolean().default(false),
  })
  .passthrough();

const redditListingSchema = z
  .object({
    data: z.object({
      after: z.string().nullable().optional(),
      children: z.array(z.object({ data: redditPostDataSchema }).passthrough()),
    }).passthrough(),
  })
  .passthrough();

const redditCommentDataSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    parent_id: z.string(),
    body: z.string().nullish().default(""),
    permalink: z.string().optional(),
    score: z.number().default(0),
    created_utc: z.number(),
    depth: z.number().int().nonnegative().default(0),
    replies: z.unknown().optional(),
  })
  .passthrough();

const redditSubredditSchema = z
  .object({
    data: z.object({
      display_name: z.string(),
      title: z.string().default(""),
      public_description: z.string().nullish().default(""),
      subscribers: z.number().int().nonnegative().nullable().default(null),
      active_user_count: z.number().int().nonnegative().nullable().optional(),
      created_utc: z.number(),
      over18: z.boolean().default(false),
      url: z.string(),
    }).passthrough(),
  })
  .passthrough();

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function credentialFingerprint(credentials: RedditCredentials) {
  return createHash("sha256")
    .update(credentials.clientId)
    .update("\0")
    .update(credentials.clientSecret)
    .digest("hex");
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  return Math.min(Math.max(value ?? fallback, 1), maximum);
}

function normalizeSubreddit(value: string) {
  const subreddit = value.trim().replace(/^r\//i, "");
  if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) {
    throw new IntegrationError("provider_error", "The subreddit name is invalid.", false, 400);
  }
  return subreddit;
}

function normalizePostId(value: string) {
  const postId = value.trim().toLowerCase().replace(/^t3_/, "");
  if (!/^[a-z0-9]{4,16}$/.test(postId)) {
    throw new IntegrationError("provider_error", "The Reddit post ID is invalid.", false, 400);
  }
  return postId;
}

function normalizeQuery(value: string) {
  const query = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 200) {
    throw new IntegrationError("provider_error", "The Reddit discovery query is invalid.", false, 400);
  }
  return query;
}

function normalizeAfter(value: string | undefined) {
  if (!value) return undefined;
  const after = value.trim().toLowerCase();
  if (!/^t3_[a-z0-9]{4,16}$/.test(after)) {
    throw new IntegrationError("provider_error", "The Reddit pagination cursor is invalid.", false, 400);
  }
  return after;
}

function numericHeader(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rateLimitFrom(headers: Headers): RedditRateLimit {
  return {
    used: numericHeader(headers, "x-ratelimit-used"),
    remaining: numericHeader(headers, "x-ratelimit-remaining"),
    resetSeconds: numericHeader(headers, "x-ratelimit-reset"),
  };
}

function isRedditUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "reddit.com" || url.hostname.endsWith(".reddit.com"));
  } catch {
    return false;
  }
}

function toPost(data: z.infer<typeof redditPostDataSchema>): RedditPost {
  return {
    id: data.id,
    fullname: data.name ?? `t3_${data.id}`,
    title: data.title,
    body: data.selftext || data.title,
    permalink: `https://www.reddit.com${data.permalink}`,
    externalUrl: data.url && !isRedditUrl(data.url) ? data.url : null,
    score: data.score,
    commentCount: data.num_comments,
    createdAt: new Date(data.created_utc * 1_000).toISOString(),
    sourceLabel: `r/${data.subreddit}`,
    attribution: `r/${data.subreddit}`,
    over18: data.over_18,
  };
}

function mapProviderStatus(response: Response, action: string): never {
  if (response.status === 401) {
    throw new IntegrationError("not_authorized", "Reddit rejected the configured OAuth credentials.", false, 401);
  }
  if (response.status === 403) {
    throw new IntegrationError("insufficient_scope", "Reddit did not authorize this read operation.", false, 403);
  }
  if (response.status === 429) {
    throw new IntegrationError("rate_limited", `Reddit rate-limited ${action}.`, true, 429);
  }
  throw new IntegrationError(
    "provider_error",
    `Reddit did not complete ${action}.`,
    response.status >= 500,
    response.status >= 500 ? 502 : 400,
  );
}

async function timedFetch(input: string | URL, init: RequestInit, action: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new IntegrationError("timeout", `Reddit timed out during ${action}.`, true, 504);
    }
    throw new IntegrationError("provider_error", `Reddit could not be reached during ${action}.`, true, 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function parseProviderJson(response: Response, action: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new IntegrationError("invalid_response", `Reddit returned an invalid response for ${action}.`, true, 502);
  }
}

export function assertRedditApproved(credentials: Partial<RedditCredentials>) {
  if (!credentials.approvalReference?.trim()) {
    throw new IntegrationError(
      "not_authorized",
      "Live Reddit is locked until a written approval reference is recorded.",
      false,
      403,
    );
  }
  const parsed = RedditStoredCredentialSchema.safeParse({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    userAgent: credentials.userAgent,
  });
  if (!parsed.success) {
    throw new IntegrationError("not_configured", "Reddit credentials are incomplete.", false, 400);
  }
}

async function accessToken(credentials: RedditCredentials) {
  assertRedditApproved(credentials);
  const cacheKey = credentialFingerprint(credentials);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) return cached.accessToken;

  const authorization = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await timedFetch(REDDIT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${authorization}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": credentials.userAgent,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  }, "OAuth authentication");
  if (!response.ok) mapProviderStatus(response, "OAuth authentication");
  const parsed = tokenSchema.safeParse(await parseProviderJson(response, "OAuth authentication"));
  if (!parsed.success) {
    throw new IntegrationError("invalid_response", "Reddit returned an invalid OAuth response.", false, 502);
  }
  tokenCache.set(cacheKey, {
    accessToken: parsed.data.access_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1_000,
  });
  return parsed.data.access_token;
}

async function redditGet(credentials: RedditCredentials, path: string, parameters: Record<string, string | undefined>, action: string) {
  assertRedditApproved(credentials);
  const token = await accessToken(credentials);
  const url = new URL(path, REDDIT_OAUTH_ORIGIN);
  url.searchParams.set("raw_json", "1");
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  const response = await timedFetch(url, {
    headers: { authorization: `Bearer ${token}`, "user-agent": credentials.userAgent },
  }, action);
  if (!response.ok) mapProviderStatus(response, action);
  return { body: await parseProviderJson(response, action), rateLimit: rateLimitFrom(response.headers) };
}

function listingPage(body: unknown, rateLimit: RedditRateLimit): RedditPage<RedditPost> {
  const parsed = redditListingSchema.safeParse(body);
  if (!parsed.success) {
    throw new IntegrationError("invalid_response", "Reddit returned an invalid post listing.", false, 502);
  }
  return {
    items: parsed.data.data.children.map(({ data }) => toPost(data)),
    after: parsed.data.data.after ?? null,
    rateLimit,
  };
}

export async function testRedditConnection(credentials: RedditCredentials) {
  const startedAt = Date.now();
  const probe = await redditGet(credentials, "/r/all/new", { limit: "1" }, "the connection test");
  const parsed = redditListingSchema.safeParse(probe.body);
  if (!parsed.success) {
    throw new IntegrationError("invalid_response", "Reddit returned an invalid connection-test response.", false, 502);
  }
  return { ok: true as const, latencyMs: Date.now() - startedAt, rateLimit: probe.rateLimit };
}

export async function listApprovedSubreddit(input: {
  credentials: RedditCredentials;
  subreddit: string;
  sort?: RedditListingSort;
  time?: RedditTimeRange;
  limit?: number;
  after?: string;
}) {
  const subreddit = normalizeSubreddit(input.subreddit);
  const sort = input.sort ?? "new";
  const after = normalizeAfter(input.after);
  const result = await redditGet(input.credentials, `/r/${subreddit}/${sort}`, {
    limit: String(boundedInteger(input.limit, 50, 100)),
    after,
    ...(sort === "top" ? { t: input.time ?? "year" } : {}),
  }, `the r/${subreddit} listing`);
  return listingPage(result.body, result.rateLimit);
}

export async function searchApprovedRedditPage(input: {
  credentials: RedditCredentials;
  query: string;
  subreddit?: string;
  sort?: RedditSearchSort;
  time?: RedditTimeRange;
  limit?: number;
  after?: string;
}) {
  const query = normalizeQuery(input.query);
  const subreddit = input.subreddit ? normalizeSubreddit(input.subreddit) : undefined;
  const after = normalizeAfter(input.after);
  const result = await redditGet(input.credentials, subreddit ? `/r/${subreddit}/search` : "/search", {
    q: query,
    sort: input.sort ?? "relevance",
    t: input.time ?? "year",
    type: "link",
    restrict_sr: subreddit ? "true" : undefined,
    limit: String(boundedInteger(input.limit, 100, 100)),
    after,
  }, "the discovery search");
  return listingPage(result.body, result.rateLimit);
}

export async function searchApprovedSubreddits(input: {
  credentials: RedditCredentials;
  query: string;
  limit?: number;
  after?: string;
}) {
  const query = normalizeQuery(input.query);
  const after = normalizeAfter(input.after);
  const result = await redditGet(input.credentials, "/subreddits/search", {
    q: query,
    limit: String(boundedInteger(input.limit, 25, 100)),
    after,
  }, "the subreddit search");
  const listing = z.object({
    data: z.object({
      after: z.string().nullable().optional(),
      children: z.array(z.object({
        data: z.object({
          display_name: z.string(),
          title: z.string().default(""),
          public_description: z.string().nullish().default(""),
          subscribers: z.number().int().nonnegative().nullable().default(null),
          over18: z.boolean().default(false),
          url: z.string(),
        }).passthrough(),
      }).passthrough()),
    }).passthrough(),
  }).passthrough().safeParse(result.body);
  if (!listing.success) {
    throw new IntegrationError("invalid_response", "Reddit returned an invalid subreddit listing.", false, 502);
  }
  return {
    items: listing.data.data.children.map(({ data }) => ({
      name: data.display_name,
      title: data.title,
      description: data.public_description,
      subscribers: data.subscribers,
      over18: data.over18,
      permalink: `https://www.reddit.com${data.url}`,
    })),
    after: listing.data.data.after ?? null,
    rateLimit: result.rateLimit,
  };
}

export async function getApprovedSubreddit(input: { credentials: RedditCredentials; subreddit: string }) {
  const subreddit = normalizeSubreddit(input.subreddit);
  const result = await redditGet(input.credentials, `/r/${subreddit}/about`, {}, `the r/${subreddit} metadata request`);
  const parsed = redditSubredditSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new IntegrationError("invalid_response", "Reddit returned invalid subreddit metadata.", false, 502);
  }
  const data = parsed.data.data;
  return {
    subreddit: {
      name: data.display_name,
      title: data.title,
      description: data.public_description,
      subscribers: data.subscribers,
      activeUsers: data.active_user_count ?? null,
      createdAt: new Date(data.created_utc * 1_000).toISOString(),
      over18: data.over18,
      permalink: `https://www.reddit.com${data.url}`,
    },
    rateLimit: result.rateLimit,
  };
}

function flattenComments(value: unknown, maximum: number) {
  const comments: RedditComment[] = [];
  const visitListing = (listingValue: unknown) => {
    if (comments.length >= maximum || !listingValue || typeof listingValue !== "object") return;
    const children = (listingValue as { data?: { children?: unknown[] } }).data?.children;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (comments.length >= maximum || !child || typeof child !== "object") break;
      const record = child as { kind?: unknown; data?: unknown };
      if (record.kind !== "t1") continue;
      const parsed = redditCommentDataSchema.safeParse(record.data);
      if (!parsed.success || !parsed.data.body || parsed.data.body === "[deleted]" || parsed.data.body === "[removed]") continue;
      comments.push({
        id: parsed.data.id,
        fullname: parsed.data.name ?? `t1_${parsed.data.id}`,
        parentId: parsed.data.parent_id,
        body: parsed.data.body,
        permalink: parsed.data.permalink ? `https://www.reddit.com${parsed.data.permalink}` : null,
        score: parsed.data.score,
        createdAt: new Date(parsed.data.created_utc * 1_000).toISOString(),
        depth: parsed.data.depth,
      });
      if (parsed.data.replies && typeof parsed.data.replies === "object") visitListing(parsed.data.replies);
    }
  };
  visitListing(value);
  return comments;
}

export async function getApprovedPostThread(input: {
  credentials: RedditCredentials;
  postId: string;
  commentLimit?: number;
  commentDepth?: number;
  commentSort?: "confidence" | "top" | "new" | "controversial" | "old" | "qa";
}) {
  const postId = normalizePostId(input.postId);
  const commentLimit = boundedInteger(input.commentLimit, 50, 100);
  const commentDepth = boundedInteger(input.commentDepth, 4, 10);
  const result = await redditGet(input.credentials, `/comments/${postId}`, {
    limit: String(commentLimit),
    depth: String(commentDepth),
    sort: input.commentSort ?? "confidence",
  }, "the post thread request");
  const body = z.array(z.unknown()).min(2).safeParse(result.body);
  if (!body.success) {
    throw new IntegrationError("invalid_response", "Reddit returned an invalid post thread.", false, 502);
  }
  const postListing = redditListingSchema.safeParse(body.data[0]);
  const postData = postListing.success ? postListing.data.data.children[0]?.data : undefined;
  if (!postData) {
    throw new IntegrationError("invalid_response", "Reddit did not return the requested post.", false, 404);
  }
  return {
    post: toPost(postData),
    comments: flattenComments(body.data[1], commentLimit),
    commentsTruncated: flattenComments(body.data[1], commentLimit + 1).length > commentLimit,
    rateLimit: result.rateLimit,
  };
}

/** Backward-compatible research adapter used by workflow runs. */
export async function fetchApprovedSubreddit(input: {
  credentials: RedditCredentials;
  subreddit: string;
  limit?: number;
}) {
  return (await listApprovedSubreddit(input)).items;
}

/** Backward-compatible global discovery adapter used by workflow runs. */
export async function searchApprovedReddit(input: {
  credentials: RedditCredentials;
  query: string;
  limit?: number;
}) {
  return (await searchApprovedRedditPage(input)).items;
}

export function clearRedditTokenCache() {
  tokenCache.clear();
}
