import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@jarvis/core"],
  async rewrites() {
    // Same-origin API in dev and behind a single reverse proxy in prod; the websocket goes direct (see lib/live.tsx).
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
