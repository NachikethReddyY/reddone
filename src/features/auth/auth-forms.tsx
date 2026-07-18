"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import { Brand, BrandMark } from "@/components/brand";
import { Icon } from "@/components/icons";
import { Button, StatusBadge } from "@/components/ui";
import { safeReturnTo } from "@/policy/return-to";
import styles from "./auth.module.css";

function getPayloadError(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    if (typeof record.error === "object" && record.error !== null) {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
  }
  return fallback;
}

async function getApiError(response: Response, fallback: string) {
  try {
    return getPayloadError(await response.json(), fallback);
  } catch {
    // The fallback is intentionally user-safe when the response is not JSON.
    return fallback;
  }
}

const feedbackIds = {
  setup: "setup-form-feedback",
  signIn: "sign-in-form-feedback",
  signUp: "sign-up-form-feedback",
  forgotPassword: "forgot-password-form-feedback",
  resetPassword: "reset-password-form-feedback",
} as const;

type AuthView = "setup" | "sign-in" | "sign-up" | "recovery";

function AuthAside({ view }: { view: AuthView }) {
  const copy = {
    setup: ["Evidence in. Verified software out.", "Create the sole workspace owner, then connect only the providers you need. Every expensive or external action stays behind a human gate."],
    "sign-in": ["Return to the control plane.", "Your projects, provider boundary, approvals, and production releases are waiting in one controlled workspace."],
    "sign-up": ["Your invite opens the workspace.", "Create the owner account for this private-beta seat, then move from source evidence to a release decision you still own."],
    recovery: ["Recover access without weakening the boundary.", "Reset links expire, password resets revoke existing sessions, and the workspace remains limited to one owner."],
  } satisfies Record<AuthView, readonly [string, string]>;
  return (
    <aside className="auth-aside">
      <div className="auth-brand"><Brand /></div>
      <div className="auth-story">
        <span className="eyebrow">EVIDENCE TO SOFTWARE</span>
        <h2>{copy[view][0]}</h2>
        <p>{copy[view][1]}</p>
        <div className="auth-flow" aria-label="ReDDone workflow">
          <span><Icon name="search" size={18} /><small>Research</small></span><i /><span><Icon name="file" size={18} /><small>Specify</small></span><i /><span><Icon name="terminal" size={18} /><small>Verify</small></span><i /><span><Icon name="globe" size={18} /><small>Release</small></span>
        </div>
      </div>
      <div className="auth-assurance"><Icon name="shield" size={20} /><p><strong>Control stays visible.</strong><span>Provider secrets are write-only. Production never changes without an exact approval.</span></p></div>
    </aside>
  );
}

function AuthShell({ view, children }: { view: AuthView; children: ReactNode }) {
  return (
    <div className={`${styles.authScope} auth-layout`}>
      <AuthAside view={view} />
      <main className="auth-main">
        <Link className="auth-mobile-brand" href="/"><BrandMark size={42} /><strong>ReDDone</strong></Link>
        {children}
      </main>
    </div>
  );
}

function Feedback({ id, error, success }: { id?: string | undefined; error?: string | undefined; success?: string | undefined }) {
  return (
    <div aria-live="polite" aria-atomic="true">
      {error ? <div className="inline-error" id={id} role="alert"><Icon name="warning" size={17} />{error}</div> : null}
      {success ? <div className="inline-notice notice-success" role="status"><Icon name="check" size={17} />{success}</div> : null}
    </div>
  );
}

