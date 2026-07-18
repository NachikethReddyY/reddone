import type { Metadata } from "next";

import "./generated/app.css";

export const metadata: Metadata = {
  title: "Generated with ReDDone",
  description: "An approval-gated application generated from attributable product evidence.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
