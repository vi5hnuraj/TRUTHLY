import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  accountId: text("account_id").unique().notNull(),
  chainId: text("chain_id").notNull(),
  address: text("address").notNull(),
  name: text("name").notNull(),
  bio: text("bio"),
  registeredAt: text("registered_at").notNull(),
  totalSignals: integer("total_signals").default(0).notNull(),
  signalsIncluded: integer("signals_included").default(0).notNull(),
  totalEarnedCents: integer("total_earned_cents").default(0).notNull(),
  currentStreak: integer("current_streak").default(0).notNull(),
  longestStreak: integer("longest_streak").default(0).notNull(),
  // TRUTHLY / World: bound at byline birth (IDKit), checked fresh on appeal.
  worldSubHash: text("world_sub_hash"), // sha256(World sub) — the raw sub is never stored
  worldVerifiedAt: text("world_verified_at"),
  worldNullifierHash: text("world_nullifier_hash"), // legacy mirror; principal table is authoritative
  ensName: text("ens_name"), // ENSv2 byline, e.g. maya.stakedbylines.eth
  ensVerifiedAt: text("ens_verified_at"), // when on-chain resolution last proved name → this wallet
  payoutAddress: text("payout_address"), // World-gated override; null means pay the byline wallet
});

// IDKit creates this durable, pseudonymous root. A principal may delegate many
// wallets, but reputation, quotas and revocation remain attached to this row.
export const humanPrincipals = sqliteTable("human_principals", {
  id: text("id").primaryKey(),
  nullifierHash: text("nullifier_hash").unique().notNull(),
  ownerWallet: text("owner_wallet").unique().notNull(),
  worldSubHash: text("world_sub_hash").unique(),
  status: text("status").default("active").notNull(), // active | revoked
  dailyFilingLimit: integer("daily_filing_limit").default(5).notNull(),
  dailyStakeAtomic: text("daily_stake_atomic").default("50000").notNull(),
  dailyTradeAtomic: text("daily_trade_atomic").default("5000000").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  revokedAt: text("revoked_at"),
  // Emergency stop. While set, every delegated agent of this principal is
  // blocked server-side before any sensitive action, and no new authorization
  // can be minted except the one that resumes the principal.
  pausedAt: text("paused_at"),
  pauseReason: text("pause_reason"),
  // Monotonic generation prevents an authorization for an earlier pause from
  // clearing a newer emergency stop after concurrent resume/pause requests.
  pauseVersion: integer("pause_version").default(0).notNull(),
});

// A wallet controlled by an agent. The bearer credential is returned once;
// only its SHA-256 digest is stored, so database reads cannot impersonate it.
export const delegatedAgents = sqliteTable("delegated_agents", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => humanPrincipals.id),
  agentWallet: text("agent_wallet").unique().notNull(),
  label: text("label").notNull(),
  credentialHash: text("credential_hash").unique(),
  status: text("status").default("active").notNull(), // active | revoked
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  revokedAt: text("revoked_at"),
});

// HORS-style per-function authority, specialized for newsroom actions. A new
// version supersedes the old row instead of rewriting the audit history.
export const newsroomMandates = sqliteTable("newsroom_mandates", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => humanPrincipals.id),
  delegatedAgentId: text("delegated_agent_id").notNull().references(() => delegatedAgents.id),
  version: integer("version").default(1).notNull(),
  roles: text("roles").notNull(), // JSON string[]
  allowedBeats: text("allowed_beats").notNull(), // JSON string[]
  dailyFilings: integer("daily_filings").default(0).notNull(),
  dailyStakeAtomic: text("daily_stake_atomic").default("0").notNull(),
  maxTradeAtomic: text("max_trade_atomic").default("0").notNull(),
  freshPassAboveAtomic: text("fresh_pass_above_atomic").default("0").notNull(),
  status: text("status").default("active").notNull(), // active | superseded | revoked | expired
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
});

// Append-only usage makes a quota follow the human principal rather than a
// wallet. That is the newsroom equivalent of Turing Pool's per-human quota.
export const newsroomUsage = sqliteTable("newsroom_usage", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => humanPrincipals.id),
  delegatedAgentId: text("delegated_agent_id").notNull().references(() => delegatedAgents.id),
  kind: text("kind").notNull(), // filing | stake | trade
  amountAtomic: text("amount_atomic").default("0").notNull(),
  day: text("day").notNull(), // UTC YYYY-MM-DD
  refId: text("ref_id"),
  createdAt: text("created_at").notNull(),
});

