"use client";

import { useQuery } from "@tanstack/react-query";
import {
  BadgeCheck,
  Bell,
  Cable,
  CalendarClock,
  ChartNoAxesCombined,
  CircleUserRound,
  Coins,
  Ellipsis,
  FolderKanban,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AccountProfileResponseSchema, type AccountProfile } from "@/contracts/account";
import { AccountAvatar } from "@/components/account-avatar";
import { Brand } from "@/components/brand";
import { Dialog, Sheet } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-provider";
import { signOutOwnerSession } from "@/features/auth/sign-out";

type ShellProject = { id: string; name: string; detail: string };
type NavigationItem = { href: string; label: string; icon: LucideIcon; detail: string };
type HealthResponse = {
  status?: string;
  mode?: "demo" | "live";
  deploymentMode?: string;
  service?: string;
};

type ApprovalResponse = { data?: { items?: Array<{ status?: string }> } };
type BillingResponse = {
  data?: {
    account?: {
      planKey?: string | null;
    };
    wallet?: {
      spendable?: string;
      held?: string;
    };
    catalog?: {
      plans?: Array<{
        key?: string;
        displayName?: string;
      }>;
    };
  };
};
type ProjectsResponse = {
  data?: {
    items?: Array<{
      id?: string;
      name?: string;
      status?: string;
      stageLabel?: string;
      nextAction?: string;
    }>;
  };
};

const navigationGroups: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: "Build",
    items: [
      { href: "/projects", label: "Projects", icon: FolderKanban, detail: "Build from approved evidence" },
      { href: "/approvals", label: "Approvals", icon: BadgeCheck, detail: "Review gated actions" },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/usage", label: "Usage", icon: ChartNoAxesCombined, detail: "Inspect tokens and provider cost" },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/connections", label: "Connections", icon: Cable, detail: "Authorize external providers" },
      { href: "/schedules", label: "Schedules", icon: CalendarClock, detail: "Control recurring research" },
    ],
  },
];

const allNavigationItems = navigationGroups.flatMap((group) => group.items);
const morePaths = ["/connections", "/schedules", "/account", "/settings"];

