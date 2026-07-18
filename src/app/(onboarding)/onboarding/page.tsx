import { redirect } from "next/navigation";

import { OnboardingFlow } from "@/features/onboarding/onboarding-flow";
import { safeReturnTo } from "@/policy/return-to";
import { getDeploymentMode } from "@/server/env";

export const metadata = { title: "Set up workspace" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const mode = getDeploymentMode();
  if (mode === "demo" || mode === "private") redirect("/projects");
  const query = await searchParams;
  return <OnboardingFlow returnTo={safeReturnTo(typeof query.returnTo === "string" ? query.returnTo : undefined)} />;
}
