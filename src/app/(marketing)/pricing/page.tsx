import { redirect } from "next/navigation";

export const metadata = {
  title: "Private beta",
  description: "ReDDone is in private beta. Redeem an invite or join the waitlist.",
};

export default function PricingPage() {
  redirect("/beta");
}
