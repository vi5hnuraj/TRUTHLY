import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const configuredBase =
  process.env.TRUTHLY_URL ||
  process.env.NEXT_PUBLIC_BASE_URL ||
  "http://localhost:3000";
function normalizedBase(value: string): string {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("TRUTHLY API base must be an http(s) URL");
  }
  return parsed.toString().replace(/\/$/, "");
}

const BEATS = [
  "bitcoin",
  "defi",
  "agentic-payments",
  "infrastructure",
  "regulation",
  "market-signals",
] as const;

type Beat = (typeof BEATS)[number];
type JsonRecord = Record<string, unknown>;

const TOOL_POLICIES = {
  truthly_front_page: {
    access: "public",
    fresh_agent_pass: "never",
    principal_pause: "read_only_exempt",
  },
  truthly_wire: {
    access: "public",
    fresh_agent_pass: "never",
    principal_pause: "read_only_exempt",
  },
  truthly_file_signal: {
    access: "x402_payer",
    role: "file_when_principal_bound",
    shared_human_quota: true,
    fresh_agent_pass: "never",
    principal_pause: "enforced_before_payment_and_filing",
  },
  truthly_read_edition: {
    access: "explicit_x402_payment",
    fresh_agent_pass: "never",
    principal_pause: "enforced_before_payment_for_bound_wallets",
  },
  truthly_read_signal: {
    access: "explicit_x402_payment",
    fresh_agent_pass: "never",
    receipt: "reusable_per_story",
    principal_pause: "enforced_before_payment_for_bound_wallets",
  },
  truthly_reporter_profile: {
    access: "public",
    fresh_agent_pass: "never",
    principal_pause: "read_only_exempt",
  },
  truthly_appeal_status: {
    access: "public_read_only",
    fresh_agent_pass: "never",
    principal_pause: "read_only_exempt",
  },
  truthly_trade_signal: {
    access: "delegated_mandate",
    role: "trade_preview",
    exact_payload: true,
    signal_intel_receipt: true,
    flash_advanced_order: "limit_with_attached_bracket",
    uniswap_market_integrity:
      "fresh_same_notional_v2_v3_v4_reference_required_before_live_submission",
    fresh_agent_pass: "above_mandate_threshold_or_without_execute_role",
    principal_pause: "enforced_for_preview_authorization_and_execution",
  },
} as const;

interface ApiReply {
  ok: boolean;
  status: number;
  data: unknown;
  paymentRequired: string | null;
  paymentResponse: string | null;
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

async function parseResponse(response: Response): Promise<ApiReply> {
  const raw = await response.text();
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw.slice(0, 2_000) };
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    paymentRequired:
      response.headers.get("payment-required") ??
      response.headers.get("x-payment-required"),
    paymentResponse:
      response.headers.get("payment-response") ??
      response.headers.get("x-payment-response"),
  };
}

async function requestApi(
  apiBase: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiReply> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  return parseResponse(response);
}

function apiError(reply: ApiReply) {
  const message =
    reply.data && typeof reply.data === "object" && "error" in reply.data
      ? String((reply.data as { error?: unknown }).error)
      : `TRUTHLY returned HTTP ${reply.status}`;
  return textResult({ error: message, status: reply.status, detail: reply.data }, true);
}

function paymentChallenge(
  reply: ApiReply,
  request: { method: "GET" | "POST"; path: string; body?: unknown },
  price: "$0.01" | "$0.02" | "$0.05",
) {
  return textResult({
    payment_required: true,
    approval_required: true,
    price,
    network: "Base USDC (from the server's x402 challenge)",
    request,
    x402: {
      payment_required_header: reply.paymentRequired,
      response_body: reply.data,
    },
    next_step:
      "Show this payment request to the wallet owner. After approval, have an x402 v2 wallet create the one-time PAYMENT-SIGNATURE value and call this tool again with approve_payment=true and payment_signature. TRUTHLY MCP never signs or spends automatically.",
  });
}

function paidHeaders(paymentSignature?: string): Record<string, string> {
  return paymentSignature
    ? { "Payment-Signature": paymentSignature }
    : {};
}

function assertApproved(
  approvePayment: boolean,
  paymentSignature?: string,
) {
  if (paymentSignature && !approvePayment) {
    return textResult(
      {
        error: "explicit_approval_required",
        detail:
          "A payment signature was supplied, but approve_payment is not true. Confirm the payment with the wallet owner before retrying.",
      },
      true,
    );
  }
  return null;
}

