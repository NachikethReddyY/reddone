"use client";

import { useEffect, useState } from "react";
import type { ZodType } from "zod";

import { Icon, type IconName } from "@/components/icons";
import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  Skeleton,
  StatusBadge,
  Surface,
} from "@/components/ui";
import {
  BillingCheckoutResultSchema,
  BillingLedgerPageSchema,
  BillingPortalResultSchema,
  BillingSummarySchema,
  type BillingCatalogKey,
  type BillingLedgerEntry,
  type BillingLedgerPage,
  type BillingSummary,
} from "@/contracts";

const webhookPollDelays = [1_000, 1_500, 2_500, 3_500, 5_000];
const initialLedgerLimit = 25;

type CheckoutOutcome = "success" | "canceled" | null;
type HostedPageKind = "checkout" | "portal";

type PrimaryAction = {
  kind: HostedPageKind | "anchor";
  label: string;
  disabled: boolean;
  catalogKey?: BillingCatalogKey;
  targetId?: string;
};

async function apiData(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  }
  if (body && typeof body === "object" && "data" in body) return body.data;
  if (body !== null) return body;
  throw new Error("The server returned an invalid response.");
}

async function parsedApiData<T>(response: Response, schema: ZodType<T>): Promise<T> {
  return schema.parse(await apiData(response));
}

async function fetchBilling(): Promise<BillingSummary> {
  return parsedApiData(await fetch("/api/v1/billing", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }), BillingSummarySchema);
}

