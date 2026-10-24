import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@novnc/novnc"],
  experimental: { optimizePackageImports: ["lucide-react"] },
};

export default nextConfig;
