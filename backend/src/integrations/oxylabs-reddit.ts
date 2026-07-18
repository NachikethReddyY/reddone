import "server-only";

import * as http from "node:http";
import * as https from "node:https";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";

import { z } from "zod";

import type { RedditWebScrapeConfig } from "@/contracts";

import { IntegrationError } from "./errors";

const REDDIT_ORIGIN = "https://www.reddit.com";
const REDDONE_REDDIT_USER_AGENT = "ReDDone/1.0 (server-side public Reddit research collector)";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const OxylabsResidentialCredentialSchema = z
  .object({
    endpoint: z.string().trim().min(1).max(500),
    port: z.string().trim().regex(/^\d{1,5}$/),
    username: z.string().trim().min(1).max(500),
    password: z.string().min(1).max(4_096),
    authorizationReference: z.string().trim().min(1).max(500),
  })
  .strict();

export type OxylabsResidentialCredentials = z.infer<typeof OxylabsResidentialCredentialSchema>;

type ProxyEndpoint = {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
};

export type ScrapedRedditDocument = {
  id: string;
  title: string;
  body: string;
  permalink: string;
  attribution: string;
  createdAt: string;
  score: number;
};

export type ResidentialScrapeResult = {
  documents: ScrapedRedditDocument[];
  pagesFetched: number;
  agents: { requested: number; active: number; fallbackCount: number };
};

const redditPostDataSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+$/i),
    title: z.string(),
    selftext: z.string().nullish().default(""),
    permalink: z.string().startsWith("/"),
    score: z.number().default(0),
    created_utc: z.number().finite(),
    subreddit: z.string(),
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

type RedditPostData = z.infer<typeof redditPostDataSchema>;

function parseProxyEndpoint(credentials: OxylabsResidentialCredentials): ProxyEndpoint {
  const rawEndpoint = credentials.endpoint.includes("://")
    ? credentials.endpoint
    : `http://${credentials.endpoint}`;
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new IntegrationError("not_configured", "The Oxylabs residential proxy endpoint is invalid.", false, 400);
  }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || !endpoint.hostname || endpoint.username || endpoint.password) {
    throw new IntegrationError("not_configured", "The Oxylabs residential proxy endpoint must be an HTTP(S) host without embedded credentials.", false, 400);
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new IntegrationError("not_configured", "The Oxylabs residential proxy endpoint must not include a path, query, or fragment.", false, 400);
  }
  const port = Number(credentials.port || endpoint.port || "7777");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new IntegrationError("not_configured", "The Oxylabs residential proxy port is invalid.", false, 400);
  }
  return { protocol: endpoint.protocol, hostname: endpoint.hostname, port };
}

function createResidentialProxyAgent(credentials: OxylabsResidentialCredentials, maxSockets: number) {
  const proxy = parseProxyEndpoint(credentials);
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const agent = new https.Agent({ keepAlive: true, maxSockets: Math.max(1, Math.min(maxSockets, 8)) });

  agent.createConnection = (options, callback) => {
    if (!callback) return undefined;
    const onConnection = callback;
    const targetHost = options.hostname ?? options.host;
    const targetPort = Number(options.port ?? 443);
    if (!targetHost || !Number.isInteger(targetPort)) {
      onConnection(new Error("The Reddit request target is invalid."), undefined as unknown as Duplex);
      return undefined;
    }

    let finished = false;
    const finish = (error: Error | null, socket?: Duplex) => {
      if (finished) return;
      finished = true;
      onConnection(error, socket ?? (undefined as unknown as Duplex));
    };
    const connect = proxy.protocol === "https:" ? https.request : http.request;
    const proxyRequest = connect({
      hostname: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: {
        host: `${targetHost}:${targetPort}`,
        "proxy-authorization": authorization,
      },
    });
    const timeout = setTimeout(() => {
      proxyRequest.destroy(new Error("Oxylabs residential proxy tunnel timed out."));
    }, REQUEST_TIMEOUT_MS);

    proxyRequest.once("error", (error) => {
      clearTimeout(timeout);
      finish(error instanceof Error ? error : new Error("Oxylabs residential proxy connection failed."));
    });
    proxyRequest.once("connect", (response, socket, head) => {
      clearTimeout(timeout);
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`Oxylabs residential proxy rejected the tunnel (${response.statusCode ?? "unknown"}).`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secureSocket = tls.connect({
        socket,
        servername: typeof options.servername === "string" ? options.servername : targetHost,
        rejectUnauthorized: options.rejectUnauthorized !== false,
        ALPNProtocols: ["http/1.1"],
      });
      secureSocket.once("secureConnect", () => finish(null, secureSocket));
      secureSocket.once("error", (error) => finish(error));
    });
    proxyRequest.end();
    return undefined;
  };
  return agent;
}

