import "server-only";

import { ensurePromotionalGrant } from "./credits";
import { getDb } from "./db";
import { withSerializableTransaction } from "./transactions";

export interface WorkspaceProvisioningInput {
  ownerName: string;
  timeZone: string;
}

export async function createWorkspaceWithPromotionalGrant(
  input: WorkspaceProvisioningInput,
): Promise<{ id: string; name: string; timeZone: string }> {
  const ownerName = input.ownerName.trim().slice(0, 80) || "Owner";
  return withSerializableTransaction(getDb(), async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: `${ownerName} workspace`,
        timeZone: input.timeZone,
        maxConcurrentSandboxes: 2,
        monthlyBudgetMicros: 0,
      },
      select: { id: true, name: true, timeZone: true },
    });
    await ensurePromotionalGrant(tx, { workspaceId: workspace.id });
    return workspace;
  });
}
