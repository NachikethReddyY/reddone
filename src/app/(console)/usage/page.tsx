import { PageHeader } from "@/components/page-header";
import { UsageDashboard } from "@/features/usage/usage-dashboard";
import { buildUsagePageSearchParams, parseUsagePageSearchParams } from "@/features/usage/usage-format";
import "./usage.css";

export const metadata = { title: "Usage" };

type UsagePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function UsagePage({ searchParams }: UsagePageProps) {
  const initialFilters = parseUsagePageSearchParams(await searchParams);
  const dashboardKey = buildUsagePageSearchParams(initialFilters).toString();

  return (
    <div className="page-shell usage-page">
      <PageHeader
        eyebrow="Operate / Usage"
        title="Usage"
        description="Inspect exact Kimi token volume and recorded provider cost across projects, runs, models, and operations."
      />
      <UsageDashboard initialFilters={initialFilters} key={dashboardKey} />
    </div>
  );
}
