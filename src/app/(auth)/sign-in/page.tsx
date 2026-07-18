import { SignInForm } from "@/features/auth/auth-forms";
import { safeReturnTo } from "@/policy/return-to";
import { getRuntimeConfig } from "@/server/env";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

type SignInQuery = {
  returnTo?: string | string[];
  setup?: string | string[];
  reset?: string | string[];
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<SignInQuery> }) {
  const query = await searchParams;
  const config = getRuntimeConfig();
  return (
    <SignInForm
      deploymentMode={config.deploymentMode}
      emailDeliveryAvailable={
        config.deploymentMode !== "demo"
        && config.deploymentMode !== "hackathon"
        && config.auth.emailDelivery.kind !== "unavailable"
      }
      resetComplete={query.reset === "complete"}
      returnTo={safeReturnTo(typeof query.returnTo === "string" ? query.returnTo : undefined)}
      setupComplete={query.setup === "complete"}
    />
  );
}
