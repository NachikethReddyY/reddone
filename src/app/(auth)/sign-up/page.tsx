import { redirect } from "next/navigation";

import { SignUpForm } from "@/features/auth/auth-forms";
import { safeReturnTo } from "@/policy/return-to";
import { getDeploymentMode } from "@/server/env";

export const metadata = { title: "Create workspace" };
export const dynamic = "force-dynamic";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ access?: string | string[]; returnTo?: string | string[] }> }) {
  if (getDeploymentMode() !== "public") redirect("/sign-in");
  const query = await searchParams;
  if (query.access !== "ready") redirect("/beta#invite");
  const returnTo = safeReturnTo(typeof query.returnTo === "string" ? query.returnTo : undefined);
  return <SignUpForm returnTo={returnTo} />;
}
