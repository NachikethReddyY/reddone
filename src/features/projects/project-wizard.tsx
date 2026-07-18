"use client";

import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/components/icons";
import { Button, SourceBadge, StatusBadge } from "@/components/ui";
import type { ProjectCreateInput, ProjectDraftRunEstimateInput } from "@/contracts";
import {
  createProjectRequest,
  useBackendProviderStatusQuery,
  useDraftRunEstimateQuery,
  useProjectWorkspaceContextQuery,
} from "./project-queries";

const steps = [
  { id: 1, label: "Intent", description: "Name the market" },
  { id: 2, label: "Evidence", description: "Choose an approved source" },
  { id: 3, label: "Guardrails", description: "Bound the run" },
  { id: 4, label: "Review", description: "Confirm before creation" },
] as const;

const demoDefaults = {
  source: "fixture" as const,
  name: "LatePay Copilot",
  market: "Independent service businesses with overdue invoices",
  context: "Repeated workflow pain that can become a focused web application with a human approval boundary.",
  communities: "r/freelance, r/smallbusiness, r/consulting",
  limit: "50",
  maxCost: "12.00",
};

const liveDefaults = {
  source: "import" as const,
  name: "",
  market: "",
  context: "",
  communities: "",
  limit: "",
  maxCost: "",
};

const maxImportBytes = 10 * 1024 * 1024;

type Source = "fixture" | "import" | "live";
type FieldName = "name" | "market" | "context" | "communities" | "limit" | "maxCost" | "file" | "workspaceTimeZone";
type Draft = {
  version: 1;
  demoMode: boolean;
  step: number;
  source: Source;
  name: string;
  market: string;
  context: string;
  communities: string;
  limit: string;
  maxCost: string;
  fileName: string;
};

function draftKey(demoMode: boolean) {
  return `reddone:project-wizard:v1:${demoMode ? "demo" : "live"}`;
}

function isDraft(value: unknown): value is Draft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  const stringFields = ["name", "market", "context", "communities", "limit", "maxCost", "fileName"] as const;
  return draft.version === 1
    && typeof draft.demoMode === "boolean"
    && typeof draft.step === "number"
    && Number.isInteger(draft.step)
    && draft.step >= 1
    && draft.step <= 4
    && (draft.source === "fixture" || draft.source === "import" || draft.source === "live")
    && stringFields.every((field) => typeof draft[field] === "string");
}

function decimalMicros(value: string) {
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? Math.round(amount * 1_000_000) : 0;
}

function formatMicros(value: string | number) {
  const micros = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(micros)) return "Unavailable";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(micros / 1_000_000);
}

function formatTokens(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(amount) : value;
}

function slugFor(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `project-${Date.now()}`;
}