async function getJson(agent: https.Agent, url: URL, userAgent: string, action: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      agent,
      method: "GET",
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en;q=0.8",
        "user-agent": userAgent,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Reddit response exceeded the permitted size."));
          return;
        }
        chunks.push(bytes);
      });
      response.once("error", () => reject(new IntegrationError("provider_error", `Reddit could not complete ${action}.`, true, 502)));
      response.once("end", () => {
        const status = response.statusCode ?? 502;
        if (status === 407) {
          reject(new IntegrationError("not_authorized", "Oxylabs rejected the configured residential proxy credentials.", false, 502));
          return;
        }
        if (status === 429) {
          reject(new IntegrationError("rate_limited", `Reddit rate-limited ${action}.`, true, 429));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new IntegrationError("provider_error", `Reddit did not complete ${action}.`, status >= 500, status >= 500 ? 502 : 400));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new IntegrationError("invalid_response", `Reddit returned an invalid response for ${action}.`, true, 502));
        }
      });
    });
    request.once("error", (error) => {
      const message = error instanceof Error ? error.message : "";
      if (/timed out/i.test(message)) {
        reject(new IntegrationError("timeout", `Reddit timed out during ${action}.`, true, 504));
        return;
      }
      reject(new IntegrationError("provider_error", `Reddit could not be reached during ${action}.`, true, 502));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("Reddit request timed out.")));
    request.end();
  });
}

function listingUrl(config: RedditWebScrapeConfig, after: string | null, limit: number) {
  const hasKeywords = Boolean(config.keywords);
  const listingSort = config.sort === "relevance" ? "new" : config.sort === "comments" ? "top" : config.sort;
  const path = hasKeywords ? `/r/${config.subreddit}/search.json` : `/r/${config.subreddit}/${listingSort}.json`;
  const url = new URL(path, REDDIT_ORIGIN);
  url.searchParams.set("raw_json", "1");
  url.searchParams.set("limit", String(limit));
  if (after) url.searchParams.set("after", after);
  if (hasKeywords) {
    url.searchParams.set("q", config.keywords!);
    url.searchParams.set("restrict_sr", "on");
    url.searchParams.set("type", "link");
    url.searchParams.set("sort", config.sort);
    url.searchParams.set("t", config.time);
  } else if (listingSort === "top") {
    url.searchParams.set("t", config.time);
  }
  return url;
}

