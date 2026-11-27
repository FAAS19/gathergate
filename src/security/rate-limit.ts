import type { Context } from "hono";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Fixed-window in-memory rate limiter suitable for single-instance self-hosted deployments. */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxBuckets = 10_000
  ) {}

  check(key: string, limit: number, windowMs: number): RateLimitResult {
    const current = this.now();
    if (this.buckets.size >= this.maxBuckets && !this.buckets.has(key)) {
      for (const [k, entry] of this.buckets) {
        if (entry.resetAt <= current) this.buckets.delete(k);
      }
      while (this.buckets.size >= this.maxBuckets) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey === undefined) break;
        this.buckets.delete(oldestKey);
      }
    }

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= current) {
      this.buckets.delete(key);
      this.buckets.set(key, { count: 1, resetAt: current + windowMs });
      return {
        allowed: true,
        remaining: Math.max(0, limit - 1),
        retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
      };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - current) / 1000)),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - existing.count),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - current) / 1000)),
    };
  }
}

export function extractClientIp(c: Context, trustProxy: boolean): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const socketIp = incoming?.socket?.remoteAddress?.trim() || "";

  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const rightmost = parts[parts.length - 1];
      if (rightmost) return rightmost.slice(0, 64);
    }

    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp.slice(0, 64);

    const cfIp = c.req.header("cf-connecting-ip")?.trim();
    if (cfIp) return cfIp.slice(0, 64);
  }

  return socketIp ? socketIp.slice(0, 64) : "unknown";
}