export function SetupForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [invalidFields, setInvalidFields] = useState<Array<"token" | "name" | "email" | "password">>([]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim().length < 32) { setInvalidFields(["token"]); setError("Enter the complete one-time setup token from the deployment output."); return; }
    if (name.trim().length < 2) { setInvalidFields(["name"]); setError("Enter the name to display for the workspace owner."); return; }
    if (!email.includes("@")) { setInvalidFields(["email"]); setError("Enter a valid owner email address."); return; }
    if (password.length < 12) { setInvalidFields(["password"]); setError("Use at least 12 characters for the owner password."); return; }
    setLoading(true);
    setError("");
    setInvalidFields([]);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `setup-${crypto.randomUUID()}` },
        credentials: "same-origin",
        body: JSON.stringify({ setupToken: token, name: name.trim(), email: email.trim(), password }),
      });
      if (!response.ok) {
        setError(await getApiError(response, "Unable to create the workspace owner. Verify the setup token and try again."));
        return;
      }
      router.replace("/sign-in?setup=complete");
      router.refresh();
    } catch {
      setError("Unable to reach the setup service. Check the deployment and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell view="setup">
      <form className="auth-form" onSubmit={submit}>
        <div className="auth-form-head"><span className="step-number">ONE-TIME SETUP</span><h1>Create the workspace owner.</h1><p>This route closes permanently after the first account is created. Public registration stays disabled.</p></div>
        <div className="setup-token-note"><Icon name="key" size={20} /><div><strong>Use the hashed setup token once.</strong><p>The token and owner account are consumed atomically, so concurrent attempts cannot create a second owner.</p></div></div>
        <label className="form-field"><span>One-time setup token</span><input aria-describedby={invalidFields.includes("token") ? feedbackIds.setup : undefined} aria-invalid={invalidFields.includes("token") || undefined} autoFocus autoComplete="off" placeholder="Paste token from deployment output" required type="password" value={token} onChange={(event) => { setToken(event.target.value); setError(""); setInvalidFields([]); }} /></label>
        <label className="form-field"><span>Owner name</span><input aria-describedby={invalidFields.includes("name") ? feedbackIds.setup : undefined} aria-invalid={invalidFields.includes("name") || undefined} autoComplete="name" placeholder="Name shown in the workspace" required value={name} onChange={(event) => { setName(event.target.value); setError(""); setInvalidFields([]); }} /></label>
        <label className="form-field"><span>Owner email</span><input aria-describedby={invalidFields.includes("email") ? feedbackIds.setup : undefined} aria-invalid={invalidFields.includes("email") || undefined} autoComplete="email" inputMode="email" placeholder="owner@company.com" required type="email" value={email} onChange={(event) => { setEmail(event.target.value); setError(""); setInvalidFields([]); }} /></label>
        <label className="form-field"><span>Password</span><span className="password-field"><input aria-describedby={invalidFields.includes("password") ? feedbackIds.setup : undefined} aria-invalid={invalidFields.includes("password") || undefined} autoComplete="new-password" placeholder="At least 12 characters" required type={showPassword ? "text" : "password"} value={password} onChange={(event) => { setPassword(event.target.value); setError(""); setInvalidFields([]); }} /><button aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)} type="button"><Icon name="eye" size={18} /></button></span><small>Use a unique password. Password managers and paste are supported.</small></label>
        <Feedback error={error} id={feedbackIds.setup} />
        <Button className="full-button" kind="primary" icon="shield" disabled={loading} type="submit">{loading ? "Creating owner…" : "Create private workspace"}</Button>
        <p className="auth-legal">By continuing, you confirm this deployment is private and you control the configured provider accounts.</p>
      </form>
    </AuthShell>
  );
}

export interface SignInFormProps {
  deploymentMode: "demo" | "private" | "hackathon" | "public";
  returnTo?: string;
  setupComplete?: boolean;
  resetComplete?: boolean;
  emailDeliveryAvailable?: boolean;
}

