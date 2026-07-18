"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { AccountAvatar } from "@/components/account-avatar";
import {
  AccountProfileResponseSchema,
  AccountSessionListResponseSchema,
  type AccountProfile,
  type AccountSession,
} from "@/contracts/account";
import { ThemeToggle } from "@/components/theme-provider";
import { Alert, Button, PageState, SectionHeading, Surface } from "@/components/ui";
import { signOutOwnerSession } from "@/features/auth/sign-out";
import { compressAvatarFile } from "./avatar-image";
import styles from "./account.module.css";

async function responseMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: { message?: string }; message?: string };
    return body.error?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

function mutationHeaders() {
  return {
    "content-type": "application/json",
    "idempotency-key": `account-${crypto.randomUUID()}`,
  };
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AccountPanel() {
  const queryClient = useQueryClient();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const acceptProfileResponse = useCallback((payload: ReturnType<typeof AccountProfileResponseSchema.parse>) => {
    setProfile(payload.data);
    queryClient.setQueryData(["shell", "account"], payload);
  }, [queryClient]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [profileResponse, sessionResponse] = await Promise.all([
        fetch("/api/v1/account", { credentials: "same-origin", headers: { accept: "application/json" } }),
        fetch("/api/v1/account/sessions", { credentials: "same-origin", headers: { accept: "application/json" } }),
      ]);
      if (!profileResponse.ok) throw new Error(await responseMessage(profileResponse, "Unable to load account details."));
      acceptProfileResponse(AccountProfileResponseSchema.parse(await profileResponse.json()));
      if (!sessionResponse.ok) {
        setSessions([]);
        setError(await responseMessage(sessionResponse, "Sign in again to review active sessions."));
      } else {
        setSessions(AccountSessionListResponseSchema.parse(await sessionResponse.json()).data.items);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load the account.");
    } finally {
      setLoading(false);
    }
  }, [acceptProfileResponse]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    const data = new FormData(event.currentTarget);
    const body = {
      name: String(data.get("name") || "").trim(),
      workspaceName: String(data.get("workspaceName") || "").trim(),
      timeZone: String(data.get("timeZone") || "").trim(),
    };
    setBusy("profile"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/account", { method: "PATCH", credentials: "same-origin", headers: mutationHeaders(), body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await responseMessage(response, "Unable to save account changes."));
      acceptProfileResponse(AccountProfileResponseSchema.parse(await response.json()));
      setNotice("Profile and workspace settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save account changes.");
    } finally {
      setBusy("");
    }
  }

  async function updateAvatar(image: string | null) {
    setBusy("avatar"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/account/avatar", {
        method: "PUT",
        credentials: "same-origin",
        headers: mutationHeaders(),
        body: JSON.stringify({ image }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "Unable to save the profile image."));
      acceptProfileResponse(AccountProfileResponseSchema.parse(await response.json()));
      setNotice(image ? "Profile image compressed and saved." : "Profile image removed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the profile image.");
    } finally {
      setBusy("");
    }
  }

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setBusy("avatar"); setError(""); setNotice("");
    try {
      await updateAvatar(await compressAvatarFile(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the profile image.");
      setBusy("");
    } finally {
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  async function revokeSession(sessionId: string) {
    setBusy(sessionId); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/v1/account/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "same-origin", headers: mutationHeaders() });
      if (!response.ok) throw new Error(await responseMessage(response, "Unable to revoke the session."));
      setSessions((items) => items.filter((session) => session.id !== sessionId));
      setNotice("Session revoked.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke the session.");
    } finally {
      setBusy("");
    }
  }

  async function revokeOthers() {
    setBusy("others"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/account/sessions/revoke-others", { method: "POST", credentials: "same-origin", headers: mutationHeaders(), body: "{}" });
      if (!response.ok) throw new Error(await responseMessage(response, "Unable to revoke other sessions."));
      setSessions((items) => items.filter((session) => session.current));
      setNotice("Other sessions revoked. This browser remains signed in.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke other sessions.");
    } finally {
      setBusy("");
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") || "");
    const newPassword = String(data.get("newPassword") || "");
    const confirmation = String(data.get("passwordConfirmation") || "");
    if (newPassword.length < 12) { setError("Choose a new password with at least 12 characters."); return; }
    if (newPassword !== confirmation) { setError("The new password confirmation does not match."); return; }
    setBusy("password"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/account/password", { method: "POST", credentials: "same-origin", headers: mutationHeaders(), body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }) });
      if (!response.ok) throw new Error(await responseMessage(response, "Unable to change the password."));
      form.reset();
      setNotice("Password changed. Older sessions were revoked.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the password.");
    } finally {
      setBusy("");
    }
  }

  async function signOut() {
    setBusy("sign-out"); setError("");
    try {
      await signOutOwnerSession();
      window.location.assign("/sign-in");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign out.");
      setBusy("");
    }
  }

  if (loading && !profile) return <PageState kind="loading" title="Loading account" description="Retrieving the owner profile, workspace, and active sessions." />;
  if (error && !profile) return <PageState action={<Button kind="secondary" onClick={() => void load()}>Try again</Button>} kind="error" title="Account unavailable" description={error} />;
  if (!profile) return null;

  const otherSessions = sessions.filter((session) => !session.current);
  return (
    <div className={styles.stack}>
      <div aria-live="polite" className={styles.feedback}>{error ? <Alert tone="danger" title="Unable to complete the action">{error}</Alert> : null}{notice ? <Alert tone="success">{notice}</Alert> : null}</div>

      <Surface className={styles.section}>
        <SectionHeading eyebrow="Owner and workspace" title="Account details" description="These names appear throughout the control plane. The email address remains the verified sign-in identity." />
        <div className={styles.profileIdentity}>
          <AccountAvatar className={styles.profileAvatar} image={profile.user.image} name={profile.user.name} size={76} />
          <div><strong>{profile.user.name}</strong><span>{profile.user.email}</span><small id="profile-image-help">JPEG, PNG, or WebP. Compressed to a private 256×256 WebP before database storage.</small></div>
          <div className={styles.avatarActions}>
            <label className={`${styles.avatarButton} ${busy === "avatar" ? styles.isDisabled : ""}`}>
              <input
                accept="image/jpeg,image/png,image/webp"
                aria-describedby="profile-image-help"
                disabled={busy === "avatar"}
                onChange={(event) => void chooseAvatar(event)}
                ref={avatarInputRef}
                type="file"
              />
              {busy === "avatar" ? "Processing…" : profile.user.image ? "Change image" : "Add image"}
            </label>
            {profile.user.image ? <Button disabled={busy === "avatar"} kind="ghost" onClick={() => void updateAvatar(null)} type="button">Remove</Button> : null}
          </div>
        </div>
        <form className={styles.form} onSubmit={updateProfile}>
          <label><span>Owner name</span><input defaultValue={profile.user.name} name="name" required /></label>
          <label><span>Verified email</span><input defaultValue={profile.user.email} readOnly type="email" /><small>{profile.user.emailVerified ? "Verified" : "Verification pending"}</small></label>
          <label><span>Workspace name</span><input defaultValue={profile.workspace.name} name="workspaceName" required /></label>
          <label><span>Workspace time zone</span><input defaultValue={profile.workspace.timeZone} name="timeZone" placeholder="Asia/Singapore" required /><small>Use an IANA time zone such as America/New_York.</small></label>
          <div className={styles.formAction}><Button kind="primary" disabled={busy === "profile"} type="submit">{busy === "profile" ? "Saving…" : "Save changes"}</Button></div>
        </form>
      </Surface>

      <Surface className={styles.section}>
        <SectionHeading eyebrow="Appearance" title="Theme" description="Use the system setting or keep a light or dark preference on this browser." />
        <div className={styles.themeRow}><ThemeToggle /><p>The preference is stored locally and in a cookie to prevent a theme flash on the next visit.</p></div>
      </Surface>

      <Surface className={styles.section}>
        <SectionHeading eyebrow="Security" title="Active sessions" description="IP addresses are masked. Session tokens are never returned by this API." action={otherSessions.length ? <Button kind="secondary" disabled={busy === "others"} onClick={() => void revokeOthers()}>{busy === "others" ? "Revoking…" : "Revoke other sessions"}</Button> : undefined} />
        <div className={styles.sessionList}>
          {sessions.map((session) => <article className={styles.session} key={session.id}>
            <div className={styles.sessionTop}><div><strong>{session.current ? "Current session" : "Signed-in browser"}</strong>{session.current ? <span>Current</span> : null}</div>{!session.current ? <Button kind="ghost" disabled={busy === session.id} onClick={() => void revokeSession(session.id)}>{busy === session.id ? "Revoking…" : "Revoke"}</Button> : null}</div>
            <p>{session.userAgent || "User agent unavailable"}</p>
            <dl><div><dt>Masked IP</dt><dd>{session.ipAddress || "Unavailable"}</dd></div><div><dt>Last active</dt><dd>{formatDate(session.updatedAt)}</dd></div><div><dt>Expires</dt><dd>{formatDate(session.expiresAt)}</dd></div></dl>
          </article>)}
          {!sessions.length ? <p className={styles.empty}>No active sessions were returned. Refresh the page or sign in again.</p> : null}
        </div>
      </Surface>

      {profile.capabilities.canChangePassword ? <Surface className={styles.section}>
        <SectionHeading eyebrow="Credential" title="Change password" description="Changing the password replaces the current credential and revokes older sessions." />
        <form className={styles.form} onSubmit={changePassword}>
          <label><span>Current password</span><input autoComplete="current-password" name="currentPassword" required type="password" /></label>
          <label><span>New password</span><input autoComplete="new-password" minLength={12} name="newPassword" required type="password" /><small>Use at least 12 characters.</small></label>
          <label><span>Confirm new password</span><input autoComplete="new-password" minLength={12} name="passwordConfirmation" required type="password" /></label>
          <div className={styles.formAction}><Button kind="primary" disabled={busy === "password"} type="submit">{busy === "password" ? "Changing…" : "Change password"}</Button></div>
        </form>
      </Surface> : <Surface className={styles.section}><SectionHeading eyebrow="Credential" title="Password unavailable" description="This workspace uses an external identity provider, so there is no ReDDone password to change." /></Surface>}

      <Surface className={`${styles.section} ${styles.signOut}`}>
        <div><h2>Sign out of this browser</h2><p>The other active sessions listed above are not affected.</p></div>
        <Button kind="secondary" disabled={busy === "sign-out"} onClick={() => void signOut()}>{busy === "sign-out" ? "Signing out…" : "Sign out"}</Button>
      </Surface>
    </div>
  );
}