// One exact, short-lived, one-use permission minted after fresh Agent Pass.
export const worldAuthorizations = sqliteTable("world_authorizations", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => humanPrincipals.id),
  action: text("action").notNull(),
  payloadHash: text("payload_hash").notNull(),
  payloadJson: text("payload_json").notNull(),
  nonce: text("nonce").unique().notNull(),
  status: text("status").default("pending").notNull(), // pending | approved | denied | cancelled | expired | mismatch | consumed
  createdAt: text("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  approvedAt: text("approved_at"),
  consumedAt: text("consumed_at"),
  reason: text("reason"),
});

// Every success and denial is retained, including wrong-human, expiry,
// modified-payload and replay attempts.
export const authorizationAttempts = sqliteTable("authorization_attempts", {
  id: text("id").primaryKey(),
  authorizationId: text("authorization_id").notNull().references(() => worldAuthorizations.id),
  status: text("status").notNull(),
  reason: text("reason"),
  subHash: text("sub_hash"),
  authTime: integer("auth_time"),
  createdAt: text("created_at").notNull(),
});

// OIDC state and PKCE are durable so a callback may land on another serverless
// instance. Secrets are never returned by the public session endpoint.
export const worldSessions = sqliteTable("world_sessions", {
  id: text("id").primaryKey(),
  purpose: text("purpose").notNull(),
  address: text("address"),
  signalId: text("signal_id"),
  principalId: text("principal_id"),
  authorizationId: text("authorization_id"),
  action: text("action"),
  payloadHash: text("payload_hash"),
  returnTo: text("return_to").notNull(),
  state: text("state").unique().notNull(),
  nonce: text("nonce").notNull(),
  verifier: text("verifier").notNull(),
  startedAt: integer("started_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  stateConsumedAt: text("state_consumed_at"),
  status: text("status").default("pending").notNull(),
  reason: text("reason"),
  updatedAt: text("updated_at").notNull(),
});

export const idkitNonces = sqliteTable("idkit_nonces", {
  nonce: text("nonce").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: text("consumed_at"),
});

// One row per Flash trade the newsroom executes on a verified signal.
// status: reserved | submitting | submitted | needs_review | failed. A reserved
// row has not crossed the final pause gate; ambiguous provider responses remain
// needs_review and are never auto-retried.
export const trades = sqliteTable("trades", {
  id: text("id").primaryKey(),
  requestId: text("request_id").unique(),
  signalId: text("signal_id").references(() => signals.id),
  chain: text("chain").notNull(), // base
  side: text("side").notNull(), // buy | sell
  qty: text("qty").notNull(),
  targetAsset: text("target_asset").notNull(),
  contraAsset: text("contra_asset").notNull(),
  tokenSymbol: text("token_symbol"),
  maxSpendUsdc: text("max_spend_usdc"),
  orderType: text("order_type").default("market").notNull(), // market (legacy) | limit
  limitPriceUsd: text("limit_price_usd"),
  orderExpiresAt: text("order_expires_at"),
  takeProfitPriceUsd: text("take_profit_price_usd"),
  stopLossPriceUsd: text("stop_loss_price_usd"),
  bracketStatus: text("bracket_status"),
  bracketOrderId: text("bracket_order_id"),
  providerStatus: text("provider_status"),
  providerCloseReason: text("provider_close_reason"),
  fillCount: integer("fill_count").default(0).notNull(),
  fillTransaction: text("fill_transaction"),
  reconciledAt: text("reconciled_at"),
  rationale: text("rationale"),
  approvedAt: text("approved_at"),
  authorizationId: text("authorization_id"),
  // Optional immutable council run that informed this live order. Demo council
  // runs are never accepted by the live execution route.
  councilRunId: text("council_run_id"),
  executionMode: text("execution_mode").default("live").notNull(),
  // The paid signal-intel receipt that authorized this order (see lib/intel.ts).
  receiptId: text("receipt_id"),
  principalId: text("principal_id"),
  agentWallet: text("agent_wallet"),
  quoteId: text("quote_id"),
  // Fresh cross-market evidence captured before Definitive submission. The
  // full JSON contains safe quote metadata only—never Uniswap calldata,
  // permits, API credentials or signatures.
  marketGuardStatus: text("market_guard_status"),
  marketGuardJson: text("market_guard_json"),
  uniswapRequestId: text("uniswap_request_id"),
  uniswapQuoteId: text("uniswap_quote_id"),
  uniswapRouting: text("uniswap_routing"),
  uniswapPriceUsd: text("uniswap_price_usd"),
  marketDeviationBps: text("market_deviation_bps"),
  orderId: text("order_id").unique(),
  spentNotional: text("spent_notional"),
  receivedNotional: text("received_notional"),
  funder: text("funder").notNull(),
  status: text("status").default("submitted").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

// Immutable AI deliberation record. `mode` is demo | live; demo inputs are
// predefined scenarios and live inputs must reference a Herald-verified signal.
export const councilRuns = sqliteTable("council_runs", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  sourceSignalId: text("source_signal_id"),
  demoScenarioId: text("demo_scenario_id"),
  inputHash: text("input_hash").notNull(),
  newsJson: text("news_json").notNull(),
  verificationJson: text("verification_json").notNull(),
  marketSnapshotJson: text("market_snapshot_json"),
  councilJson: text("council_json"),
  status: text("status").notNull(), // pending | completed | failed
  error: text("error"),
  validUntil: text("valid_until"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

// Paper executions are physically separate from live `trades`: they have no
// funder, signature, authorization, transaction hash or provider order id.
export const paperExecutions = sqliteTable("paper_executions", {
  id: text("id").primaryKey(),
  councilRunId: text("council_run_id").notNull().references(() => councilRuns.id),
  demoScenarioId: text("demo_scenario_id").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  assetAddress: text("asset_address").notNull(),
  action: text("action").notNull(), // BUY | SELL | HOLD
  notionalUsdc: text("notional_usdc").notNull(),
  entryPriceUsd: text("entry_price_usd"),
  stopLossPriceUsd: text("stop_loss_price_usd"),
  takeProfitPriceUsd: text("take_profit_price_usd"),
  providerQuoteId: text("provider_quote_id"),
  quoteJson: text("quote_json").notNull(),
  status: text("status").notNull(), // open | hold | take_profit | stop_loss
  createdAt: text("created_at").notNull(),
  closedAt: text("closed_at"),
});

export const paperMarks = sqliteTable("paper_marks", {
  id: text("id").primaryKey(),
  paperExecutionId: text("paper_execution_id").notNull().references(() => paperExecutions.id),
  marketPriceUsd: text("market_price_usd").notNull(),
  providerQuoteId: text("provider_quote_id"),
  quoteJson: text("quote_json").notNull(),
  hypotheticalPnlPercent: text("hypothetical_pnl_percent").notNull(),
  outcome: text("outcome").notNull(),
  markedAt: text("marked_at").notNull(),
});

// Every appeal attempt is recorded — approved or denied (denied rows are the demo).
export const appeals = sqliteTable("appeals", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  agentId: text("agent_id").notNull(),
  status: text("status").notNull(), // approved | denied
  reason: text("reason"),
  subHash: text("sub_hash"),
  authTime: integer("auth_time"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
});

export const signals = sqliteTable("signals", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  headline: text("headline").notNull(),
  body: text("body").notNull(),
  sources: text("sources").notNull(), // JSON array
  sourceMetadata: text("source_metadata"), // JSON SourceMetadata[]
  claims: text("claims"), // JSON StoryClaim[]
  tags: text("tags").notNull(), // JSON array
  beat: text("beat").notNull(),
  status: text("status").default("submitted").notNull(),
  score: real("score"),
  editorFeedback: text("editor_feedback"),
  verification: text("verification"), // JSON: Herald's fact-check (see lib/herald/verification.ts)
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // TRUTHLY: 1¢ locked at filing, settled by Herald's verdict.
  stakeAtomic: text("stake_atomic").default("0").notNull(), // atomic USDC (10000 = 1¢)
  stakeStatus: text("stake_status").default("none").notNull(), // none | locked | refund_pending | refunded | slashed
});

export const sourceSnapshots = sqliteTable("source_snapshots", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull().references(() => signals.id),
  url: text("url").notNull(),
  contentHash: text("content_hash").notNull(),
  title: text("title"),
  publishedAt: text("published_at"),
  fetchedAt: text("fetched_at").notNull(),
});

export const signalRevisions = sqliteTable("signal_revisions", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull().references(() => signals.id),
  action: text("action").notNull(), // filed | corrected | retracted
  headline: text("headline").notNull(),
  body: text("body").notNull(),
  sources: text("sources").notNull(),
  sourceMetadata: text("source_metadata"),
  claims: text("claims"),
  reason: text("reason").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
});

// Unpaid discoveries from RSS/GitHub. Scout queues leads; it never files or spends.
export const scoutCandidates = sqliteTable("scout_candidates", {
  id: text("id").primaryKey(), // sha256(canonical URL)
  canonicalUrl: text("canonical_url").unique().notNull(),
  contentHash: text("content_hash").unique().notNull(),
  sourceKind: text("source_kind").notNull(), // rss | github | snapshot
  headline: text("headline").notNull(),
  summary: text("summary").notNull(),
  sources: text("sources").notNull(), // JSON array
  tags: text("tags").notNull(), // JSON array
  beat: text("beat").notNull(),
  publishedAt: text("published_at"),
  discoveredAt: text("discovered_at").notNull(),
  status: text("status").default("candidate").notNull(),
});

// One row per stake settlement — the referee's record of every refund/slash decision.
export const settlements = sqliteTable("settlements", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  verdict: text("verdict").notNull(), // supported | partially_supported | contradicted | unsupported | unchecked
  stakeAtomic: text("stake_atomic").notNull(),
  payoutAtomic: text("payout_atomic").notNull(),
  action: text("action").notNull(), // refund | slash
  reason: text("reason"),
  payoutStatus: text("payout_status"), // pending | settled | not_applicable
  payoutTxHash: text("payout_tx_hash"),
  payoutError: text("payout_error"),
  refundLedgerId: text("refund_ledger_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

export const editions = sqliteTable("editions", {
  id: text("id").primaryKey(),
  number: integer("number").unique().notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  contentHtml: text("content_html").notNull(),
  contentText: text("content_text").notNull(),
  signalCount: integer("signal_count").notNull(),
  priceCents: integer("price_cents").default(5).notNull(),
  costCents: integer("cost_cents").default(0).notNull(),
  // What Herald's paid editor's brief cost, in atomic USDC (sub-cent, so not in costCents).
  heraldCostAtomic: text("herald_cost_atomic"),
  revenueCents: integer("revenue_cents").default(0).notNull(),
  publishedAt: text("published_at").notNull(),
  createdAt: text("created_at").notNull(),
  emailedAt: text("emailed_at"),
  status: text("status").default("compiled").notNull(), // compiled | published | delivery_failed
});

export const editionSignals = sqliteTable(
  "edition_signals",
  {
    editionId: text("edition_id")
      .notNull()
      .references(() => editions.id),
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id),
    position: integer("position").notNull(),
    payoutCents: integer("payout_cents").default(0).notNull(),
  },
  (table) => [primaryKey({ columns: [table.editionId, table.signalId] })],
);

export const subscribers = sqliteTable("subscribers", {
  id: text("id").primaryKey(),
  email: text("email").unique().notNull(),
  accountId: text("account_id"),
  subscribedAt: text("subscribed_at").notNull(),
  active: integer("active").default(1).notNull(),
});

export const ledger = sqliteTable("ledger", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // revenue | expense | payout | refund
  amountCents: integer("amount_cents").notNull(),
  description: text("description").notNull(),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  txHash: text("tx_hash"),
  editionId: text("edition_id").references(() => editions.id),
  createdAt: text("created_at").notNull(),
});

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  editionId: text("edition_id")
    .notNull()
    .references(() => editions.id),
  // Set when the sale is one signal's intel rather than a whole edition. The
  // payment still books against the edition that published the story.
  signalId: text("signal_id").references(() => signals.id),
  payerAddress: text("payer_address").notNull(),
  amountCents: integer("amount_cents").notNull(),
  txHash: text("tx_hash"),
  network: text("network").notNull(),
  paidAt: text("paid_at").notNull(),
});

export const entitlements = sqliteTable("entitlements", {
  id: text("id").primaryKey(),
  paymentId: text("payment_id")
    .notNull()
    .references(() => payments.id),
  editionId: text("edition_id")
    .notNull()
    .references(() => editions.id),
  // Signal-scoped receipt: non-null only for individual intelligence purchases.
  signalId: text("signal_id").references(() => signals.id),
  accountId: text("account_id").notNull(),
  grantedAt: text("granted_at").notNull(),
});

export const nonces = sqliteTable("nonces", {
  nonce: text("nonce").primaryKey(),
  usedAt: integer("used_at").notNull(),
});
