import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: { "/page-renderer": ["./lib/pages-renderer.mjs"] },
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@novnc/novnc"],
};

export default nextConfig;
