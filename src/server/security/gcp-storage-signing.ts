import "server-only";

import { createHash } from "node:crypto";

import type { AuthClient } from "google-auth-library";

const ALGORITHM = "GOOG4-RSA-SHA256";
const HOST = "storage.googleapis.com";

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signingTimestamp(now: Date) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { date: iso.slice(0, 8), timestamp: iso };
}

async function signBlob(authClient: Pick<AuthClient, "getAccessToken">, serviceAccount: string, payload: string) {
  const accessTokenResponse = await authClient.getAccessToken();
  const accessToken = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;
  if (!accessToken) throw new Error("Google workload identity did not return an access token for artifact signing");
  const response = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signBlob`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: Buffer.from(payload, "utf8").toString("base64") }),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`Google IAM artifact signing failed (${response.status})`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).signedBlob !== "string") {
    throw new Error("Google IAM artifact signing returned an invalid response");
  }
  return Buffer.from((body as { signedBlob: string }).signedBlob, "base64").toString("hex");
}

export async function createGcpV4SignedArtifactUrl(input: {
  authClient: Pick<AuthClient, "getAccessToken">;
  signerServiceAccount: string;
  bucket: string;
  objectKey: string;
  method: "GET" | "PUT";
  expiresInSeconds: number;
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const { date, timestamp } = signingTimestamp(now);
  const scope = `${date}/auto/storage/goog4_request`;
  const headers: Array<[string, string]> = [["host", HOST]];
  if (input.contentType) headers.push(["content-type", input.contentType]);
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (!/^x-goog-meta-[a-z0-9-]+$/.test(key) || !value) throw new Error("Invalid signed artifact metadata header");
    headers.push([key, value]);
  }
  headers.sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = headers.map(([key]) => key).join(";");
  const canonicalHeaders = `${headers.map(([key, value]) => `${key}:${value.trim().replace(/\s+/g, " ")}\n`).join("")}`;
  const query = new Map<string, string>([
    ["X-Goog-Algorithm", ALGORITHM],
    ["X-Goog-Credential", `${input.signerServiceAccount}/${scope}`],
    ["X-Goog-Date", timestamp],
    ["X-Goog-Expires", String(input.expiresInSeconds)],
    ["X-Goog-SignedHeaders", signedHeaders],
  ]);
  // An object-generation precondition prevents signed PUTs from overwriting
  // an existing artifact. It cannot be used for reads: a GET with
  // ifGenerationMatch=0 can only match an object that does not exist.
  if (input.method === "PUT") query.set("ifGenerationMatch", "0");
  const canonicalQuery = [...query.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const canonicalUri = `/${encode(input.bucket)}/${input.objectKey.split("/").map(encode).join("/")}`;
  const canonicalRequest = `${input.method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const stringToSign = `${ALGORITHM}\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const signature = await signBlob(input.authClient, input.signerServiceAccount, stringToSign);
  return `https://${HOST}${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${signature}`;
}
