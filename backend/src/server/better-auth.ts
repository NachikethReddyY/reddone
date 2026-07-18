import "server-only";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { deliverAuthEmail } from "./auth-email";
import { redeemHackathonCreditCode } from "./credits";
import { getDb } from "./db";
import { getRuntimeConfig } from "./env";
import { HACKATHON_ADMISSION_COOKIE, readCookie, readHackathonAdmission, verifyHackathonAdmission } from "./hackathon-admission";
import { withSerializableTransaction } from "./transactions";
import { createWorkspaceWithPromotionalGrant } from "./workspace-provisioning";

function createAuth() {
  const config = getRuntimeConfig();
  if (!config.auth.secret || !config.database) {
    throw new Error("Better Auth requires DATABASE_URL and BETTER_AUTH_SECRET.");
  }
  const publicSignUp = false;
  const provisionSelfServiceWorkspace = config.deploymentMode === "hackathon";

  return betterAuth({
    appName: "ReDDone",
    baseURL: config.appUrl,
    basePath: "/api/auth",
    secret: config.auth.secret,
    database: prismaAdapter(getDb(), { provider: "postgresql", transaction: true }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !publicSignUp,
      minPasswordLength: 12,
      maxPasswordLength: 200,
      autoSignIn: false,
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await deliverAuthEmail({ kind: "password-reset", to: user.email, name: user.name, url });
      },
    },
    emailVerification: {
      expiresIn: 60 * 60,
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user, url }) {
        await deliverAuthEmail({ kind: "verification", to: user.email, name: user.name, url });
      },
    },
    socialProviders: config.deploymentMode === "hackathon"
      ? {
          github: {
            clientId: config.auth.githubClientId!,
            clientSecret: config.auth.githubClientSecret!,
            disableImplicitSignUp: false,
            scope: ["read:user", "user:email"],
          },
        }
      : {},
    account: { encryptOAuthTokens: true },
    user: {
      additionalFields: {
        workspaceId: { type: "string", required: true, input: false, returned: true },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    databaseHooks: provisionSelfServiceWorkspace
      ? {
          user: {
            create: {
              async before(user, context) {
                if (config.deploymentMode === "hackathon") {
                  const admission = readCookie(context?.request?.headers.get("cookie") ?? null, HACKATHON_ADMISSION_COOKIE);
                  if (!verifyHackathonAdmission(admission)) return false;
                }
                const workspace = await createWorkspaceWithPromotionalGrant({
                  ownerName: String(user.name || (publicSignUp ? "Owner" : "Participant")),
                  timeZone: config.timeZone,
                });
                return { data: { ...user, workspaceId: workspace.id, emailVerified: Boolean(user.emailVerified) } };
              },
              async after(user, context) {
                if (config.deploymentMode !== "hackathon" || !config.auth.registrationPepper) return;
                const workspaceId = typeof user.workspaceId === "string" ? user.workspaceId : null;
                if (!workspaceId) return;
                const admission = readHackathonAdmission(
                  readCookie(context?.request?.headers.get("cookie") ?? null, HACKATHON_ADMISSION_COOKIE),
                );
                if (!admission?.creditCode) return;
                await withSerializableTransaction(getDb(), async (tx) => {
                  await redeemHackathonCreditCode(tx, {
                    workspaceId,
                    userId: user.id,
                    code: admission.creditCode!,
                    hashSecret: config.auth.registrationPepper!,
                  });
                });
              },
            },
          },
        }
      : undefined,
    rateLimit: {
      enabled: true,
      window: 60,
      max: 20,
      customRules: {
        "/sign-in/email": { window: 60, max: 3 },
        "/sign-up/email": { window: 15 * 60, max: 3 },
        "/request-password-reset": { window: 15 * 60, max: 3 },
        "/send-verification-email": { window: 15 * 60, max: 3 },
        "/reset-password": { window: 15 * 60, max: 5 },
        "/change-password": { window: 15 * 60, max: 5 },
      },
      storage: "database",
    },
    trustedOrigins: [config.auth.trustedOrigin],
    advanced: {
      cookiePrefix: "reddone",
      useSecureCookies: config.environment === "production",
      database: { generateId: "uuid" },
    },
  });
}

let authInstance: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  authInstance ??= createAuth();
  return authInstance;
}

export async function getAuthenticatedSession(request: Request) {
  return getAuth().api.getSession({ headers: request.headers });
}

export async function getOwnerSession(request: Request) {
  const session = await getAuthenticatedSession(request);
  if (!session?.user.id || !session.user.email || !session.user.workspaceId) return null;
  return {
    userId: session.user.id,
    workspaceId: session.user.workspaceId,
    email: session.user.email,
    role: "owner" as const,
  };
}
