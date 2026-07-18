import "server-only";

import { deleteArtifactObject } from "@/integrations/artifact-store";

import { getDb } from "./db";

/** Required revocation/removal purge. Immutable hashes remain, but Reddit-origin text is removed. */
export async function purgeRedditOrigin(workspaceId: string) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const findings = await tx.finding.findMany({
      where: { workspaceId, originMode: "LIVE_REDDIT" },
      select: { id: true },
    });
    const findingIds = findings.map((finding) => finding.id);
    const documents = await tx.researchDocument.deleteMany({
      where: { workspaceId, source: { mode: "LIVE_REDDIT" } },
    });
    const evidence = await tx.evidenceExcerpt.deleteMany({
      where: { workspaceId, findingId: { in: findingIds } },
    });
    const specs = await tx.productSpecVersion.updateMany({
      where: { workspaceId, basedOnFindingId: { in: findingIds } },
      data: {
        status: "REJECTED",
        content: { removed: true, reason: "Reddit authorization revoked or removal required" },
        supersededAt: new Date(),
        optimisticVersion: { increment: 1 },
      },
    });
    await tx.finding.updateMany({
      where: { workspaceId, id: { in: findingIds } },
      data: {
        title: "Removed Reddit-origin finding",
        problemSummary: "Removed after authorization revocation or required content removal.",
        audience: "Removed",
        frequencyScore: 0,
        severityScore: 0,
        willingnessToPayScore: 0,
        feasibilityScore: 0,
        totalScore: 0,
        scoreExplanation: "Content removed by policy.",
      },
    });
    await tx.researchSource.updateMany({
      where: { workspaceId, mode: "LIVE_REDDIT" },
      data: { status: "PURGED", purgedAt: new Date(), purgeRequestedAt: new Date() },
    });
    await tx.project.updateMany({
      where: { workspaceId, researchMode: "LIVE_REDDIT" },
      data: {
        status: "PAUSED",
        currentBlocker: "Reddit-origin content was purged; choose fixture or authorized import mode",
        selectedFindingId: null,
        currentSpecVersionId: null,
        optimisticVersion: { increment: 1 },
      },
    });
    return { documents: documents.count, evidence: evidence.count, specifications: specs.count, findings: findingIds.length };
  });
}

export async function runRetentionCleanup(now = new Date()) {
  const db = getDb();
  const expiredImports = await db.researchImport.findMany({
    where: { rawExpiresAt: { lte: now }, purgedAt: null },
    select: { id: true, objectKey: true },
  });
  const expiredPreviews = await db.buildArtifact.findMany({
    where: { kind: "PREVIEW_STATIC", expiresAt: { lte: now } },
    select: { id: true, objectKey: true },
  });
  for (const objectKey of [...new Set(expiredImports.map((item) => item.objectKey))]) {
    const liveReferences = await db.researchImport.count({
      where: { objectKey, purgedAt: null, rawExpiresAt: { gt: now } },
    });
    if (liveReferences === 0) await deleteArtifactObject(objectKey);
  }
  for (const objectKey of [...new Set(expiredPreviews.map((item) => item.objectKey))]) {
    await deleteArtifactObject(objectKey);
  }
  return db.$transaction(async (tx) => {
    const [documents, activity, audit] = await Promise.all([
      tx.researchDocument.deleteMany({ where: { rawExpiresAt: { lte: now } } }),
      tx.activityEvent.deleteMany({ where: { expiresAt: { lte: now } } }),
      tx.auditEvent.deleteMany({ where: { expiresAt: { lte: now } } }),
    ]);
    const imports = await tx.researchImport.updateMany({
      where: { id: { in: expiredImports.map((item) => item.id) }, purgedAt: null },
      data: { status: "PURGED", purgedAt: now },
    });
    const previews = await tx.buildArtifact.deleteMany({
      where: { id: { in: expiredPreviews.map((item) => item.id) }, kind: "PREVIEW_STATIC" },
    });
    return {
      documents: documents.count,
      imports: imports.count,
      previewArtifacts: previews.count,
      activityEvents: activity.count,
      auditEvents: audit.count,
    };
  });
}
