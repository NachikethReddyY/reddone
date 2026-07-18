import { redirect } from "next/navigation";

export const metadata = { title: "Payments" };

export default function PaymentsPage() {
  redirect("/beta");
}
