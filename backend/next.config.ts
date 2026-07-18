import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" }
];
const vercelIntegrationHeaders = securityHeaders.map((header) =>
  header.key === "Cross-Origin-Opener-Policy"
    ? { ...header, value: "unsafe-none" }
    : header,
);

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  outputFileTracingRoot: __dirname,
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      { source: "/api/integrations/vercel/:path*", headers: vercelIntegrationHeaders },
    ];
  },
  async redirects() {
    return [
      { source: "/signin", destination: "/sign-in", permanent: true },
    ];
  },
};

export default withWorkflow(nextConfig);
