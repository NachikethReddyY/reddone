// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignInForm, SignUpForm } from "@/features/auth/auth-forms";

const { replace, refresh } = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authentication forms", () => {
  it("propagates a validated return path through email sign in", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ url: "/account?section=sessions" }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<SignInForm deploymentMode="public" emailDeliveryAvailable returnTo="/account?section=sessions" setupComplete />);

    expect(screen.getByRole("status")).toHaveTextContent(/Workspace owner created/i);
    expect(screen.getByRole("link", { name: /Forgot password/i })).toHaveAttribute("href", "/forgot-password?returnTo=%2Faccount%3Fsection%3Dsessions");
    expect(screen.getByRole("link", { name: /Request beta access/i })).toHaveAttribute("href", "/beta");
    expect(screen.queryByRole("link", { name: /populated UI demo/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Owner email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter control plane" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ callbackURL: "/account?section=sessions" });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/account?section=sessions"));
  });

  it("lets returning hackathon participants sign in with email and password", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ url: "/projects" }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<SignInForm deploymentMode="hackathon" returnTo="/projects" />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in or join the hackathon.");
    expect(screen.getByLabelText("Hackathon registration code")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Owner email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/auth/sign-in/email", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        email: "owner@example.com",
        password: "correct horse battery staple",
        rememberMe: false,
        callbackURL: "/projects",
      }),
    }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects"));
  });

  it("shows the demo link only in demo mode", () => {
    const { rerender } = render(<SignInForm deploymentMode="private" />);
    expect(screen.queryByRole("link", { name: /populated UI demo/i })).not.toBeInTheDocument();
    rerender(<SignInForm deploymentMode="demo" returnTo="/projects" />);
    expect(screen.getByRole("link", { name: /populated UI demo/i })).toHaveAttribute("href", "/projects");
  });

  it("retains GitHub callback errors while parsing the response body once", async () => {
    const socialJson = vi.fn().mockResolvedValue({ error: { message: "GitHub authorization is temporarily unavailable." } });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ admitted: true }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce({ ok: false, json: socialJson } as unknown as Response);
    render(<SignInForm deploymentMode="hackathon" returnTo="/projects/new?source=event" />);

    fireEvent.change(screen.getByLabelText("Hackathon registration code"), { target: { value: "event-code-12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub authorization is temporarily unavailable.");
    expect(socialJson).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const init = vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      provider: "github",
      callbackURL: "/projects/new?source=event",
      newUserCallbackURL: "/onboarding?returnTo=%2Fprojects%2Fnew%3Fsource%3Devent",
      errorCallbackURL: "/sign-in?returnTo=%2Fprojects%2Fnew%3Fsource%3Devent",
      disableRedirect: true,
    });
  });

  it("uses the visible form title as the sole h1", () => {
    render(<SignInForm deploymentMode="private" />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to ReDDone.");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Return to the control plane.");
  });

  it("marks required signup fields and associates invalid input with stable feedback", async () => {
    render(<SignUpForm />);

    const name = screen.getByLabelText("Owner name");
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText(/^Password/);
    const confirmation = screen.getByLabelText("Confirm password");
    for (const input of [name, email, password, confirmation]) expect(input).toBeRequired();

    fireEvent.change(name, { target: { value: "N" } });
    fireEvent.change(email, { target: { value: "nora@example.com" } });
    fireEvent.change(password, { target: { value: "long public password" } });
    fireEvent.change(confirmation, { target: { value: "long public password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("id", "sign-up-form-feedback");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "sign-up-form-feedback");
    expect(email).not.toHaveAttribute("aria-invalid");
  });

  it("creates an invite-gated owner and signs in with the return path", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { created: true } }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "/onboarding?returnTo=%2Fprojects%2Fnew%3Fsource%3Dpricing" }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<SignUpForm returnTo="/projects/new?source=pricing" />);

    fireEvent.change(screen.getByLabelText("Owner name"), { target: { value: "Nora" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nora@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "long public password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "long public password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "Nora",
      email: "nora@example.com",
      password: "long public password",
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/owner/register", expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/auth/sign-in/email", expect.objectContaining({
      body: JSON.stringify({
        email: "nora@example.com",
        password: "long public password",
        rememberMe: true,
        callbackURL: "/onboarding?returnTo=%2Fprojects%2Fnew%3Fsource%3Dpricing",
      }),
    }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/onboarding?returnTo=%2Fprojects%2Fnew%3Fsource%3Dpricing"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("returns to beta access when the invite session is unavailable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Review the owner details and access code." } }), { status: 400, headers: { "content-type": "application/json" } }));
    render(<SignUpForm returnTo="/projects" />);

    fireEvent.change(screen.getByLabelText("Owner name"), { target: { value: "Nora" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nora@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "long public password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "long public password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/owner/register", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Nora", email: "nora@example.com", password: "long public password" }),
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review the owner details and access code.");
    expect(screen.getByRole("link", { name: "Use a different invite" })).toHaveAttribute("href", "/beta#invite");
    expect(replace).not.toHaveBeenCalled();
  });
});
