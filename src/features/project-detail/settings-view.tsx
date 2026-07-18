"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/components/icons";
import { Button, ButtonLink, SourceBadge, StatusBadge, Surface } from "@/components/ui";
import { ProjectSecretsSettings } from "./project-secrets-settings";

type ProjectSettingsRecord = {
  id: string;
  name: string;
  slug?: string;
  status?: string;
  marketLabel?: string;
  researchContext?: string;
  researchMode?: string;
  sourceMode?: string;
  sourceLabel?: string;
  optimisticVersion?: number;
  version?: number;
  config?: {
    researchContext?: string;
    maxDocumentsPerRun?: number;
    maxCostMicrosPerRun?: number;
  };
  sources?: Array<{ label?: string; mode?: string }>;
};

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok || !body || !("data" in body)) throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  return body.data as T;
}

function Switch({ checked, disabled, onChange, label, description }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; label: string; description: string }) {
  return <label className="setting-toggle"><span><strong>{label}</strong><small>{description}</small></span><input checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} role="switch" type="checkbox" /><i aria-hidden="true"><b /></i></label>;
}

export function SettingsView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [market, setMarket] = useState("");
  const [slug, setSlug] = useState("");
  const [context, setContext] = useState("");
  const [sourceMode, setSourceMode] = useState<"fixture" | "import" | "live">("fixture");
  const [sourceLabel, setSourceLabel] = useState("Loading source…");
  const [maxDocuments, setMaxDocuments] = useState(100);
  const [maxCost, setMaxCost] = useState(5);
  const [paused, setPaused] = useState(false);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState("Loading canonical project settings…");
  const [working, setWorking] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/projects/${projectId}`, { headers: { accept: "application/json" } })
      .then((response) => responseData<ProjectSettingsRecord>(response))
      .then((project) => {
        if (!active) return;
        const mode = (project.researchMode ?? project.sourceMode ?? "fixture").toLowerCase();
        setName(project.name);
        setMarket(project.marketLabel ?? "Private product workspace");
        setSlug(project.slug ?? project.id.replace(/^project_/, ""));
        setContext(project.researchContext ?? project.config?.researchContext ?? "Evidence-backed product research and constrained application delivery.");
        setMaxDocuments(project.config?.maxDocumentsPerRun ?? 100);
        setMaxCost((project.config?.maxCostMicrosPerRun ?? 5_000_000) / 1_000_000);
        setPaused(project.status?.toLowerCase() === "paused");
        setVersion(project.optimisticVersion ?? project.version ?? 0);
        setSourceMode(mode.includes("reddit") ? "live" : mode.includes("import") ? "import" : "fixture");
        setSourceLabel(project.sources?.[0]?.label ?? project.sourceLabel ?? (mode.includes("import") ? "Authorized JSON import" : "Curated fixture"));
        setNotice("Settings loaded from canonical workspace state.");
      })
      .catch((error: unknown) => { if (active) setNotice(error instanceof Error ? error.message : "Project settings are unavailable."); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [projectId]);

  async function patchProject(body: Record<string, unknown>) {
    const updated = await responseData<ProjectSettingsRecord>(await fetch(`/api/v1/projects/${projectId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `project-settings-${crypto.randomUUID()}`,
        "if-match": String(version),
      },
      body: JSON.stringify(body),
    }));
    setVersion(updated.optimisticVersion ?? updated.version ?? version + 1);
    return updated;
  }

  async function saveGeneral() {
    setWorking(true);
    try {
      await patchProject({ name: name.trim(), marketLabel: market.trim(), researchContext: context.trim() });
      setNotice("Project identity and research context were saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Settings could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function saveLimits() {
    setWorking(true);
    try {
      await patchProject({ maxDocumentsPerRun: maxDocuments, maxCostMicrosPerRun: Math.round(maxCost * 1_000_000) });
      setNotice("Research and provider-spend ceilings were saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Limits could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function togglePause(next: boolean) {
    setWorking(true);
    try {
      await patchProject({ status: next ? "paused" : "active" });
      setPaused(next);
      setNotice(next ? "Future runs are paused. Active work is not interrupted; schedules must be re-enabled explicitly." : "The project can accept new runs again. Schedules remain off until explicitly enabled.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Pause state could not be changed.");
    } finally {
      setWorking(false);
    }
  }

  async function archiveProject() {
    if (window.prompt(`Type ${name} to archive this project.`) !== name) {
      setNotice("Archive canceled; the confirmation text did not match.");
      return;
    }
    setWorking(true);
    try {
      await responseData(await fetch(`/api/v1/projects/${projectId}`, {
        method: "DELETE",
        headers: { "idempotency-key": `archive-${crypto.randomUUID()}`, "if-match": String(version) },
      }));
      router.push("/projects");
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The project could not be archived.");
      setWorking(false);
    }
  }

  return (
    <div className="settings-layout">
      <aside className="settings-nav"><span className="nav-label">Project settings</span><a className="is-active" href="#general">General</a><a href="#research">Research</a><a href="#runtime-secrets">Runtime secrets</a><a href="#limits">Limits</a><a href="#automation">Automation</a><a href="#danger">Danger zone</a></aside>
      <div className="settings-content">
        <div className="inline-notice" role="status"><Icon name="shield" size={17} /><span>{notice}</span></div>
        <Surface className="settings-section" id="general">
          <div className="settings-heading"><div><span className="eyebrow">General</span><h2>Project identity</h2><p>Used inside the private workspace and exact release payloads.</p></div><StatusBadge tone={paused ? "warning" : "success"}>{paused ? "Paused" : "Active"}</StatusBadge></div>
          <div className="field-grid two-col"><label className="form-field"><span>Project name</span><input disabled={!loaded || working} value={name} onChange={(event) => setName(event.target.value)} /></label><label className="form-field"><span>Project slug</span><input readOnly value={slug} /><small>Immutable after creation.</small></label></div>
          <label className="form-field"><span>Market label</span><input disabled={!loaded || working} value={market} onChange={(event) => setMarket(event.target.value)} /></label>
          <label className="form-field"><span>Research context</span><textarea disabled={!loaded || working} rows={4} value={context} onChange={(event) => setContext(event.target.value)} /></label>
          <div className="settings-actions"><Button kind="primary" icon="check" disabled={!loaded || working} onClick={saveGeneral}>{working ? "Saving…" : "Save settings"}</Button></div>
        </Surface>

        <Surface className="settings-section" id="research">
          <div className="settings-heading"><div><span className="eyebrow">Evidence policy</span><h2>Research source</h2><p>Source mode is explicit and never inferred from color.</p></div><SourceBadge mode={sourceMode} /></div>
          <div className="research-source-card"><span><Icon name="database" size={22} /></span><div><strong>{sourceLabel}</strong><small>{sourceMode === "live" ? "Authorized Reddit adapter" : sourceMode === "import" ? "Owner-authorized JSON packet" : "No external Reddit request"}</small></div></div>
          {sourceMode !== "live" && <div className="policy-lock"><Icon name="lock" size={19} /><span><strong>Live Reddit API remains disabled</strong><small>Only add access that has written commercial and downstream AI authorization.</small></span><ButtonLink href="/connections">Open requirements</ButtonLink></div>}
        </Surface>

        <Surface className="settings-section" id="runtime-secrets">
          <ProjectSecretsSettings projectId={projectId} />
        </Surface>

        <Surface className="settings-section" id="limits">
          <div className="settings-heading"><div><span className="eyebrow">Cost and execution</span><h2>Hard run limits</h2><p>Builds are additionally fixed at 20 model turns, two repair passes, and 30 minutes.</p></div></div>
          <div className="field-grid two-col"><label className="form-field"><span>Research documents</span><input disabled={!loaded || working} inputMode="numeric" min="1" max="1000" type="number" value={maxDocuments} onChange={(event) => setMaxDocuments(Number(event.target.value))} /><small>Maximum per research run</small></label><label className="form-field"><span>Provider cost ceiling</span><div className="input-with-unit"><b>$</b><input disabled={!loaded || working} inputMode="decimal" min="0" step="0.25" type="number" value={maxCost} onChange={(event) => setMaxCost(Number(event.target.value))} /><small>USD</small></div></label></div>
          <div className="settings-actions"><Button icon="check" disabled={!loaded || working} onClick={saveLimits}>Save limits</Button></div>
        </Surface>

        <Surface className="settings-section" id="automation">
          <div className="settings-heading"><div><span className="eyebrow">Emergency control</span><h2>Pause future automation</h2><p>Pausing never interrupts an active run. It disables both schedules and blocks new work.</p></div></div>
          <div className="setting-toggle-list"><Switch checked={paused} disabled={!loaded || working} onChange={togglePause} label="Project paused" description="Resume the project here, then explicitly re-enable desired schedules from Schedules." /></div>
        </Surface>

        <Surface className="settings-section danger-section" id="danger">
          <div className="settings-heading"><div><span className="eyebrow">Danger zone</span><h2>Archive this project</h2><p>Archiving pauses schedules and revokes pending or active project secret grants. Existing external resources remain intact.</p></div><Button kind="danger" icon="trash" disabled={!loaded || working} onClick={archiveProject}>Archive project</Button></div>
        </Surface>
      </div>
    </div>
  );
}
