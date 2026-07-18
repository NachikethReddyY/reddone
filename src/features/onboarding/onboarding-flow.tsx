"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { BrandMark } from "@/components/brand";
import { Icon } from "@/components/icons";
import { ThemeToggle } from "@/components/theme-provider";
import { Alert, Button, PageState } from "@/components/ui";
import { AccountProfileResponseSchema, type AccountProfile } from "@/contracts/account";
import { safeReturnTo } from "@/policy/return-to";
import styles from "./onboarding.module.css";

async function message(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function OnboardingFlow({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const destination = safeReturnTo(returnTo);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/v1/account", { credentials: "same-origin", headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(await message(response, "Unable to load the workspace."));
        setProfile(AccountProfileResponseSchema.parse(await response.json()).data);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to load the workspace.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const workspaceName = String(data.get("workspaceName") || "").trim();
    const timeZone = String(data.get("timeZone") || "").trim();
    if (workspaceName.length < 2) { setError("Enter a workspace name with at least two characters."); return; }
    if (!timeZone) { setError("Enter the time zone used for schedules and account dates."); return; }
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/account", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": `onboarding-${crypto.randomUUID()}` },
        body: JSON.stringify({ workspaceName, timeZone }),
      });
      if (!response.ok) throw new Error(await message(response, "Unable to save the workspace."));
      router.replace(destination);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the workspace.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className={styles.state}><PageState kind="loading" title="Preparing the workspace" description="Loading the owner identity and workspace defaults." /></div>;
  if (!profile) return <div className={styles.state}><PageState action={<Link className="button button-secondary" href="/sign-in">Return to sign in</Link>} kind="error" title="Workspace unavailable" description={error || "Sign in again to continue."} /></div>;

  return (
    <main className={styles.page}>
      <header className={styles.header}><Link href="/" aria-label="ReDDone home"><BrandMark size={40} /><strong>ReDDone</strong></Link><ThemeToggle compact /></header>
      <div className={styles.content}>
        <section className={styles.intro}>
          <p>Workspace ready</p>
          <h1>Name the place where evidence becomes software.</h1>
          <span>Reasonable defaults are already applied. Confirm the workspace identity and time zone, then start with the real product workflow.</span>
          <ol>
            <li><Icon name="search" size={20} /><div><strong>Bring evidence</strong><span>Authorized sources and excerpts remain attached to ranked problems.</span></div></li>
            <li><Icon name="approval" size={20} /><div><strong>Approve boundaries</strong><span>Specifications and releases stay behind explicit owner decisions.</span></div></li>
            <li><Icon name="terminal" size={20} /><div><strong>Verify in isolation</strong><span>Kimi builds in Daytona; a clean environment verifies the artifact.</span></div></li>
          </ol>
        </section>
        <form className={styles.form} onSubmit={submit}>
          <div><span>OWNER WORKSPACE</span><h2>Confirm the operating context.</h2><p>One owner remains linked to this workspace. Teams and invitations are not part of this flow.</p></div>
          <label><span>Owner</span><input defaultValue={profile.user.name} readOnly /></label>
          <label><span>Workspace name</span><input autoFocus defaultValue={profile.workspace.name} name="workspaceName" required /></label>
          <label><span>Time zone</span><input defaultValue={profile.workspace.timeZone} name="timeZone" placeholder="Asia/Singapore" required /><small>Use an IANA time zone. Schedules and account dates use this value.</small></label>
          {error ? <Alert tone="danger" title="Unable to continue">{error}</Alert> : null}
          <Button className="full-button" kind="primary" icon="arrow-right" disabled={saving} type="submit">{saving ? "Saving workspace…" : "Continue to ReDDone"}</Button>
          <Link className={styles.skip} href={destination}>Skip for now</Link>
        </form>
      </div>
    </main>
  );
}
