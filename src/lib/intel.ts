import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { retryRead } from "./db/retry";
import { ERA_START, currentSignal, publishedEdition } from "./era";
import { splitTags } from "./act-on";
import {
  buildPublicDecisionBrief,
  decisionCouncilFromStoredRun,
  type DecisionCouncilInput,
} from "./flash/decision-brief";
import { readVerification, type PublicVerification } from "./herald/verification";
import {
  independentOwnerGroups,
  sourceMetadataListSchema,
  type SourceMetadata,
} from "./evidence";
import {
  EDITION_PRICE_CENTS,
  FILING_FEE_CENTS,
  INTEL_EXCERPT_CHARS,
  SIGNAL_PRICE_CENTS,
} from "./constants";
import { formatUsdcAtomic } from "./usdc";
import { publicCouncilRun } from "./council/store";

/**
 * Individual intelligence purchase: one x402 payment buys exactly one
 * published story — body, sources, claims, Herald's fact-check and archive —
 * and mints a signal-scoped entitlement. That entitlement id is the receipt a
 * trading agent must present to POST /api/flash/trade for the same story.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

type Db = Awaited<ReturnType<typeof getDb>>;

export interface SignalBaseRow {
  id: string;
  headline: string;
  body: string;
  beat: string;
  status: string;
  score: number | null;
  tags: string;
  sources: string;
  sourceMetadata: string | null;
  claims: string | null;
  verification: string | null;
  stakeAtomic: string;
  stakeStatus: string;
  createdAt: string;
  agentId: string;
  reporterName: string | null;
  reporterAddress: string | null;
  editionId: string | null;
  editionNumber: number | null;
  editionStatus: string | null;
}

/** A purchasable story: always carried by a published edition. */
export type SignalIntelRow = SignalBaseRow & { editionId: string; editionNumber: number };

export type SignalLookup =
  | { ok: true; row: SignalIntelRow }
  | {
      ok: false;
      reason:
        | "invalid_signal_id"
        | "signal_not_found"
        | "not_in_published_edition"
        | "story_unavailable";
    };

export type PublicLookup =
  | { ok: true; row: SignalBaseRow }
  | { ok: false; reason: "invalid_signal_id" | "signal_not_found" };

function intelQuery(db: Db) {
  return db
    .select({
      id: schema.signals.id,
      headline: schema.signals.headline,
      body: schema.signals.body,
      beat: schema.signals.beat,
      status: schema.signals.status,
      score: schema.signals.score,
      tags: schema.signals.tags,
      sources: schema.signals.sources,
      sourceMetadata: schema.signals.sourceMetadata,
      claims: schema.signals.claims,
      verification: schema.signals.verification,
      stakeAtomic: schema.signals.stakeAtomic,
      stakeStatus: schema.signals.stakeStatus,
      createdAt: schema.signals.createdAt,
      agentId: schema.signals.agentId,
      reporterName: schema.agents.name,
      reporterAddress: schema.agents.address,
      editionId: schema.editions.id,
      editionNumber: schema.editions.number,
      editionStatus: schema.editions.status,
    })
    .from(schema.signals)
    .leftJoin(schema.editionSignals, eq(schema.editionSignals.signalId, schema.signals.id))
    .leftJoin(schema.editions, eq(schema.editions.id, schema.editionSignals.editionId))
    .leftJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id));
}

/**
 * A story is for sale only once it sits in a published edition and has not
 * been retracted or rejected — the same rule that makes it tradeable, so what
 * you can buy and what you can trade on always agree.
 */
export async function findSignalForSale(signalId: string): Promise<SignalLookup> {
  if (!isUuid(signalId)) return { ok: false, reason: "invalid_signal_id" };
  const db = await getDb();

  const row = await retryRead(() =>
    intelQuery(db)
      .where(and(eq(schema.signals.id, signalId), currentSignal, publishedEdition))
      .orderBy(desc(schema.editions.number))
      .limit(1)
      .get(),
  );

  if (!row) {
    const bare = await retryRead(() =>
      db
        .select({ status: schema.signals.status, createdAt: schema.signals.createdAt })
        .from(schema.signals)
        .where(eq(schema.signals.id, signalId))
        .get(),
    );
    if (!bare || bare.createdAt < ERA_START) return { ok: false, reason: "signal_not_found" };
    if (["retracted", "rejected"].includes(bare.status)) {
      return { ok: false, reason: "story_unavailable" };
    }
    return { ok: false, reason: "not_in_published_edition" };
  }

  if (["retracted", "rejected"].includes(row.status)) {
    return { ok: false, reason: "story_unavailable" };
  }
  // publishedEdition in the WHERE clause guarantees both are present.
  return { ok: true, row: { ...row, editionId: row.editionId!, editionNumber: row.editionNumber! } };
}