function postUrl(postId: string) {
  const url = new URL(`/comments/${postId}.json`, REDDIT_ORIGIN);
  url.searchParams.set("raw_json", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("depth", "0");
  return url;
}

function toDocument(post: RedditPostData): ScrapedRedditDocument {
  const body = (post.selftext ?? "").trim();
  return {
    id: post.id,
    title: post.title.trim(),
    body: body && body !== "[removed]" && body !== "[deleted]" ? body : post.title.trim(),
    permalink: new URL(post.permalink, REDDIT_ORIGIN).toString(),
    attribution: `r/${post.subreddit}`,
    createdAt: new Date(post.created_utc * 1_000).toISOString(),
    score: post.score,
  };
}

function timeCutoff(range: RedditWebScrapeConfig["time"]) {
  const milliseconds: Record<Exclude<RedditWebScrapeConfig["time"], "all">, number> = {
    hour: 60 * 60_000,
    day: 24 * 60 * 60_000,
    week: 7 * 24 * 60 * 60_000,
    month: 30 * 24 * 60 * 60_000,
    year: 365 * 24 * 60 * 60_000,
  };
  return range === "all" ? null : Date.now() - milliseconds[range];
}

function matchesKeywords(post: RedditPostData, keywords: string | undefined) {
  if (!keywords) return true;
  const haystack = `${post.title}\n${post.selftext}`.normalize("NFKC").toLowerCase();
  return keywords.normalize("NFKC").toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

async function fetchPost(agent: https.Agent, credentials: OxylabsResidentialCredentials, fallback: RedditPostData) {
  const body = await getJson(agent, postUrl(fallback.id), REDDONE_REDDIT_USER_AGENT, `the ${fallback.id} post request`);
  const thread = z.array(z.unknown()).min(1).safeParse(body);
  const listing = thread.success ? redditListingSchema.safeParse(thread.data[0]) : null;
  const post = listing?.success ? listing.data.data.children[0]?.data : undefined;
  return post ? toDocument(post) : toDocument(fallback);
}

/**
 * Collects public Reddit post pages through Oxylabs' residential CONNECT proxy.
 * The page cursor is necessarily serial; after discovery, bounded collection
 * agents independently verify assigned post pages in parallel.
 */
export async function scrapeRedditSubredditThroughOxylabs(input: {
  credentials: OxylabsResidentialCredentials;
  config: RedditWebScrapeConfig;
  maxDocuments: number;
}): Promise<ResidentialScrapeResult> {
  const credentials = OxylabsResidentialCredentialSchema.parse(input.credentials);
  const maxDocuments = Math.min(Math.max(input.maxDocuments, 1), 1_000);
  const agent = createResidentialProxyAgent(credentials, input.config.agentCount);
  try {
    const collected: RedditPostData[] = [];
    let after: string | null = null;
    let pagesFetched = 0;
    do {
      const remaining = Math.min(100, maxDocuments - collected.length);
      const body = await getJson(agent, listingUrl(input.config, after, remaining), REDDONE_REDDIT_USER_AGENT, `the r/${input.config.subreddit} listing`);
      const parsed = redditListingSchema.safeParse(body);
      if (!parsed.success) {
        throw new IntegrationError("invalid_response", "Reddit returned an invalid subreddit listing.", false, 502);
      }
      collected.push(...parsed.data.data.children.map(({ data }) => data));
      after = parsed.data.data.after ?? null;
      pagesFetched += 1;
    } while (after && collected.length < maxDocuments);

    const cutoff = timeCutoff(input.config.time);
    const seen = new Set<string>();
    const selected = collected.filter((post) => {
      if (seen.has(post.id)) return false;
      seen.add(post.id);
      return (!cutoff || post.created_utc * 1_000 >= cutoff) && matchesKeywords(post, input.config.keywords);
    }).slice(0, maxDocuments);

    const activeAgents = Math.min(input.config.agentCount, selected.length);
    const documents = new Array<ScrapedRedditDocument>(selected.length);
    let fallbackCount = 0;
    await Promise.all(Array.from({ length: activeAgents }, async (_, agentIndex) => {
      for (let index = agentIndex; index < selected.length; index += activeAgents) {
        const post = selected[index]!;
        try {
          documents[index] = await fetchPost(agent, credentials, post);
        } catch {
          // The post appeared in the canonical listing. Preserve attributable
          // listing evidence when one individual post page cannot be re-read.
          documents[index] = toDocument(post);
          fallbackCount += 1;
        }
      }
    }));
    return {
      documents,
      pagesFetched,
      agents: { requested: input.config.agentCount, active: activeAgents, fallbackCount },
    };
  } finally {
    agent.destroy();
  }
}
