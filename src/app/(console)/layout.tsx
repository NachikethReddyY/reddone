import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { ConsoleQueryProvider } from "@/components/query-provider";
import { safeReturnTo } from "@/policy/return-to";
import { getOwnerSession } from "@/server/better-auth";
import { isDemoMode } from "@/server/env";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  if (!isDemoMode()) {
    const requestHeaders = await headers();
    const session = await getOwnerSession(new Request("https://console.invalid", { headers: requestHeaders }));
    if (!session) {
      const returnTo = safeReturnTo(requestHeaders.get("x-reddone-return-to"));
      redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }

  return (
    <ConsoleQueryProvider>
      <AppShell>{children}</AppShell>
    </ConsoleQueryProvider>
  );
}