/** Any current wire story — published or not — for the free public teaser. */
export async function findPublicSignal(signalId: string): Promise<PublicLookup> {
  if (!isUuid(signalId)) return { ok: false, reason: "invalid_signal_id" };
  const db = await getDb();
  const row = await retryRead(() =>
    intelQuery(db)
      .where(and(eq(schema.signals.id, signalId), currentSignal))
      .orderBy(desc(schema.editions.number))
      .limit(1)
      .get(),
  );
  return row ? { ok: true, row } : { ok: false, reason: "signal_not_found" };
}

/** The free sample: whitespace-collapsed body text, cut on a word boundary. */
export function signalExcerpt(body: string, maxChars = INTEL_EXCERPT_CHARS): string {
  const clean = body.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const head = clean.slice(0, maxChars);
  const trimmed = head.replace(/\s+\S*$/, "");
  return `${trimmed || head.trimEnd()}…`;
}

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string | null): SourceMetadata[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = sourceMetadataListSchema.safeParse(
      Array.isArray(value)
        ? value.filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          )
        : [],
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Herald's fact-check spend in atomic USDC — a real DIY input cost. */
function factCheckCostAtomic(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object") {
      const cost = (value as { cost_atomic?: unknown }).cost_atomic;
      if (typeof cost === "string" && /^\d+$/.test(cost)) return cost;
    }
  } catch {
    return null;
  }
  return null;
}

export type ReceiptCheck =
  | {
      ok: true;
      entitlement: typeof schema.entitlements.$inferSelect;
      payment: typeof schema.payments.$inferSelect;
    }
  | { ok: false; reason: "receipt_unknown" | "receipt_wrong_story" | "receipt_wrong_account" };

/**
 * The receipt gate. A receipt is valid only for the story it was minted for,
 * and — when the caller has an identity — only for the wallet that paid.
 */
export async function verifySignalReceipt(input: {
  receiptId: string;
  signalId: string;
  /** Lowercase wallet addresses allowed to spend this receipt. */
  allowedAccounts?: string[];
}): Promise<ReceiptCheck> {
  const receiptId = input.receiptId?.trim();
  if (!receiptId) return { ok: false, reason: "receipt_unknown" };

  const db = await getDb();
  const row = await retryRead(() =>
    db
      .select({ entitlement: schema.entitlements, payment: schema.payments })
      .from(schema.entitlements)
      .innerJoin(schema.payments, eq(schema.payments.id, schema.entitlements.paymentId))
      .where(eq(schema.entitlements.id, receiptId))
      .get(),
  );

  if (!row || !row.entitlement.signalId) return { ok: false, reason: "receipt_unknown" };
  if (row.entitlement.signalId !== input.signalId) {
    return { ok: false, reason: "receipt_wrong_story" };
  }
  const allowed = (input.allowedAccounts ?? [])
    .map((account) => account.toLowerCase().trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(row.entitlement.accountId.toLowerCase())) {
    return { ok: false, reason: "receipt_wrong_account" };
  }
  return { ok: true, entitlement: row.entitlement, payment: row.payment };
}

export interface IntelReceipt {
  receipt_id: string | null;
  signal_id: string;
  paid_usd: string;
  payer: string | null;
  transaction: string | null;
  network: string | null;
  granted_at: string | null;
  note: string;
}

export type IntelPayment = {
  payer: string;
  transaction: string | null;
  network: string | null;
};

export function intelReceipt(
  row: SignalIntelRow,
  opts: { entitlementId?: string | null; payment?: IntelPayment | null; grantedAt?: string | null },
): IntelReceipt {
  return {
    receipt_id: opts.entitlementId ?? null,
    signal_id: row.id,
    paid_usd: (SIGNAL_PRICE_CENTS / 100).toFixed(2),
    payer: opts.payment?.payer ?? null,
    transaction: opts.payment?.transaction ?? null,
    network: opts.payment?.network ?? null,
    granted_at: opts.grantedAt ?? null,
    note: opts.entitlementId
      ? "This receipt is the entitlement a trade must present: POST /api/flash/trade with receipt=<receipt_id>."
      : "The payment settled but the entitlement write failed — do not pay again; quote this transaction to support.",
  };
}

