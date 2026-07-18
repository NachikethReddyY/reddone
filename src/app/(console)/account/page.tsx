import { PageHeader } from "@/components/page-header";
import { AccountPanel } from "@/features/account/account-panel";

export const metadata = { title: "Account" };

export default function AccountPage() {
  return (
    <div className="page-shell medium-page">
      <PageHeader
        eyebrow="Account / Owner"
        title="Account and security"
        description="Manage the sole workspace owner, workspace identity, theme, password, active sessions, and sign out."
      />
      <AccountPanel />
    </div>
  );
}
