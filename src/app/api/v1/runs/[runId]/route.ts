import { z } from "zod";

import { RunDetailSchema } from "@/contracts";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { createLivePreviewUrl } from "@/server/preview";
import { verifySignedVerificationReport } from "@/server/security/verification-signature";
import { serializeDemoRunUsage, serializeRunUsage } from "@/server/usage-reporting";
import { getRun, serializeDemoRun } from "@/workflows/demo-store";
import { HttpError, route } from "@/workflows/http";
import { assertOwnerRequest } from "@/workflows/http";
import { serializeRun } from "@/workflows/production-run";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { runId } = await params;
  const response = await route(request, async () => {
    if (!isDemoMode()) {
      const owner = await assertOwnerRequest(request);
      const run = await getDb().workflowRun.findFirst({
        where: { id: runId, workspaceId: owner.workspaceId },
        include: {
          steps: { orderBy: { createdAt: "asc" } },
          artifacts: { include: { verification: true }, orderBy: { createdAt: "asc" } },
          usageEntries: { orderBy: { occurredAt: "asc" } },
        },
      });
      if (!run) throw new HttpError("not_found", "Run not found.", 404);
      const outputArtifact = run.artifacts.find((artifact) => artifact.kind === "VERCEL_OUTPUT");
      const previewArtifact = run.artifacts.find((artifact) => artifact.kind === "PREVIEW_STATIC");
      const sourceArtifact = run.artifacts.find((artifact) => artifact.kind === "VERIFIED_SOURCE");
      const signedHashes = z.object({
        sourceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
        previewArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
      }).passthrough().safeParse(outputArtifact?.verification?.report);
      const signedReportValid = outputArtifact?.verification
        ? verifySignedVerificationReport({
            report: outputArtifact.verification.report,
            reportHash: outputArtifact.verification.reportHash,
            signature: outputArtifact.verification.signature,
            key: process.env.VERIFICATION_SIGNING_KEY ?? process.env.BETTER_AUTH_SECRET,
          })
        : false;
      const previewUrl =
        outputArtifact?.verification?.status === "PASSED" &&
        signedReportValid &&
        previewArtifact &&
        sourceArtifact &&
        (!previewArtifact.expiresAt || previewArtifact.expiresAt > new Date()) &&
        signedHashes.success &&
        signedHashes.data.sourceArtifactHash === sourceArtifact.artifactHash &&
        signedHashes.data.artifactHash === outputArtifact.artifactHash &&
        signedHashes.data.previewArtifactHash === previewArtifact.artifactHash
          ? createLivePreviewUrl({ artifactId: previewArtifact.id, artifactHash: previewArtifact.artifactHash })
          : null;
      const usageDetail = serializeRunUsage(run.usageEntries);
      return RunDetailSchema.parse({
        ...serializeRun(run),
        failureCode: run.failureCode,
        failureMessage: run.failureMessage,
        mode: "live",
        artifactHash: outputArtifact?.artifactHash ?? null,
        previewUrl,
        ...usageDetail,
        artifacts: run.artifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind.toLowerCase(),
          artifactHash: artifact.artifactHash,
          manifestHash: artifact.manifestHash,
          byteSize: Number(artifact.byteSize),
          fileCount: artifact.fileCount,
          expiresAt: artifact.expiresAt?.toISOString() ?? null,
          createdAt: artifact.createdAt.toISOString(),
          verification: artifact.verification
            ? {
                id: artifact.verification.id,
                status: artifact.verification.status.toLowerCase(),
                verifierImage: artifact.verification.verifierImage,
                report: artifact.verification.report,
                reportHash: artifact.verification.reportHash,
                signatureKeyId: artifact.verification.signatureKeyId,
                verifiedAt: artifact.verification.verifiedAt?.toISOString() ?? null,
                expiresAt: artifact.verification.expiresAt?.toISOString() ?? null,
              }
            : null,
        })),
      });
    }
    const run = getRun(runId);
    if (!run) throw new HttpError("not_found", "Run not found.", 404);
    return RunDetailSchema.parse({ ...serializeDemoRun(run), ...serializeDemoRunUsage(run) });
  });
  response.headers.set("cache-control", "private, no-store, max-age=0");
  return response;
}
