import type { NextConfig } from "next";

const staticPreview = process.env.REDDONE_STATIC_PREVIEW === "1";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: process.cwd() },
  ...(staticPreview
    ? {
        output: "export" as const,
        distDir: ".reddone-runtime/preview-static",
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
