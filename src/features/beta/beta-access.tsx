"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { BrandMark } from "@/components/brand";
import { Icon } from "@/components/icons";
import styles from "./beta.module.css";

async function responseMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message || fallback;
  } catch {
    return fallback;
  }
}

export function BetaAccess() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [email, setEmail] = useState("");
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState("");
  const [joined, setJoined] = useState(false);

  async function redeemInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.trim().length < 12) {
      setInviteError("Enter the complete invite code.");
      return;
    }
    setInviteLoading(true);
    setInviteError("");
    try {
      const response = await fetch("/api/beta/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        setInviteError(await responseMessage(response, "This invite could not be accepted."));
        return;
      }
      router.push("/sign-up?access=ready");
    } catch {
      setInviteError("Unable to check the invite. Check your connection and try again.");
    } finally {
      setInviteLoading(false);
    }
  }

  async function joinWaitlist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!email.includes("@")) {
      setWaitlistError("Enter a valid email address.");
      return;
    }
    setWaitlistLoading(true);
    setWaitlistError("");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: email.trim(), source: "beta-page", website: String(data.get("website") || "") }),
      });
      if (!response.ok) {
        setWaitlistError(await responseMessage(response, "The waitlist could not be updated. Try again."));
        return;
      }
      setJoined(true);
      setEmail("");
    } catch {
      setWaitlistError("Unable to reach the waitlist. Check your connection and try again.");
    } finally {
      setWaitlistLoading(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.status}><span aria-hidden="true" /><strong>Private beta</strong><small>Access is opening in small groups</small></div>
          <p className={styles.kicker}>ReDDone is being wired for launch</p>
          <h1>Good software starts with the right problem.</h1>
          <p className={styles.lede}>The evidence-to-release workflow is in beta while the new data foundation is connected. Bring an invite to start now, or leave one email for an access update.</p>
          <div className={styles.signInNote}>Already have an account? <Link href="/sign-in">Sign in</Link></div>
        </div>

        <div className={styles.accessStack}>
          <form className={styles.inviteCard} id="invite" onSubmit={redeemInvite}>
            <div className={styles.cardHeader}>
              <span className={styles.cardIcon}><Icon name="key" size={20} /></span>
              <div><span>01 · Invited access</span><h2>Enter your invite code</h2></div>
            </div>
            <p>Your code unlocks account creation. It is redeemed only after the owner account is created.</p>
            <label><span>Invite code</span><div className={styles.fieldAction}><input aria-describedby={inviteError ? "invite-error" : "invite-help"} aria-invalid={Boolean(inviteError) || undefined} autoCapitalize="characters" autoComplete="off" autoFocus name="code" onChange={(event) => { setCode(event.target.value); setInviteError(""); }} placeholder="OWNER-XXXXXX-XXXXXX" spellCheck="false" type="password" value={code} /><button disabled={inviteLoading} type="submit">{inviteLoading ? "Checking…" : "Continue"}<Icon name="arrow-right" size={17} /></button></div></label>
            <small id="invite-help">Codes are single-use and time-limited.</small>
            {inviteError ? <div className={styles.error} id="invite-error" role="alert"><Icon name="warning" size={16} />{inviteError}</div> : null}
          </form>

          <form className={styles.waitlistCard} onSubmit={joinWaitlist}>
            <div className={styles.cardHeader}>
              <span className={styles.cardIcon}><Icon name={joined ? "check" : "clock"} size={20} /></span>
              <div><span>02 · No invite yet</span><h2>{joined ? "You’re on the list" : "Join the waitlist"}</h2></div>
            </div>
            {joined ? (
              <div className={styles.success} role="status"><strong>That’s all we need.</strong><p>We’ll email you when another beta group opens. No payment details, no extra profile.</p></div>
            ) : (
              <>
                <p>Leave one email. We’ll only use it for ReDDone beta access updates.</p>
                <label className={styles.honeypot} aria-hidden="true">Website<input autoComplete="off" name="website" tabIndex={-1} /></label>
                <label><span>Email address</span><div className={styles.fieldAction}><input aria-describedby={waitlistError ? "waitlist-error" : "waitlist-help"} aria-invalid={Boolean(waitlistError) || undefined} autoComplete="email" inputMode="email" name="email" onChange={(event) => { setEmail(event.target.value); setWaitlistError(""); }} placeholder="you@company.com" required type="email" value={email} /><button disabled={waitlistLoading} type="submit">{waitlistLoading ? "Joining…" : "Join waitlist"}</button></div></label>
                <small id="waitlist-help">One launch update list. Unsubscribe anytime.</small>
                {waitlistError ? <div className={styles.error} id="waitlist-error" role="alert"><Icon name="warning" size={16} />{waitlistError}</div> : null}
              </>
            )}
          </form>
        </div>
      </section>

      <section className={styles.buildNote} aria-label="Beta progress">
        <BrandMark size={42} />
        <div><span>What’s happening now</span><strong>Supabase integration and launch infrastructure are in progress.</strong></div>
        <p>Core product work continues behind the private-beta boundary. Billing and payment surfaces stay offline until they are ready for real use.</p>
      </section>
    </main>
  );
}
