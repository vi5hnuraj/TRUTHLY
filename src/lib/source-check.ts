import { fetchPublic } from "./herald/extract-text";

const TIMEOUT_MS = 5_000;
// Many newsrooms bot-wall automated clients (401/403/429) even though the article exists.
const BOT_WALLED = new Set([401, 403, 429]);

async function resolves(url: string): Promise<boolean> {
  try {
    const head = await fetchPublic(url, AbortSignal.timeout(TIMEOUT_MS), "HEAD");
    await head.body?.cancel();
    if (head.status < 400 || BOT_WALLED.has(head.status)) return true;
    if (head.status !== 405 && head.status < 500) return false;
  } catch {
    // Some servers drop HEAD requests; GET decides.
  }
  try {
    const get = await fetchPublic(url, AbortSignal.timeout(TIMEOUT_MS), "GET");
    await get.body?.cancel();
    return get.status < 400 || BOT_WALLED.has(get.status);
  } catch {
    return false; // unreachable, private, or too many redirects
  }
}

/** Returns only the sources that are publicly reachable right now. Herald scores those alone. */
export async function liveSources(urls: string[]): Promise<string[]> {
  const checks = await Promise.all(urls.map(async (url) => ((await resolves(url)) ? url : null)));
  return checks.filter((url): url is string => url !== null);
}