export function SignInForm({ deploymentMode, returnTo, setupComplete = false, resetComplete = false, emailDeliveryAvailable = false }: SignInFormProps) {
  const router = useRouter();
  const destination = safeReturnTo(returnTo);
  const hackathon = deploymentMode === "hackathon";
  const publicMode = deploymentMode === "public";
  const demoMode = deploymentMode === "demo";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [invalidFields, setInvalidFields] = useState<Array<"registrationCode" | "email" | "password">>([]);

  async function signInWithGitHub() {
    if (registrationCode.trim().length < 12) {
      setInvalidFields(["registrationCode"]);
      setError("Enter the complete hackathon registration code.");
      return;
    }
    setLoading(true);
    setError("");
    setInvalidFields([]);
    try {
      const admission = await fetch("/api/hackathon/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: registrationCode }),
      });
      if (!admission.ok) {
        setError(await getApiError(admission, "Registration is unavailable."));
        return;
      }
      const newUserDestination = `/onboarding?returnTo=${encodeURIComponent(destination)}`;
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ provider: "github", callbackURL: destination, newUserCallbackURL: newUserDestination, errorCallbackURL: `/sign-in?returnTo=${encodeURIComponent(destination)}`, disableRedirect: true }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const redirectUrl = typeof payload === "object" && payload !== null && typeof (payload as Record<string, unknown>).url === "string"
        ? (payload as { url: string }).url
        : undefined;
      if (!response.ok || !redirectUrl) {
        setError(getPayloadError(payload, "GitHub sign-in could not start."));
        return;
      }
      window.location.assign(redirectUrl);
    } catch {
      setError("Unable to start GitHub sign-in. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const rememberMe = data.get("rememberMe") === "on";
    const invalid: Array<"email" | "password"> = [];
    if (!email.includes("@")) invalid.push("email");
    if (password.length < 1) invalid.push("password");
    if (invalid.length > 0) {
      setInvalidFields(invalid);
      setError("Enter the owner email and password for this workspace.");
      return;
    }
    setLoading(true);
    setError("");
    setInvalidFields([]);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password, rememberMe, callbackURL: destination }),
      });
      if (!response.ok) {
        setError(await getApiError(response, "The owner email or password was not accepted."));
        return;
      }
      const payload = await response.json().catch(() => null) as { url?: string } | null;
      router.replace(safeReturnTo(payload?.url, destination));
      router.refresh();
    } catch {
      setError("Unable to reach the sign-in service. Check the deployment and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell view="sign-in">
      <form className="auth-form sign-in-form" onSubmit={hackathon ? (event) => { event.preventDefault(); void signInWithGitHub(); } : submit}>
        <div className="auth-form-head"><StatusBadge tone={hackathon ? "info" : "success"}>{hackathon ? "Hackathon access" : publicMode ? "Public workspace" : demoMode ? "Product demo" : "Private workspace online"}</StatusBadge><h1>{hackathon ? "Start with GitHub." : "Sign in to ReDDone."}</h1><p>{hackathon ? "Use your event code, then sign in with the GitHub account that will own your generated repository." : "One owner. One controlled path from evidence to production."}</p></div>
        <Feedback success={setupComplete ? "Workspace owner created. Sign in with the credentials you just set." : resetComplete ? "Password reset complete. Sign in with the new password." : undefined} />
        {hackathon ? <><label className="form-field"><span>Hackathon registration code</span><input aria-describedby={invalidFields.includes("registrationCode") ? feedbackIds.signIn : undefined} aria-invalid={invalidFields.includes("registrationCode") || undefined} autoFocus autoComplete="off" placeholder="Paste the event code" required type="password" value={registrationCode} onChange={(event) => { setRegistrationCode(event.target.value); setError(""); setInvalidFields([]); }} /></label><div className="session-note"><Icon name="branch" size={18} /><p>GitHub identity creates the isolated workspace. Connecting the ReDDone GitHub App later is a separate release authorization.</p></div></> : <><label className="form-field"><span>Owner email</span><input aria-describedby={invalidFields.includes("email") ? feedbackIds.signIn : undefined} aria-invalid={invalidFields.includes("email") || undefined} autoFocus autoComplete="email" inputMode="email" name="email" placeholder="owner@company.com" required type="email" onChange={() => { setError(""); setInvalidFields([]); }} /></label>
        <label className="form-field"><span>Password</span><input aria-describedby={invalidFields.includes("password") ? feedbackIds.signIn : undefined} aria-invalid={invalidFields.includes("password") || undefined} autoComplete="current-password" name="password" placeholder="Enter your password" required type="password" onChange={() => { setError(""); setInvalidFields([]); }} /></label>
        <div className="sign-in-options"><label><input name="rememberMe" type="checkbox" />Keep this browser signed in</label>{emailDeliveryAvailable ? <Link href={`/forgot-password?returnTo=${encodeURIComponent(destination)}`}>Forgot password?</Link> : null}</div></>}
        <Feedback error={error} id={feedbackIds.signIn} />
        {hackathon ? <Button className="full-button" kind="primary" icon="branch" disabled={loading} onClick={signInWithGitHub} type="button">{loading ? "Opening GitHub…" : "Continue with GitHub"}</Button> : <Button className="full-button" kind="primary" icon="arrow-right" disabled={loading} type="submit">{loading ? "Signing in…" : "Enter control plane"}</Button>}
        {publicMode ? <p className="auth-legal">New to ReDDone? <Link href="/beta">Request beta access</Link></p> : null}
        <div className="auth-divider"><span>Secure session</span></div>
        <div className="session-note"><Icon name="lock" size={18} /><p>{hackathon ? "Database-backed session · admission code required · isolated workspace" : publicMode ? "Verified email · one owner per workspace · database-backed session" : "Database-backed session · CSRF protected · public registration disabled"}</p></div>
        {demoMode ? <Link className="auth-demo-link" href={destination}>Open the populated UI demo <Icon name="arrow-right" size={15} /></Link> : null}
      </form>
    </AuthShell>
  );
}

