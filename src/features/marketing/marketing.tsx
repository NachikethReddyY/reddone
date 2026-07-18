import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/brand";
import { Icon } from "@/components/icons";
import { ThemeToggle } from "@/components/theme-provider";
import type { getDeploymentMode } from "@/server/env";
import styles from "./marketing.module.css";

type DeploymentMode = ReturnType<typeof getDeploymentMode>;

const workflow = [
  {
    index: "01",
    title: "Collect evidence",
    description: "Import authorized research or run a bounded research pass. Source excerpts remain attached to each ranked problem.",
    icon: "search" as const,
  },
  {
    index: "02",
    title: "Choose the problem",
    description: "Compare frequency, severity, willingness to pay, and feasibility before committing provider work.",
    icon: "layers" as const,
  },
  {
    index: "03",
    title: "Approve the ProductSpec",
    description: "Edit the generated specification, inspect its exact hash, and approve the boundary the builder must follow.",
    icon: "file" as const,
  },
  {
    index: "04",
    title: "Build and verify in isolation",
    description: "Kimi writes inside a disposable Daytona sandbox. A clean verifier checks the resulting artifact separately.",
    icon: "terminal" as const,
  },
  {
    index: "05",
    title: "Release with owner approval",
    description: "Review the signed artifact, changed files, actual tokens, provider cost, and release target before production changes.",
    icon: "globe" as const,
  },
];

export function deploymentCta(mode: DeploymentMode) {
  switch (mode) {
    case "public":
      return { href: "/beta", label: "Join the private beta", detail: "Invite access or waitlist" };
    case "hackathon":
      return { href: "/sign-in", label: "Enter the hackathon", detail: "Event code and GitHub required" };
    case "private":
      return { href: "/sign-in", label: "Sign in", detail: "Private registration stays closed" };
    case "demo":
      return { href: "/projects", label: "Open the product demo", detail: "Explore populated workflows" };
  }
}

function Header({ mode }: { mode: DeploymentMode }) {
  const cta = deploymentCta(mode);
  return (
    <header className={styles.header}>
      <Link className={styles.wordmark} href="/" aria-label="ReDDone home">
        <BrandMark size={38} />
        <span><strong>ReDDone</strong><small>Evidence to software</small></span>
      </Link>
      <nav aria-label="Marketing navigation" className={styles.nav}>
        <Link className={styles.inviteLink} href="/beta#invite">Have an invite?</Link>
        <Link href="/#workflow">Workflow</Link>
        <Link href="/#safety">Safety</Link>
      </nav>
      <div className={styles.headerActions}>
        <ThemeToggle compact />
        {cta.href !== "/sign-in" ? <Link className={styles.signInLink} href="/sign-in">Sign in</Link> : null}
        <Link className={styles.headerCta} href={cta.href}>{cta.label}</Link>
      </div>
    </header>
  );
}

function Footer({ mode }: { mode: DeploymentMode }) {
  const cta = deploymentCta(mode);
  return (
    <footer className={styles.footer}>
      <div><BrandMark size={32} /><p><strong>ReDDone</strong><span>Evidence-backed product work with an owner-controlled release boundary.</span></p></div>
      <nav aria-label="Footer navigation">
        <Link href="/beta#invite">Redeem invite</Link>
        {cta.href !== "/sign-in" ? <Link href="/sign-in">Sign in</Link> : null}
        <Link href={cta.href}>{cta.label}</Link>
      </nav>
    </footer>
  );
}

export function MarketingFrame({ mode, children }: { mode: DeploymentMode; children: ReactNode }) {
  return <div className={styles.site}><Header mode={mode} />{children}<Footer mode={mode} /></div>;
}

function ArtifactNarrative() {
  return (
    <div className={styles.artifactBoard} aria-label="ReDDone artifact workflow">
      <article className={styles.evidenceArtifact}>
        <div className={styles.artifactMeta}><span>Evidence / 14 excerpts</span><Icon name="search" size={17} /></div>
        <blockquote>“The invoice says overdue, but the real story is buried across messages and a phone call.”</blockquote>
        <p>Ranked problem <strong>8.7 / 10</strong></p>
      </article>
      <article className={styles.specArtifact}>
        <div className={styles.artifactMeta}><span>ProductSpec / owner approved</span><Icon name="file" size={17} /></div>
        <dl><div><dt>Outcome</dt><dd>One reliable collection view</dd></div><div><dt>Boundary</dt><dd>No automatic customer contact</dd></div><div><dt>Hash</dt><dd className={styles.mono}>9d4c…71ae</dd></div></dl>
      </article>
      <article className={styles.releaseArtifact}>
        <div className={styles.artifactMeta}><span>Verified artifact</span><Icon name="shield" size={17} /></div>
        <div className={styles.releaseLine}><Icon name="check" size={16} /><span>Clean Daytona verification</span></div>
        <div className={styles.releaseLine}><Icon name="activity" size={16} /><span>Actual Kimi usage attached</span></div>
        <div className={styles.releaseLine}><Icon name="lock" size={16} /><span>Release awaits owner approval</span></div>
      </article>
    </div>
  );
}

export function HomeMarketing({ mode }: { mode: DeploymentMode }) {
  const cta = deploymentCta(mode);
  return (
    <MarketingFrame mode={mode}>
      <main>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Evidence in. Verified software out.</p>
            <h1>Build the right product without surrendering the release decision.</h1>
            <p className={styles.lede}>ReDDone turns source evidence into a ranked problem, an owner-approved ProductSpec, an isolated Kimi build, a clean verification result, and one explicit production decision.</p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryCta} href={cta.href}>{cta.label}<Icon name="arrow-right" size={18} /></Link>
              <Link className={styles.secondaryCta} href="/#workflow">See the real workflow</Link>
            </div>
            <p className={styles.modeNote}><Icon name="shield" size={16} />{cta.detail}</p>
          </div>
          <ArtifactNarrative />
        </section>

        <section className={styles.workflowSection} id="workflow">
          <div className={styles.sectionIntro}><p>One governed path</p><h2>The artifact changes. The owner stays in control.</h2><span>Each stage produces evidence for the next decision instead of hiding work behind an autonomous progress bar.</span></div>
          <ol className={styles.workflowList}>
            {workflow.map((step) => <li key={step.index}><span className={styles.stepIndex}>{step.index}</span><Icon name={step.icon} size={22} /><div><h3>{step.title}</h3><p>{step.description}</p></div></li>)}
          </ol>
        </section>

        <section className={styles.safetySection} id="safety">
          <div className={styles.safetyStatement}><p>Designed around consequential actions</p><h2>Automation can prepare. It cannot quietly publish.</h2></div>
          <div className={styles.safetyDetails}>
            <article><Icon name="approval" size={23} /><h3>Exact approvals</h3><p>Specifications, secret grants, first releases, polish releases, and rollbacks have explicit approval records.</p></article>
            <article><Icon name="terminal" size={23} /><h3>Separated sandboxes</h3><p>The builder works in an isolated Daytona environment; verification runs against the resulting artifact in a clean boundary.</p></article>
            <article><Icon name="database" size={23} /><h3>Immutable evidence</h3><p>Artifact hashes, usage entries, provider cost, and the customer credit ledger remain distinct and auditable.</p></article>
          </div>
        </section>

        <section className={styles.finalCta}>
          <BrandMark size={48} /><div><p>Private beta · access is opening gradually</p><h2>Bring an invite, or join the waitlist.</h2></div><Link className={styles.primaryCta} href={cta.href}>{cta.label}<Icon name="arrow-right" size={18} /></Link>
        </section>
      </main>
    </MarketingFrame>
  );
}
