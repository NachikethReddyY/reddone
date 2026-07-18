// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageReport } from "@/contracts";
import { UsageDashboard } from "@/features/usage/usage-dashboard";
import { createUsageFilters, formatBucketDate, parseUsagePageSearchParams, type UsageFilterState } from "@/features/usage/usage-format";

const navigation = vi.hoisted(() => ({
  pathname: "/usage",
  replace: vi.fn<(href: string, options?: { scroll?: boolean }) => void>(),
  search: "continue=sign-in",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const report: UsageReport = {
  source: "simulated",
  simulated: true,
  query: {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-04T00:00:00.000Z",
    granularity: "day",
  },
  totals: {
    providerCalls: 6,
    inputTokens: "7000",
    outputTokens: "3500",
    totalTokens: "10500",
    costMicros: "2500000",
    completedRuns: 2,
    averageCostPerCompletedRunMicros: "1250000",
  },
  buckets: [
    { start: "2026-07-01T00:00:00.000Z", end: "2026-07-02T00:00:00.000Z", providerCalls: 1, inputTokens: "1000", outputTokens: "500", totalTokens: "1500", costMicros: "250000" },
    { start: "2026-07-02T00:00:00.000Z", end: "2026-07-03T00:00:00.000Z", providerCalls: 2, inputTokens: "2000", outputTokens: "1000", totalTokens: "3000", costMicros: "750000" },
    { start: "2026-07-03T00:00:00.000Z", end: "2026-07-04T00:00:00.000Z", providerCalls: 3, inputTokens: "4000", outputTokens: "2000", totalTokens: "6000", costMicros: "1500000" },
  ],
  breakdowns: [
    { dimension: "model", value: "kimi-k2.7-code", providerCalls: 6, inputTokens: "7000", outputTokens: "3500", totalTokens: "10500", costMicros: "2500000" },
    { dimension: "operation", value: "simulated_build", providerCalls: 6, inputTokens: "7000", outputTokens: "3500", totalTokens: "10500", costMicros: "2500000" },
  ],
  recentRuns: [{
    runId: "run_1",
    projectId: "project_1",
    projectName: "Signal Forge",
    kind: "build",
    status: "succeeded",
    models: ["kimi-k2.7-code"],
    providerCalls: 6,
    inputTokens: "7000",
    outputTokens: "3500",
    totalTokens: "10500",
    costMicros: "2500000",
    startedAt: "2026-07-03T10:00:00.000Z",
    finishedAt: "2026-07-03T10:05:00.000Z",
  }],
  generatedAt: "2026-07-04T00:05:00.000Z",
};

function response(data: UsageReport) {
  return new Response(JSON.stringify({ data, requestId: "request_usage" }), { status: 200, headers: { "content-type": "application/json" } });
}

function renderDashboard(initialFilters: UsageFilterState = createUsageFilters(new Date())) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><UsageDashboard initialFilters={initialFilters} /></QueryClientProvider>);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
  navigation.pathname = "/usage";
  navigation.search = "continue=sign-in";
  navigation.replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usage dashboard", () => {
  it("renders headline totals, clear simulated labeling, table parity, and beta entitlement separation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(report)));
    renderDashboard();

    expect(await screen.findByText("Simulated demo usage")).toBeInTheDocument();
    const totals = screen.getByRole("region", { name: "Usage totals" });
    expect(within(totals).getByText("Provider cost")).toBeInTheDocument();
    expect(within(totals).getByText("Total tokens")).toBeInTheDocument();
    expect(within(totals).getByText("Kimi calls")).toBeInTheDocument();
    expect(within(totals).getByText("Average cost per completed run")).toBeInTheDocument();
    expect(within(totals).getByText("$2.50")).toBeInTheDocument();

    const table = screen.getByTestId("usage-bucket-table");
    expect(within(table).getAllByRole("row")).toHaveLength(report.buckets.length + 1);
    for (const bucket of report.buckets) {
      expect(within(table).getByText(new Intl.NumberFormat().format(BigInt(bucket.totalTokens)))).toBeInTheDocument();
    }
    expect(screen.getByText("Provider usage remains independently measurable.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open payments/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Source: simulated demo data/)).toBeInTheDocument();
  });

  it("switches from the single OrangeRed cost series to encoded input and output token series", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(report)));
    renderDashboard();

    expect(await screen.findByTestId("usage-series-cost")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-series-input")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));

    expect(screen.getByTestId("usage-series-input")).toBeInTheDocument();
    expect(screen.getByTestId("usage-series-output")).toHaveClass("is-dashed");
    expect(screen.getByRole("list", { name: "Token series legend" })).toHaveTextContent("Input tokens");
    expect(screen.getByRole("list", { name: "Token series legend" })).toHaveTextContent("Output tokens");
  });

  it("uses one roving chart tab stop and preserves arrow, Home, and End navigation without button semantics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(report)));
    const { container } = renderDashboard();
    await screen.findByTestId("usage-series-cost");

    const buckets = [...container.querySelectorAll<SVGRectElement>("[data-bucket-index]")];
    const [firstBucket, secondBucket, thirdBucket] = buckets;
    expect(buckets).toHaveLength(report.buckets.length);
    expect(buckets.filter((bucket) => bucket.tabIndex === 0)).toHaveLength(1);
    expect(firstBucket).toHaveAttribute("tabindex", "0");
    expect(secondBucket).toHaveAttribute("tabindex", "-1");
    expect(buckets.every((bucket) => bucket.getAttribute("role") !== "button")).toBe(true);

    firstBucket!.focus();
    fireEvent.keyDown(firstBucket!, { key: "ArrowRight" });
    expect(secondBucket).toHaveFocus();
    expect(secondBucket).toHaveAttribute("tabindex", "0");
    expect(firstBucket).toHaveAttribute("tabindex", "-1");
    expect(container.querySelector(".usage-chart-tooltip")).toHaveTextContent("$0.75");

    fireEvent.mouseLeave(container.querySelector(".usage-chart-wrap")!);
    expect(container.querySelector(".usage-chart-tooltip")).toHaveTextContent("$0.75");
    fireEvent.keyDown(secondBucket!, { key: "End" });
    expect(thirdBucket).toHaveFocus();
    fireEvent.keyDown(thirdBucket!, { key: "Home" });
    expect(firstBucket).toHaveFocus();
  });

  it("applies run, operation, model, project, granularity, and bounded date filters to the usage request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return response(report);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDashboard();
    await screen.findByText("Simulated demo usage");

    fireEvent.change(screen.getByLabelText("Run kind"), { target: { value: "build" } });
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "simulated_build" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "kimi-k2.7-code" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "project_1" } });
    fireEvent.change(screen.getByLabelText("Granularity"), { target: { value: "week" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const url = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(url).toContain("runKind=build");
    expect(url).toContain("operation=simulated_build");
    expect(url).toContain("model=kimi-k2.7-code");
    expect(url).toContain("projectId=project_1");
    expect(url).toContain("granularity=week");
    expect(url).toContain("from=2026-06-18T00%3A00%3A00.000Z");
    expect(url).toContain("to=2026-07-18T00%3A00%3A00.000Z");
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringContaining("/usage?continue=sign-in"), { scroll: false });
    const pageUrl = String(navigation.replace.mock.calls.at(-1)?.[0]);
    expect(pageUrl).toContain("from=2026-06-18");
    expect(pageUrl).toContain("to=2026-07-17");
    expect(pageUrl).toContain("granularity=week");
    expect(pageUrl).toContain("runKind=build");
  });

  it("initializes the first request from a shareable weekly URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return response(report);
    });
    vi.stubGlobal("fetch", fetchMock);
    const initialFilters = parseUsagePageSearchParams(new URLSearchParams("granularity=week&projectId=project_1&runKind=build"), new Date());
    renderDashboard(initialFilters);

    await screen.findByText("Simulated demo usage");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("granularity=week");
    expect(url).toContain("projectId=project_1");
    expect(url).toContain("runKind=build");
    expect(screen.getByLabelText("Granularity")).toHaveValue("week");
  });

  it("updates preserved URL state for presets and reset", async () => {
    const fetchMock = vi.fn(async () => response(report));
    vi.stubGlobal("fetch", fetchMock);
    renderDashboard();
    await screen.findByText("Simulated demo usage");

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(navigation.replace).toHaveBeenLastCalledWith(expect.stringMatching(/^\/usage\?continue=sign-in&preset=7d&/), { scroll: false });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const resetUrl = String(navigation.replace.mock.calls.at(-1)?.[0]);
    expect(resetUrl).toContain("continue=sign-in");
    expect(resetUrl).toContain("preset=30d");
    expect(resetUrl).toContain("granularity=day");
  });

  it("does not request or synchronize invalid ranges", async () => {
    const fetchMock = vi.fn(async () => response(report));
    vi.stubGlobal("fetch", fetchMock);
    renderDashboard();
    await screen.findByText("Simulated demo usage");

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Usage ranges cannot exceed one year.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("shows the loading state while the first request is pending", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderDashboard();
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeInTheDocument();
  });

  it("shows the empty state for a report without provider calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      ...report,
      totals: { ...report.totals, providerCalls: 0 },
      buckets: [],
    })));
    renderDashboard();
    expect(await screen.findByText("No usage in this range")).toBeInTheDocument();
  });

  it("shows a safe initial error without raw contract diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })));
    renderDashboard();
    expect(await screen.findByText("Usage request failed (502).")).toBeInTheDocument();
    expect(screen.queryByText(/invalid_type|ZodError|expected/i)).not.toBeInTheDocument();
  });

  it("keeps stale report data visible when a filtered refresh fails", async () => {
    const refreshFetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes("granularity=week")
      ? new Response("not json", { status: 502 })
      : response(report));
    vi.stubGlobal("fetch", refreshFetch);
    renderDashboard();
    expect(await screen.findByText("Simulated demo usage")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Granularity"), { target: { value: "week" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByText("Latest refresh failed")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Usage totals" })).getByText("$2.50")).toBeInTheDocument();
  });

  it("uses Monday-aligned boundaries in the weekly headline range", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      ...report,
      query: {
        from: "2026-06-18T00:00:00.000Z",
        to: "2026-07-18T00:00:00.000Z",
        granularity: "week",
      },
    })));
    renderDashboard(parseUsagePageSearchParams(new URLSearchParams("granularity=week"), new Date()));

    const expectedRange = `${formatBucketDate("2026-06-15T00:00:00.000Z", "week", true)} to ${formatBucketDate("2026-07-13T00:00:00.000Z", "week", true)}`;
    expect(await screen.findByText(new RegExp(expectedRange))).toBeInTheDocument();
  });
});