export function SignUpForm({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const destination = safeReturnTo(returnTo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [invalidFields, setInvalidFields] = useState<Array<"name" | "email" | "password" | "passwordConfirmation">>([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const confirmation = String(data.get("passwordConfirmation") || "");
    if (name.length < 2) { setInvalidFields(["name"]); setError("Enter the name to show for the workspace owner."); return; }
    if (!email.includes("@")) { setInvalidFields(["email"]); setError("Enter a valid email address."); return; }
    if (password.length < 12) { setInvalidFields(["password"]); setError("Choose a password with at least 12 characters."); return; }
    if (password !== confirmation) { setInvalidFields(["passwordConfirmation"]); setError("The password confirmation does not match."); return; }
    setLoading(true); setError(""); setInvalidFields([]);
    try {
      const callbackURL = `/onboarding?returnTo=${encodeURIComponent(destination)}`;
      const ownerResponse = await fetch("/api/owner/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, email, password }),
      });
      if (!ownerResponse.ok) {
        setError(await getApiError(ownerResponse, "Your invite may have expired. Return to beta access and enter it again."));
        return;
      }
      const signInResponse = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password, rememberMe: true, callbackURL }),
      });
      if (!signInResponse.ok) {
        setError("Your workspace was created. Sign in with the email and password you just entered.");
        return;
      }
      const payload = await signInResponse.json().catch(() => null) as { url?: string } | null;
      form.reset();
      router.replace(safeReturnTo(payload?.url, callbackURL));
      router.refresh();
    } catch {
      setError("Unable to reach the signup service. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell view="sign-up">
      <form className="auth-form" onSubmit={submit}>
        <div className="auth-form-head"><StatusBadge tone="info">Invite accepted</StatusBadge><h1>Create your owner account.</h1><p>Your private-beta seat is ready. Finish the account before the invite session expires.</p></div>
        <label className="form-field"><span>Owner name</span><input aria-describedby={invalidFields.includes("name") ? feedbackIds.signUp : undefined} aria-invalid={invalidFields.includes("name") || undefined} autoFocus autoComplete="name" name="name" placeholder="Name shown in ReDDone" required onChange={() => { setError(""); setInvalidFields([]); }} /></label>
        <label className="form-field"><span>Email</span><input aria-describedby={invalidFields.includes("email") ? feedbackIds.signUp : undefined} aria-invalid={invalidFields.includes("email") || undefined} autoComplete="email" inputMode="email" name="email" placeholder="you@company.com" required type="email" onChange={() => { setError(""); setInvalidFields([]); }} /></label>
        <label className="form-field"><span>Password</span><input aria-describedby={invalidFields.includes("password") ? feedbackIds.signUp : undefined} aria-invalid={invalidFields.includes("password") || undefined} autoComplete="new-password" name="password" placeholder="At least 12 characters" required type="password" onChange={() => { setError(""); setInvalidFields([]); }} /><small>Password managers and paste are supported.</small></label>
        <label className="form-field"><span>Confirm password</span><input aria-describedby={invalidFields.includes("passwordConfirmation") ? feedbackIds.signUp : undefined} aria-invalid={invalidFields.includes("passwordConfirmation") || undefined} autoComplete="new-password" name="passwordConfirmation" placeholder="Repeat the password" required type="password" onChange={() => { setError(""); setInvalidFields([]); }} /></label>
        <Feedback error={error} id={feedbackIds.signUp} />
        <Button className="full-button" kind="primary" icon="arrow-right" disabled={loading} type="submit">{loading ? "Creating workspace…" : "Create workspace"}</Button>
        <p className="auth-legal"><Link href="/beta#invite">Use a different invite</Link> · Already have a workspace? <Link href={`/sign-in?returnTo=${encodeURIComponent(destination)}`}>Sign in</Link></p>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordForm({ returnTo }: { returnTo?: string }) {
  const destination = safeReturnTo(returnTo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") || "").trim();
    if (!email.includes("@")) { setEmailInvalid(true); setError("Enter the email address used by the workspace owner."); return; }
    setLoading(true); setError(""); setEmailInvalid(false);
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, redirectTo: `/reset-password?returnTo=${encodeURIComponent(destination)}` }),
      });
      if (!response.ok) {
        setError(await getApiError(response, "Unable to request a password reset right now."));
        return;
      }
      setSuccess("If that email belongs to a workspace, a reset link is on its way.");
    } catch {
      setError("Unable to reach the recovery service. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell view="recovery">
      <form className="auth-form sign-in-form" onSubmit={submit}>
        <div className="auth-form-head"><StatusBadge tone="neutral">Account recovery</StatusBadge><h1>Request a reset link.</h1><p>For privacy, the result is the same whether or not the email is registered.</p></div>
        <label className="form-field"><span>Owner email</span><input aria-describedby={emailInvalid ? feedbackIds.forgotPassword : undefined} aria-invalid={emailInvalid || undefined} autoFocus autoComplete="email" inputMode="email" name="email" placeholder="owner@company.com" required type="email" onChange={() => { setError(""); setEmailInvalid(false); }} /></label>
        <Feedback error={error} id={feedbackIds.forgotPassword} success={success} />
        <Button className="full-button" kind="primary" icon="arrow-right" disabled={loading || Boolean(success)} type="submit">{loading ? "Requesting link…" : success ? "Check your email" : "Send reset link"}</Button>
        <p className="auth-legal"><Link href={`/sign-in?returnTo=${encodeURIComponent(destination)}`}>Return to sign in</Link></p>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordForm({ token, errorCode, returnTo }: { token?: string | undefined; errorCode?: string | undefined; returnTo?: string | undefined }) {
  const router = useRouter();
  const destination = safeReturnTo(returnTo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(errorCode ? "This reset link is invalid or has expired. Request a new one." : "");
  const [invalidFields, setInvalidFields] = useState<Array<"password" | "passwordConfirmation">>([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) { setError("This reset link is invalid or has expired. Request a new one."); return; }
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") || "");
    const confirmation = String(data.get("passwordConfirmation") || "");
    if (password.length < 12) { setInvalidFields(["password"]); setError("Choose a password with at least 12 characters."); return; }
    if (password !== confirmation) { setInvalidFields(["passwordConfirmation"]); setError("The password confirmation does not match."); return; }
    setLoading(true); setError(""); setInvalidFields([]);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token, newPassword: password }),
      });
      if (!response.ok) {
        setError(await getApiError(response, "Unable to reset the password. The link may have expired."));
        return;
      }
      router.replace(`/sign-in?reset=complete&returnTo=${encodeURIComponent(destination)}`);
      router.refresh();
    } catch {
      setError("Unable to reach the recovery service. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell view="recovery">
      <form className="auth-form sign-in-form" onSubmit={submit}>
        <div className="auth-form-head"><StatusBadge tone={errorCode ? "danger" : "info"}>Secure reset</StatusBadge><h1>Choose a new password.</h1><p>The reset token is single-use. Completing this step revokes existing sessions.</p></div>
        <label className="form-field"><span>New password</span><input aria-describedby={invalidFields.includes("password") ? feedbackIds.resetPassword : undefined} aria-invalid={invalidFields.includes("password") || undefined} autoFocus autoComplete="new-password" disabled={!token || Boolean(errorCode)} name="password" placeholder="At least 12 characters" required type="password" onChange={() => { setError(""); setInvalidFields([]); }} /></label>
        <label className="form-field"><span>Confirm new password</span><input aria-describedby={invalidFields.includes("passwordConfirmation") ? feedbackIds.resetPassword : undefined} aria-invalid={invalidFields.includes("passwordConfirmation") || undefined} autoComplete="new-password" disabled={!token || Boolean(errorCode)} name="passwordConfirmation" placeholder="Repeat the password" required type="password" onChange={() => { setError(""); setInvalidFields([]); }} /></label>
        <Feedback error={error} id={feedbackIds.resetPassword} />
        <Button className="full-button" kind="primary" icon="shield" disabled={loading || !token || Boolean(errorCode)} type="submit">{loading ? "Resetting password…" : "Reset password"}</Button>
        <p className="auth-legal">Need another link? <Link href={`/forgot-password?returnTo=${encodeURIComponent(destination)}`}>Request a new reset</Link></p>
      </form>
    </AuthShell>
  );
}
