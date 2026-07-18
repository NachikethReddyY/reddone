import { PageHeader } from "@/components/page-header";
import { ApprovalQueue } from "@/features/approvals/approval-queue";

export const metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <div className="page-shell medium-page">
      <PageHeader eyebrow="Workspace / Human gates" title="Approvals" description="Inspect the exact hashes, accounts, grants, limits, and expiry before ReDDone may act." />
      <ApprovalQueue />
    </div>
  );
}

