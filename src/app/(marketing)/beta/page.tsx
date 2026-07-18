import { BetaAccess } from "@/features/beta/beta-access";
import { MarketingFrame } from "@/features/marketing/marketing";
import { getDeploymentMode } from "@/server/env";

export const metadata = {
  title: "Private beta",
  description: "Redeem a ReDDone beta invite or join the early-access waitlist.",
};
export const dynamic = "force-dynamic";

export default function BetaPage() {
  return <MarketingFrame mode={getDeploymentMode()}><BetaAccess /></MarketingFrame>;
}