/**
 * What a reader must still build to replace this purchase. Priced in real
 * cash outlays already spent by the newsroom, not in vibes.
 */
export function diyVsBuy(row: SignalBaseRow, verification: PublicVerification | null) {
  const factCheckAtomic = factCheckCostAtomic(row.verification);
  return {
    price_cents: SIGNAL_PRICE_CENTS,
    price_usd: (SIGNAL_PRICE_CENTS / 100).toFixed(2),
    buy: {
      cost_usd: (SIGNAL_PRICE_CENTS / 100).toFixed(2),
      gets: [
        "the full story body and its structured claims",
        "every cited source with metadata and content hashes",
        "Herald's fact-check verdict, notes and per-claim checks",
        "the source archive and correction history",
        "the receipt that unlocks a Flash trade on this story",
      ],
    },
    diy: {
      filing_stake_cents: FILING_FEE_CENTS,
      fact_check_atomic: factCheckAtomic,
      fact_check_usd:
        factCheckAtomic && BigInt(factCheckAtomic) > BigInt(0)
          ? (Number(factCheckAtomic) / 1_000_000).toFixed(6)
          : null,
      steps: [
        "scout the story from RSS, GitHub and governance feeds",
        "fetch, hash and archive each source yourself",
        "run and pay for an LLM fact-check on every claim",
        "lock a 1¢ stake and settle refunds or slashes",
        "serve metered reads over x402 and handle disputes",
      ],
      note:
        "Cash outlay alone is the 1¢ filing stake plus the paid fact-check call " +
        "(the ledger shows exactly what this story's check cost); the rest is the " +
        "pipeline you would have to build, operate and keep honest.",
    },
    full_edition: {
      price_cents: EDITION_PRICE_CENTS,
      detail: "A complete four-story edition still costs $0.05, with 80% paid to its reporters.",
    },
    verdict: verification?.verdict ?? "unchecked",
  };
}

function actOnOf(row: { tags: string }) {
  return splitTags(parseStringList(row.tags)).actOn;
}

/** The free public teaser: enough to decide, never the product itself. */
export function buildSignalTeaser(
  row: SignalBaseRow,
  opts: {
    snapshotCount: number;
    verification: PublicVerification | null;
    council?: DecisionCouncilInput | null;
  },
) {
  const sources = parseStringList(row.sources);
  const metadata = parseMetadata(row.sourceMetadata);
  const claims = (() => {
    try {
      const value: unknown = JSON.parse(row.claims ?? "[]");
      return Array.isArray(value) ? value.length : 0;
    } catch {
      return 0;
    }
  })();
  const withdrawn = ["retracted", "rejected"].includes(row.status);
  const actOn = actOnOf(row);

  return {
    signal: {
      id: row.id,
      headline: row.headline,
      beat: row.beat,
      score: row.score,
      status: row.status,
      created_at: row.createdAt,
      edition_number: row.editionStatus === "published" ? row.editionNumber : null,
      reporter: { name: row.reporterName ?? "Unknown", address: row.reporterAddress ?? "" },
    },
    excerpt: withdrawn ? "" : signalExcerpt(row.body),
    withdrawn_notice: withdrawn
      ? row.status === "retracted"
        ? "This story was retracted. Its correction history stays public."
        : "This story was rejected by the editor and is not for sale."
      : null,
    evidence_summary: {
      verdict: opts.verification?.verdict ?? null,
      source_count: withdrawn ? 0 : sources.length,
      independent_owner_groups: withdrawn
        ? 0
        : independentOwnerGroups(sources, metadata).length,
      claim_count: withdrawn ? 0 : claims,
      snapshot_count: withdrawn ? 0 : opts.snapshotCount,
      stake_status: row.stakeStatus,
      stake_locked: formatUsdcAtomic(row.stakeAtomic || "0"),
    },
    act_on: actOn,
    execution: buildPublicDecisionBrief({
      status: row.status,
      published: row.editionStatus === "published",
      verdict: opts.verification?.verdict ?? null,
      stakeStatus: row.stakeStatus,
      tokens: actOn.tokens,
      council: opts.council,
    }),
    price: {
      cents: SIGNAL_PRICE_CENTS,
      usd: (SIGNAL_PRICE_CENTS / 100).toFixed(2),
      network: "Base mainnet USDC via x402",
      endpoint: `GET /api/intel/${row.id}`,
      re_read_header: "x-receipt: <receipt_id>",
      mcp_tool: "truthly_read_signal",
      for_sale: !withdrawn && row.editionStatus === "published",
    },
    diy_vs_buy: diyVsBuy(row, opts.verification),
    purchase_note: withdrawn
      ? "This story is no longer for sale."
      : row.editionStatus === "published"
        ? "The excerpt above is free. Body, sources, claims, Herald's notes and the archive are the product: " +
          `pay $${(SIGNAL_PRICE_CENTS / 100).toFixed(2)} over x402 for this story alone.`
        : "This story is filed but not yet in a published edition, so it is not for sale yet.",
  };
}

