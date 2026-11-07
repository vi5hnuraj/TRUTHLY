import { resolvesToPublic } from "./public-host";
import { createHash } from "node:crypto";

/**
 * Fetches a cited source and reduces it to readable text Herald can judge:
 * title, meta description, then the page's main text, capped in length.
 */
const FETCH_TIMEOUT_MS = 6_000;
const MAX_TEXT_CHARS = 2_500;
const MAX_BODY_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;
const MIN_MAIN_CHARS = 400;
// Some newsrooms reset a share of automated connections; retry those (never timeouts).
const NETWORK_ATTEMPTS = 4;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface SourceText {
  url: string;
  text: string;
  title: string | null;
  published_at: string | null;
  content_hash: string;
  fetched_at: string;
}

// Loopback, link-local, private and internal hosts (the URL parser normalises
// numeric IPv4 forms like 2130706433 to dotted quads before this runs).
const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[.*\])$/i;

/** Public http(s) URLs only: no credentials, no loopback/private/internal hosts. */
export function fetchableUrl(raw: string, base?: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || PRIVATE_HOST.test(url.hostname))
    return null;
  return url;
}

async function fetchWithRetry(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted || attempt >= NETWORK_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/** Follows redirects by hand so every hop passes the same public-URL and public-DNS check. */
export async function fetchPublic(
  start: string,
  signal: AbortSignal,
  method: "GET" | "HEAD" = "GET",
): Promise<Response> {
  let url = fetchableUrl(start);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    if (!(await resolvesToPublic(url.hostname))) break;
    const response = await fetchWithRetry(
      url,
      {
        method,
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      signal,
    );
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location)
      return response;
    await response.body?.cancel();
    url = fetchableUrl(location, url.href);
  }
  throw new Error(
    url ? "too many redirects" : "URL is not a public http(s) address",
  );
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= maxBytes) await reader.cancel();
  return new TextDecoder("utf-8").decode(
    Buffer.concat(chunks).subarray(0, maxBytes),
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, code: string) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? match;
      const point =
        code[1].toLowerCase() === "x"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    },
  );
}

function toPlain(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function metaDescription(html: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (
      !/(name|property)\s*=\s*["']?(description|og:description|twitter:description)["'\s>/]/i.test(
        tag,
      )
    )
      continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (content) return toPlain(content[1] ?? content[2] ?? "");
  }
  return "";
}

function documentTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const value = match ? toPlain(match[1]) : "";
  return value || null;
}

function publicationTimestamp(html: string): string | null {
  const candidates: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/(article:published_time|datePublished|date|pubdate)/i.test(tag)) continue;
    const content = /content\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tag);
    if (content) candidates.push(content[1] ?? content[2] ?? "");
  }
  for (const match of html.matchAll(/"datePublished"\s*:\s*"([^"]+)"/gi)) {
    candidates.push(match[1]);
  }
  for (const candidate of candidates) {
    const time = Date.parse(decodeEntities(candidate));
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  return null;
}

const DROPPED_BLOCKS =
  /<(script|style|noscript|nav|svg|template|head|footer|iframe)\b[\s\S]*?<\/\1\s*>/gi;

/** Prefers the <article>/<main> region when it holds real text, else the whole page. */
function mainText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(DROPPED_BLOCKS, " ");
  for (const tag of ["article", "main"]) {
    const region = new RegExp(
      `<${tag}\\b[^>]*>([\\s\\S]*)</${tag}\\s*>`,
      "i",
    ).exec(cleaned);
    const text = region ? toPlain(region[1]) : "";
    if (text.length >= MIN_MAIN_CHARS) return text;
  }
  return toPlain(cleaned);
}

/** Title + meta description + main text, whitespace-collapsed and capped at `maxChars`. */
export function htmlToText(html: string, maxChars = MAX_TEXT_CHARS): string {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch ? toPlain(titleMatch[1]) : "";
  const description = metaDescription(html);
  const parts = [
    title && `Title: ${title}`,
    description && `Description: ${description}`,
    mainText(html),
  ];
  const text = parts.filter((part) => part).join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Fetches one source and returns its readable text. Throws with a short reason on failure. */
export async function fetchSourceText(url: string): Promise<SourceText> {
  const response = await fetchPublic(
    url,
    AbortSignal.timeout(FETCH_TIMEOUT_MS),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (type && !/text\/|html|xml|json/i.test(type)) {
    await response.body?.cancel();
    throw new Error(`unsupported content type ${type.split(";")[0]}`);
  }
  const raw = await readCapped(response, MAX_BODY_BYTES);
  const text = htmlToText(raw);
  if (!text) throw new Error("no readable text");
  // response.url is the parsed, percent-encoded final hop, safer to quote in a prompt.
  return {
    url: response.url || url,
    text,
    title: documentTitle(raw),
    published_at: publicationTimestamp(raw),
    content_hash: createHash("sha256").update(text).digest("hex"),
    fetched_at: new Date().toISOString(),
  };
}
