import { z } from "zod";

import { ApprovalResolutionInputSchema } from "@/contracts";
import { resolveProductionApproval } from "@/server/approval-repository";
import { isDemoMode } from "@/server/env";
import { readIdempotent, resolveApproval, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ approvalId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const { approvalId } = await params;
    const rawBody: unknown = await request.json();
    if (!isDemoMode()) {
      const body = ApprovalResolutionInputSchema.parse(rawBody);
      if (body.optimisticVersion !== context.expectedVersion) {
        throw new Error("Approval version does not match If-Match.");
      }
      const result = await resolveProductionApproval({
        workspaceId: context.owner.workspaceId,
        userId: context.owner.userId,
        approvalId,
        expectedVersion: context.expectedVersion!,
        payloadHash: body.payloadHash,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
        idempotencyKey: context.idempotencyKey,
      });
      return ok(result, context.requestId);
    }
    const body = z
      .object({
        decision: z.enum(["approve", "reject", "approved", "rejected"]),
        reason: z.string().trim().min(1).max(2_000).optional(),
        payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
        optimisticVersion: z.number().int().nonnegative(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if ((value.decision === "reject" || value.decision === "rejected") && !value.reason) {
          ctx.addIssue({ code: "custom", path: ["reason"], message: "A rejection reason is required." });
        }
      })
      .parse(rawBody);
    const result = resolveApproval({
      approvalId,
      decision: body.decision === "approve" || body.decision === "approved" ? "approve" : "reject",
      ...(body.reason ? { reason: body.reason } : {}),
      payloadHash: body.payloadHash,
      expectedVersion: body.optimisticVersion,
    });
    writeIdempotent(context.idempotencyKey, result);
    return ok(result, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
