import { PageHeader } from "@/components/page-header";
import { ConnectionsPanel } from "@/features/connections/connections-panel";

export const metadata = { title: "Connections" };

export default function ConnectionsPage() {
  return (
    <div className="page-shell">
      <PageHeader eyebrow="Workspace / Account boundary" title="Connections" description="Authorize the GitHub and Vercel accounts used for source control and releases." />
      <ConnectionsPanel />
    </div>
  );
}