async function fetchBillingLedger(cursor?: string): Promise<BillingLedgerPage> {
  const query = new URLSearchParams({ limit: String(initialLedgerLimit) });
  if (cursor) query.set("cursor", cursor);
  return parsedApiData(await fetch(`/api/v1/billing/ledger?${query}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }), BillingLedgerPageSchema);
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function formatCredits(value: string | number | bigint) {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(BigInt(value));
  } catch {
    return "0";
  }
}

function signedCredits(value: string) {
  const amount = BigInt(value);
  return `${amount > 0n ? "+" : ""}${formatCredits(amount)}`;
}

function formatSgd(amountMinor: number) {
  return new Intl.NumberFormat("en-SG", {
    style: "currency",
    currency: "SGD",
    maximumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
  }).format(amountMinor / 100);
}

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusTone(status: string) {
  if (["active", "trialing"].includes(status)) return "success" as const;
  if (["past_due", "unpaid", "incomplete", "paused"].includes(status)) return "warning" as const;
  if (["canceled", "inactive"].includes(status)) return "neutral" as const;
  return "info" as const;
}

function planIcon(key: BillingCatalogKey): IconName {
  if (key === "plan_scale_sgd_v1") return "layers";
  if (key === "plan_builder_sgd_v1") return "spark";
  return "activity";
}

function initialCheckoutOutcome(): CheckoutOutcome {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("checkout");
  return value === "success" ? "success" : value === "canceled" ? "canceled" : null;
}

function uniqueLedgerEntries(entries: BillingLedgerEntry[]) {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

export function getBillingPrimaryAction(summary: BillingSummary): PrimaryAction {
  const status = summary.account.status ?? "inactive";
  const paymentNeedsAttention = ["past_due", "unpaid", "incomplete"].includes(status);
  if (paymentNeedsAttention) {
    return {
      kind: "portal",
      label: "Fix payment",
      disabled: !summary.portalEnabled || !summary.account.portalAvailable,
    };
  }

  const spendable = BigInt(summary.wallet.spendable);
  const lowBalanceThreshold = BigInt(Math.max(1, ...summary.operationPrices.map((operation) => operation.credits)));
  const firstPack = summary.catalog.packs[0];
  if (spendable < lowBalanceThreshold) {
    return {
      kind: "checkout",
      label: "Add credits",
      disabled: !summary.checkoutEnabled || !firstPack,
      ...(firstPack ? { catalogKey: firstPack.key } : {}),
    };
  }

  if (summary.account.planKey && summary.account.portalAvailable) {
    return {
      kind: "portal",
      label: "Manage plan",
      disabled: !summary.portalEnabled,
    };
  }

  return {
    kind: "anchor",
    label: "Manage plan",
    disabled: summary.catalog.plans.length === 0,
    targetId: "payment-plans",
  };
}

function BillingSkeleton() {
  return (
    <div aria-label="Loading payments" className="payments-stack" role="status">
      <span className="sr-only">Loading payments…</span>
      <div className="payments-hero-grid">
        <Surface className="payments-skeleton-card"><Skeleton className="payments-skeleton-short" /><Skeleton className="payments-skeleton-title" /><Skeleton className="payments-skeleton-line" /><Skeleton className="payments-skeleton-action" /></Surface>
        <Surface className="payments-skeleton-card"><Skeleton className="payments-skeleton-short" /><Skeleton className="payments-skeleton-title" /><div className="payments-skeleton-metrics">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} />)}</div></Surface>
      </div>
      <div className="payments-skeleton-cards">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} />)}</div>
      <Skeleton className="payments-skeleton-table" />
    </div>
  );
}

function LedgerAmount({ entry }: { entry: BillingLedgerEntry }) {
  const amount = BigInt(entry.amount);
  return <span className={amount < 0n ? "is-debit" : "is-credit"}>{signedCredits(entry.amount)}</span>;
}

export function BillingPanel() {
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [ledger, setLedger] = useState<BillingLedgerEntry[]>([]);
  const [ledgerCursor, setLedgerCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [ledgerError, setLedgerError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkoutOutcome] = useState<CheckoutOutcome>(initialCheckoutOutcome);
  const [working, setWorking] = useState("");

  useEffect(() => {
    let active = true;
    const outcome = checkoutOutcome;
    if (outcome) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("checkout");
      window.history.replaceState(window.history.state, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }

    async function loadLedger() {
      if (active) setLedgerLoading(true);
      try {
        const page = await fetchBillingLedger();
        if (!active) return;
        setLedger(page.items);
        setLedgerCursor(page.nextCursor);
        setLedgerError("");
      } catch (ledgerLoadError) {
        if (active) setLedgerError(ledgerLoadError instanceof Error ? ledgerLoadError.message : "Credit activity could not be loaded.");
      } finally {
        if (active) setLedgerLoading(false);
      }
    }

    async function load() {
      try {
        const initial = await fetchBilling();
        if (!active) return;
        setBilling(initial);
        setLedger(initial.recentLedger);
        setError("");
        setLoading(false);
        void loadLedger();

        if (outcome === "canceled") {
          setNotice("Checkout was canceled. No subscription or credits were added.");
          return;
        }
        if (outcome !== "success") return;

        setSyncing(true);
        setNotice("Checkout completed. Waiting for Stripe webhooks to confirm the workspace billing state…");
        for (const delay of webhookPollDelays) {
          await wait(delay);
          if (!active) return;
          try {
            const refreshed = await fetchBilling();
            if (active) setBilling(refreshed);
          } catch {
            // Keep the last webhook-confirmed server state through transient poll failures.
          }
        }
        if (active) {
          setNotice("Checkout returned successfully. The state below is confirmed by ReDDone; delayed payment methods may take longer to appear.");
          void loadLedger();
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Workspace billing is unavailable.");
      } finally {
        if (active) {
          setLoading(false);
          setSyncing(false);
        }
      }
    }

    void load();
    return () => { active = false; };
  }, [checkoutOutcome]);

  async function refresh() {
    setLoading(!billing);
    setError("");
    setLedgerError("");
    try {
      const [summary, page] = await Promise.all([fetchBilling(), fetchBillingLedger()]);
      setBilling(summary);
      setLedger(page.items);
      setLedgerCursor(page.nextCursor);
      setNotice("Payments refreshed from webhook-confirmed server state.");
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Workspace billing is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshLedger() {
    setLedgerLoading(true);
    setLedgerError("");
    try {
      const page = await fetchBillingLedger();
      setLedger(page.items);
      setLedgerCursor(page.nextCursor);
    } catch (refreshError) {
      setLedgerError(refreshError instanceof Error ? refreshError.message : "Credit activity could not be loaded.");
    } finally {
      setLedgerLoading(false);
    }
  }

  async function loadMoreLedger() {
    if (!ledgerCursor) return;
    setLedgerLoading(true);
    setLedgerError("");
    try {
      const page = await fetchBillingLedger(ledgerCursor);
      setLedger((current) => uniqueLedgerEntries([...current, ...page.items]));
      setLedgerCursor(page.nextCursor);
    } catch (loadError) {
      setLedgerError(loadError instanceof Error ? loadError.message : "More credit activity could not be loaded.");
    } finally {
      setLedgerLoading(false);
    }
  }

  async function openHostedPage(kind: HostedPageKind, catalogKey?: BillingCatalogKey) {
    const workKey = kind === "portal" ? "portal" : catalogKey ?? "checkout";
    setWorking(workKey);
    setError("");
    try {
      const response = await fetch(`/api/v1/billing/${kind}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(catalogKey ? { catalogKey } : {}),
      });
      const hosted = kind === "checkout"
        ? await parsedApiData(response, BillingCheckoutResultSchema)
        : await parsedApiData(response, BillingPortalResultSchema);
      const destination = new URL(hosted.url, window.location.origin);
      if (destination.protocol !== "https:" && destination.origin !== window.location.origin) {
        throw new Error("The server returned an invalid billing URL.");
      }
      window.location.assign(destination.href);
    } catch (hostedError) {
      setError(hostedError instanceof Error ? hostedError.message : "The billing page could not be opened.");
      setWorking("");
    }
  }

  function invokePrimaryAction(action: PrimaryAction) {
    if (action.kind === "anchor") {
      document.getElementById(action.targetId ?? "payment-plans")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    void openHostedPage(action.kind, action.catalogKey);
  }

  if (loading && !billing) return <BillingSkeleton />;

  if (error && !billing) {
    return <div role="alert"><EmptyState action={<Button icon="retry" onClick={refresh}>Try again</Button>} description={error} icon="warning" title="Payments are unavailable" /></div>;
  }

  if (!billing) return null;

  const status = billing.account.status ?? "inactive";
  const plan = billing.catalog.plans.find((item) => item.key === billing.account.planKey) ?? null;
  const primaryAction = getBillingPrimaryAction(billing);
  const paymentNeedsAttention = ["past_due", "unpaid", "incomplete"].includes(status);
  const hasSubscription = billing.account.planKey !== null;
  const hasManagedSubscription = hasSubscription && !["inactive", "canceled"].includes(status);
  const canUsePortal = billing.portalEnabled && billing.account.portalAvailable;

  return (
    <div aria-busy={syncing} className="payments-stack">
      <div aria-live="polite" className="payments-live-region">
        {notice && (
          <Alert tone={checkoutOutcome === "canceled" ? "warning" : checkoutOutcome === "success" ? "success" : "info"}>
            {notice}
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {!billing.enabled && (
          <Alert title="Billing visibility only" tone="warning">
            New billing activity is paused. Confirmed balances and ledger history remain visible.
          </Alert>
        )}
      </div>

      <div className="payments-hero-grid">
        <Surface className={`payments-plan-summary ${paymentNeedsAttention ? "has-warning" : ""}`}>
          <div className="payments-card-heading">
            <div>
              <span className="eyebrow">Current plan</span>
              <h2>{plan?.displayName ?? "Pay as you go"}</h2>
            </div>
            <StatusBadge pulse={syncing} tone={statusTone(status)}>{titleCase(status)}</StatusBadge>
          </div>
          <p className="payments-summary-copy">
            {billing.account.hasPaidAccess
              ? "Subscription access and included credits are confirmed through the current paid period."
              : "Purchased and promotional credits can fund approved work without an active subscription."}
          </p>
          <dl className="payments-facts">
            <div><dt>Payment status</dt><dd>{paymentNeedsAttention ? "Needs attention" : billing.account.hasPaidAccess ? "Paid" : "No active payment"}</dd></div>
            <div><dt>Paid through</dt><dd>{formatDate(billing.account.paidThroughAt)}</dd></div>
            <div><dt>Renewal</dt><dd>{billing.account.cancelAtPeriodEnd ? "Cancels at period end" : hasSubscription ? "Managed by Stripe" : "No renewal scheduled"}</dd></div>
          </dl>
          {paymentNeedsAttention && (
            <div className="payments-state-callout is-danger">
              <Icon name="warning" size={19} />
              <span><strong>Payment needs attention</strong><small>Update payment details in Stripe. Access changes only after server-side confirmation.</small></span>
            </div>
          )}
          {billing.account.cancelAtPeriodEnd && (
            <div className="payments-state-callout is-warning">
              <Icon name="clock" size={19} />
              <span><strong>Cancellation scheduled</strong><small>Included credits expire when this paid period ends.</small></span>
            </div>
          )}
          <div className="payments-primary-actions">
            <Button
              disabled={primaryAction.disabled || Boolean(working)}
              icon={primaryAction.kind === "portal" ? "external" : primaryAction.kind === "checkout" ? "plus" : "arrow-right"}
              kind="primary"
              onClick={() => invokePrimaryAction(primaryAction)}
            >
              {working === "portal" || working === primaryAction.catalogKey ? "Opening…" : primaryAction.label}
            </Button>
            <Button disabled={syncing || loading} icon="retry" kind="ghost" onClick={refresh}>Refresh</Button>
          </div>
          {primaryAction.disabled && (
            <p className="payments-action-note">
              {primaryAction.kind === "portal" ? "The Stripe billing portal is not available for this workspace." : "Checkout is not available right now."}
            </p>
          )}
        </Surface>

        <Surface className="payments-wallet">
          <div className="payments-card-heading">
            <div><span className="eyebrow">Credit wallet</span><h2>{formatCredits(billing.wallet.spendable)} spendable</h2></div>
            <span className="payments-heading-icon"><Icon name="database" size={23} /></span>
          </div>
          <div className="payments-wallet-grid">
            <div className="is-emphasis"><span>Spendable</span><strong>{formatCredits(billing.wallet.spendable)}</strong><small>Available for approved work</small></div>
            <div><span>Held</span><strong>{formatCredits(billing.wallet.held)}</strong><small>Reserved by active workflows</small></div>
            <div><span>Included</span><strong>{formatCredits(billing.wallet.included)}</strong><small>Expires with the paid period</small></div>
            <div><span>Promotional</span><strong>{formatCredits(billing.wallet.promotional)}</strong><small>Workspace grant</small></div>
            <div><span>Purchased</span><strong>{formatCredits(billing.wallet.purchased)}</strong><small>Pay-as-you-go balance</small></div>
            <div><span>Next pack expiry</span><strong className="payments-date-value">{formatDate(billing.wallet.nextPurchasedExpiryAt)}</strong><small>Packs expire six months after purchase</small></div>
          </div>
        </Surface>
      </div>

      <section aria-labelledby="payment-plans-title" className="payments-section" id="payment-plans">
        <div className="payments-section-heading">
          <div><span className="eyebrow">Monthly plans</span><h2 id="payment-plans-title">Predictable included credits</h2><p>Included credits reset and expire at the end of each webhook-confirmed paid period.</p></div>
        </div>
        {billing.catalog.plans.length ? (
          <div className="payments-plan-grid">
            {billing.catalog.plans.map((item) => {
              const current = item.key === billing.account.planKey && hasManagedSubscription;
              const usesPortal = hasManagedSubscription;
              const actionDisabled = usesPortal ? !canUsePortal : !billing.checkoutEnabled;
              const itemWorking = working === (usesPortal ? "portal" : item.key);
              return (
                <Surface className={`payments-plan-card ${current ? "is-current" : ""}`} key={item.key}>
                  <div className="payments-plan-card-top">
                    <span className="payments-plan-glyph"><Icon name={planIcon(item.key)} size={22} /></span>
                    {current && <StatusBadge tone="success">Current</StatusBadge>}
                  </div>
                  <div><h3>{item.displayName}</h3><p className="payments-price"><strong>{formatSgd(item.amountMinor)}</strong><span>/ month</span></p></div>
                  <p className="payments-credit-allowance"><strong>{formatCredits(item.credits)}</strong><span>included credits each paid period</span></p>
                  <Button
                    disabled={current || actionDisabled || Boolean(working)}
                    kind="secondary"
                    onClick={() => void openHostedPage(usesPortal ? "portal" : "checkout", usesPortal ? undefined : item.key)}
                  >
                    {current ? "Current plan" : itemWorking ? "Opening…" : usesPortal ? "Manage in portal" : `Choose ${item.displayName}`}
                  </Button>
                </Surface>
              );
            })}
          </div>
        ) : (
          <EmptyState description="Monthly plans will appear when the server catalog is available." icon="clock" title="No plans available" />
        )}
      </section>

      <section aria-labelledby="payment-packs-title" className="payments-section" id="payment-packs">
        <div className="payments-section-heading">
          <div><span className="eyebrow">Pay as you go</span><h2 id="payment-packs-title">Add credits when needed</h2><p>Credit packs do not start a subscription and expire six months after purchase.</p></div>
        </div>
        {billing.catalog.packs.length ? (
          <div className="payments-pack-grid">
            {billing.catalog.packs.map((item) => (
              <Surface className="payments-pack-card" key={item.key}>
                <span className="payments-pack-icon"><Icon name="plus" size={20} /></span>
                <div><strong>{formatCredits(item.credits)} credits</strong><small>Expires six months after purchase</small></div>
                <span className="payments-pack-price">{formatSgd(item.amountMinor)}</span>
                <Button disabled={!billing.checkoutEnabled || Boolean(working)} kind="secondary" onClick={() => void openHostedPage("checkout", item.key)}>
                  {working === item.key ? "Opening…" : "Buy credits"}
                </Button>
              </Surface>
            ))}
          </div>
        ) : (
          <EmptyState description="Pay-as-you-go packs will appear when the server catalog is available." icon="clock" title="No credit packs available" />
        )}
      </section>

      <div className="payments-detail-grid">
        <Surface className="payments-operation-surface">
          <div className="payments-card-heading"><div><span className="eyebrow">Operation prices</span><h2>Credits charged by operation</h2></div><span className="payments-heading-icon"><Icon name="activity" size={21} /></span></div>
          {billing.operationPrices.length ? (
            <div className="payments-operation-list">
              {billing.operationPrices.map((operation) => (
                <div key={operation.key}><span><strong>{operation.label}</strong><small>Pricing version {operation.version}</small></span><b>{formatCredits(operation.credits)} credits</b></div>
              ))}
            </div>
          ) : (
            <EmptyState description="Operation prices will appear when the server publishes them." icon="clock" title="No operation prices" />
          )}
        </Surface>

        <Surface className="payments-explainer">
          <div className="payments-card-heading"><div><span className="eyebrow">Three separate measures</span><h2>Credits are not provider usage</h2></div><span className="payments-heading-icon"><Icon name="shield" size={21} /></span></div>
          <div className="payments-explainer-list">
            <div><strong>Customer credits</strong><p>Service entitlements charged at the fixed operation prices shown here.</p></div>
            <div><strong>Kimi tokens</strong><p>Actual input and output tokens reported by the Kimi provider for each model call.</p></div>
            <div><strong>Provider cost</strong><p>The provider-dollar cost calculated from token usage and the captured pricing snapshot.</p></div>
          </div>
          <p className="payments-explainer-note">Credits have no cash value and are never converted from token counts or provider cost.</p>
        </Surface>
      </div>

      <section aria-labelledby="payment-ledger-title" className="payments-ledger-section">
        <div className="payments-section-heading payments-ledger-heading">
          <div><span className="eyebrow">Credit ledger</span><h2 id="payment-ledger-title">Immutable transaction history</h2><p>Grants, purchases, holds, settlements, releases, expiries, and adjustments are appended in confirmed order.</p></div>
          <Button disabled={ledgerLoading} icon="retry" kind="ghost" onClick={refreshLedger}>Refresh ledger</Button>
        </div>

        {ledgerError && <Alert title="Ledger could not be refreshed" tone="danger">{ledgerError}</Alert>}
        {ledgerLoading && ledger.length === 0 ? (
          <div aria-label="Loading credit ledger" className="payments-ledger-loading" role="status">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} />)}</div>
        ) : ledger.length === 0 ? (
          <EmptyState action={<Button icon="retry" onClick={refreshLedger}>Try again</Button>} description="Confirmed grants, purchases, holds, settlements, releases, expiries, and adjustments will appear here." icon="file" title="No credit activity yet" />
        ) : (
          <>
            <DataTable caption="Workspace credit ledger" className="payments-ledger-table">
              <thead><tr><th scope="col">Date</th><th scope="col">Activity</th><th scope="col">Bucket</th><th scope="col">Available</th><th scope="col">Held</th></tr></thead>
              <tbody>
                {ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td><time dateTime={entry.occurredAt}>{formatDate(entry.occurredAt, true)}</time></td>
                    <td><strong>{entry.description}</strong><small>{titleCase(entry.type)}</small></td>
                    <td>{entry.bucket ? titleCase(entry.bucket) : "Workspace"}</td>
                    <td className={BigInt(entry.availableDelta) < 0n ? "is-debit" : BigInt(entry.availableDelta) > 0n ? "is-credit" : ""}>{signedCredits(entry.availableDelta)}</td>
                    <td className={BigInt(entry.heldDelta) < 0n ? "is-debit" : BigInt(entry.heldDelta) > 0n ? "is-credit" : ""}>{signedCredits(entry.heldDelta)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <div className="payments-ledger-mobile" role="list">
              {ledger.map((entry) => (
                <article className="payments-ledger-mobile-row" key={entry.id} role="listitem">
                  <span className={`payments-ledger-icon ${BigInt(entry.amount) < 0n ? "is-debit" : "is-credit"}`}><Icon name={BigInt(entry.amount) < 0n ? "arrow-up-right" : "plus"} size={16} /></span>
                  <div><strong>{entry.description}</strong><small>{titleCase(entry.bucket ?? "workspace")} · <time dateTime={entry.occurredAt}>{formatDate(entry.occurredAt, true)}</time></small></div>
                  <LedgerAmount entry={entry} />
                </article>
              ))}
            </div>
            {ledgerCursor && (
              <div className="payments-ledger-more"><Button disabled={ledgerLoading} kind="secondary" onClick={loadMoreLedger}>{ledgerLoading ? "Loading…" : "Load older activity"}</Button></div>
            )}
          </>
        )}
      </section>

      <div className="payments-trust-note">
        <Icon name="shield" size={21} />
        <div><strong>Webhook-confirmed state is authoritative.</strong><p>Returning from Stripe starts reconciliation polling only. Checkout redirects never grant access or credits locally; the server updates this page after verified Stripe events are processed.</p></div>
      </div>
    </div>
  );
}
