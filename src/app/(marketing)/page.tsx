import { HomeMarketing } from "@/features/marketing/marketing";
import { getDeploymentMode } from "@/server/env";

export const metadata = {
  title: "Evidence to verified software",
  description: "Turn source evidence into an approved ProductSpec, isolated Kimi build, clean verification, and owner-controlled release.",
};
export const dynamic = "force-dynamic";

export default function MarketingHomePage() {
  return <HomeMarketing mode={getDeploymentMode()} />;
}
