// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BetaAccess } from "@/features/beta/beta-access";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

beforeEach(() => {
  push.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("private beta access", () => {
  it("validates an invite before opening account creation", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { admitted: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    render(<BetaAccess />);

    fireEvent.change(screen.getByLabelText("Invite code"), { target: { value: "OWNER-ABCDEF-123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/beta/access", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "OWNER-ABCDEF-123456" }),
    })));
    expect(push).toHaveBeenCalledWith("/sign-up?access=ready");
  });

  it("collects one email without requesting payment or profile details", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { joined: true } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    render(<BetaAccess />);

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "Nora@Example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Join waitlist" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/waitlist", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "Nora@Example.com", source: "beta-page", website: "" }),
    })));
    expect(await screen.findByRole("status")).toHaveTextContent("That’s all we need");
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
  });
});
