import { Skeleton } from "@/components/ui";

export default function ConsoleLoading() {
  return (
    <div aria-label="Loading workspace" aria-live="polite" className="route-loading-shell" role="status">
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
      <span className="sr-only">Loading workspace content.</span>
    </div>
  );
}