/** The purchased product: everything about one story, plus its receipt. */
export async function buildSignalIntel(
  row: SignalIntelRow,
  opts: {
    entitlementId?: string | null;
    payment?: IntelPayment | null;
    grantedAt?: string | null;
  },
) {
  const db = await getDb();
  const [snapshots, revisions, councilRun] = await Promise.all([
    retryRead(() =>
      db
        .select()
        .from(schema.sourceSnapshots)
        .where(eq(schema.sourceSnapshots.signalId, row.id))
        .all(),
    ),
    retryRead(() =>
      db
        .select()
        .from(schema.signalRevisions)
        .where(eq(schema.signalRevisions.signalId, row.id))
        .all(),
    ),
    retryRead(() =>
      db
        .select()
        .from(schema.councilRuns)
        .where(
          and(
            eq(schema.councilRuns.sourceSignalId, row.id),
            eq(schema.councilRuns.mode, "live"),
            eq(schema.councilRuns.status, "completed"),
          ),
        )
        .orderBy(desc(schema.councilRuns.createdAt))
        .limit(1)
        .get(),
    ),
  ]);

  const verification = readVerification(row.verification);
  const withdrawn = ["retracted", "rejected"].includes(row.status);
  const sources = parseStringList(row.sources);
  const metadata = parseMetadata(row.sourceMetadata);
  const actOn = actOnOf(row);
  const councilDecision = decisionCouncilFromStoredRun(councilRun);

  return {
    signal: {
      id: row.id,
      headline: row.headline,
      body: withdrawn ? "" : row.body,
      beat: row.beat,
      score: row.score,
      status: row.status,
      created_at: row.createdAt,
      retraction_notice: withdrawn
        ? revisions.filter((revision) => revision.action === "retracted").at(-1)?.reason ??
          "This story was retracted."
        : null,
      tags: splitTags(parseStringList(row.tags)).tags,
      act_on: actOn,
    },
    sources: withdrawn ? [] : sources,
    source_metadata: withdrawn ? [] : metadata,
    source_ownership_groups: withdrawn ? [] : independentOwnerGroups(sources, metadata),
    claims: withdrawn ? [] : parseClaimObjects(row.claims),
    source_archive: snapshots.map((snapshot) => ({
      url: snapshot.url,
      content_hash: snapshot.contentHash,
      title: snapshot.title,
      published_at: snapshot.publishedAt,
      fetched_at: snapshot.fetchedAt,
    })),
    correction_history: revisions.map((revision) => ({
      action: revision.action,
      reason: revision.reason,
      actor: revision.actor,
      at: revision.createdAt,
    })),
    verification,
    stake: {
      status: row.stakeStatus,
      locked: formatUsdcAtomic(row.stakeAtomic || "0"),
      atomic: row.stakeAtomic,
    },
    reporter: { name: row.reporterName ?? "Unknown", address: row.reporterAddress ?? "" },
    edition: { id: row.editionId, number: row.editionNumber },
    receipt: intelReceipt(row, opts),
    trading_intelligence_council: councilRun ? publicCouncilRun(councilRun) : null,
    execution: buildPublicDecisionBrief({
      status: row.status,
      published: true,
      verdict: verification?.verdict ?? null,
      stakeStatus: row.stakeStatus,
      tokens: actOn.tokens,
      council: councilDecision,
    }),
    excerpt: signalExcerpt(row.body),
    diy_vs_buy: diyVsBuy(row, verification),
    act_on_guide:
      "act_on.world_market_search is a query for World's world_search; act_on.tokens are symbols to look up with discover_tokens. Read-only checks first; any trade still needs this story's receipt and the user's approval.",
  };
}

function parseClaimObjects(raw: string | null): Record<string, unknown>[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}
