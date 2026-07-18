import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/features/auth/auth-forms";
import { safeReturnTo } from "@/policy/return-to";
import { getRuntimeConfig } from "@/server/env";

export const metadata = { title: "Forgot password" };
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const config = getRuntimeConfig();
  if (config.deploymentMode === "demo" || config.deploymentMode === "hackathon" || config.auth.emailDelivery.kind === "unavailable") redirect("/sign-in");
  const query = await searchParams;
  const returnTo = safeReturnTo(typeof query.returnTo === "string" ? query.returnTo : undefined);
  return <ForgotPasswordForm returnTo={returnTo} />;
}
