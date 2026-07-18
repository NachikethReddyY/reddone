import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ThemeProvider, type ThemePreference } from "@/components/theme-provider";
import "./globals.css";
import "./responsive.css";

const sans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "ReDDone", template: "%s · ReDDone" },
  description: "Private evidence-to-software control plane.",
  icons: { icon: "/reddone-mark.svg" },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F7F5" },
    { media: "(prefers-color-scheme: dark)", color: "#11110F" },
  ],
  width: "device-width",
  initialScale: 1,
};

const themeCookie = "reddone-theme";

function isThemePreference(value: string | undefined): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

const themeBootScript = `(() => {
  const key = ${JSON.stringify(themeCookie)};
  const valid = (value) => value === "system" || value === "light" || value === "dark";
  const local = window.localStorage.getItem(key);
  const cookie = document.cookie.split("; ").find((entry) => entry.startsWith(key + "="))?.split("=")[1];
  const preference = valid(cookie) ? cookie : valid(local) ? local : document.documentElement.dataset.themePreference || "system";
  const resolved = preference === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
})();`;

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const cookiePreference = cookieStore.get(themeCookie)?.value;
  const initialPreference: ThemePreference = isThemePreference(cookiePreference) ? cookiePreference : "system";
  const explicitTheme = initialPreference === "system" ? undefined : initialPreference;

  return (
    <html
      className={`${sans.variable} ${mono.variable}`}
      data-theme={explicitTheme}
      data-theme-preference={initialPreference}
      lang="en"
      style={{ colorScheme: explicitTheme ?? "light dark" }}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <ThemeProvider initialPreference={initialPreference}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
