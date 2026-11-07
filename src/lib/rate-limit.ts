import { NextRequest, NextResponse } from "next/server";

const requests = new Map<string, number[]>();
const WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX = 20;

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function checkRateLimit(
  req: NextRequest,
  maxRequests = DEFAULT_MAX,
): NextResponse | null {
  const ip = getClientIp(req);
  const now = Date.now();
  const timestamps = (requests.get(ip) || []).filter((t) => now - t < WINDOW_MS);

  if (timestamps.length >= maxRequests) {
    return NextResponse.json(
      { error: "Too many requests. Try again later." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  timestamps.push(now);
  requests.set(ip, timestamps);

  // Probabilistic cleanup (serverless-safe)
  if (Math.random() < 0.02) {
    const cutoff = now - WINDOW_MS;
    for (const [key, ts] of requests) {
      const recent = ts.filter((t) => t > cutoff);
      if (recent.length === 0) requests.delete(key);
      else requests.set(key, recent);
    }
  }

  return null;
}
