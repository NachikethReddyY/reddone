import { Skeleton } from "@/components/ui";

export default function ProjectLoading() {
  return (
    <div aria-label="Loading project" aria-live="polite" className="route-loading-shell project-route-loading" role="status">
      <div className="route-loading-header">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
      <div className="route-loading-grid">
        <Skeleton className="route-loading-card" />
        <Skeleton className="route-loading-card" />
        <Skeleton className="route-loading-card" />
      </div>
      <span className="sr-only">Loading project details.</span>
    </div>
  );
}
