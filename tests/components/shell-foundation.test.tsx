// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, MobileMoreSheet, SidebarCreditBalance } from "@/components/app-shell";
import { ThemeProvider, ThemeToggle } from "@/components/theme-provider";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/projects",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

type MediaListener = (event: MediaQueryListEvent) => void;
let systemDark = false;
const mediaListeners = new Set<MediaListener>();
const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() { return storage.size; },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => { storage.delete(key); },
  setItem: (key, value) => { storage.set(key, String(value)); },
};

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? systemDark : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: MediaListener) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: MediaListener) => mediaListeners.delete(listener),
      addListener: (listener: MediaListener) => mediaListeners.add(listener),
      removeListener: (listener: MediaListener) => mediaListeners.delete(listener),
      dispatchEvent: () => true,
    })),
  });
}

beforeEach(() => {
  push.mockReset();
  systemDark = false;
  mediaListeners.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageMock });
  window.localStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.dataset.themePreference = "system";
  document.cookie = "reddone-theme=; path=/; max-age=0";
  installMatchMedia();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => cleanup());

describe("theme behavior", () => {
  it("persists explicit themes and follows system changes", async () => {
    render(<ThemeProvider initialPreference="system"><ThemeToggle /></ThemeProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
    expect(window.localStorage.getItem("reddone-theme")).toBe("dark");
    expect(document.cookie).toContain("reddone-theme=dark");

    fireEvent.click(screen.getByRole("button", { name: "Use system theme" }));
    systemDark = true;
    mediaListeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement.dataset.themePreference).toBe("system");
  });
});

describe("command palette keyboard navigation", () => {
  it("supports Arrow keys, Home, End, and Enter", async () => {
    render(<CommandPalette onOpenChange={vi.fn()} open projects={[]} />);
    const search = await screen.findByRole("combobox", { name: "Search ReDDone" });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(push).toHaveBeenLastCalledWith("/approvals");

    push.mockReset();
    cleanup();
    render(<CommandPalette onOpenChange={vi.fn()} open projects={[]} />);
    const reopenedSearch = await screen.findByRole("combobox", { name: "Search ReDDone" });
    fireEvent.keyDown(reopenedSearch, { key: "End" });
    fireEvent.keyDown(reopenedSearch, { key: "Enter" });
    expect(push).toHaveBeenLastCalledWith("/projects/new");
  });

  it("dismisses with Escape", async () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette onOpenChange={onOpenChange} open projects={[]} />);
    await screen.findByRole("dialog", { name: "Quick navigation" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("mobile More sheet", () => {
  it("exposes secondary destinations, theme controls, and sign out", async () => {
    const signOut = vi.fn(async () => undefined);
    render(
      <ThemeProvider initialPreference="light">
        <MobileMoreSheet
          account={{ name: "Test Owner", image: null, planName: "Builder plan" }}
          onOpenChange={vi.fn()}
          open
          signOut={signOut}
          signingOut={false}
        />
      </ThemeProvider>,
    );

    await screen.findByRole("dialog", { name: "More" });
    expect(screen.queryByRole("link", { name: /Payments/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Connections/ })).toHaveAttribute("href", "/connections");
    expect(screen.getByRole("link", { name: /Schedules/ })).toHaveAttribute("href", "/schedules");
    expect(screen.getByRole("link", { name: /Account/ })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("link", { name: /Test Owner/ })).toHaveAttribute("href", "/account");
    expect(screen.getByText("Builder plan")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color theme" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledOnce();
  });
});

describe("sidebar credit balance", () => {
  it("shows the exact spendable balance and held-credit state", () => {
    const { rerender } = render(<SidebarCreditBalance held="0" spendable="1000100" />);

    expect(screen.getByRole("region", { name: "Credit balance" })).toHaveTextContent("1,000,100 credits");
    expect(screen.getByText("Ready to spend")).toBeInTheDocument();

    rerender(<SidebarCreditBalance held="300" spendable="999800" />);
    expect(screen.getByRole("region", { name: "Credit balance" })).toHaveTextContent("999,800 credits");
    expect(screen.getByText("300 held")).toBeInTheDocument();
  });

  it("covers loading and unavailable states", () => {
    const { rerender } = render(<SidebarCreditBalance loading />);
    expect(screen.getByLabelText("Loading credit balance")).toBeInTheDocument();

    rerender(<SidebarCreditBalance unavailable />);
    expect(screen.getByRole("region", { name: "Credit balance" })).toHaveTextContent("Unavailable");
  });
});
