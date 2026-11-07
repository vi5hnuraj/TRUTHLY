"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import CryptoChart from "@/components/trades/crypto-chart";
import styles from "./page.module.css";

type Gate = {
  key: "published" | "herald" | "stake" | "asset" | "council";
  label: string;
  passed: boolean;
  state: string;
};

type DecisionBrief = {
  story_eligible: boolean;
  execution_eligible: boolean;
  status: string;
  label: string;
  detail: string;
  asset: {
    symbol: "ETH";
    execution_symbol: "WETH";
    network: string;
    pair: string;
    venue: string;
    reference: string;
    address: string;
  } | null;
  direction: { action: "BUY" | "SELL" | "HOLD" | null; label: string; detail: string };
  plan: {
    council_run_id: string;
    entry_price_usd: string;
    stop_loss_price_usd: string;
    take_profit_price_usd: string;
    risk_reward: string | null;
    valid_until: string;
  } | null;
  gates: Gate[];
};

type DeskBrief = {
  id: string;
  headline: string;
  beat: string;
  score: number | null;
  created_at: string;
  edition_number: number;
  verdict: string | null;
  stake_status: string;
  tokens: string[];
  reporter: { name: string; address: string };
  execution: DecisionBrief;
  signal_quality: SignalQuality;
  council_summary: PublicCouncilSummary | null;
  private_council_available: boolean;
  private_council_valid_until: string | null;
};

type Trade = {
  id: string;
  signalId: string | null;
  side: string;
  qty: string;
  tokenSymbol: string | null;
  targetAsset: string;
  orderId: string | null;
  status: string;
  error: string | null;
  rationale: string | null;
  receiptId: string | null;
  orderType: string;
  limitPriceUsd: string | null;
  orderExpiresAt: string | null;
  takeProfitPriceUsd: string | null;
  stopLossPriceUsd: string | null;
  bracketStatus: string | null;
  providerStatus: string | null;
  fillCount: number;
  fillTransaction: string | null;
  spentNotional: string | null;
  receivedNotional: string | null;
  marketGuardStatus: string | null;
  uniswapRouting: string | null;
  uniswapPriceUsd: string | null;
  marketDeviationBps: string | null;
  createdAt: string;
};

type DeskResponse = {
  desk_armed: boolean;
  uniswap_configured: boolean;
  maximum_trade_usdc: string;
  briefs: DeskBrief[];
  trades: Trade[];
};

type SignalTeaser = {
  signal: {
    id: string;
    headline: string;
    beat: string;
    score: number | null;
    status: string;
    created_at: string;
    edition_number: number | null;
    reporter: { name: string; address: string };
  };
  excerpt: string;
  evidence_summary: {
    verdict: string | null;
    source_count: number;
    independent_owner_groups: number;
    claim_count: number;
    snapshot_count: number;
    stake_status: string;
    stake_locked: string;
  };
  act_on: { world_market_search: string | null; tokens: string[] };
  execution: DecisionBrief;
  price: { usd: string; for_sale: boolean };
};

type CouncilOpinion = {
  role: string;
  vote: string;
  confidence: number;
  reasoning: string;
  risk_flags: string[];
  veto: boolean;
};

type CouncilResult = {
  action: "BUY" | "SELL" | "HOLD";
  consensus: string;
  consensusConfidence: number;
  reasoning: string;
  disagreements: string[];
  entryPriceUsd: string | null;
  stopLossPriceUsd: string | null;
  takeProfitPriceUsd: string | null;
  riskReward: string | null;
  executionEligible: boolean;
  opinions: CouncilOpinion[];
  validUntil: string;
};

type CouncilRun = {
  id: string;
  status: string;
  valid_until: string | null;
  market_snapshot: {
    executionQuote?: { impliedPriceUsd?: string; providerQuoteId?: string; fetchedAt?: string };
    referenceQuote?: {
      impliedPriceUsd?: string;
      providerRequestId?: string;
      providerQuoteId?: string;
      routing?: string;
      protocols?: string[];
    } | null;
    integrity?: { status?: string; deviationBps?: string | null; maximumDeviationBps?: number };
  } | null;
  council: CouncilResult | null;
};

type PublicCouncilSummary = {
  id: string;
  status: string;
  valid_until: string | null;
  generated_at: string;
  action: "BUY" | "SELL" | "HOLD";
  consensus: string;
  consensus_confidence: number;
  execution_eligible: boolean;
  entry_price_usd: string | null;
  stop_loss_price_usd: string | null;
  take_profit_price_usd: string | null;
  risk_reward: string | null;
  agents: Array<{
    role: string;
    vote: string;
    confidence: number;
    veto: boolean;
  }>;
  market: {
    definitive_price_usd: string;
    definitive_quote_id: string;
    uniswap_price_usd: string | null;
    uniswap_request_id: string | null;
    uniswap_quote_id: string | null;
    uniswap_routing: string | null;
    uniswap_protocols: string[];
    integrity_status: string;
    deviation_bps: string | null;
    maximum_deviation_bps: number;
    checked_at: string;
  };
};

type SignalQuality = {
  score: number;
  final_score: number | null;
  assessed_score: number;
  assessed_maximum: number;
  coverage_percent: number;
  grade: "A" | "B" | "C" | "D" | null;
  state: "complete" | "incomplete" | "blocked";
  execution_ready: boolean;
  label: string;
  note: string;
  components: Record<
    "evidence" | "accountability" | "council" | "market_integrity" | "risk_plan",
    { score: number; maximum: number; state: "assessed" | "pending" }
  >;
  hard_blocks: string[];
  missing: string[];
};

