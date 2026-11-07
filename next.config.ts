import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 blocks dev resources from any origin it did not expect, which
  // silently kills hydration (every click goes dead). Allow both loopback
  // spellings so localhost and 127.0.0.1 behave identically in development.
  allowedDevOrigins: ["127.0.0.1"],
  async redirects() {
    return [
      { source: "/leaderboard", destination: "/agents", permanent: false },
    ];
  },
};

export default nextConfig;