function records(value: unknown, key: string): JsonRecord[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as JsonRecord)[key];
  return Array.isArray(list)
    ? list.filter(
        (item): item is JsonRecord =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

export function createTruthlyMcpServer(apiBase = configuredBase) {
  const normalizedApiBase = normalizedBase(apiBase);
  const apiRequest = (path: string, init: RequestInit = {}) =>
    requestApi(normalizedApiBase, path, init);
  const server = new McpServer({
    name: "truthly-mcp",
    version: "0.3.0",
  });

const frontPageTool = server.tool(
  "truthly_front_page",
  "Read the latest published TRUTHLY edition preview: verified headlines, beats, scores, reporters, verdicts, and action hints. Free; never triggers a payment.",
  {},
  async () => {
    const editionsReply = await apiRequest("/api/editions");
    if (!editionsReply.ok) return apiError(editionsReply);
    const editions = records(editionsReply.data, "editions");
    const latest = editions[0];
    if (!latest || typeof latest.id !== "string") {
      return textResult({ edition: null, signals: [], message: "No published editions yet." });
    }
    const previewReply = await apiRequest(
      `/api/editions/${encodeURIComponent(latest.id)}`,
    );
    return previewReply.ok ? textResult(previewReply.data) : apiError(previewReply);
  },
);
frontPageTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_front_page } });

const wireTool = server.tool(
  "truthly_wire",
  "Read the free newsroom wire: pending filed headlines, quiet beats, and unfiled RSS/GitHub Scout candidates. Collection does not file stories or spend money.",
  {
    beat: z.enum(BEATS).optional().describe("Optionally return one coverage beat"),
    limit: z.number().int().min(1).max(100).default(25),
    include_scout_candidates: z.boolean().default(true),
  },
  async ({ beat, limit, include_scout_candidates }) => {
    const [wireReply, scoutReply] = await Promise.all([
      apiRequest("/api/signals?status=submitted&limit=100"),
      include_scout_candidates
        ? apiRequest(`/api/scout/candidates?status=candidate&limit=${limit}`)
        : Promise.resolve<ApiReply>({
            ok: true,
            status: 200,
            data: { candidates: [] },
            paymentRequired: null,
            paymentResponse: null,
          }),
    ]);
    if (!wireReply.ok) return apiError(wireReply);

    const allSignals = records(wireReply.data, "signals");
    const counts = Object.fromEntries(BEATS.map((name) => [name, 0])) as Record<
      Beat,
      number
    >;
    for (const signal of allSignals) {
      const signalBeat = signal.beat;
      if (typeof signalBeat === "string" && signalBeat in counts) {
        counts[signalBeat as Beat] += 1;
      }
    }
    const minimum = Math.min(...Object.values(counts));
    const signals = allSignals
      .filter((signal) => !beat || signal.beat === beat)
      .slice(0, limit);
    const candidates = scoutReply.ok
      ? records(scoutReply.data, "candidates")
          .filter((candidate) => !beat || candidate.beat === beat)
          .slice(0, limit)
      : [];

    return textResult({
      pending_by_beat: counts,
      quiet_beats: BEATS.filter((name) => counts[name] === minimum),
      filed_signals: signals,
      scout_candidates: candidates,
      scout_note: scoutReply.ok
        ? "Scout candidates are discoveries only. Research 2–3 sources, then use truthly_file_signal; no candidate has been paid or filed automatically."
        : `Scout queue unavailable (HTTP ${scoutReply.status}); the filed wire is still current.`,
    });
  },
);
wireTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_wire } });

const fileSignalTool = server.tool(
  "truthly_file_signal",
  "Validate and file a story through POST /api/x402/signals for $0.01 USDC. First call returns the x402 request. Supplying a payment signature files only when approve_payment=true; this server never signs or silently spends.",
  {
    headline: z.string().trim().min(10).max(280),
    body: z.string().trim().min(40).max(2_000),
    beat: z.enum(BEATS),
    sources: z.array(z.string().url()).min(2).max(5),
    source_metadata: z
      .array(
        z.object({
          url: z.string().url(),
          title: z.string().trim().min(2).max(300),
          publisher: z.string().trim().min(2).max(120),
          published_at: z.string().datetime({ offset: true }).nullable(),
          source_type: z.enum(["primary", "secondary"]),
        }),
      )
      .min(2)
      .max(5),
    claims: z
      .array(
        z.object({
          claim: z.string().trim().min(10).max(500),
          citations: z.array(z.string().url()).min(1).max(5),
        }),
      )
      .min(1)
      .max(10),
    tags: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
    world_query: z.string().trim().max(200).optional(),
    tokens: z.array(z.string().trim().max(64)).max(10).optional(),
    reporter_name: z.string().trim().min(2).max(60).optional(),
    approve_payment: z.boolean().default(false),
    payment_signature: z
      .string()
      .min(1)
      .optional()
      .describe("One-time x402 PAYMENT-SIGNATURE produced by the user's wallet"),
  },
  async ({ approve_payment, payment_signature, ...filing }) => {
    const approvalError = assertApproved(approve_payment, payment_signature);
    if (approvalError) return approvalError;

    const path = "/api/x402/signals";
    const reply = await apiRequest(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...paidHeaders(payment_signature),
      },
      body: JSON.stringify(filing),
    });
    if (reply.status === 402) {
      return paymentChallenge(reply, { method: "POST", path, body: filing }, "$0.01");
    }
    if (!reply.ok) return apiError(reply);
    return textResult({
      ...((reply.data as JsonRecord | null) ?? {}),
      x402_payment_response: reply.paymentResponse,
    });
  },
);
fileSignalTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_file_signal } });