type PrivateIntel = {
  signal: {
    id: string;
    headline: string;
    body: string;
    status: string;
    created_at: string;
    act_on: { world_market_search: string | null; tokens: string[] };
  };
  sources: string[];
  claims: Array<Record<string, unknown>>;
  verification: {
    verdict: string;
    confidence: number;
    notes: string;
    claim_checks: Array<{ note: string; verdict: string }>;
  } | null;
  receipt: { receipt_id: string | null; signal_id: string; payer: string | null };
  trading_intelligence_council: CouncilRun | null;
  execution: DecisionBrief;
};

type MarketState = {
  pair: string;
  network: string;
  venue: string;
  reference: string;
  current_price_usd: string;
  posted_price_usd: string | null;
  since_posted_pct: number | null;
  fetched_at: string;
  definitive: { providerQuoteId: string; impliedPriceUsd: string };
  uniswap: {
    providerRequestId: string;
    providerQuoteId: string;
    impliedPriceUsd: string;
    routing: string;
    protocols: string[];
  } | null;
  integrity: { status: string; deviationBps: string | null; maximumDeviationBps: number };
};

type Approval = {
  request_id: string;
  signal_id: string;
  headline: string;
  receipt_id: string;
  token: string;
  maximum_spend_usdc: string;
  limit_price_usd: string;
  take_profit_price_usd: string;
  stop_loss_price_usd: string;
  expires_at: string;
  council_run_id: string;
  market_integrity_policy?: {
    maximum_deviation_bps: number;
    maximum_quote_age_seconds: number;
  };
};

type WorldAuthorization = {
  authorization_id: string;
  authorization_url: string;
  payload_hash: string;
  expires_at: string;
};

const STAR_KEY = "truthly.starred-crypto-theses";
const PENDING_KEY = "truthly.pending-council-trade";

function short(value: string | null | undefined, size = 8) {
  if (!value) return "—";
  return value.length <= size ? value : `${value.slice(0, size)}…`;
}

