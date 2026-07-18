import { createHash } from "node:crypto";

export type OwnedResourceProvider = "github" | "vercel";

const markerPattern = /^reddone-v1-(github|vercel)-([a-f0-9]{24})$/;

export function resourceOwnershipMarker(input: {
  provider: OwnedResourceProvider;
  workspaceId: string;
  projectId: string;
}) {
  const digest = createHash("sha256")
    .update(`reddone-resource-v1\0${input.provider}\0${input.workspaceId}\0${input.projectId}`)
    .digest("hex")
    .slice(0, 24);
  return `reddone-v1-${input.provider}-${digest}`;
}

export function assertResourceOwnershipMarker(input: {
  marker: string;
  provider: OwnedResourceProvider;
  workspaceId: string;
  projectId: string;
}) {
  const expected = resourceOwnershipMarker(input);
  if (input.marker !== expected) throw new Error(`The ${input.provider} ownership marker is not bound to this workspace project.`);
  return expected;
}

export function collisionResistantResourceName(base: string, marker: string, maxLength = 100) {
  const parsed = markerPattern.exec(marker);
  if (!parsed) throw new Error("Resource ownership marker is invalid.");
  const suffix = parsed[2]!;
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "app";
  const prefixLength = maxLength - suffix.length - 1;
  if (prefixLength < 1) throw new Error("Resource name limit cannot fit its ownership suffix.");
  const prefix = normalized.slice(0, prefixLength).replace(/[._-]+$/g, "") || "app";
  return `${prefix}-${suffix}`;
}

export function assertCollisionResistantResourceName(name: string, marker: string) {
  const parsed = markerPattern.exec(marker);
  if (!parsed || !name.endsWith(`-${parsed[2]}`)) {
    throw new Error("The external resource name is not bound to its approved ownership marker.");
  }
}
