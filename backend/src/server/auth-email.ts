import "server-only";

import { getRuntimeConfig } from "./env";

export type AuthEmailKind = "verification" | "password-reset";

export interface AuthEmailMessage {
  kind: AuthEmailKind;
  to: string;
  name?: string | null;
  url: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]!);
}

function contentFor(message: AuthEmailMessage) {
  const action = message.kind === "verification" ? "Verify email" : "Reset password";
  const introduction = message.kind === "verification"
    ? "Verify this email address to activate your ReDDone workspace."
    : "Use this secure link to choose a new ReDDone password.";
  const greeting = message.name?.trim() ? `Hello ${message.name.trim()},` : "Hello,";
  const text = `${greeting}\n\n${introduction}\n\n${message.url}\n\nIf you did not request this, you can ignore this message.`;
  const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(introduction)}</p><p><a href="${escapeHtml(message.url)}">${action}</a></p><p>If you did not request this, you can ignore this message.</p>`;
  return { action, text, html };
}

export function isAuthEmailDeliveryAvailable(): boolean {
  return getRuntimeConfig().auth.emailDelivery.kind !== "unavailable";
}

export async function deliverAuthEmail(message: AuthEmailMessage): Promise<void> {
  const delivery = getRuntimeConfig().auth.emailDelivery;
  const content = contentFor(message);

  if (delivery.kind === "unavailable") {
    throw new Error("Transactional email delivery is not configured.");
  }

  if (delivery.kind === "log") {
    console.info("[auth-email]", JSON.stringify({
      kind: message.kind,
      to: message.to,
      subject: content.action,
      url: message.url,
    }));
    return;
  }

  const response = await fetch(delivery.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${delivery.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      category: `auth.${message.kind}`,
      from: delivery.from,
      to: message.to,
      subject: content.action,
      text: content.text,
      html: content.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Transactional email delivery failed with status ${response.status}.`);
  }
}
