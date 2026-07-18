import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { ConsoleQueryProvider } from "@/components/query-provider";

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <ConsoleQueryProvider>
      <AppShell>{children}</AppShell>
    </ConsoleQueryProvider>
  );
}
