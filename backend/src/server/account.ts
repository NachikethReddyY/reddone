import "server-only";

import { isIP } from "node:net";

import type { AccountProfile, AccountSession, AccountUpdateInput } from "@/contracts/account";
import type { OwnerContext } from "./auth";
import { isAuthEmailDeliveryAvailable } from "./auth-email";
import { getDb } from "./db";
import { AppError } from "./errors";
import { withSerializableTransaction } from "./transactions";

export function createDemoAccountProfile(input: Partial<AccountUpdateInput> = {}, image: string | null = null): AccountProfile {
  return {
    user: {
      id: "demo-owner",
      name: input.name ?? "Demo owner",
      image,
      email: "owner@demo.invalid",
      emailVerified: true,
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    workspace: {
      id: "demo-workspace",
      name: input.workspaceName ?? "ReDDone demo",
      timeZone: input.timeZone ?? "Asia/Singapore",
      status: "active",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
    },
    capabilities: { canChangePassword: false, emailDeliveryAvailable: false },
  };
}

export function maskIpAddress(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.split(",", 1)[0]?.trim() ?? "";
  if (isIP(candidate) === 4) {
    const octets = candidate.split(".");
    return `${octets[0]}.${octets[1]}.${octets[2]}.xxx`;
  }
  if (isIP(candidate) === 6) {
    const groups = candidate.split(":").filter(Boolean).slice(0, 3);
    return `${groups.join(":")}${groups.length > 0 ? ":" : ""}…`;
  }
  return "masked";
}

export function assertValidTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new AppError("bad_request", "Choose a valid IANA time zone.");
  }
}

export async function getAccountProfile(owner: OwnerContext): Promise<AccountProfile> {
  const record = await getDb().user.findUnique({
    where: { id: owner.userId },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      image: true,
      email: true,
      emailVerified: true,
      createdAt: true,
      accounts: { select: { providerId: true, password: true } },
      workspace: {
        select: {
          id: true,
          name: true,
          timeZone: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!record || record.workspaceId !== owner.workspaceId) throw new AppError("not_found", "Account not found.");

  return {
    user: {
      id: record.id,
      name: record.name,
      image: record.image,
      email: record.email,
      emailVerified: record.emailVerified,
      createdAt: record.createdAt.toISOString(),
    },
    workspace: {
      id: record.workspace.id,
      name: record.workspace.name,
      timeZone: record.workspace.timeZone,
      status: record.workspace.status.toLowerCase() as AccountProfile["workspace"]["status"],
      createdAt: record.workspace.createdAt.toISOString(),
      updatedAt: record.workspace.updatedAt.toISOString(),
    },
    capabilities: {
      canChangePassword: record.accounts.some((account) => account.providerId === "credential" && Boolean(account.password)),
      emailDeliveryAvailable: isAuthEmailDeliveryAvailable(),
    },
  };
}

export async function updateAccountAvatar(owner: OwnerContext, image: string | null): Promise<AccountProfile> {
  const updated = await getDb().user.updateMany({
    where: { id: owner.userId, workspaceId: owner.workspaceId },
    data: { image },
  });
  if (updated.count !== 1) throw new AppError("not_found", "Account not found.");
  return getAccountProfile(owner);
}

export async function updateAccountProfile(owner: OwnerContext, input: AccountUpdateInput): Promise<AccountProfile> {
  if (input.timeZone) assertValidTimeZone(input.timeZone);

  await withSerializableTransaction(getDb(), async (tx) => {
    const existing = await tx.user.findUnique({
      where: { id: owner.userId },
      select: { workspaceId: true },
    });
    if (!existing || existing.workspaceId !== owner.workspaceId) throw new AppError("not_found", "Account not found.");

    if (input.name !== undefined) {
      await tx.user.update({ where: { id: owner.userId }, data: { name: input.name } });
    }
    if (input.workspaceName !== undefined || input.timeZone !== undefined) {
      await tx.workspace.update({
        where: { id: owner.workspaceId },
        data: {
          ...(input.workspaceName !== undefined ? { name: input.workspaceName } : {}),
          ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
        },
      });
    }
  });

  return getAccountProfile(owner);
}

export async function listAccountSessions(owner: OwnerContext, currentSessionId: string): Promise<AccountSession[]> {
  const sessions = await getDb().session.findMany({
    where: { userId: owner.userId, expiresAt: { gt: new Date() } },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
    },
  });

  return sessions.map((session) => ({
    id: session.id,
    current: session.id === currentSessionId,
    ipAddress: maskIpAddress(session.ipAddress),
    userAgent: session.userAgent?.slice(0, 1_000) ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  }));
}

export async function getOwnedSessionToken(owner: OwnerContext, sessionId: string): Promise<string> {
  const session = await getDb().session.findFirst({
    where: { id: sessionId, userId: owner.userId },
    select: { token: true },
  });
  if (!session) throw new AppError("not_found", "Session not found.");
  return session.token;
}