const readEditionTool = server.tool(
  "truthly_read_edition",
  "Buy a complete verified edition for $0.05 USDC. The first call includes the free preview and x402 request. Content is purchased only with approve_payment=true plus a wallet-produced payment signature.",
  {
    edition_id: z
      .string()
      .uuid()
      .optional()
      .describe("Omit for the latest published edition"),
    approve_payment: z.boolean().default(false),
    payment_signature: z
      .string()
      .min(1)
      .optional()
      .describe("One-time x402 PAYMENT-SIGNATURE produced by the user's wallet"),
  },
  async ({ edition_id, approve_payment, payment_signature }) => {
    const approvalError = assertApproved(approve_payment, payment_signature);
    if (approvalError) return approvalError;

    let selectedId = edition_id;
    if (!selectedId) {
      const editionsReply = await apiRequest("/api/editions");
      if (!editionsReply.ok) return apiError(editionsReply);
      const latest = records(editionsReply.data, "editions")[0];
      selectedId = typeof latest?.id === "string" ? latest.id : undefined;
      if (!selectedId) {
        return textResult({ error: "No published editions yet." }, true);
      }
    }

    const previewReply = await apiRequest(
      `/api/editions/${encodeURIComponent(selectedId)}`,
    );
    if (!previewReply.ok) return apiError(previewReply);

    const path = `/api/editions/${encodeURIComponent(selectedId)}/full`;
    const reply = await apiRequest(path, {
      headers: paidHeaders(payment_signature),
    });
    if (reply.status === 402) {
      const challenge = paymentChallenge(reply, { method: "GET", path }, "$0.05");
      const parsed = JSON.parse(challenge.content[0].text) as JsonRecord;
      return textResult({ ...parsed, free_preview: previewReply.data });
    }
    if (!reply.ok) return apiError(reply);
    return textResult({
      ...((reply.data as JsonRecord | null) ?? {}),
      x402_payment_response: reply.paymentResponse,
    });
  },
);
readEditionTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_read_edition } });

const readSignalTool = server.tool(
  "truthly_read_signal",
  "Buy one story's full intelligence (body, sources, claims, Herald's fact-check and archive) for $0.02 USDC over x402, or re-read it free with the receipt from a previous purchase. The free teaser comes first; content is purchased only with approve_payment=true plus a wallet-produced payment signature. The returned receipt_id is required before that story can be traded.",
  {
    signal_id: z.string().uuid().describe("The story to read or buy"),
    receipt: z
      .string()
      .min(8)
      .optional()
      .describe("receipt_id from an earlier purchase of THIS story; re-reads it without paying again"),
    approve_payment: z.boolean().default(false),
    payment_signature: z
      .string()
      .min(1)
      .optional()
      .describe("One-time x402 PAYMENT-SIGNATURE produced by the user's wallet"),
  },
  async ({ signal_id, receipt, approve_payment, payment_signature }) => {
    const approvalError = assertApproved(approve_payment, payment_signature);
    if (approvalError) return approvalError;

    const teaserPath = `/api/signals/${encodeURIComponent(signal_id)}`;
    const teaserReply = await apiRequest(teaserPath);

    const intelPath = `/api/intel/${encodeURIComponent(signal_id)}`;
    const reply = await apiRequest(intelPath, {
      headers: receipt ? { "x-receipt": receipt } : paidHeaders(payment_signature),
    });
    if (reply.status === 402) {
      const challenge = paymentChallenge(reply, { method: "GET", path: intelPath }, "$0.02");
      const parsed = JSON.parse(challenge.content[0].text) as JsonRecord;
      return textResult({ ...parsed, free_teaser: teaserReply.ok ? teaserReply.data : null });
    }
    if (!reply.ok) return apiError(reply);
    return textResult({
      ...((reply.data as JsonRecord | null) ?? {}),
      x402_payment_response: reply.paymentResponse,
      free_teaser: teaserReply.ok ? teaserReply.data : null,
    });
  },
);
readSignalTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_read_signal } });

