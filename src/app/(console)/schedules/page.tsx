import { PageHeader } from "@/components/page-header";
import { SchedulesPanel } from "@/features/schedules/schedules-panel";

export const metadata = { title: "Schedules" };

export default function SchedulesPage() {
  return (
    <div className="page-shell medium-page">
      <PageHeader eyebrow="Workspace / Durable cadence" title="Schedules" description="Fixed MVP loops with visible next runs, overlap protection, and no catch-up storms." />
      <SchedulesPanel />
    </div>
  );
}