function isActive(pathname: string, href: string) {
  if (href === "/projects") return pathname === "/projects" || pathname.startsWith("/projects/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
  return response.json() as Promise<T>;
}

function formatCreditBalance(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return "0";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(BigInt(value));
}

export function SidebarCreditBalance({
  spendable,
  held,
  loading = false,
  unavailable = false,
}: {
  spendable?: string | undefined;
  held?: string | undefined;
  loading?: boolean;
  unavailable?: boolean;
}) {
  const heldCredits = held && /^\d+$/.test(held) ? BigInt(held) : 0n;
  const state = loading ? "loading" : unavailable ? "error" : "ready";

  return (
    <section aria-busy={loading} aria-label="Credit balance" className={`sidebar-wallet is-${state}`}>
      <span className="sidebar-wallet-icon" aria-hidden="true"><Coins size={18} strokeWidth={1.9} /></span>
      <div className="sidebar-wallet-copy">
        <small>Credit balance</small>
        {loading ? (
          <span className="sidebar-wallet-skeleton" aria-label="Loading credit balance" />
        ) : unavailable ? (
          <strong>Unavailable</strong>
        ) : (
          <strong><span>{formatCreditBalance(spendable)}</span> credits</strong>
        )}
      </div>
      {!loading && !unavailable ? (
        <small className="sidebar-wallet-detail">{heldCredits > 0n ? `${formatCreditBalance(held)} held` : "Ready to spend"}</small>
      ) : null}
    </section>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  onRestoreFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ShellProject[];
  onRestoreFocus?: () => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const destinations = [
      ...allNavigationItems.map((item) => ({ ...item, group: "Workspace" })),
      ...projects.map((project) => ({
        label: project.name,
        detail: project.detail,
        href: `/projects/${project.id}`,
        icon: FolderKanban,
        group: "Projects",
      })),
      { label: "Account", detail: "Profile, sessions, and workspace", href: "/account", icon: CircleUserRound, group: "Account" },
      { label: "Create new project", detail: "Start from evidence", href: "/projects/new", icon: Plus, group: "Action" },
    ];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return destinations;
    return destinations.filter((item) => `${item.label} ${item.detail} ${item.group}`.toLowerCase().includes(normalizedQuery));
  }, [projects, query]);

  const selectedIndex = results.length > 0 ? Math.min(activeIndex, results.length - 1) : 0;

  const closePalette = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    onOpenChange(false);
    if (onRestoreFocus) window.requestAnimationFrame(onRestoreFocus);
  }, [onOpenChange, onRestoreFocus]);

  const navigateTo = useCallback((href: string) => {
    router.push(href);
    closePalette();
  }, [closePalette, router]);

  useEffect(() => {
    if (!open || results.length === 0) return;
    resultRefs.current[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, results.length, selectedIndex]);

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(results.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const result = results[selectedIndex];
      if (result) navigateTo(result.href);
    }
  }

  return (
    <Dialog
      {...(onRestoreFocus ? { onCloseAutoFocus: (event: Event) => {
        event.preventDefault();
        onRestoreFocus();
      } } : {})}
      className="command-dialog-frame"
      contentClassName="command-dialog"
      description="Search destinations and projects, then press Enter to open the selected result."
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        inputRef.current?.focus();
      }}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else closePalette();
      }}
      open={open}
      title="Quick navigation"
    >
      <div className="command-search">
        <Search aria-hidden="true" size={19} strokeWidth={1.9} />
        <input
          aria-activedescendant={results[selectedIndex] ? `command-result-${selectedIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls="command-results"
          aria-expanded="true"
          aria-label="Search ReDDone"
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={onSearchKeyDown}
          placeholder="Jump to a project or destination"
          ref={inputRef}
          role="combobox"
          type="search"
          value={query}
        />
        <kbd>Esc</kbd>
      </div>
      <div className="command-results" id="command-results" role="listbox">
        <span className="command-group-label">Navigate</span>
        {results.length ? results.map((item, index) => {
          const ResultIcon = item.icon;
          const selected = index === selectedIndex;
          return (
            <button
              aria-selected={selected}
              className={`command-result ${selected ? "is-selected" : ""}`}
              id={`command-result-${index}`}
              key={`${item.href}-${item.label}`}
              onClick={() => navigateTo(item.href)}
              onMouseMove={() => setActiveIndex(index)}
              ref={(element) => { resultRefs.current[index] = element; }}
              role="option"
              type="button"
            >
              <span className="command-result-icon"><ResultIcon aria-hidden="true" size={18} strokeWidth={1.9} /></span>
              <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              {selected && <kbd>Enter</kbd>}
            </button>
          );
        }) : (
          <div className="command-empty">No destination matches “{query}”.</div>
        )}
      </div>
    </Dialog>
  );
}

type ShellAccount = Pick<AccountProfile["user"], "name" | "image"> & { planName: string };

function AccountMenu({ account, signingOut, signOut }: { account: ShellAccount; signingOut: boolean; signOut: () => Promise<void> }) {
  return (
    <details className="account-menu">
      <summary className="profile-chip">
        <AccountAvatar className="avatar" image={account.image} name={account.name} />
        <span><strong>{account.name}</strong><small>{account.planName}</small></span>
        <Ellipsis aria-hidden="true" size={17} />
      </summary>
      <div className="account-menu-panel">
        <Link href="/account"><CircleUserRound aria-hidden="true" size={17} /><span>Account</span></Link>
        <div className="account-theme-row"><span>Theme</span><ThemeToggle compact /></div>
        <button disabled={signingOut} onClick={() => void signOut()} type="button">
          <LogOut aria-hidden="true" size={17} /><span>{signingOut ? "Signing out…" : "Sign out"}</span>
        </button>
      </div>
    </details>
  );
}

export function MobileMoreSheet({
  account,
  open,
  onOpenChange,
  signingOut,
  signOut,
}: {
  account: ShellAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signingOut: boolean;
  signOut: () => Promise<void>;
}) {
  const links = [
    { href: "/connections", label: "Connections", detail: "External providers", icon: Cable },
    { href: "/schedules", label: "Schedules", detail: "Recurring research", icon: CalendarClock },
    { href: "/account", label: "Account", detail: "Profile and sessions", icon: Settings2 },
  ];

  return (
    <Sheet
      description="Configure the workspace and account."
      onOpenChange={onOpenChange}
      open={open}
      side="bottom"
      title="More"
    >
      <Link className="mobile-account-identity" href="/account" onClick={() => onOpenChange(false)}>
        <AccountAvatar image={account.image} name={account.name} size={46} />
        <span><strong>{account.name}</strong><small>{account.planName}</small></span>
      </Link>
      <nav aria-label="More destinations" className="mobile-more-links">
        {links.map((item) => {
          const ItemIcon = item.icon;
          return (
            <Link href={item.href} key={item.href} onClick={() => onOpenChange(false)}>
              <span className="mobile-more-icon"><ItemIcon aria-hidden="true" size={20} strokeWidth={1.9} /></span>
              <span><strong>{item.label}</strong><small>{item.detail}</small></span>
            </Link>
          );
        })}
      </nav>
      <div className="mobile-more-theme"><span>Color theme</span><ThemeToggle /></div>
      <button className="mobile-sign-out" disabled={signingOut} onClick={() => void signOut()} type="button">
        <LogOut aria-hidden="true" size={18} />{signingOut ? "Signing out…" : "Sign out"}
      </button>
    </Sheet>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const commandReturnFocusRef = useRef<HTMLElement | null>(null);

  const approvalsQuery = useQuery({
    queryKey: ["shell", "approvals"],
    queryFn: () => fetchJson<ApprovalResponse>("/api/v1/approvals"),
  });
  const healthQuery = useQuery({
    queryKey: ["shell", "health"],
    queryFn: () => fetchJson<HealthResponse>("/api/health"),
    refetchInterval: 60_000,
  });
  const billingQuery = useQuery({
    queryKey: ["shell", "billing"],
    queryFn: () => fetchJson<BillingResponse>("/api/v1/billing"),
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const projectsQuery = useQuery({
    queryKey: ["shell", "projects"],
    queryFn: () => fetchJson<ProjectsResponse>("/api/v1/projects"),
  });
  const accountQuery = useQuery({
    queryKey: ["shell", "account"],
    queryFn: async () => AccountProfileResponseSchema.parse(await fetchJson<unknown>("/api/v1/account")),
    staleTime: 60_000,
  });

  const approvalCount = (approvalsQuery.data?.data?.items ?? [])
    .filter((approval) => approval.status?.toLowerCase() === "pending").length;
  const workspaceProjects = (projectsQuery.data?.data?.items ?? []).flatMap((project) => (
    project.id && project.name
      ? [{
          id: project.id,
          name: project.name,
          detail: project.nextAction ?? project.stageLabel ?? project.status?.replaceAll("_", " ") ?? "Workspace project",
        }]
      : []
  ));

  const healthState = healthQuery.isPending
    ? "loading"
    : healthQuery.isError || healthQuery.data?.status !== "ok"
      ? "error"
      : "healthy";
  const healthLabel = healthState === "loading"
    ? "Checking control plane"
    : healthState === "healthy"
      ? "Control plane healthy"
      : "Control plane unavailable";
  const healthDetail = healthState === "healthy"
    ? `${healthQuery.data?.deploymentMode ?? "Private"} deployment · lease-gated`
    : healthState === "loading"
      ? "Waiting for health response"
      : "Health endpoint did not confirm readiness";
  const runtimeMode = healthQuery.data?.mode === "live" ? "Live" : "Demo";
  const activePlanKey = billingQuery.data?.data?.account?.planKey;
  const activePlan = billingQuery.data?.data?.catalog?.plans?.find((plan) => plan.key === activePlanKey);
  const planName = billingQuery.isPending
    ? "Loading plan…"
    : billingQuery.isError
      ? "Plan unavailable"
      : activePlanKey
        ? `${activePlan?.displayName ?? "Active"} plan`
        : "Free plan";
  const shellUser = accountQuery.data?.data.user;
  const shellAccount: ShellAccount = shellUser
    ? { name: shellUser.name, image: shellUser.image, planName }
    : {
        name: accountQuery.isPending ? "Loading profile…" : "Workspace owner",
        image: null,
        planName,
      };

  const openCommandPalette = useCallback(() => {
    commandReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommandOpen(true);
  }, []);

  const restoreCommandFocus = useCallback(() => {
    commandReturnFocusRef.current?.focus();
    commandReturnFocusRef.current = null;
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openCommandPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCommandPalette]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    setSignOutError("");
    try {
      await signOutOwnerSession();
      window.location.assign("/sign-in");
    } catch {
      setSignOutError("Unable to sign out. Check the connection and try again.");
      setSigningOut(false);
    }
  }, []);

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`sidebar ${navOpen ? "is-open" : ""}`} aria-label="Primary navigation">
        <div className="sidebar-head">
          <Brand />
          <button aria-label="Close navigation" className="sidebar-close icon-button" onClick={() => setNavOpen(false)} type="button">
            <X aria-hidden="true" size={19} />
          </button>
        </div>

        <button className="command-trigger" onClick={openCommandPalette} type="button">
          <Search aria-hidden="true" size={17} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav className="sidebar-nav">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-label">{group.label}</span>
              {group.items.map((item) => {
                const ItemIcon = item.icon;
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={`nav-item ${active ? "is-active" : ""}`}
                    href={item.href}
                    key={item.href}
                    onClick={() => setNavOpen(false)}
                  >
                    <ItemIcon aria-hidden="true" size={18} strokeWidth={1.9} />
                    <span>{item.label}</span>
                    {item.href === "/approvals" && approvalCount > 0 && <small>{approvalCount}</small>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <SidebarCreditBalance
          held={billingQuery.data?.data?.wallet?.held}
          loading={billingQuery.isPending}
          spendable={billingQuery.data?.data?.wallet?.spendable}
          unavailable={billingQuery.isError}
        />

        <div className={`sidebar-signal is-${healthState}`} aria-live="polite">
          <div className="signal-orbit" aria-hidden="true"><span /></div>
          <div><strong>{healthLabel}</strong><small>{healthDetail}</small></div>
        </div>

        <AccountMenu account={shellAccount} signOut={signOut} signingOut={signingOut} />
        {signOutError && <p className="account-menu-error" role="alert">{signOutError}</p>}
      </aside>

      {navOpen && <button aria-label="Close navigation" className="sidebar-scrim" onClick={() => setNavOpen(false)} type="button" />}

      <div className="app-stage">
        <header className="topbar">
          <button aria-label="Open navigation" className="mobile-menu icon-button" onClick={() => setNavOpen(true)} type="button">
            <Menu aria-hidden="true" size={20} />
          </button>
          <div className="topbar-context">
            <span className={`live-dot is-${healthState}`} aria-hidden="true" />
            <span>Private workspace</span>
            <strong>{runtimeMode} control plane</strong>
          </div>
          <div className="topbar-actions">
            <button className="topbar-search" onClick={openCommandPalette} type="button"><Search aria-hidden="true" size={16} /><span>Search</span><kbd>⌘K</kbd></button>
            <Link className="icon-button" href="/approvals" aria-label={`Approvals, ${approvalCount} pending`}><Bell aria-hidden="true" size={19} /></Link>
            <Link aria-current={isActive(pathname, "/account") ? "page" : undefined} className="topbar-avatar" href="/account" aria-label={`Open ${shellAccount.name} account settings`}>
              <AccountAvatar image={shellAccount.image} name={shellAccount.name} size={34} />
            </Link>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
      </div>

      <nav aria-label="Mobile navigation" className="mobile-tabbar">
        {[
          { href: "/projects", label: "Projects", icon: FolderKanban },
          { href: "/approvals", label: "Approvals", icon: BadgeCheck },
          { href: "/usage", label: "Usage", icon: ChartNoAxesCombined },
        ].map((item) => {
          const ItemIcon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <Link aria-current={active ? "page" : undefined} className={active ? "is-active" : ""} href={item.href} key={item.href}>
              <span><ItemIcon aria-hidden="true" size={20} />{item.href === "/approvals" && approvalCount > 0 && <i>{approvalCount}</i>}</span>
              <small>{item.label}</small>
            </Link>
          );
        })}
        <button
          aria-current={morePaths.some((path) => isActive(pathname, path)) ? "page" : undefined}
          aria-label="Open more navigation"
          className={`mobile-tab-more ${morePaths.some((path) => isActive(pathname, path)) ? "is-active" : ""}`}
          onClick={() => setMoreOpen(true)}
          type="button"
        >
          <MoreHorizontal aria-hidden="true" size={20} />
          <small>More</small>
        </button>
      </nav>

      <CommandPalette onOpenChange={setCommandOpen} onRestoreFocus={restoreCommandFocus} open={commandOpen} projects={workspaceProjects} />
      <MobileMoreSheet account={shellAccount} onOpenChange={setMoreOpen} open={moreOpen} signOut={signOut} signingOut={signingOut} />
    </div>
  );
}