function price(value: string | number | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  if (Math.abs(amount) < 1) return `$${amount.toFixed(4)}`;
  if (Math.abs(amount) < 1_000) return `$${amount.toFixed(2)}`;
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function timeAgo(iso: string | null | undefined) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1_000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function localDateTime(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function expiryIso(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function claimText(claim: Record<string, unknown>) {
  for (const key of ["claim", "text", "statement"]) {
    if (typeof claim[key] === "string" && claim[key]) return String(claim[key]);
  }
  return "Structured claim available in the purchased evidence record.";
}

export default function TradeDeskPage() {
  const [desk, setDesk] = useState<DeskResponse | null>(null);
  const [deskError, setDeskError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [teaser, setTeaser] = useState<SignalTeaser | null>(null);
  const [teaserLoading, setTeaserLoading] = useState(false);
  const [market, setMarket] = useState<MarketState | null>(null);
  const [marketError, setMarketError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "ready" | "blocked" | "starred">("all");
  const [starred, setStarred] = useState<string[]>([]);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);

  const [receipt, setReceipt] = useState("");
  const [privateIntel, setPrivateIntel] = useState<PrivateIntel | null>(null);
  const [intelBusy, setIntelBusy] = useState(false);
  const [intelError, setIntelError] = useState("");
  const [editorKey, setEditorKey] = useState("");
  const [councilBusy, setCouncilBusy] = useState(false);
  const [councilError, setCouncilError] = useState("");

  const [mandateToken, setMandateToken] = useState("");
  const [maxSpend, setMaxSpend] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [councilRunId, setCouncilRunId] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [rationale, setRationale] = useState("");
  const [requestId, setRequestId] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [worldAuthorization, setWorldAuthorization] = useState<WorldAuthorization | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeResult, setTradeResult] = useState("");
  const [reconciling, setReconciling] = useState("");

  const reloadDesk = useCallback(async () => {
    try {
      const response = await fetch("/api/flash/trade", { cache: "no-store" });
      const data = (await response.json()) as DeskResponse & { detail?: string; error?: string };
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Desk unavailable");
      setDesk(data);
      setDeskError("");
      setSelectedId((current) => {
        if (current && data.briefs.some((brief) => brief.id === current)) return current;
        const requested = new URL(window.location.href).searchParams.get("signal");
        return data.briefs.find((brief) => brief.id === requested)?.id ?? data.briefs[0]?.id ?? "";
      });
    } catch (error) {
      setDeskError(error instanceof Error ? error.message : "Desk unavailable");
      setDesk((current) => current ?? {
        desk_armed: false,
        uniswap_configured: false,
        maximum_trade_usdc: "5",
        briefs: [],
        trades: [],
      });
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void reloadDesk(), 0);
    const timer = window.setInterval(() => void reloadDesk(), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [reloadDesk]);

  useEffect(() => {
    const load = window.setTimeout(() => {
      try {
        const saved: unknown = JSON.parse(window.localStorage.getItem(STAR_KEY) ?? "[]");
        if (Array.isArray(saved)) setStarred(saved.filter((id): id is string => typeof id === "string"));
      } catch {
        setStarred([]);
      }
    }, 0);
    return () => window.clearTimeout(load);
  }, []);

  const selected = useMemo(
    () => desk?.briefs.find((brief) => brief.id === selectedId) ?? null,
    [desk?.briefs, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const reset = window.setTimeout(() => {
      setTeaserLoading(true);
      setTeaser(null);
      setMarket(null);
      setMarketError("");
    }, 0);
    void fetch(`/api/signals/${encodeURIComponent(selected.id)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? data.error ?? "Brief unavailable");
        return data as SignalTeaser;
      })
      .then((data) => setTeaser(data))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setIntelError(error instanceof Error ? error.message : "Brief unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setTeaserLoading(false);
      });

    const loadMarket = () => {
      void fetch(`/api/market/eth?posted_at=${encodeURIComponent(selected.created_at)}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.detail ?? data.error ?? "Live price unavailable");
          return data as MarketState;
        })
        .then((data) => {
          setMarket(data);
          setMarketError("");
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setMarketError(error instanceof Error ? error.message : "Live price unavailable");
        });
    };
    loadMarket();
    const timer = window.setInterval(loadMarket, 60_000);
    return () => {
      controller.abort();
      window.clearTimeout(reset);
      window.clearInterval(timer);
    };
  }, [selected]);

  function chooseBrief(id: string) {
    setSelectedId(id);
    setMobileDetail(true);
    setReceipt("");
    setPrivateIntel(null);
    setIntelError("");
    setCouncilError("");
    setCouncilRunId("");
    setLimitPrice("");
    setTakeProfitPrice("");
    setStopLossPrice("");
    setExpiresAt("");
    setApproval(null);
    setWorldAuthorization(null);
    setConfirmed(false);
    setTradeResult("");
  }

  function toggleStar(id: string) {
    setStarred((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      window.localStorage.setItem(STAR_KEY, JSON.stringify(next));
      return next;
    });
  }

  const visibleBriefs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (desk?.briefs ?? []).filter((brief) => {
      if (filter === "ready" && !brief.execution.execution_eligible) return false;
      if (filter === "blocked" && brief.execution.execution_eligible) return false;
      if (filter === "starred" && !starred.includes(brief.id)) return false;
      if (!normalized) return true;
      return [brief.headline, brief.reporter.name, brief.beat, ...brief.tokens]
        .some((value) => value.toLocaleLowerCase().includes(normalized));
    });
  }, [desk?.briefs, filter, query, starred]);

  function applyExecutionPlan(intel: PrivateIntel) {
    const plan = intel.execution.plan;
    if (!plan) return;
    setCouncilRunId(plan.council_run_id);
    setLimitPrice(plan.entry_price_usd);
    setTakeProfitPrice(plan.take_profit_price_usd);
    setStopLossPrice(plan.stop_loss_price_usd);
    setExpiresAt(localDateTime(plan.valid_until));
    const councilReason = intel.trading_intelligence_council?.council?.reasoning ?? "";
    setRationale(
      (councilReason.length >= 10
        ? councilReason
        : `Execute the unexpired live Council BUY plan ${plan.council_run_id}.`).slice(0, 280),
    );
    setRequestId("");
    setApproval(null);
    setWorldAuthorization(null);
    setConfirmed(false);
    setTradeResult("");
  }

  async function unlockIntel(receiptValue = receipt, signalId = selectedId) {
    if (!signalId || !receiptValue.trim()) return;
    setIntelBusy(true);
    setIntelError("");
    try {
      const response = await fetch(`/api/intel/${encodeURIComponent(signalId)}`, {
        headers: { "x-receipt": receiptValue.trim() },
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Receipt could not unlock this brief");
      const intel = data as PrivateIntel;
      if (intel.receipt.signal_id !== signalId || intel.receipt.receipt_id !== receiptValue.trim()) {
        throw new Error("The returned intelligence does not match this story receipt.");
      }
      setPrivateIntel(intel);
      applyExecutionPlan(intel);
      setReceipt(receiptValue.trim());
    } catch (error) {
      setPrivateIntel(null);
      setIntelError(error instanceof Error ? error.message : "Receipt could not unlock this brief");
    } finally {
      setIntelBusy(false);
    }
  }

  async function conveneCouncil() {
    if (!selectedId || !editorKey.trim()) return;
    setCouncilBusy(true);
    setCouncilError("");
    try {
      const response = await fetch("/api/council/live", {
        method: "POST",
        headers: { "content-type": "application/json", "x-editor-key": editorKey.trim() },
        body: JSON.stringify({ signal_id: selectedId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Live Council failed");
      await unlockIntel(receipt);
      await reloadDesk();
    } catch (error) {
      setCouncilError(error instanceof Error ? error.message : "Live Council failed safely");
    } finally {
      setCouncilBusy(false);
    }
  }

  async function requestTrade(approved: boolean) {
    const orderExpiresAt = expiryIso(expiresAt);
    if (!orderExpiresAt || !councilRunId) {
      setTradeResult("The Council plan or order expiry is missing.");
      return;
    }
    const activeRequestId = requestId || crypto.randomUUID();
    if (!requestId) setRequestId(activeRequestId);
    setTradeBusy(true);
    setTradeResult("");
    try {
      const response = await fetch("/api/flash/trade", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mandateToken}`,
        },
        body: JSON.stringify({
          request_id: activeRequestId,
          signal_id: selectedId,
          receipt,
          token: "ETH",
          side: "buy",
          max_spend_usdc: maxSpend,
          order_type: "limit",
          limit_price_usd: limitPrice,
          take_profit_price_usd: takeProfitPrice,
          stop_loss_price_usd: stopLossPrice,
          expires_at: orderExpiresAt,
          rationale,
          council_run_id: councilRunId,
          approved,
          ...(worldAuthorization ? { authorization_id: worldAuthorization.authorization_id } : {}),
        }),
      });
      const data = await response.json();
      if (!approved && data.reason === "approval_required") {
        setApproval(data.approval as Approval);
        if (data.action_required === "world_agent_pass") {
          const authorization = {
            authorization_id: data.authorization_id,
            authorization_url: data.authorization_url,
            payload_hash: data.payload_hash,
            expires_at: data.expires_at,
          } as WorldAuthorization;
          setWorldAuthorization(authorization);
          window.localStorage.setItem(PENDING_KEY, JSON.stringify({
            selectedId,
            receipt,
            maxSpend,
            expiresAt,
            councilRunId,
            limitPrice,
            takeProfitPrice,
            stopLossPrice,
            rationale,
            requestId: activeRequestId,
            approval: data.approval,
            authorization,
          }));
          setTradeResult("Complete the fresh World approval, return, and execute this exact unchanged Council plan.");
        } else {
          setTradeResult("The plan is inside the mandate. Confirm the exact one-use order below.");
        }
        return;
      }
      if (!response.ok || !data.traded) {
        setTradeResult(`Not traded: ${data.reason ?? "request_failed"}${data.detail ? ` — ${data.detail}` : ""}`);
        return;
      }
      setTradeResult(`Submitted to Definitive — order ${data.orderId ?? data.order_id}`);
      setApproval(null);
      setWorldAuthorization(null);
      setConfirmed(false);
      window.localStorage.removeItem(PENDING_KEY);
      await reloadDesk();
    } catch {
      setTradeResult("Trade request failed before a confirmed result was returned.");
    } finally {
      setTradeBusy(false);
    }
  }

  function restorePendingTrade() {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) {
      setTradeResult("No pending World-authorized Council trade is stored in this browser.");
      return;
    }
    try {
      const saved = JSON.parse(raw) as {
        selectedId: string;
        receipt: string;
        maxSpend: string;
        expiresAt: string;
        councilRunId: string;
        limitPrice: string;
        takeProfitPrice: string;
        stopLossPrice: string;
        rationale: string;
        requestId: string;
        approval: Approval;
        authorization: WorldAuthorization;
      };
      setSelectedId(saved.selectedId);
      setReceipt(saved.receipt);
      setMaxSpend(saved.maxSpend);
      setExpiresAt(saved.expiresAt);
      setCouncilRunId(saved.councilRunId);
      setLimitPrice(saved.limitPrice);
      setTakeProfitPrice(saved.takeProfitPrice);
      setStopLossPrice(saved.stopLossPrice);
      setRationale(saved.rationale);
      setRequestId(saved.requestId);
      setApproval(saved.approval);
      setWorldAuthorization(saved.authorization);
      setConfirmed(false);
      setMandateToken("");
      setTradeOpen(true);
      setTradeResult("Pending order restored. Re-enter the mandate token and verify World approval before executing.");
      void unlockIntel(saved.receipt, saved.selectedId);
    } catch {
      setTradeResult("The saved pending trade is invalid.");
    }
  }

  async function reconcileTrade(id: string) {
    setReconciling(id);
    try {
      const response = await fetch(`/api/flash/trade/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json();
      setTradeResult(response.ok
        ? `Reconciled ${data.order_id}: ${data.provider_status}`
        : `Reconciliation stopped: ${data.detail ?? data.reason ?? "unknown status"}`);
      await reloadDesk();
    } catch {
      setTradeResult("Provider reconciliation failed.");
    } finally {
      setReconciling("");
    }
  }

  const privateCouncil = privateIntel?.trading_intelligence_council?.council ?? null;
  const activeExecution = privateIntel?.execution ?? selected?.execution ?? teaser?.execution ?? null;
  const canReview = Boolean(
    privateIntel?.execution.execution_eligible &&
      privateIntel.execution.plan &&
      mandateToken.trim() &&
      receipt.trim() &&
      Number(maxSpend) > 0 &&
      Number(maxSpend) <= Number(desk?.maximum_trade_usdc ?? 0) &&
      expiryIso(expiresAt),
  );

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <div className={styles.wordmark}>truthly</div>
        <div className={styles.search}>
          <span aria-hidden>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search crypto theses, reporters, or tokens…"
            aria-label="Search crypto decision briefs"
          />
          <kbd>/</kbd>
        </div>
        <div className={styles.liveState}>
          <span className={market ? styles.liveDot : styles.idleDot} />
          <div><strong>{market ? price(market.current_price_usd) : "Connecting"}</strong><small>ETH · Definitive</small></div>
        </div>
      </header>

      <div className={styles.bodyGrid}>
        <aside className={`${styles.desk} ${mobileDetail ? styles.deskMobileHidden : ""}`}>
          <header className={styles.deskHeader}>
            <nav className={styles.filters} aria-label="Decision brief filters">
              {(["all", "ready", "blocked", "starred"] as const).map((item) => (
                <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>
                  {item === "all" ? "All crypto" : item}
                </button>
              ))}
            </nav>
            <div className={styles.feedStatus}>
              <span>{visibleBriefs.length} decision brief{visibleBriefs.length === 1 ? "" : "s"}</span>
              <button type="button" onClick={() => void reloadDesk()} aria-label="Refresh desk">↻</button>
            </div>
          </header>

          <div className={styles.ideaList}>
            {!desk && <div className={styles.listState}>Loading the verified crypto wire…</div>}
            {deskError && <div className={`${styles.listState} ${styles.errorText}`}>{deskError}</div>}
            {desk && visibleBriefs.length === 0 && (
              <div className={styles.listState}>No crypto theses match this view.</div>
            )}
            {visibleBriefs.map((brief) => {
              const isSelected = brief.id === selectedId;
              const isStarred = starred.includes(brief.id);
              const selectedMarket = isSelected ? market : null;
              return (
                <article key={brief.id} className={`${styles.ideaRow} ${isSelected ? styles.selected : ""}`}>
                  <button type="button" className={styles.ideaMain} onClick={() => chooseBrief(brief.id)} aria-pressed={isSelected}>
                    <div className={styles.ideaTopline}>
                      <div>
                        <span className={styles.venueTag}>DEFINITIVE</span>
                        <strong className={brief.execution.story_eligible ? styles.long : styles.review}>
                          {brief.council_summary?.action ?? "ETH"}
                        </strong>
                      </div>
                      <div className={styles.returnValue}>
                        <strong>{percent(selectedMarket?.since_posted_pct)}</strong>
                        <small>SINCE STORY</small>
                      </div>
                    </div>
                    <div className={styles.ideaPrice}>{selectedMarket ? price(selectedMarket.current_price_usd) : "Live on open"}</div>
                    <div className={styles.thesisCard}>
                      <div className={styles.sourceLine}>
                        <span className={styles.avatar}>{brief.reporter.name.slice(0, 1).toUpperCase()}</span>
                        <div><strong>{brief.reporter.name}</strong><small>{brief.beat} · edition #{brief.edition_number}</small></div>
                      </div>
                      <h2>{brief.headline}</h2>
                      <p>{brief.execution.detail}</p>
                    </div>
                  </button>
                  <div className={styles.ideaFoot}>
                    <button
                      type="button"
                      className={`${styles.star} ${isStarred ? styles.starred : ""}`}
                      onClick={() => toggleStar(brief.id)}
                      aria-label={isStarred ? "Unstar thesis" : "Star thesis"}
                    >
                      {isStarred ? "★" : "☆"}
                    </button>
                      <span>{brief.signal_quality.final_score === null ? "Q pending" : `Q${brief.signal_quality.final_score}`} · {timeAgo(brief.created_at)} ago · {brief.verdict?.replace(/_/g, " ") ?? "unchecked"}</span>
                    <button type="button" className={styles.viewTrade} onClick={() => { chooseBrief(brief.id); setTradeOpen(true); }}>
                      View trade
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </aside>

        <section className={`${styles.terminal} ${!mobileDetail ? styles.terminalMobileHidden : ""}`}>
          <button type="button" className={styles.back} onClick={() => setMobileDetail(false)}>← The Desk</button>
          {!selected && (
            <div className={styles.emptyTerminal}>
              <span>↗</span><h1>A thesis is the beginning.</h1><p>Select a verified crypto story from the desk.</p>
            </div>
          )}
          {selected && (
            <div className={styles.ideaView}>
              <section className={styles.marketSummary}>
                <div className={styles.marketIdentity}>
                  <span className={styles.ethIcon}>Ξ</span>
                  <div><strong>ETH / USDC</strong><small>DEFINITIVE FLASH · BASE SPOT</small></div>
                </div>
                <Metric label="Now" value={market ? price(market.current_price_usd) : "—"} />
                <Metric label="Since story" value={percent(market?.since_posted_pct)} tone={(market?.since_posted_pct ?? 0) >= 0 ? "green" : "pink"} />
                <Metric
                  label="Decision"
                  value={privateCouncil?.action ?? selected.council_summary?.action ?? (activeExecution?.story_eligible ? "COUNCIL" : "BLOCKED")}
                  tone={(privateCouncil?.action ?? selected.council_summary?.action) === "BUY" ? "green" : (privateCouncil?.action ?? selected.council_summary?.action) === "SELL" ? "pink" : undefined}
                />
                <Metric label="Integrity" value={market?.integrity.status?.toUpperCase() ?? "—"} tone={market?.integrity.status === "verified" ? "green" : "pink"} />
              </section>
              {marketError && <p className={styles.inlineError}>{marketError}</p>}

              <div className={styles.sourceRow}>
                <div className={styles.author}>
                  <span className={styles.avatarLarge}>{selected.reporter.name.slice(0, 1).toUpperCase()}</span>
                  <div><strong>{selected.reporter.name}</strong><small>{short(selected.reporter.address, 12)} · {timeAgo(selected.created_at)} ago</small></div>
                </div>
                <Link href={`/signals/${selected.id}`}>Public story ↗</Link>
              </div>

              <section className={styles.chartCard}>
                <CryptoChart postedAt={selected.created_at} />
              </section>

              {teaserLoading && <div className={styles.detailState}>Building the decision brief…</div>}
              {!teaserLoading && teaser && (
                <article className={styles.tradeBrief}>
                  <header className={styles.thesisHeader}>
                    <div>
                      <span className={activeExecution?.story_eligible ? styles.convictionGood : styles.convictionBlocked}>
                        {selected.verdict?.replace(/_/g, " ") ?? "unchecked"}
                      </span>
                      <button type="button" onClick={() => toggleStar(selected.id)} aria-label="Toggle starred thesis">
                        {starred.includes(selected.id) ? "★" : "☆"}
                      </button>
                    </div>
                    <h1>{teaser.signal.headline}</h1>
                    <p className={styles.excerpt}>{teaser.excerpt}</p>
                  </header>

                  <section className={styles.briefSection}>
                    <h2>Decision gates</h2>
                    <GateList gates={activeExecution?.gates ?? []} />
                    <div className={activeExecution?.execution_eligible ? styles.decisionReady : styles.decisionBlocked}>
                      <strong>{activeExecution?.label}</strong>
                      <p>{activeExecution?.detail}</p>
                    </div>
                  </section>

                  <SignalQualityPanel
                    quality={selected.signal_quality}
                    council={selected.council_summary}
                  />

                  {privateIntel ? (
                    <>
                      <section className={styles.briefSection}>
                        <div className={styles.sectionHeading}>
                          <h2>Purchased thesis</h2><span>receipt {short(privateIntel.receipt.receipt_id)}</span>
                        </div>
                        <p className={styles.fullBody}>{privateIntel.signal.body}</p>
                      </section>

                      <section className={styles.briefSection}>
                        <h2>Alpha drivers</h2>
                        <div className={styles.driverList}>
                          {[
                            privateIntel.verification?.notes,
                            ...privateIntel.claims.slice(0, 3).map(claimText),
                          ].filter((item): item is string => Boolean(item)).slice(0, 3).map((driver) => (
                            <div key={driver} className={styles.driver}><span /><p>{driver}</p></div>
                          ))}
                        </div>
                      </section>

                      <CouncilAnalysis run={privateIntel.trading_intelligence_council} />

                      <section className={styles.briefSection}>
                        <h2>Evidence archive</h2>
                        <div className={styles.sourceList}>
                          {privateIntel.sources.map((source) => (
                            <a key={source} href={source} target="_blank" rel="noreferrer">{source} ↗</a>
                          ))}
                        </div>
                      </section>
                    </>
                  ) : (
                    <section className={`${styles.briefSection} ${styles.unlockPrompt}`}>
                      <h2>Unlock the complete trade brief</h2>
                      <p>The full story, Herald reasoning, claims, sources, Council direction, and exact plan remain bound to this story&apos;s paid receipt.</p>
                      <button type="button" onClick={() => setTradeOpen(true)}>Open receipt rail →</button>
                    </section>
                  )}
                </article>
              )}

              <TradeLedger trades={desk?.trades ?? []} reconciling={reconciling} onReconcile={(id) => void reconcileTrade(id)} />
            </div>
          )}
        </section>

        <button type="button" className={styles.tradeCta} onClick={() => setTradeOpen(true)} disabled={!selected}>
          Decision &amp; execution rail →
        </button>
        {tradeOpen && <button type="button" aria-label="Close execution rail" className={styles.backdrop} onClick={() => setTradeOpen(false)} />}

        <aside className={`${styles.tradeRail} ${tradeOpen ? styles.tradeRailOpen : ""}`} aria-label="Council trade plan">
          <button type="button" className={styles.closeRail} onClick={() => setTradeOpen(false)} aria-label="Close execution rail">×</button>
          {!selected ? (
            <div className={styles.railEmpty}><span>↗</span><p>Select a crypto thesis to build its decision.</p></div>
          ) : (
            <div className={styles.railContent}>
              <div className={styles.railOpening}>
                <p>{activeExecution?.execution_eligible ? "Council will buy" : "Council gate"}</p>
                <h2>ETH</h2>
                <span>{activeExecution?.label}</span>
              </div>

              <section className={styles.unlockBox}>
                <label>
                  Story intelligence receipt
                  <input value={receipt} onChange={(event) => { setReceipt(event.target.value.trim()); setPrivateIntel(null); setIntelError(""); }} placeholder="receipt_id from the $0.02 read" />
                </label>
                <button type="button" onClick={() => void unlockIntel()} disabled={!receipt || intelBusy}>
                  {intelBusy ? "Checking receipt…" : privateIntel ? "Refresh purchased brief" : "Unlock purchased brief"}
                </button>
                <Link href={`/signals/${selected.id}`}>Need a receipt? Open this story →</Link>
                {intelError && <p className={styles.railError}>{intelError}</p>}
              </section>

              {privateIntel && !privateIntel.execution.execution_eligible && (
                <section className={styles.councilControl}>
                  <p className={styles.railKicker}>Live Council</p>
                  <strong>{privateIntel.execution.label}</strong>
                  <p>{privateIntel.execution.detail}</p>
                  {privateIntel.execution.story_eligible && (
                    <>
                      <label>
                        Council operator key
                        <input type="password" value={editorKey} onChange={(event) => setEditorKey(event.target.value)} placeholder="server validates; never stored" />
                      </label>
                      <button type="button" onClick={() => void conveneCouncil()} disabled={!editorKey || councilBusy}>
                        {councilBusy ? "Five agents are analyzing…" : privateCouncil ? "Convene a fresh Council" : "Convene live Council"}
                      </button>
                    </>
                  )}
                  {councilError && <p className={styles.railError}>{councilError}</p>}
                </section>
              )}

              {privateIntel?.execution.plan ? (
                <>
                  <PlanMap
                    entry={privateIntel.execution.plan.entry_price_usd}
                    target={privateIntel.execution.plan.take_profit_price_usd}
                    stop={privateIntel.execution.plan.stop_loss_price_usd}
                  />
                  <div className={styles.planMeta}>
                    <div><span>Risk / reward</span><strong>{privateIntel.execution.plan.risk_reward ?? "—"}</strong></div>
                    <div><span>Council valid</span><strong>{timeAgo(privateIntel.execution.plan.valid_until) ? `${timeAgo(privateIntel.execution.plan.valid_until)} old` : "fresh"}</strong></div>
                  </div>
                  <p className={styles.planReason}>{privateCouncil?.reasoning}</p>

                  <section className={styles.executionForm}>
                    <div className={styles.executionStatus}>
                      <span className={desk?.desk_armed && desk.uniswap_configured ? styles.liveDot : styles.idleDot} />
                      {desk?.desk_armed && desk.uniswap_configured
                        ? `Live · ${desk.maximum_trade_usdc} USDC cap · Uniswap guarded`
                        : "Review only · execution prerequisites are not fully armed"}
                    </div>
                    <label>
                      Delegated mandate token
                      <input type="password" value={mandateToken} onChange={(event) => { setMandateToken(event.target.value); setApproval(null); setConfirmed(false); }} placeholder="apm_…" />
                    </label>
                    <div className={styles.twoFields}>
                      <label>Maximum USDC<input value={maxSpend} onChange={(event) => { setMaxSpend(event.target.value); setApproval(null); }} inputMode="decimal" /></label>
                      <label>Order expiry<input type="datetime-local" value={expiresAt} onChange={(event) => { setExpiresAt(event.target.value); setApproval(null); }} /></label>
                    </div>
                    <p className={styles.lockedPlan}>Locked to Council {short(councilRunId)} · entry {price(limitPrice)} · target {price(takeProfitPrice)} · stop {price(stopLossPrice)}</p>
                    <button type="button" className={styles.execute} onClick={() => void requestTrade(false)} disabled={!canReview || tradeBusy}>
                      {tradeBusy ? "Validating exact plan…" : "Review protected Definitive order"}
                    </button>
                  </section>
                </>
              ) : (
                <div className={styles.noPlan}>
                  <span>○</span><p>No execution ticket. Every story, market, and Council gate must pass first.</p>
                </div>
              )}

              <button type="button" className={styles.restore} onClick={restorePendingTrade}>Restore after World approval →</button>

              {approval && (
                <section className={styles.approvalBox}>
                  <p className={styles.railKicker}>Exact one-use approval</p>
                  <dl>
                    <dt>Spend</dt><dd>{approval.maximum_spend_usdc} USDC</dd>
                    <dt>Entry</dt><dd>{price(approval.limit_price_usd)}</dd>
                    <dt>Target</dt><dd>{price(approval.take_profit_price_usd)}</dd>
                    <dt>Stop</dt><dd>{price(approval.stop_loss_price_usd)}</dd>
                    <dt>Receipt</dt><dd>{short(approval.receipt_id)}</dd>
                    <dt>Council</dt><dd>{short(approval.council_run_id)}</dd>
                  </dl>
                  {worldAuthorization && (
                    <a href={worldAuthorization.authorization_url} className={styles.worldLink}>Fresh World approval →</a>
                  )}
                  <label className={styles.confirm}>
                    <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                    I approve only this unchanged Council plan.
                  </label>
                  <button type="button" className={styles.execute} onClick={() => void requestTrade(true)} disabled={!confirmed || !mandateToken || tradeBusy}>
                    {tradeBusy ? "Submitting…" : "Execute protected order"}
                  </button>
                </section>
              )}
              {tradeResult && <p className={styles.tradeResult}>{tradeResult}</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "green" | "pink" }) {
  return <div className={styles.metric}><span>{label}</span><strong className={tone === "green" ? styles.green : tone === "pink" ? styles.pink : ""}>{value}</strong></div>;
}

function GateList({ gates }: { gates: Gate[] }) {
  return (
    <div className={styles.gates}>
      {gates.map((gate) => (
        <div key={gate.key}><span className={gate.passed ? styles.gatePass : styles.gateStop}>{gate.passed ? "✓" : "×"}</span><div><strong>{gate.label}</strong><small>{gate.state.replace(/_/g, " ")}</small></div></div>
      ))}
    </div>
  );
}

function SignalQualityPanel({
  quality,
  council,
}: {
  quality: SignalQuality;
  council: PublicCouncilSummary | null;
}) {
  const components = [
    ["Evidence", quality.components.evidence],
    ["Accountability", quality.components.accountability],
    ["Agent Council", quality.components.council],
    ["Market integrity", quality.components.market_integrity],
    ["Risk plan", quality.components.risk_plan],
  ] as const;
  const displayedScore = quality.final_score ?? quality.assessed_score;
  const displayedMaximum = quality.final_score === null ? quality.assessed_maximum : 100;
  return (
    <section className={styles.briefSection}>
      <div className={styles.sectionHeading}>
        <h2>Decision quality</h2>
        <span>COMPLETENESS · NOT PROFIT PROBABILITY</span>
      </div>
      <div className={styles.qualityHero}>
        <div className={styles.qualityScore}>
          <strong>{displayedScore}</strong><span>/{displayedMaximum}</span><b>{quality.grade ?? "P"}</b>
        </div>
        <div>
          <h3>{quality.label}</h3>
          <p>{quality.note}</p>
        </div>
        <span className={quality.execution_ready ? styles.qualityReady : styles.qualityBlocked}>
          {quality.execution_ready ? "EXECUTION READY" : quality.state.toUpperCase()}
        </span>
      </div>
      <div className={styles.qualityComponents}>
        {components.map(([label, component]) => (
          <div key={label}>
            <div><span>{label}</span><strong>{component.state === "pending" ? "PENDING" : `${component.score}/${component.maximum}`}</strong></div>
            <div className={`${styles.qualityTrack} ${component.state === "pending" ? styles.qualityTrackPending : ""}`}>
              {component.state === "assessed" && <span style={{ width: `${component.maximum ? component.score / component.maximum * 100 : 0}%` }} />}
            </div>
          </div>
        ))}
      </div>
      {(quality.hard_blocks.length > 0 || quality.missing.length > 0) && (
        <div className={styles.qualityFlags}>
          {quality.hard_blocks.map((item) => <span key={`block-${item}`} className={styles.qualityHardBlock}>× {item}</span>)}
          {quality.missing.map((item) => <span key={`missing-${item}`}>○ missing {item}</span>)}
        </div>
      )}
      {quality.final_score === null && (
        <p className={styles.qualityCoverage}>{quality.coverage_percent}% of the complete decision has been assessed. Pending layers are not counted as zero.</p>
      )}
      {council && (
        <div className={styles.publicCouncil}>
          <div className={styles.publicCouncilHead}>
            <div><span>LIVE FIVE-AGENT DECISION</span><strong>{council.action}</strong></div>
            <div><span>CONSENSUS</span><strong>{council.consensus.replace(/_/g, " ")} · {council.consensus_confidence}%</strong></div>
            <div><span>VALID UNTIL</span><strong>{council.valid_until ? new Date(council.valid_until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</strong></div>
          </div>
          <div className={styles.agentVotes}>
            {council.agents.map((agent) => (
              <div key={agent.role}>
                <span>{agent.role.replace(/_/g, " ")}</span>
                <strong className={agent.vote === "BUY" ? styles.green : agent.vote === "SELL" ? styles.pink : ""}>
                  {agent.vote} · {agent.confidence}%{agent.veto ? " · VETO" : ""}
                </strong>
              </div>
            ))}
          </div>
          <div className={styles.marketAudit}>
            <span>Definitive {price(council.market.definitive_price_usd)}</span>
            <span>Uniswap {price(council.market.uniswap_price_usd)}</span>
            <span>{council.market.deviation_bps ?? "—"}/{council.market.maximum_deviation_bps} bps</span>
            <span>{council.market.integrity_status.replace(/_/g, " ")}</span>
          </div>
          <p className={styles.publicCouncilNote}>
            Agent votes and provider evidence are public. Unlock the purchased brief for each agent&apos;s detailed rationale and the verified source record.
          </p>
        </div>
      )}
    </section>
  );
}

function CouncilAnalysis({ run }: { run: CouncilRun | null }) {
  if (!run?.council) return null;
  const council = run.council;
  return (
    <section className={styles.briefSection}>
      <div className={styles.sectionHeading}><h2>Trading Intelligence Council</h2><span>{council.consensus} · {council.consensusConfidence}%</span></div>
      <div className={council.executionEligible ? styles.councilBuy : styles.councilNoTrade}>
        <strong>{council.action}</strong><p>{council.reasoning}</p>
        {council.entryPriceUsd && <small>Entry {price(council.entryPriceUsd)} · stop {price(council.stopLossPriceUsd)} · target {price(council.takeProfitPriceUsd)} · R/R {council.riskReward}</small>}
      </div>
      <div className={styles.opinions}>
        {council.opinions.map((opinion) => (
          <details key={opinion.role}>
            <summary><span>{opinion.role.replace(/_/g, " ")}</span><strong>{opinion.vote} · {opinion.confidence}%{opinion.veto ? " · VETO" : ""}</strong></summary>
            <p>{opinion.reasoning}</p>
          </details>
        ))}
      </div>
      {run.market_snapshot && (
        <div className={styles.marketAudit}>
          <span>Definitive {price(run.market_snapshot.executionQuote?.impliedPriceUsd)}</span>
          <span>Uniswap {price(run.market_snapshot.referenceQuote?.impliedPriceUsd)}</span>
          <span>{run.market_snapshot.integrity?.deviationBps ?? "—"} bps divergence</span>
        </div>
      )}
    </section>
  );
}

function PlanMap({ entry, target, stop }: { entry: string; target: string; stop: string }) {
  return (
    <div className={styles.planMap} aria-label={`Entry ${entry}, target ${target}, stop ${stop}`}>
      <svg viewBox="0 0 280 136" fill="none" aria-hidden>
        <defs><pattern id="truthly-plan-dots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" fill="currentColor" /></pattern></defs>
        <rect width="280" height="136" fill="url(#truthly-plan-dots)" className={styles.planGrid} />
        <path d="M18 65H90" className={styles.approach} />
        <path d="M90 65C130 65 135 28 170 28H244" className={styles.profitPath} />
        <path d="M90 65C130 65 135 103 170 103H244" className={styles.stopPath} />
        <circle cx="90" cy="65" r="13" className={styles.originHalo} /><circle cx="90" cy="65" r="4" className={styles.origin} />
        <circle cx="244" cy="28" r="3.5" className={styles.profitNode} /><circle cx="244" cy="103" r="3.5" className={styles.stopNode} />
        <text x="90" y="44" textAnchor="middle">ENTRY</text><text x="90" y="90" textAnchor="middle">{price(entry)}</text>
        <text x="236" y="16" textAnchor="end">TAKE PROFIT</text><text x="236" y="42" textAnchor="end">{price(target)}</text>
        <text x="236" y="92" textAnchor="end">EXIT</text><text x="236" y="118" textAnchor="end">{price(stop)}</text>
      </svg>
    </div>
  );
}

function TradeLedger({ trades, reconciling, onReconcile }: { trades: Trade[]; reconciling: string; onReconcile: (id: string) => void }) {
  return (
    <section className={styles.ledger}>
      <div className={styles.sectionHeading}><h2>Definitive order ledger</h2><span>{trades.length} attempt{trades.length === 1 ? "" : "s"}</span></div>
      {trades.length === 0 && <p className={styles.ledgerEmpty}>No approved live orders yet.</p>}
      {trades.map((trade) => {
        const spent = Number(trade.spentNotional);
        const received = Number(trade.receivedNotional);
        const adverse = Number.isFinite(spent) && Number.isFinite(received) && received < spent;
        return (
          <article key={trade.id}>
            <div><strong className={trade.status === "submitted" ? styles.green : styles.pink}>{trade.status}</strong><span>{trade.side} {trade.tokenSymbol ?? short(trade.targetAsset)} · {trade.qty} USDC · {timeAgo(trade.createdAt)} ago</span></div>
            <p>Entry {price(trade.limitPriceUsd)} · target {price(trade.takeProfitPriceUsd)} · stop {price(trade.stopLossPriceUsd)}</p>
            {trade.marketGuardStatus && <small>Uniswap {trade.uniswapRouting ?? "reference"} · {trade.marketDeviationBps ?? "—"} bps · {price(trade.uniswapPriceUsd)}</small>}
            {trade.spentNotional && <small className={adverse ? styles.pink : ""}>{trade.spentNotional} spent → {trade.receivedNotional} received{adverse ? " · adverse outcome retained" : ""}</small>}
            <div className={styles.ledgerActions}>
              {trade.fillTransaction && <a href={`https://basescan.org/tx/${trade.fillTransaction}`} target="_blank" rel="noreferrer">BaseScan ↗</a>}
              {trade.orderId && <button type="button" onClick={() => onReconcile(trade.id)} disabled={reconciling === trade.id}>{reconciling === trade.id ? "Checking…" : "Reconcile"}</button>}
            </div>
          </article>
        );
      })}
    </section>
  );
}
