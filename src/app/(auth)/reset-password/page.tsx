import { redirect } from "next/navigation";

import { ResetPasswordForm } from "@/features/auth/auth-forms";
import { safeReturnTo } from "@/policy/return-to";
import { getRuntimeConfig } from "@/server/env";

export const metadata = { title: "Reset password" };
export const dynamic = "force-dynamic";

type ResetQuery = { token?: string | string[]; error?: string | string[]; returnTo?: string | string[] };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<ResetQuery> }) {
  const config = getRuntimeConfig();
  if (config.deploymentMode === "demo" || config.deploymentMode === "hackathon" || config.auth.emailDelivery.kind === "unavailable") redirect("/sign-in");
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : undefined;
  const errorCode = typeof query.error === "string" ? query.error : undefined;
  const returnTo = safeReturnTo(typeof query.returnTo === "string" ? query.returnTo : undefined);
  return <ResetPasswordForm errorCode={errorCode} returnTo={returnTo} token={token} />;
}
