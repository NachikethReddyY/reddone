import {
  claimRun,
  executeBuild,
  executeRelease,
  executeResearch,
  executeRollback,
  executeSelectedFindingSpecification,
  failRun,
} from "./executor-steps";

export async function executeRunWorkflow(workspaceId: string, runId: string) {
  "use workflow";
  let fencingToken: string | null = null;
  try {
    const claim = await claimRun(workspaceId, runId);
    if (!claim) return { runId, status: "skipped" as const };
    fencingToken = claim.fencingToken;
    if (claim.kind === "RESEARCH" && claim.researchPurpose === "specification") {
      return await executeSelectedFindingSpecification(workspaceId, runId, fencingToken, claim.findingId);
    }
    if (claim.kind === "RESEARCH") return await executeResearch(workspaceId, runId, fencingToken);
    if (claim.kind === "BUILD" || claim.kind === "POLISH") {
      return await executeBuild(workspaceId, runId, fencingToken, claim.kind === "POLISH");
    }
    if (claim.kind === "RELEASE") return await executeRelease(workspaceId, runId, fencingToken);
    if (claim.kind === "ROLLBACK") return await executeRollback(workspaceId, runId, fencingToken);
    throw new Error(`Unsupported operator workflow kind: ${claim.kind}`);
  } catch (error) {
    if (fencingToken) {
      await failRun(workspaceId, runId, fencingToken, error instanceof Error ? error.message : "Workflow execution failed.");
    }
    throw error;
  }
}
