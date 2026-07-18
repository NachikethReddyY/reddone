// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChatPage from "@/app/(console)/chat/page";
import { BuildsView } from "@/features/project-detail/builds-view";
import { SpecEditor } from "@/features/project-detail/spec-editor";
import { CreateProjectButton } from "@/features/projects/create-project-dialog";
import { ProjectWizard } from "@/features/projects/project-wizard";

const { push, refresh, redirect } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), redirect: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  redirect,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
}

function renderWithQuery(ui: ReactNode) {
  return render(<QueryClientProvider client={queryClient()}>{ui}</QueryClientProvider>);
}

function response(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } }));
}

function urlOf(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

const estimate = {
  projectId: "project-1",
  simulated: false,
  runKind: "build",
  model: "kimi-k2.7-code",
  method: "cold_start",
  confidence: "low",
  sampleCount: 0,
  low: { inputTokens: "1000", outputTokens: "2000", totalTokens: "3000" },
  expected: { inputTokens: "5000", outputTokens: "7000", totalTokens: "12000" },
  high: { inputTokens: "10000", outputTokens: "15000", totalTokens: "25000" },
  providerCostMicros: { low: "100000", expected: "400000", high: "900000", pricingVersion: "v1", ratesConfigured: true },
  creditQuote: { operation: "build", credits: "300", pricingVersion: "2026-07-17.v1" },
  authorizedProviderCostCeilingMicros: "12000000",
  assumptions: ["Cold-start scenario."],
  scenarioOnly: true,
  estimatedAt: "2026-07-17T12:00:00.000Z",
};

function projectRaw(status = "READY_TO_BUILD", runStatus?: string) {
  return {
    id: "project-1",
    name: "ScopeGuard",
    marketLabel: "Agency operations",
    status,
    optimisticVersion: 4,
    updatedAt: "2026-07-17T12:00:00.000Z",
    selectedFindingId: "finding-1",
    findings: [{ id: "finding-1", title: "Scope changes hide", selected: true, excerpts: [] }],
    currentSpecVersionId: "spec-1",
    specVersions: [{
      id: "spec-1",
      version: 2,
      status: "APPROVED",
      contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      updatedAt: "2026-07-17T11:00:00.000Z",
      content: { productName: "ScopeGuard", oneLinePitch: "Keep billable scope visible.", targetAudience: "Small agencies" },
    }],
    config: { maxCostMicrosPerRun: 12_000_000 },
    runs: runStatus ? [{ id: "run-1", kind: "BUILD", status: runStatus, currentStepKey: "build.verifier", actualCostMicros: 420000, steps: [] }] : [],
    approvals: status === "AWAITING_RELEASE_APPROVAL" ? [{ id: "approval-1", kind: "FIRST_RELEASE", status: "PENDING" }] : [],
  };
}

function liveRun(status: "running" | "succeeded" | "failed" | "canceled") {
  const succeeded = status === "succeeded";
  return {
    id: "run-1",
    projectId: "project-1",
    kind: "build",
    status,
    stateVersion: 3,
    attempt: 1,
    currentStepKey: succeeded ? null : "build.verifier",
    steps: [{ id: "step-1", key: "build.verifier", label: "Fresh sandbox verification", status: status === "running" ? "running" : succeeded ? "succeeded" : status, attempt: 1, startedAt: "2026-07-17T11:55:00.000Z", finishedAt: status === "running" ? null : "2026-07-17T12:00:00.000Z", summary: status === "failed" ? "Verifier gate failed." : null }],
    budgetCeilingMicros: 12_000_000,
    reservedMicros: 12_000_000,
    actualCostMicros: 420_000,
    cancelRequestedAt: status === "canceled" ? "2026-07-17T11:59:00.000Z" : null,
    startedAt: "2026-07-17T11:55:00.000Z",
    finishedAt: status === "running" ? null : "2026-07-17T12:00:00.000Z",
    createdAt: "2026-07-17T11:54:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
    failureCode: status === "failed" ? "verification_failed" : null,
    failureMessage: status === "failed" ? "The accessibility gate failed." : null,
    mode: "live",
    artifactHash: succeeded ? "a".repeat(64) : null,
    previewUrl: succeeded ? "https://preview.example.test/signed" : null,
    usage: { providerCalls: 2, inputTokens: "8000", outputTokens: "4000", totalTokens: "12000", costMicros: "420000", models: ["kimi-k2.7-code"], pricingSnapshotsComplete: true },
    usageEntries: [],
    artifacts: succeeded ? [{
      id: "artifact-1",
      kind: "verified_source",
      artifactHash: "b".repeat(64),
      manifestHash: "c".repeat(64),
      byteSize: 9000,
      fileCount: 18,
      expiresAt: null,
      createdAt: "2026-07-17T12:00:00.000Z",
      verification: null,
    }, {
      id: "artifact-2",
      kind: "vercel_output",
      artifactHash: "a".repeat(64),
      manifestHash: "d".repeat(64),
      byteSize: 12000,
      fileCount: 24,
      expiresAt: null,
      createdAt: "2026-07-17T12:00:00.000Z",
      verification: {
        id: "verification-1",
        status: "passed",
        verifierImage: "verifier@sha256:test",
        report: { gates: [{ name: "accessibility", status: "passed", durationMs: 40, summary: "Axe checks passed." }] },
        reportHash: "e".repeat(64),
        signatureKeyId: "kms-key-1",
        verifiedAt: "2026-07-17T12:00:00.000Z",
        expiresAt: null,
      },
    }] : [],
  };
}

function installWizardFetch(runEstimate = { ...estimate, projectId: "draft", runKind: "research", model: "kimi-k2.6", creditQuote: { operation: "research", credits: "25", pricingVersion: "2026-07-17.v1" } }) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url === "/api/v1/projects") return response({ items: [], workspaceTimeZone: "America/New_York", demoMode: false });
    if (url === "/api/v1/providers/status") return response({ providers: { aiand: true, daytona: true, oxylabs: true }, discoveryReady: true, buildReady: true });
    if (url === "/api/v1/projects/run-estimate") return response(runEstimate);
    throw new Error(`Unexpected request: ${url}`);
  }));
}

