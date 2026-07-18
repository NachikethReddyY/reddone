"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { Button, StatusBadge, Surface } from "@/components/ui";
import { schedules } from "@/demo-data/control-plane";

type ProjectOption = { id: string; name: string; optimisticVersion?: number; version?: number };
type ScheduleRecord = {
  enabled: boolean;
  version: number;
  status: string;
  timeZone: string;
  nextRunAt: string | null;
  lastEnqueuedAt: string | null;
  lastCompletedAt: string | null;
  backoffUntil: string | null;
  consecutiveFailures: number;
};

function scheduleTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

function timeZoneOffset(timeZone: string) {
  const part = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(new Date())
    .find((item) => item.type === "timeZoneName")?.value;
  return part ?? "UTC";
}

export function SchedulesPanel() {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(schedules.map((schedule) => [schedule.id, schedule.enabled])));
  const [notice, setNotice] = useState("Schedule times are stored in UTC and shown here in Asia/Singapore.");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState("");
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [records, setRecords] = useState<Record<string, ScheduleRecord>>({});
  const [working, setWorking] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/v1/projects", { headers: { accept: "application/json" } })
      .then((response) => response.json())
      .then((body: { data?: { items?: ProjectOption[] } }) => {
        if (!active) return;
        const items = body.data?.items ?? [];
        setProjects(items);
        setProjectId((current) => current || items[0]?.id || "");
      })
      .catch(() => setNotice("Project schedules could not be loaded."));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    Promise.all(schedules.map(async (schedule) => {
      const kind = schedule.id.includes("research") ? "hourly_research" : "five_hour_polish";
      const response = await fetch(`/api/v1/projects/${projectId}/schedules/${kind}`, { headers: { accept: "application/json" } });
      const body = await response.json() as {
        data?: {
          enabled?: boolean;
          status?: string;
          optimisticVersion?: number;
          timeZone?: string;
          nextRunAt?: string | null;
          lastEnqueuedAt?: string | null;
          lastCompletedAt?: string | null;
          backoffUntil?: string | null;
          consecutiveFailures?: number;
        };
        error?: { message?: string };
      };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Schedule unavailable.");
      return {
        id: schedule.id,
        enabled: body.data.enabled ?? body.data.status?.toUpperCase() !== "PAUSED",
        version: body.data.optimisticVersion ?? 0,
        status: body.data.status ?? "paused",
        timeZone: body.data.timeZone ?? "Asia/Singapore",
        nextRunAt: body.data.nextRunAt ?? null,
        lastEnqueuedAt: body.data.lastEnqueuedAt ?? null,
        lastCompletedAt: body.data.lastCompletedAt ?? null,
        backoffUntil: body.data.backoffUntil ?? null,
        consecutiveFailures: body.data.consecutiveFailures ?? 0,
      };
    }))
      .then((items) => {
        if (!active) return;
        setEnabled(Object.fromEntries(items.map((item) => [item.id, item.enabled])));
        setVersions(Object.fromEntries(items.map((item) => [item.id, item.version])));
        setRecords(Object.fromEntries(items.map((item) => [item.id, item])));
      })
      .catch((error: unknown) => { if (active) setNotice(error instanceof Error ? error.message : "Schedules unavailable."); });
    return () => { active = false; };
  }, [projectId]);

  async function toggle(id: string) {
    if (!projectId) return;
    const next = !enabled[id];
    const kind = id.includes("research") ? "hourly_research" : "five_hour_polish";
    const version = versions[id] ?? 0;
    setWorking(id);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/schedules/${kind}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": `schedule-${crypto.randomUUID()}`, "if-match": String(version) },
        body: JSON.stringify({ enabled: next, optimisticVersion: version }),
      });
      const body = await response.json().catch(() => null) as {
        data?: {
          status?: string;
          optimisticVersion?: number;
          timeZone?: string;
          nextRunAt?: string | null;
          lastEnqueuedAt?: string | null;
          lastCompletedAt?: string | null;
          backoffUntil?: string | null;
          consecutiveFailures?: number;
        };
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "The schedule could not be updated.");
      setEnabled((current) => ({ ...current, [id]: next }));
      const nextVersion = body?.data?.optimisticVersion ?? version + 1;
      setVersions((current) => ({ ...current, [id]: nextVersion }));
      setRecords((current) => ({
        ...current,
        [id]: {
          enabled: next,
          version: nextVersion,
          status: body?.data?.status?.toLowerCase() ?? (next ? "enabled" : "paused"),
          timeZone: body?.data?.timeZone ?? current[id]?.timeZone ?? "Asia/Singapore",
          nextRunAt: body?.data?.nextRunAt ?? null,
          lastEnqueuedAt: body?.data?.lastEnqueuedAt ?? current[id]?.lastEnqueuedAt ?? null,
          lastCompletedAt: body?.data?.lastCompletedAt ?? current[id]?.lastCompletedAt ?? null,
          backoffUntil: body?.data?.backoffUntil ?? null,
          consecutiveFailures: body?.data?.consecutiveFailures ?? 0,
        },
      }));
      setNotice(next ? "Schedule enabled. A missed window coalesces into one run." : "Schedule paused. Active work continues safely; future runs will not start.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The schedule could not be updated.");
    } finally {
      setWorking("");
    }
  }

  async function runNow(id: string, name: string) {
    if (!projectId) return;
    const kind = id.includes("research") ? "research" : "polish";
    setWorking(id);
    try {
      const projectResponse = await fetch(`/api/v1/projects/${projectId}`, { headers: { accept: "application/json" } });
      const projectBody = await projectResponse.json() as { data?: { currentSpecVersionId?: string | null; spec?: { id?: string } | null; config?: { maxCostMicrosPerRun?: number }; optimisticVersion?: number; version?: number }; error?: { message?: string } };
      if (!projectResponse.ok || !projectBody.data) throw new Error(projectBody.error?.message ?? "Project unavailable.");
      const specVersionId = projectBody.data.currentSpecVersionId ?? projectBody.data.spec?.id;
      const configuredCeiling = projectBody.data.config?.maxCostMicrosPerRun;
      if (!configuredCeiling || configuredCeiling < 1) throw new Error("Set a positive project cost ceiling before queuing scheduled work.");
      const response = await fetch(`/api/v1/projects/${projectId}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `manual-${kind}-${crypto.randomUUID()}`,
          "if-match": String(projectBody.data.optimisticVersion ?? projectBody.data.version ?? 0),
        },
        body: JSON.stringify({ kind, ...(kind === "polish" && specVersionId ? { specVersionId } : {}), budgetCeilingMicros: Math.min(kind === "research" ? 5_000_000 : 7_500_000, configuredCeiling) }),
      });
      const body = await response.json().catch(() => null) as { data?: { id?: string; status?: string }; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "The run could not be queued.");
      setNotice(`${name} run ${body?.data?.id?.slice(0, 12) ?? "created"} is ${body?.data?.status ?? "queued"}. Duplicate requests cannot duplicate spend.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The run could not be queued.");
    } finally {
      setWorking("");
    }
  }

  const firstScheduleId = schedules[0]?.id;
  const selectedRecord = (firstScheduleId ? records[firstScheduleId] : undefined) ?? Object.values(records)[0];
  const workspaceTimeZone = selectedRecord?.timeZone ?? "Asia/Singapore";

  return (
    <div className="content-stack">
      <div className="timezone-bar">
        <div><Icon name="globe" size={18} /><span><small>Workspace timezone</small><strong>{workspaceTimeZone.replaceAll("_", " ")} · {timeZoneOffset(workspaceTimeZone)}</strong></span></div>
        <p>Project <strong>{projects.find((project) => project.id === projectId)?.name ?? "Loading…"}</strong></p>
        <label className="select-field compact-select"><span className="sr-only">Choose project</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select><Icon name="chevron-down" size={15} /></label>
      </div>
      <div className="inline-notice" aria-live="polite"><Icon name="clock" size={17} /><span>{notice}</span></div>

      <div className="schedule-grid">
        {schedules.map((schedule) => {
          const on = enabled[schedule.id];
          const busy = working === schedule.id;
          const record = records[schedule.id];
          const backingOff = record?.status === "backing_off";
          return <Surface className={`schedule-card ${on ? "is-enabled" : "is-paused"}`} key={schedule.id}>
            <div className="schedule-card-head"><span className="schedule-icon"><Icon name={schedule.id.includes("research") ? "search" : "spark"} size={23} /></span><label className="switch-only"><span className="sr-only">{on ? "Disable" : "Enable"} {schedule.name}</span><input checked={on} disabled={busy || !projectId} onChange={() => toggle(schedule.id)} role="switch" type="checkbox" /><i><b /></i></label></div>
            <div><StatusBadge tone={backingOff ? "warning" : on ? "success" : "neutral"}>{backingOff ? "Backing off" : on ? "Enabled" : "Paused"}</StatusBadge><h2>{schedule.name}</h2><p>{schedule.description}</p></div>
            <dl><div><dt>Cadence</dt><dd>{schedule.cadence}</dd></div><div><dt>Next run</dt><dd>{on ? scheduleTime(record?.backoffUntil ?? record?.nextRunAt, workspaceTimeZone) : "Paused"}</dd></div><div><dt>Last outcome</dt><dd>{record?.lastCompletedAt ? scheduleTime(record.lastCompletedAt, workspaceTimeZone) : "No completed run"}{record?.consecutiveFailures ? ` · ${record.consecutiveFailures} failed attempt${record.consecutiveFailures === 1 ? "" : "s"}` : ""}</dd></div></dl>
            <div className="schedule-card-footer"><span><Icon name="shield" size={16} />{schedule.id.includes("polish") ? "Proposal only; release approval required" : "Evidence only; no product changes"}</span><Button disabled={busy || !projectId} icon="play" onClick={() => runNow(schedule.id, schedule.name)}>{busy ? "Queuing…" : "Run now"}</Button></div>
          </Surface>;
        })}
      </div>

      <div className="schedule-policy-grid">
        <Surface><span><Icon name="layers" size={20} /></span><div><strong>Missed windows coalesce</strong><p>Downtime produces one due run, never a catch-up storm.</p></div></Surface>
        <Surface><span><Icon name="lock" size={20} /></span><div><strong>Leases prevent overlap</strong><p>A project never starts a second research or polish run while one is active.</p></div></Surface>
        <Surface><span><Icon name="warning" size={20} /></span><div><strong>Failures back off</strong><p>Provider errors delay the next attempt and surface a clear recovery action.</p></div></Surface>
      </div>
    </div>
  );
}