export function ProjectWizard({ demoMode }: { demoMode: boolean }) {
  const defaults = demoMode ? demoDefaults : liveDefaults;
  const router = useRouter();
  const workspaceQuery = useProjectWorkspaceContextQuery();
  const providerQuery = useBackendProviderStatusQuery();
  const [step, setStep] = useState(1);
  const [source, setSource] = useState<Source>(defaults.source);
  const [name, setName] = useState(defaults.name);
  const [market, setMarket] = useState(defaults.market);
  const [context, setContext] = useState(defaults.context);
  const [communities, setCommunities] = useState(defaults.communities);
  const [limit, setLimit] = useState(defaults.limit);
  const [maxCost, setMaxCost] = useState(defaults.maxCost);
  const [fileName, setFileName] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draftNotice, setDraftNotice] = useState("");

  const workspaceTimeZone = workspaceQuery.data?.workspaceTimeZone ?? "";
  const redditApproved = providerQuery.data?.providers.reddit === true;

  const fieldErrors = useMemo<Partial<Record<FieldName, string>>>(() => {
    const next: Partial<Record<FieldName, string>> = {};
    const trimmedName = name.trim();
    const trimmedMarket = market.trim();
    const trimmedContext = context.trim();
    const parsedLimit = Number(limit);
    const parsedCost = Number(maxCost);
    if (trimmedName.length < 2) next.name = "Enter a project name with at least 2 characters.";
    else if (trimmedName.length > 120) next.name = "Keep the project name under 120 characters.";
    if (trimmedMarket.length < 2) next.market = "Describe the market or group experiencing the problem.";
    else if (trimmedMarket.length > 120) next.market = "Keep the market description under 120 characters.";
    if (!trimmedContext) next.context = "Describe the problem shape worth researching.";
    else if (trimmedContext.length > 5_000) next.context = "Keep the research context under 5,000 characters.";
    if (source === "live" && !communities.split(",").some((value) => value.trim())) next.communities = "Add at least one approved community label.";
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1_000) next.limit = "Choose a whole-number document limit from 1 to 1,000.";
    if (!Number.isFinite(parsedCost) || parsedCost <= 0) next.maxCost = "Set a positive provider-cost ceiling in USD.";
    if (decimalMicros(maxCost) > Number.MAX_SAFE_INTEGER) next.maxCost = "The provider-cost ceiling is too large.";
    if (source === "import" && (!importFile || importFile.size > maxImportBytes || !importFile.name.toLowerCase().endsWith(".json"))) {
      next.file = importFile && importFile.size > maxImportBytes
        ? "Choose a JSON file smaller than 10 MB."
        : "Choose the authorized JSON file. Files cannot be restored from session storage.";
    }
    if (!workspaceTimeZone) next.workspaceTimeZone = workspaceQuery.isError
      ? "Workspace timezone is unavailable. Retry before creating the project."
      : "Loading the workspace timezone…";
    return next;
  }, [communities, context, importFile, limit, market, maxCost, name, source, workspaceQuery.isError, workspaceTimeZone]);

  const estimateInput = useMemo<ProjectDraftRunEstimateInput | null>(() => {
    if (step < 3 || fieldErrors.name || fieldErrors.market || fieldErrors.context || fieldErrors.limit || fieldErrors.maxCost) return null;
    return {
      kind: "research",
      name: name.trim(),
      marketLabel: market.trim(),
      researchContext: context.trim(),
      maxDocumentsPerRun: Number(limit),
      maxCostMicrosPerRun: decimalMicros(maxCost),
    };
  }, [context, fieldErrors.context, fieldErrors.limit, fieldErrors.market, fieldErrors.maxCost, fieldErrors.name, limit, market, maxCost, name, step]);
  const estimateQuery = useDraftRunEstimateQuery(estimateInput);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const key = draftKey(demoMode);
      try {
        const raw = window.sessionStorage.getItem(key);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (!isDraft(parsed) || parsed.demoMode !== demoMode) {
          window.sessionStorage.removeItem(key);
          return;
        }
        setStep(parsed.step);
        setSource(parsed.source);
        setName(parsed.name);
        setMarket(parsed.market);
        setContext(parsed.context);
        setCommunities(parsed.communities);
        setLimit(parsed.limit);
        setMaxCost(parsed.maxCost);
        setFileName(parsed.fileName);
        setDirty(true);
        setDraftNotice(parsed.source === "import" && parsed.fileName
          ? `Draft restored. Choose ${parsed.fileName} again before continuing.`
          : "Draft restored from this browser session.");
      } catch {
        try {
          window.sessionStorage.removeItem(key);
        } catch {
          // Storage can be unavailable; hydration should still complete safely.
        }
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [demoMode]);

  useEffect(() => {
    if (!hydrated || !dirty) return;
    const draft: Draft = { version: 1, demoMode, step, source, name, market, context, communities, limit, maxCost, fileName };
    window.sessionStorage.setItem(draftKey(demoMode), JSON.stringify(draft));
  }, [communities, context, demoMode, dirty, fileName, hydrated, limit, market, maxCost, name, source, step]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty || creating) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [creating, dirty]);

  function edit(update: () => void) {
    update();
    setDirty(true);
    setDraftNotice("");
    setError("");
  }

  function navigateSourceOptions(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"] as string[]).includes(event.key)) return;
    const availableSources: Source[] = redditApproved ? ["fixture", "import", "live"] : ["fixture", "import"];
    const focusedSource = (event.target as HTMLElement).dataset.source as Source | undefined;
    const currentIndex = Math.max(0, availableSources.indexOf(focusedSource ?? source));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? availableSources.length - 1
        : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + availableSources.length) % availableSources.length;
    const nextSource = availableSources[nextIndex];
    if (!nextSource) return;
    event.preventDefault();
    edit(() => setSource(nextSource));
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-source="${nextSource}"]`)?.focus();
  }

  function reveal(fields: FieldName[]) {
    setTouched((current) => ({ ...current, ...Object.fromEntries(fields.map((field) => [field, true])) }));
  }

  function advance() {
    const stepFields: Record<number, FieldName[]> = {
      1: ["name", "market", "context"],
      2: source === "import" ? ["file", "limit"] : source === "live" ? ["communities", "limit"] : ["limit"],
      3: ["limit", "maxCost", "workspaceTimeZone"],
      4: [],
    };
    const fields = stepFields[step] ?? [];
    reveal(fields);
    if (fields.some((field) => fieldErrors[field])) return;
    setStep((value) => Math.min(4, value + 1));
    setDirty(true);
  }

  async function finish() {
    const allFields: FieldName[] = ["name", "market", "context", "limit", "maxCost", "workspaceTimeZone", ...(source === "import" ? ["file" as const] : source === "live" ? ["communities" as const] : [])];
    reveal(allFields);
    const firstError = allFields.find((field) => fieldErrors[field]);
    if (firstError) {
      setStep(["name", "market", "context"].includes(firstError) ? 1 : firstError === "file" || firstError === "communities" ? 2 : 3);
      setError(fieldErrors[firstError] ?? "Review the highlighted fields.");
      return;
    }

    setCreating(true);
    setError("");
    const sourceLabels = source === "import"
      ? [fileName]
      : communities.split(",").map((item) => item.trim()).filter(Boolean);
    const input: ProjectCreateInput = {
      name: name.trim(),
      slug: slugFor(name),
      config: {
        marketLabel: market.trim(),
        researchContext: context.trim(),
        researchMode: source === "import" ? "authorized_import" : source === "live" ? "live_reddit" : "fixture",
        sourceLabels,
        maxDocumentsPerRun: Number(limit),
        maxCostMicrosPerRun: decimalMicros(maxCost),
        workspaceTimeZone,
        hourlyResearchEnabled: false,
        fiveHourPolishEnabled: false,
      },
    };

    try {
      const created = await createProjectRequest(input);
      if (source === "import") {
        if (!importFile) throw new Error("Choose the authorized JSON file again before creating the project.");
        const importResponse = await fetch(`/api/v1/projects/${created.id}/research-imports`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `research-import-${crypto.randomUUID()}`,
            "if-match": String(created.optimisticVersion ?? created.version ?? 0),
          },
          body: await importFile.text(),
        });
        const importBody = await importResponse.json().catch(() => null) as { error?: { message?: string } } | null;
        if (!importResponse.ok) throw new Error(`Project created, but the import was rejected: ${importBody?.error?.message ?? "validation failed"}`);
      }
      window.sessionStorage.removeItem(draftKey(demoMode));
      setDirty(false);
      router.push(`/projects/${created.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The project could not be created.");
      setCreating(false);
    }
  }

  function errorFor(field: FieldName) {
    return touched[field] ? fieldErrors[field] : undefined;
  }

  const estimate = estimateQuery.data;
  const fixedResearchCredits = estimate?.creditQuote.credits ?? "—";

  return (
    <div className="wizard-layout">
      <aside className="wizard-steps" aria-label="Project setup progress">
        <div className="wizard-rail" aria-hidden="true"><span style={{ height: `${((step - 1) / 3) * 100}%` }} /></div>
        {steps.map((item) => {
          const complete = step > item.id;
          const active = step === item.id;
          return (
            <button aria-current={active ? "step" : undefined} className={`${active ? "is-active" : ""} ${complete ? "is-complete" : ""}`} disabled={item.id > step} key={item.id} onClick={() => setStep(item.id)} type="button">
              <span>{complete ? <Icon name="check" size={16} /> : String(item.id).padStart(2, "0")}</span>
              <div><strong>{item.label}</strong><small>{item.description}</small></div>
            </button>
          );
        })}
        <div className="wizard-assurance"><Icon name="shield" size={20} /><p><strong>Human gates stay on.</strong> Creating a project cannot create a repository, deployment, or paid build.</p></div>
      </aside>

      <section className="wizard-panel" aria-live="polite">
        {draftNotice && <div className="wizard-draft-notice"><Icon name="activity" size={17} /><span>{draftNotice}</span></div>}
        {step === 1 && (
          <div className="wizard-section reveal">
            <div className="wizard-heading"><span className="step-number">01 / 04</span><h2>Give the research a sharp edge.</h2><p>Describe the market and outcome. ReDDone uses this to reject interesting-but-irrelevant pain.</p></div>
            <div className="field-stack">
              <label className="form-field"><span>Project name</span><input aria-label="Project name" aria-describedby="project-name-help project-name-error" aria-invalid={Boolean(errorFor("name"))} autoFocus value={name} onBlur={() => reveal(["name"])} onChange={(event) => edit(() => setName(event.target.value))} placeholder="e.g. LatePay Copilot" /><small id="project-name-help">Visible only inside this private workspace.</small>{errorFor("name") && <small className="field-error" id="project-name-error">{errorFor("name")}</small>}</label>
              <label className="form-field"><span>Market</span><input aria-label="Market" aria-describedby="project-market-error" aria-invalid={Boolean(errorFor("market"))} value={market} onBlur={() => reveal(["market"])} onChange={(event) => edit(() => setMarket(event.target.value))} placeholder="Who experiences the problem?" />{errorFor("market") && <small className="field-error" id="project-market-error">{errorFor("market")}</small>}</label>
              <label className="form-field"><span>Research context</span><textarea aria-label="Research context" aria-describedby="project-context-help project-context-error" aria-invalid={Boolean(errorFor("context"))} rows={5} value={context} onBlur={() => reveal(["context"])} onChange={(event) => edit(() => setContext(event.target.value))} placeholder="Describe the problem pattern worth investigating." /><small id="project-context-help">Describe the problem worth building around, not the product you already want.</small>{errorFor("context") && <small className="field-error" id="project-context-error">{errorFor("context")}</small>}</label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-section reveal">
            <div className="wizard-heading"><span className="step-number">02 / 04</span><h2>Choose where the evidence comes from.</h2><p>Fixture data and authorized imports work now. Live Reddit remains locked until written authorization is recorded.</p></div>
            <div className="source-options" role="radiogroup" aria-label="Research source" onKeyDown={navigateSourceOptions}>
              <button aria-checked={source === "fixture"} className={source === "fixture" ? "is-selected" : ""} data-source="fixture" role="radio" tabIndex={source === "fixture" ? 0 : -1} onClick={() => edit(() => setSource("fixture"))} type="button"><span className="source-radio" /><Icon name="database" size={23} /><strong>Curated fixture</strong><p>Prove the workflow with attributable, anonymized evidence. Demo values are prefilled only in demo mode.</p><SourceBadge mode="fixture" /></button>
              <button aria-checked={source === "import"} className={source === "import" ? "is-selected" : ""} data-source="import" role="radio" tabIndex={source === "import" ? 0 : -1} onClick={() => edit(() => setSource("import"))} type="button"><span className="source-radio" /><Icon name="file" size={23} /><strong>Authorized JSON import</strong><p>Validate and ingest a dataset you have permission to process.</p><SourceBadge mode="import" /></button>
              <button aria-checked={source === "live"} aria-disabled={!redditApproved} className={`${source === "live" ? "is-selected" : ""} ${redditApproved ? "" : "is-disabled"}`} data-source="live" disabled={!redditApproved} role="radio" tabIndex={source === "live" && redditApproved ? 0 : -1} onClick={() => redditApproved && edit(() => setSource("live"))} type="button"><span className="source-radio" /><Icon name={redditApproved ? "activity" : "lock"} size={23} /><strong>Live Reddit API</strong><p>{redditApproved ? "Use only the approved OAuth API connection and recorded authorization." : "Requires recorded API and commercial authorization."}</p>{redditApproved ? <SourceBadge mode="live" /> : <StatusBadge tone="neutral">Locked</StatusBadge>}</button>
            </div>
            {source === "import" ? (
              <><label className={`file-drop ${fileName ? "has-file" : ""}`}>
                <input accept="application/json,.json" aria-describedby="project-file-error" aria-invalid={Boolean(errorFor("file"))} type="file" onChange={(event) => edit(() => { const file = event.target.files?.[0] ?? null; setImportFile(file); setFileName(file?.name ?? ""); setTouched((current) => ({ ...current, file: true })); })} />
                <Icon name={importFile && !fieldErrors.file ? "check" : "download"} size={24} />
                <span><strong>{fileName || "Choose an authorized JSON file"}</strong><small>{fileName && !importFile ? "Choose this file again; browsers do not restore file access." : importFile && !fieldErrors.file ? "Ready for schema and safety validation" : "Maximum 10 MB · JSON only · no remote fetch instructions"}</small></span>
              </label>{errorFor("file") && <small className="field-error standalone-error" id="project-file-error">{errorFor("file")}</small>}</>
            ) : (
              <div className="field-grid two-col">
                <label className="form-field"><span>Communities represented</span><input aria-label="Communities represented" aria-describedby="project-communities-help project-communities-error" aria-invalid={Boolean(errorFor("communities"))} value={communities} onBlur={() => reveal(["communities"])} onChange={(event) => edit(() => setCommunities(event.target.value))} placeholder={source === "live" ? "Required approved labels" : "Optional attribution labels"} /><small id="project-communities-help">Labels are retained for attribution.</small>{errorFor("communities") && <small className="field-error" id="project-communities-error">{errorFor("communities")}</small>}</label>
                <label className="form-field"><span>Research document limit</span><input aria-label="Research document limit" aria-describedby="project-limit-error" aria-invalid={Boolean(errorFor("limit"))} inputMode="numeric" type="number" min="1" max="1000" value={limit} onBlur={() => reveal(["limit"])} onChange={(event) => edit(() => setLimit(event.target.value))} />{errorFor("limit") && <small className="field-error" id="project-limit-error">{errorFor("limit")}</small>}</label>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="wizard-section reveal">
            <div className="wizard-heading"><span className="step-number">03 / 04</span><h2>Separate capacity, provider spend, and credits.</h2><p>The document limit bounds research input. The USD ceiling is the hard provider-cost stop. Customer credits are a fixed product charge, not a token or dollar conversion.</p></div>
            <div className="guardrail-grid">
              <label className="form-field"><span>Research document limit</span><div className="input-with-unit"><input aria-label="Research document limit" aria-describedby="guardrail-limit-error" aria-invalid={Boolean(errorFor("limit"))} inputMode="numeric" min="1" max="1000" type="number" value={limit} onBlur={() => reveal(["limit"])} onChange={(event) => edit(() => setLimit(event.target.value))} /><small>documents</small></div>{errorFor("limit") && <small className="field-error" id="guardrail-limit-error">{errorFor("limit")}</small>}</label>
              <label className="form-field"><span>Authorized provider-cost ceiling</span><div className="input-with-unit"><b>$</b><input aria-label="Authorized provider-cost ceiling" aria-describedby="guardrail-cost-error" aria-invalid={Boolean(errorFor("maxCost"))} inputMode="decimal" value={maxCost} onBlur={() => reveal(["maxCost"])} onChange={(event) => edit(() => setMaxCost(event.target.value))} /><small>USD / run</small></div>{errorFor("maxCost") && <small className="field-error" id="guardrail-cost-error">{errorFor("maxCost")}</small>}</label>
              <div className="guardrail-card"><Icon name="layers" size={22} /><div><strong>Fixed research charge</strong><span>{fixedResearchCredits === "—" ? "Estimate pending" : `${fixedResearchCredits} customer credits`}</span><small>Independent of tokens and provider USD</small></div></div>
              <div className="guardrail-card"><Icon name="globe" size={22} /><div><strong>Workspace timezone</strong><span>{workspaceTimeZone ? workspaceTimeZone.replaceAll("_", " ") : "Loading…"}</span><small>Used for schedules created with this project</small></div></div>
            </div>
            {errorFor("workspaceTimeZone") && <small className="field-error standalone-error">{errorFor("workspaceTimeZone")}</small>}

            <div className="estimate-panel" aria-busy={estimateQuery.isPending && Boolean(estimateInput)}>
              <div className="estimate-heading"><div><span className="eyebrow">Pre-run scenario</span><h3>Research usage estimate</h3></div>{estimate && <StatusBadge tone={estimate.confidence === "high" ? "success" : estimate.confidence === "medium" ? "warning" : "neutral"}>{estimate.confidence} confidence</StatusBadge>}</div>
              {!estimateInput ? <p>Complete the intent and guardrail fields to calculate a scenario.</p> : estimateQuery.isPending ? <p>Calculating token and provider-cost scenarios…</p> : estimateQuery.isError ? <div className="estimate-error"><p>{estimateQuery.error instanceof Error ? estimateQuery.error.message : "The estimate is unavailable."}</p><Button icon="retry" onClick={() => void estimateQuery.refetch()}>Retry estimate</Button></div> : estimate ? <>
                <div className="estimate-metrics">
                  <span><small>Expected tokens</small><strong>{formatTokens(estimate.expected.totalTokens)}</strong><em>{formatTokens(estimate.low.totalTokens)}–{formatTokens(estimate.high.totalTokens)} scenario</em></span>
                  <span><small>Expected provider cost</small><strong>{estimate.providerCostMicros.ratesConfigured ? formatMicros(estimate.providerCostMicros.expected) : "Rates unavailable"}</strong><em>{estimate.providerCostMicros.ratesConfigured ? `${formatMicros(estimate.providerCostMicros.low)}–${formatMicros(estimate.providerCostMicros.high)}` : "Configure provider rates before treating cost as a forecast"}</em></span>
                  <span><small>Fixed customer charge</small><strong>{estimate.creditQuote.credits} credits</strong><em>Pricing {estimate.creditQuote.pricingVersion}</em></span>
                  <span><small>Hard USD ceiling</small><strong>{formatMicros(estimate.authorizedProviderCostCeilingMicros)}</strong><em>Stops provider calls, not a forecast</em></span>
                </div>
                <p className="estimate-method">Scenario only · {estimate.method.replaceAll("_", " ")} · {estimate.sampleCount} comparable run{estimate.sampleCount === 1 ? "" : "s"}. {estimate.assumptions[0]}</p>
              </> : null}
            </div>

            <div className="approval-boundary-note"><Icon name="approval" size={19} /><span><strong>Automation stops before building.</strong> Autonomy is not configurable here because every ProductSpec and release remains owner-approved.</span></div>
            <div className="schedule-off-note"><Icon name="calendar" size={19} /><span><strong>Schedules start off.</strong> Enable hourly research and five-hour polish later from the project’s Schedules view.</span></div>
          </div>
        )}

        {step === 4 && (
          <div className="wizard-section reveal">
            <div className="wizard-heading"><span className="step-number">04 / 04</span><h2>Ready for an evidence-first project.</h2><p>Only the workspace project and research configuration will be created now.</p></div>
            <div className="review-summary">
              <div className="review-hero"><span className="project-monogram">{name.split(" ").map((part) => part[0]).join("").slice(0, 2) || "—"}</span><div><h3>{name}</h3><p>{market}</p></div><StatusBadge tone="info">Ready</StatusBadge></div>
              <dl>
                <div><dt>Source</dt><dd><SourceBadge mode={source} /></dd></div>
                <div><dt>Research context</dt><dd>{context}</dd></div>
                <div><dt>Source labels</dt><dd>{source === "import" ? fileName : communities || "No optional labels"}</dd></div>
                <div><dt>Research capacity</dt><dd>{limit} documents per run</dd></div>
                <div><dt>Provider hard stop</dt><dd>{formatMicros(decimalMicros(maxCost))} USD per run</dd></div>
                <div><dt>Customer charge</dt><dd>{fixedResearchCredits} credits for research · fixed product pricing</dd></div>
                <div><dt>Workspace timezone</dt><dd>{workspaceTimeZone.replaceAll("_", " ")}</dd></div>
                <div><dt>Human gates</dt><dd>ProductSpec build, first release, secret grants, polish release, rollback</dd></div>
                <div><dt>Schedules</dt><dd>Hourly research off · five-hour polish off</dd></div>
              </dl>
            </div>
            <div className="trust-callout"><Icon name="shield" size={21} /><p><strong>Nothing external happens on creation.</strong> GitHub, Vercel, project secrets, and paid builds remain behind structured approvals.</p></div>
            {error && <div className="inline-error" role="alert"><Icon name="warning" size={17} />{error}</div>}
          </div>
        )}

        <footer className="wizard-footer">
          <Button icon="arrow-left" disabled={step === 1 || creating} onClick={() => setStep((value) => Math.max(1, value - 1))}>Back</Button>
          <span>Step {step} of {steps.length}</span>
          {step < 4 ? <Button kind="primary" icon="arrow-right" disabled={creating} onClick={advance}>Continue</Button> : <Button kind="primary" icon={creating ? "activity" : "plus"} disabled={creating} onClick={finish}>{creating ? "Creating…" : "Create project"}</Button>}
        </footer>
      </section>
    </div>
  );
}
