"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Icon } from "@/components/icons";
import { Alert, Button, Dialog } from "@/components/ui";
import { buildHackathonDiscoverySeed } from "./hackathon-discovery";
import {
  createProjectRequest,
  startProjectResearchRequest,
  useBackendProviderStatusQuery,
  useProjectWorkspaceContextQuery,
} from "./project-queries";

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
type Stage = "choice" | "discover";

function slugFor(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 66) || "hackathon-discovery";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export function CreateProjectButton({
  children = "Create project",
  kind = "secondary",
  className = "",
}: {
  children?: string;
  kind?: ButtonKind;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("choice");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const discoveryActive = open && stage === "discover";
  const workspaceQuery = useProjectWorkspaceContextQuery(discoveryActive);
  const providerQuery = useBackendProviderStatusQuery(discoveryActive);
  const connectionsLoading = providerQuery.isPending || workspaceQuery.isPending;
  const providersReady = providerQuery.data?.discoveryReady === true;
  const trimmedBrief = brief.trim();

  function onOpenChange(nextOpen: boolean) {
    if (!nextOpen && working) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      setStage("choice");
      setBrief("");
      setError("");
      setCreatedProjectId(null);
    }
  }

  function chooseIdeaPath() {
    setOpen(false);
    router.push("/projects/new");
  }

  async function startDiscovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmedBrief.length < 50) {
      setError("Paste at least 50 characters so the research has enough context.");
      return;
    }
    if (trimmedBrief.length > 5_000) {
      setError("Keep the hackathon brief under 5,000 characters.");
      return;
    }
    const workspaceTimeZone = workspaceQuery.data?.workspaceTimeZone;
    if (!workspaceTimeZone) {
      setError("The workspace timezone is unavailable. Retry after the workspace finishes loading.");
      return;
    }
    if (!providersReady) {
      setError("Configure AIand, Oxylabs, and OXYLABS_AUTHORIZATION_REFERENCE in the backend before starting live discovery.");
      return;
    }

    setWorking(true);
    setError("");
    setCreatedProjectId(null);
    try {
      const seed = buildHackathonDiscoverySeed(trimmedBrief);
      const created = await createProjectRequest({
        name: seed.projectName,
        slug: slugFor(seed.projectName),
        config: {
          marketLabel: seed.marketLabel,
          researchContext: seed.brief,
          researchMode: "live_reddit",
          sourceLabels: [seed.sourceLabel],
          redditWebScrape: {
            subreddit: "all",
            keywords: seed.sourceLabel.replace(/^search:/, ""),
            sort: "relevance",
            time: "year",
            agentCount: 4,
          },
          maxDocumentsPerRun: 100,
          maxCostMicrosPerRun: 12_000_000,
          workspaceTimeZone,
          hourlyResearchEnabled: false,
          fiveHourPolishEnabled: false,
        },
      });
      setCreatedProjectId(created.id);
      await startProjectResearchRequest({
        projectId: created.id,
        projectVersion: created.optimisticVersion ?? created.version ?? 0,
        budgetCeilingMicros: 12_000_000,
      });
      setOpen(false);
      router.push(`/projects/${created.id}/evidence`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Live discovery could not be started.");
      setWorking(false);
    }
  }

  return (
    <Dialog
      contentClassName="create-project-dialog"
      description={stage === "choice" ? "Choose how you want ReDDone to establish the first research boundary." : "Paste the event brief. ReDDone will collect public evidence through Oxylabs, use AIand to rank repeated problems, and propose focused solution directions."}
      onOpenChange={onOpenChange}
      open={open}
      title={stage === "choice" ? "How do you want to begin?" : "Discover what is worth building"}
      trigger={<Button className={className} icon="plus" kind={kind}>{children}</Button>}
    >
      {stage === "choice" ? (
        <div className="project-path-grid">
          <button className="project-path-choice" onClick={chooseIdeaPath} type="button">
            <span className="project-path-icon"><Icon name="projects" size={24} /></span>
            <span><small>Define</small><strong>I have an idea on what to build</strong><p>Name the market, describe the problem, and choose the evidence source yourself.</p></span>
            <Icon name="arrow-right" size={20} />
          </button>
          <button className="project-path-choice is-discovery" onClick={() => { setStage("discover"); setError(""); }} type="button">
            <span className="project-path-icon"><Icon name="spark" size={24} /></span>
            <span><small>Discover</small><strong>I don’t know what to build</strong><p>Paste the hackathon brief and let Reddit evidence reveal the strongest problems.</p></span>
            <Icon name="arrow-right" size={20} />
          </button>
        </div>
      ) : (
        <form className="hackathon-discovery-form" onSubmit={startDiscovery}>
          <button className="dialog-back-action" disabled={working} onClick={() => { setStage("choice"); setError(""); }} type="button"><Icon name="arrow-left" size={16} />Back to choices</button>
          <label className="hackathon-brief-field">
            <span>Hackathon brief or challenge contents</span>
            <textarea
              aria-describedby="hackathon-brief-help"
              aria-invalid={Boolean(error) || undefined}
              autoFocus
              disabled={working}
              maxLength={5_000}
              onChange={(event) => { setBrief(event.target.value); setError(""); }}
              placeholder="Paste the hackathon theme, judging criteria, required technology, constraints, and any notes…"
              rows={10}
              value={brief}
            />
            <small id="hackathon-brief-help"><span>The brief is treated as untrusted research context, never as executable instructions.</span><b>{brief.length.toLocaleString()} / 5,000</b></small>
          </label>

          <div className="discovery-pipeline" aria-label="Discovery steps">
            <span><Icon name="search" size={17} /><small>01</small><strong>Collect evidence</strong></span>
            <Icon name="arrow-right" size={15} />
            <span><Icon name="layers" size={17} /><small>02</small><strong>Rank problems</strong></span>
            <Icon name="arrow-right" size={15} />
            <span><Icon name="spark" size={17} /><small>03</small><strong>Propose solutions</strong></span>
          </div>

          {!connectionsLoading && !providersReady ? (
            <Alert title="Live discovery needs backend providers" tone="warning">
              Ask the operator to configure AIand, Oxylabs, and OXYLABS_AUTHORIZATION_REFERENCE on the server, then retry.
            </Alert>
          ) : null}
          {error ? <Alert title={createdProjectId ? "Project created; research did not start" : "Discovery could not start"} tone="danger">{error}{createdProjectId ? <> <Link href={`/projects/${createdProjectId}`}>Open the project</Link></> : null}</Alert> : null}

          <div className="hackathon-discovery-actions">
            <small>Uses 25 credits for one bounded research run. Building still requires approval.</small>
            <Button disabled={working || connectionsLoading || !providersReady || trimmedBrief.length < 50} icon={working ? "activity" : "search"} kind="primary" type="submit">
              {working ? "Starting discovery…" : connectionsLoading ? "Checking providers…" : "Find evidence-backed problems"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
