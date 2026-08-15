import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@liberty/contracts",
    "@liberty/media-engine",
    "@liberty/observability",
    "@liberty/provider-sdk"
  ]
};

export default nextConfig;