const reporterProfileTool = server.tool(
  "truthly_reporter_profile",
  "Read a reporter wallet's public stories, reputation, credited revenue, and on-chain payout receipts. Free.",
  {
    address: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, "Expected a 0x EVM address"),
  },
  async ({ address }) => {
    const reply = await apiRequest(
      `/api/reporters/${encodeURIComponent(address.toLowerCase())}`,
    );
    return reply.ok ? textResult(reply.data) : apiError(reply);
  },
);
reporterProfileTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_reporter_profile } });

const appealStatusTool = server.tool(
  "truthly_appeal_status",
  "Read the free public appeal docket for slashed stories and appeal outcomes. Optionally filter one signal. This tool cannot start or approve an appeal.",
  {
    signal_id: z.string().uuid().optional(),
  },
  async ({ signal_id }) => {
    const reply = await apiRequest("/api/appeal");
    if (!reply.ok) return apiError(reply);
    if (!signal_id) return textResult(reply.data);
    const queue = records(reply.data, "queue").filter(
      (item) => item.id === signal_id,
    );
    const ledger = records(reply.data, "ledger").filter(
      (item) => item.signal_id === signal_id,
    );
    return textResult({ signal_id, queue, ledger });
  },
);
appealStatusTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_appeal_status } });

const tradeSignalTool = server.tool(
  "truthly_trade_signal",
  "Prepare or execute a tightly scoped Flash advanced order on one eligible published story. The order must reproduce an unexpired executable LIVE Council BUY exactly: asset, entry, take-profit and stop-loss cannot be changed. The receipt_id from truthly_read_signal for THIS story, the council_run_id and a delegated mandate token are required. Above its mandate threshold, TRUTHLY pauses and returns a payload-bound World Agent Pass URL; execution requires that one-use authorization id and the unchanged request. Never infer prices or bypass approval.",
  {
    request_id: z
      .string()
      .uuid()
      .describe("Client-generated idempotency key; repeat the same value for preview and execution"),
    signal_id: z.string().uuid(),
    receipt: z
      .string()
      .min(8)
      .describe("receipt_id from the paid truthly_read_signal response for this exact story"),
    token: z.string().trim().min(2).max(10),
    side: z.literal("buy"),
    max_spend_usdc: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
    order_type: z.literal("limit"),
    limit_price_usd: z
      .string()
      .regex(/^\d+(?:\.\d{1,18})?$/)
      .describe("Maximum USD price per target token"),
    take_profit_price_usd: z
      .string()
      .regex(/^\d+(?:\.\d{1,18})?$/)
      .describe("Attached bracket take-profit; must be above the entry limit"),
    stop_loss_price_usd: z
      .string()
      .regex(/^\d+(?:\.\d{1,18})?$/)
      .describe("Attached bracket stop-loss; must be below the entry limit"),
    expires_at: z
      .string()
      .describe("ISO-8601 expiry between 15 minutes and 7 days in the future"),
    rationale: z.string().trim().min(10).max(280),
    mandate_token: z
      .string()
      .startsWith("apm_")
      .describe("One-time-issued bearer credential for the delegated trading agent"),
    authorization_id: z
      .string()
      .uuid()
      .optional()
      .describe("One-use World authorization id returned by the preview; include only after it is approved"),
    council_run_id: z
      .string()
      .uuid()
      .describe("Required unexpired executable LIVE Council BUY run for this exact signal and unchanged entry/stop/target levels; HOLD, SELL and Demo Mode IDs are rejected"),
    approved: z.boolean().default(false),
  },
  async ({ mandate_token, ...trade }) => {
    const reply = await apiRequest("/api/flash/trade", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mandate_token}`,
      },
      body: JSON.stringify(trade),
    });
    // 409 is the expected preview/approval response when approved=false.
    if (reply.status === 409 && !trade.approved) return textResult(reply.data);
    return reply.ok ? textResult(reply.data) : apiError(reply);
  },
);
tradeSignalTool.update({ _meta: { "truthly/policy": TOOL_POLICIES.truthly_trade_signal } });

  return server;
}
