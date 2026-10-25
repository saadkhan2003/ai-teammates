import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: { "/page-renderer": ["./lib/pages-renderer.mjs"] },
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ["@novnc/novnc"],
  images: {
    dangerouslyAllowSVG: false,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  experimental: { optimizePackageImports: ["lucide-react"] },
};

export default nextConfig;