function installBuildFetch(runStatus?: "running" | "succeeded" | "failed" | "canceled") {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url === "/api/v1/projects/project-1") return response(projectRaw(runStatus === "succeeded" ? "AWAITING_RELEASE_APPROVAL" : runStatus ? runStatus === "running" ? "BUILDING" : "FAILED" : "READY_TO_BUILD", runStatus));
    if (url === "/api/v1/projects/project-1/run-estimate") return response(estimate);
    if (url === "/api/v1/runs/run-1") return response(liveRun(runStatus ?? "running"));
    if (url.startsWith("/api/v1/runs/run-1/events")) return response({ items: [], nextCursor: null, retentionStartsAt: "2026-06-17T12:00:00.000Z" });
    throw new Error(`Unexpected request: ${url}`);
  }));
}

function installSpecFetch() {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url === "/api/v1/projects/project-1") return response({
      currentSpecVersionId: "spec-1",
      specVersions: [{
        id: "spec-1",
        version: 2,
        status: "DRAFT",
        contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        title: "ScopeGuard",
        summary: "Keep billable scope visible.",
        audience: "Small agencies",
        jobs: ["see scope changes before work starts"],
        features: [{ name: "Prioritize overdue invoices" }, { name: "Draft reviewable follow-up" }],
        nonGoals: ["Automatic external actions"],
      }],
    });
    throw new Error(`Unexpected request: ${url}`);
  }));
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  redirect.mockReset();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("project wizard", () => {
  it("keeps real-user fields blank while demo mode retains explicit fixture defaults", () => {
    installWizardFetch();
    const { unmount } = renderWithQuery(<ProjectWizard demoMode={false} />);
    expect(screen.getByLabelText("Project name")).toHaveValue("");
    expect(screen.getByLabelText("Market")).toHaveValue("");
    expect(screen.getByLabelText("Research context")).toHaveValue("");
    unmount();

    renderWithQuery(<ProjectWizard demoMode />);
    expect(screen.getByLabelText("Project name")).toHaveValue("LatePay Copilot");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("radio", { name: /Curated fixture/ })).toHaveAttribute("aria-checked", "true");
  });

  it("supports roving focus and arrow-key selection for research sources", () => {
    installWizardFetch();
    renderWithQuery(<ProjectWizard demoMode />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const group = screen.getByRole("radiogroup", { name: "Research source" });
    const fixture = screen.getByRole("radio", { name: /Curated fixture/ });
    const imported = screen.getByRole("radio", { name: /Authorized JSON import/ });
    fixture.focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });

    expect(imported).toHaveFocus();
    expect(imported).toHaveAttribute("aria-checked", "true");
    expect(imported).toHaveAttribute("tabindex", "0");
    expect(fixture).toHaveAttribute("tabindex", "-1");
  });

  it("restores session drafts and validates fields inline before advancing", async () => {
    installWizardFetch();
    window.sessionStorage.setItem("reddone:project-wizard:v1:live", JSON.stringify({ version: 1, demoMode: false, step: 1, source: "import", name: "Restored Project", market: "", context: "", communities: "", limit: "50", maxCost: "5.00", fileName: "evidence.json" }));
    renderWithQuery(<ProjectWizard demoMode={false} />);

    expect(await screen.findByDisplayValue("Restored Project")).toBeInTheDocument();
    expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Describe the market or group experiencing the problem.")).toBeInTheDocument();
    expect(screen.getByText("Describe the problem shape worth researching.")).toBeInTheDocument();
    expect(screen.getByText("01 / 04")).toBeInTheDocument();
  });

  it("clears malformed session drafts without crashing hydration", async () => {
    installWizardFetch();
    const key = "reddone:project-wizard:v1:live";
    window.sessionStorage.setItem(key, JSON.stringify({ version: 1, demoMode: true }));
    renderWithQuery(<ProjectWizard demoMode={false} />);

    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(screen.getByLabelText("Project name")).toHaveValue("");
    expect(screen.queryByText(/Draft restored/)).not.toBeInTheDocument();
  });

  it("loads a pre-run estimate and keeps credits separate from provider USD", async () => {
    installWizardFetch();
    renderWithQuery(<ProjectWizard demoMode />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Research usage estimate")).toBeInTheDocument();
    expect((await screen.findAllByText("25 credits")).length).toBeGreaterThan(0);
    expect(screen.getByText("Independent of tokens and provider USD")).toBeInTheDocument();
    expect(screen.getByText("Stops provider calls, not a forecast")).toBeInTheDocument();
    expect(screen.getByText("America/New York")).toBeInTheDocument();
  });

  it("registers an abandon warning after the draft changes", () => {
    installWizardFetch();
    renderWithQuery(<ProjectWizard demoMode={false} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New project" } });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("create project paths", () => {
  it("offers an idea path and a discovery path before creating anything", () => {
    renderWithQuery(<CreateProjectButton />);

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(screen.getByRole("button", { name: /I have an idea on what to build/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /I don’t know what to build/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /I have an idea on what to build/ }));
    expect(push).toHaveBeenCalledWith("/projects/new");
  });

  it("creates an Oxylabs discovery project and queues bounded research from a pasted brief", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url === "/api/v1/projects" && init?.method !== "POST") {
        return response({ items: [], workspaceTimeZone: "Asia/Singapore", demoMode: false });
      }
      if (url === "/api/v1/providers/status") {
        return response({ providers: { aiand: true, daytona: true, oxylabs: true }, discoveryReady: true, buildReady: true });
      }
      if (url === "/api/v1/projects" && init?.method === "POST") {
        return response({ id: "project-discovery", optimisticVersion: 0 });
      }
      if (url === "/api/v1/projects/project-discovery/runs" && init?.method === "POST") {
        return response({ id: "run-discovery", status: "queued" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderWithQuery(<CreateProjectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    fireEvent.click(screen.getByRole("button", { name: /I don’t know what to build/ }));

    const brief = "Build for a climate resilience hackathon. Judges want a focused tool that helps urban communities prepare for extreme heat using measurable evidence.";
    fireEvent.change(screen.getByPlaceholderText(/Paste the hackathon theme/), { target: { value: brief } });
    const submit = await screen.findByRole("button", { name: "Find evidence-backed problems" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/project-discovery/evidence"));
    const createRequest = requests.find((request) => request.url === "/api/v1/projects" && request.init?.method === "POST");
    const createBody = JSON.parse(String(createRequest?.init?.body)) as { config: { researchMode: string; sourceLabels: string[]; researchContext: string; redditWebScrape: { subreddit: string; keywords: string } } };
    expect(createBody.config).toMatchObject({ researchMode: "live_reddit", researchContext: brief });
    expect(createBody.config.sourceLabels[0]).toMatch(/^search:/);
    expect(createBody.config.redditWebScrape).toMatchObject({ subreddit: "all" });
    expect(createBody.config.redditWebScrape.keywords).not.toContain("search:");

    const runRequest = requests.find((request) => request.url === "/api/v1/projects/project-discovery/runs");
    expect(JSON.parse(String(runRequest?.init?.body))).toEqual({ kind: "research", budgetCeilingMicros: 12_000_000 });
    expect(new Headers(runRequest?.init?.headers).get("if-match")).toBe("0");
  });
});

describe("spec editor", () => {
  it("keeps a required-feature input focused with its caret while typing", async () => {
    installSpecFetch();
    renderWithQuery(<SpecEditor projectId="project-1" />);

    const input = await screen.findByLabelText<HTMLInputElement>("Feature 1");
    const editedValue = "Prioritize critical overdue invoices";
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(setValue).toBeDefined();
    input.focus();
    setValue?.call(input, editedValue);
    input.setSelectionRange(12, 12);
    fireEvent.input(input);

    expect(screen.getByLabelText("Feature 1")).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue(editedValue);
    expect(input.selectionStart).toBe(12);
    expect(input.selectionEnd).toBe(12);
  });
});

describe("build lifecycle states", () => {
  it("shows one pre-run action with approved hash, estimates, credits, ceiling, turns, and sandbox policy", async () => {
    installBuildFetch();
    renderWithQuery(<BuildsView projectId="project-1" />);
    expect(await screen.findByText("One approved specification. One bounded build.")).toBeInTheDocument();
    expect(await screen.findByText("300 credits")).toBeInTheDocument();
    expect(screen.getByText("20 maximum")).toBeInTheDocument();
    expect(screen.getByText("Builder + fresh verifier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start build" })).toBeInTheDocument();
  });

  it("shows running stage, elapsed usage, ceiling, cancel, and details disclosure", async () => {
    installBuildFetch("running");
    renderWithQuery(<BuildsView projectId="project-1" />);
    expect(await screen.findByRole("heading", { name: "Fresh sandbox verification" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel build" })).toBeInTheDocument();
    expect(screen.getByText("Actual tokens")).toBeInTheDocument();
    expect(screen.getByText("Technical details")).toBeInTheDocument();
  });

  it("prioritizes signed preview, verification, changed files, usage, and release approval after success", async () => {
    installBuildFetch("succeeded");
    renderWithQuery(<BuildsView projectId="project-1" />);
    expect(await screen.findByRole("button", { name: "Open signed preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Verification passed" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "18 allowlisted files" })).toBeInTheDocument();
    expect(screen.getByText("Actual provider cost")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review release approval" })).toHaveAttribute("href", "/approvals");
  });

  it("shows failed stage, cleanup policy, consumed usage, retry reuse, and one retry action", async () => {
    installBuildFetch("failed");
    renderWithQuery(<BuildsView projectId="project-1" />);
    expect(await screen.findByText(/Stopped during verifier/)).toBeInTheDocument();
    expect(screen.getByText("Cleanup policy")).toBeInTheDocument();
    expect(screen.getByText("Consumed tokens")).toBeInTheDocument();
    expect(screen.getByText("Retry reuse")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry build" })).toHaveLength(1);
  });

  it("renders a distinct canceled state with consumed usage and safe retry", async () => {
    installBuildFetch("canceled");
    renderWithQuery(<BuildsView projectId="project-1" />);
    expect(await screen.findByText("The run is terminal and production is unchanged.")).toBeInTheDocument();
    expect(screen.getByText("No reuse")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry canceled build" })).toBeInTheDocument();
  });
});

describe("chat route", () => {
  it("redirects the placeholder chat route to projects", () => {
    ChatPage();
    expect(redirect).toHaveBeenCalledWith("/projects");
  });
});
