import { createHash } from "node:crypto";

/** Fresh same-human checks for World-gated consequential actions. */

/** Only a hash of the World sub is ever stored — never the raw value. */
export function hashSub(sub: string): string {
  return createHash("sha256").update(sub).digest("hex");
}

/**
 * For max_age=0 step-up, authentication must belong to this attempt: no
 * earlier than when it started, not in the
 * future, and within the session lifetime. Never trust `iat` (an old browser
 * session keeps the original auth_time).
 */
export function isFreshForAttempt(
  authTime: number,
  attemptStartedAt: number,
  now = Math.floor(Date.now() / 1000),
  sessionTtlSec = 600,
  clockSkewSec = 60,
): boolean {
  return (
    authTime >= attemptStartedAt - clockSkewSec &&
    authTime <= now + clockSkewSec &&
    now - authTime <= sessionTtlSec
  );
}
