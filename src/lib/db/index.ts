import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

type DbClient = Awaited<ReturnType<typeof drizzle<typeof schema>>>;
export type Database = DbClient;
export type DatabaseTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export type DatabaseExecutor = DbClient | DatabaseTransaction;

let _dbPromise: Promise<DbClient> | null = null;

async function initDb(): Promise<DbClient> {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL || "file:truthly.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  await runMigrations(client);

  // drizzle-orm 0.45+ returns a Promise
  return await drizzle(client, { schema });
}

// Each migration is a function that receives the raw libsql client.
// Migrations are idempotent — safe to re-run on existing DBs.
const MIGRATIONS: Array<(client: Client) => Promise<void>> = [
  // v1: Bootstrap schema
  async (client) => {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        account_id TEXT UNIQUE NOT NULL,
        chain_id TEXT NOT NULL,
        address TEXT NOT NULL,
        name TEXT NOT NULL,
        bio TEXT,
        registered_at TEXT NOT NULL,
        total_signals INTEGER DEFAULT 0 NOT NULL,
        signals_included INTEGER DEFAULT 0 NOT NULL,
        total_earned_cents INTEGER DEFAULT 0 NOT NULL,
        current_streak INTEGER DEFAULT 0 NOT NULL,
        longest_streak INTEGER DEFAULT 0 NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        headline TEXT NOT NULL,
        body TEXT NOT NULL,
        sources TEXT NOT NULL,
        tags TEXT NOT NULL,
        beat TEXT NOT NULL,
        status TEXT DEFAULT 'submitted' NOT NULL,
        score REAL,
        editor_feedback TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS editions (
        id TEXT PRIMARY KEY,
        number INTEGER UNIQUE NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        content_html TEXT NOT NULL,
        content_text TEXT NOT NULL,
        signal_count INTEGER NOT NULL,
        price_cents INTEGER DEFAULT 5 NOT NULL,
        cost_cents INTEGER DEFAULT 0 NOT NULL,
        revenue_cents INTEGER DEFAULT 0 NOT NULL,
        published_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        emailed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS edition_signals (
        edition_id TEXT NOT NULL REFERENCES editions(id),
        signal_id TEXT NOT NULL REFERENCES signals(id),
        position INTEGER NOT NULL,
        payout_cents INTEGER DEFAULT 0 NOT NULL,
        PRIMARY KEY (edition_id, signal_id)
      );

      CREATE TABLE IF NOT EXISTS subscribers (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        account_id TEXT,
        subscribed_at TEXT NOT NULL,
        active INTEGER DEFAULT 1 NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        description TEXT NOT NULL,
        from_address TEXT,
        to_address TEXT,
        tx_hash TEXT,
        edition_id TEXT REFERENCES editions(id),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
      CREATE INDEX IF NOT EXISTS idx_signals_beat ON signals(beat);
      CREATE INDEX IF NOT EXISTS idx_signals_agent ON signals(agent_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger(type);
      CREATE INDEX IF NOT EXISTS idx_ledger_edition ON ledger(edition_id);
    `);
  },

  // v2: Edition status, payments, entitlements, persistent nonces
  async (client) => {
    // SQLite: check if column exists before adding
    const cols = await client.execute("PRAGMA table_info(editions)");
    const hasStatus = cols.rows.some((r) => r.name === "status");
    if (!hasStatus) {
      await client.execute(
        "ALTER TABLE editions ADD COLUMN status TEXT DEFAULT 'compiled' NOT NULL",
      );
    }

    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        edition_id TEXT NOT NULL REFERENCES editions(id),
        payer_address TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        tx_hash TEXT,
        network TEXT NOT NULL,
        paid_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entitlements (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL REFERENCES payments(id),
        edition_id TEXT NOT NULL REFERENCES editions(id),
        account_id TEXT NOT NULL,
        granted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nonces (
        nonce TEXT PRIMARY KEY,
        used_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_payments_edition ON payments(edition_id);
      CREATE INDEX IF NOT EXISTS idx_payments_payer ON payments(payer_address);
      CREATE INDEX IF NOT EXISTS idx_entitlements_account ON entitlements(account_id);
      CREATE INDEX IF NOT EXISTS idx_entitlements_edition ON entitlements(edition_id);
      CREATE INDEX IF NOT EXISTS idx_nonces_used_at ON nonces(used_at);
    `);

    // Back-fill: mark existing editions that have emailed_at as 'published'
    // Guard against DBs that predate the emailed_at column
    const edCols = await client.execute("PRAGMA table_info(editions)");
    const hasEmailedAt = edCols.rows.some((r) => r.name === "emailed_at");
    if (hasEmailedAt) {
      await client.execute(
        "UPDATE editions SET status = 'published' WHERE emailed_at IS NOT NULL AND status = 'compiled'",
      );
    }
  },

  // v3: Herald's fact-check verdict per signal (JSON string)
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(signals)");
    const hasVerification = cols.rows.some((r) => r.name === "verification");
    if (!hasVerification) {
      try {
        await client.execute("ALTER TABLE signals ADD COLUMN verification TEXT");
      } catch (error) {
        // Another cold start may have added it a moment ago.
        if (!String(error).includes("duplicate column")) throw error;
      }
    }
  },

  // v4: one payment row per settled transaction (a replayed settlement can't pay reporters twice)
  async (client) => {
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_network_tx ON payments(network, tx_hash)",
    );
  },

  // v5: the cost of Herald's editor's brief per edition, and which wallet received each revenue
  // payment, so the open ledger reconciles with the chain. Backfills production history: the
  // briefs for editions #4 and #5 (Base txs 0xe44026828a63…, 0xbae84afde011…, 1000 atomic USDC
  // each) and one early filing fee (0x0f7ae369…) that paid the previous treasury.
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(editions)");
    if (!cols.rows.some((r) => r.name === "herald_cost_atomic")) {
      try {
        await client.execute("ALTER TABLE editions ADD COLUMN herald_cost_atomic TEXT");
      } catch (error) {
        // Another cold start may have added it a moment ago.
        if (!String(error).includes("duplicate column")) throw error;
      }
    }
    await client.execute(
      "UPDATE editions SET herald_cost_atomic = '1000' WHERE herald_cost_atomic IS NULL AND id IN ('0f2b6c0a-465e-4c06-b33f-9f89d147865e', 'f33eea38-72a6-43c0-b358-839327b07ea1')",
    );
    await client.execute(
      "UPDATE ledger SET to_address = '0x7BEE3F129BC5336EE073715f59D31d1A082622b4' WHERE type = 'revenue' AND to_address IS NULL AND tx_hash LIKE '0x0f7ae369%'",
    );
    const treasury = process.env.TREASURY_ADDRESS;
    if (treasury) {
      // Mainnet-era rows only (the era starts 2026-10-01; see lib/era.ts).
      await client.execute({
        sql: "UPDATE ledger SET to_address = ? WHERE type = 'revenue' AND to_address IS NULL AND created_at >= '2026-10-01T00:00:00.000Z'",
        args: [treasury],
      });
    }
  },

  // v6: 1¢ locked when a story is filed, settled by Herald's verdict.
  // supported/unchecked -> refunded, contradicted/unsupported -> slashed. Idempotent — safe to re-run.
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(signals)");
    const names = cols.rows.map((r) => r.name);
    if (!names.includes("stake_atomic")) {
      await client.execute(
        "ALTER TABLE signals ADD COLUMN stake_atomic TEXT NOT NULL DEFAULT '0'",
      );
    }
    if (!names.includes("stake_status")) {
      // 'none' (legacy rows, no stake) | 'locked' | 'refunded' | 'slashed'
      await client.execute(
        "ALTER TABLE signals ADD COLUMN stake_status TEXT NOT NULL DEFAULT 'none'",
      );
    }
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS settlements (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        stake_atomic TEXT NOT NULL,
        payout_atomic TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );
    `);
  },

  // v7: World-gated appeals. A slashed reporter may appeal once — but only a fresh,
  // matching human check approves it; every attempt is recorded (the denied path is the demo).
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(agents)");
    const names = cols.rows.map((r) => r.name);
    if (!names.includes("world_sub_hash")) {
      // Bound once at "birth" by IDKit; only a hash is ever stored — never the raw World sub.
      await client.execute("ALTER TABLE agents ADD COLUMN world_sub_hash TEXT");
    }
    if (!names.includes("world_verified_at")) {
      await client.execute("ALTER TABLE agents ADD COLUMN world_verified_at TEXT");
    }
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS appeals (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        sub_hash TEXT,
        auth_time INTEGER,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
    `);
  },
  // v8: IDKit proof-of-unique-human binding (one human, one byline wallet).
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(agents)");
    const names = cols.rows.map((r) => r.name);
    if (!names.includes("world_nullifier_hash")) {
      // Action-scoped nullifier from the IDKit proof, hashed before storage.
      await client.execute("ALTER TABLE agents ADD COLUMN world_nullifier_hash TEXT");
    }
  },
  // v9: ENSv2 bylines — a reporter's human-readable name, verified on-chain.
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(agents)");
    const names = cols.rows.map((r) => r.name);
    if (!names.includes("ens_name")) {
      await client.execute("ALTER TABLE agents ADD COLUMN ens_name TEXT");
    }
    if (!names.includes("ens_verified_at")) {
      await client.execute("ALTER TABLE agents ADD COLUMN ens_verified_at TEXT");
    }
  },
  // v10: Flash trade desk — one row per on-chain trade on a verified signal.
  async (client) => {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        signal_id TEXT REFERENCES signals(id),
        chain TEXT NOT NULL,
        side TEXT NOT NULL,
        qty TEXT NOT NULL,
        target_asset TEXT NOT NULL,
        contra_asset TEXT NOT NULL,
        quote_id TEXT,
        order_id TEXT UNIQUE,
        spent_notional TEXT,
        received_notional TEXT,
        funder TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        error TEXT,
        created_at TEXT NOT NULL
      )`,
    );
  },
  // v11: Scout discovery queue. Collection is separate from paid story filing.
  async (client) => {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS scout_candidates (
        id TEXT PRIMARY KEY,
        canonical_url TEXT UNIQUE NOT NULL,
        content_hash TEXT UNIQUE NOT NULL,
        source_kind TEXT NOT NULL,
        headline TEXT NOT NULL,
        summary TEXT NOT NULL,
        sources TEXT NOT NULL,
        tags TEXT NOT NULL,
        beat TEXT NOT NULL,
        published_at TEXT,
        discovered_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate'
      );
      CREATE INDEX IF NOT EXISTS idx_scout_candidates_status ON scout_candidates(status);
      CREATE INDEX IF NOT EXISTS idx_scout_candidates_published ON scout_candidates(published_at);
    `);
  },
  // v12: preserve the user's exact Flash approval alongside each attempted order.
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(trades)");
    const names = cols.rows.map((row) => row.name);
    const additions = [
      ["token_symbol", "TEXT"],
      ["max_spend_usdc", "TEXT"],
      ["rationale", "TEXT"],
      ["approved_at", "TEXT"],
    ] as const;
    for (const [name, type] of additions) {
      if (!names.includes(name)) {
        await client.execute(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
      }
    }
  },
  // v13: real on-chain stake refunds with durable pending/error/receipt state.
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(settlements)");
    const names = cols.rows.map((row) => row.name);
    const additions = [
      ["payout_status", "TEXT"],
      ["payout_tx_hash", "TEXT"],
      ["payout_error", "TEXT"],
      ["refund_ledger_id", "TEXT"],
      ["updated_at", "TEXT"],
    ] as const;
    for (const [name, type] of additions) {
      if (!names.includes(name)) {
        await client.execute(`ALTER TABLE settlements ADD COLUMN ${name} ${type}`);
      }
    }
    // Previous "refunds" had no transfer. Put them back into an honest retryable state.
    await client.execute(`
      UPDATE settlements
      SET payout_status = CASE WHEN action = 'refund' AND payout_atomic != '0' THEN 'pending' ELSE 'not_applicable' END,
          updated_at = COALESCE(updated_at, created_at)
      WHERE payout_status IS NULL
    `);
    await client.execute(`
      UPDATE signals
      SET stake_status = 'refund_pending'
      WHERE stake_status = 'refunded'
        AND id IN (
          SELECT signal_id FROM settlements
          WHERE action = 'refund' AND payout_status = 'pending' AND payout_tx_hash IS NULL
        )
    `);
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_settlements_payout_status ON settlements(payout_status)",
    );
  },
  // v14: structured evidence, source content hashes and correction/retraction history.
  async (client) => {
    const signalCols = await client.execute("PRAGMA table_info(signals)");
    const signalNames = signalCols.rows.map((row) => row.name);
    if (!signalNames.includes("source_metadata")) {
      await client.execute("ALTER TABLE signals ADD COLUMN source_metadata TEXT");
    }
    if (!signalNames.includes("claims")) {
      await client.execute("ALTER TABLE signals ADD COLUMN claims TEXT");
    }
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS source_snapshots (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL REFERENCES signals(id),
        url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        title TEXT,
        published_at TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_source_snapshot_unique
        ON source_snapshots(signal_id, url, content_hash);
      CREATE INDEX IF NOT EXISTS idx_source_snapshot_signal
        ON source_snapshots(signal_id);

      CREATE TABLE IF NOT EXISTS signal_revisions (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL REFERENCES signals(id),
        action TEXT NOT NULL,
        headline TEXT NOT NULL,
        body TEXT NOT NULL,
        sources TEXT NOT NULL,
        source_metadata TEXT,
        claims TEXT,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signal_revisions_signal
        ON signal_revisions(signal_id, created_at);

      INSERT INTO signal_revisions (
        id, signal_id, action, headline, body, sources, source_metadata,
        claims, reason, actor, created_at
      )
      SELECT
        lower(hex(randomblob(16))), s.id, 'filed', s.headline, s.body, s.sources,
        s.source_metadata, s.claims, 'Legacy filing imported into revision history',
        COALESCE((SELECT a.address FROM agents a WHERE a.id = s.agent_id), 'legacy'),
        s.created_at
      FROM signals s
      WHERE NOT EXISTS (
        SELECT 1 FROM signal_revisions r WHERE r.signal_id = s.id
      );
    `);
  },
  // v15: World-Gated Newsroom Mandates. IDKit roots durable principals;
  // delegated wallets share human-level quota/reputation; Agent Pass approvals
  // and their OIDC state survive serverless instance changes.
  async (client) => {
    const agentCols = await client.execute("PRAGMA table_info(agents)");
    if (!agentCols.rows.some((row) => row.name === "payout_address")) {
      await client.execute("ALTER TABLE agents ADD COLUMN payout_address TEXT");
    }

    const tradeCols = await client.execute("PRAGMA table_info(trades)");
    const tradeNames = tradeCols.rows.map((row) => row.name);
    for (const [name, type] of [
      ["authorization_id", "TEXT"],
      ["principal_id", "TEXT"],
      ["agent_wallet", "TEXT"],
    ] as const) {
      if (!tradeNames.includes(name)) {
        await client.execute(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
      }
    }

    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS human_principals (
        id TEXT PRIMARY KEY,
        nullifier_hash TEXT UNIQUE NOT NULL,
        owner_wallet TEXT UNIQUE NOT NULL,
        world_sub_hash TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        daily_filing_limit INTEGER NOT NULL DEFAULT 5,
        daily_stake_atomic TEXT NOT NULL DEFAULT '50000',
        daily_trade_atomic TEXT NOT NULL DEFAULT '5000000',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS delegated_agents (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES human_principals(id),
        agent_wallet TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        credential_hash TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS newsroom_mandates (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES human_principals(id),
        delegated_agent_id TEXT NOT NULL REFERENCES delegated_agents(id),
        version INTEGER NOT NULL DEFAULT 1,
        roles TEXT NOT NULL,
        allowed_beats TEXT NOT NULL,
        daily_filings INTEGER NOT NULL DEFAULT 0,
        daily_stake_atomic TEXT NOT NULL DEFAULT '0',
        max_trade_atomic TEXT NOT NULL DEFAULT '0',
        fresh_pass_above_atomic TEXT NOT NULL DEFAULT '0',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS newsroom_usage (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES human_principals(id),
        delegated_agent_id TEXT NOT NULL REFERENCES delegated_agents(id),
        kind TEXT NOT NULL,
        amount_atomic TEXT NOT NULL DEFAULT '0',
        day TEXT NOT NULL,
        ref_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS world_authorizations (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES human_principals(id),
        action TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        nonce TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        approved_at TEXT,
        consumed_at TEXT,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS authorization_attempts (
        id TEXT PRIMARY KEY,
        authorization_id TEXT NOT NULL REFERENCES world_authorizations(id),
        status TEXT NOT NULL,
        reason TEXT,
        sub_hash TEXT,
        auth_time INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS world_sessions (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        address TEXT,
        signal_id TEXT,
        principal_id TEXT,
        authorization_id TEXT,
        action TEXT,
        payload_hash TEXT,
        return_to TEXT NOT NULL,
        state TEXT UNIQUE NOT NULL,
        nonce TEXT NOT NULL,
        verifier TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state_consumed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idkit_nonces (
        nonce TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_newsroom_mandates_active_agent
        ON newsroom_mandates(delegated_agent_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_delegated_agents_principal
        ON delegated_agents(principal_id, status);
      CREATE INDEX IF NOT EXISTS idx_newsroom_usage_principal_day
        ON newsroom_usage(principal_id, day, kind);
      CREATE INDEX IF NOT EXISTS idx_newsroom_usage_agent_day
        ON newsroom_usage(delegated_agent_id, day, kind);
      CREATE INDEX IF NOT EXISTS idx_world_authorizations_principal
        ON world_authorizations(principal_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_authorization_attempts_authorization
        ON authorization_attempts(authorization_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_world_sessions_status
        ON world_sessions(status, expires_at);
    `);

    // Preserve existing IDKit/Agent Pass bindings as the first principal and
    // default delegated reporter for that human. Deterministic legacy ids make
    // this idempotent and avoid ever needing the raw nullifier.
    await client.executeMultiple(`
      INSERT OR IGNORE INTO human_principals (
        id, nullifier_hash, owner_wallet, world_sub_hash, status,
        daily_filing_limit, daily_stake_atomic, daily_trade_atomic, created_at, updated_at
      )
      SELECT
        'principal-' || world_nullifier_hash,
        world_nullifier_hash,
        lower(address),
        world_sub_hash,
        'active',
        5,
        '50000',
        '5000000',
        COALESCE(world_verified_at, registered_at),
        COALESCE(world_verified_at, registered_at)
      FROM agents
      WHERE world_nullifier_hash IS NOT NULL;

      INSERT OR IGNORE INTO delegated_agents (
        id, principal_id, agent_wallet, label, status, created_at, updated_at
      )
      SELECT
        'delegated-' || a.id,
        p.id,
        lower(a.address),
        a.name,
        'active',
        a.registered_at,
        a.registered_at
      FROM agents a
      JOIN human_principals p ON p.owner_wallet = lower(a.address)
      WHERE a.world_nullifier_hash IS NOT NULL;

      INSERT OR IGNORE INTO newsroom_mandates (
        id, principal_id, delegated_agent_id, version, roles, allowed_beats,
        daily_filings, daily_stake_atomic, max_trade_atomic,
        fresh_pass_above_atomic, status, created_at
      )
      SELECT
        'mandate-' || d.id,
        d.principal_id,
        d.id,
        1,
        '["scout","file","trade_preview"]',
        '["bitcoin","defi","agentic-payments","infrastructure","regulation","market-signals"]',
        5,
        '50000',
        '2000000',
        '500000',
        'active',
        d.created_at
      FROM delegated_agents d
      WHERE d.status = 'active';
    `);
  },

  // v16: signal-scoped intelligence purchases. One payment buys one story's
  // intel, its entitlement is the receipt a trading agent must present, and
  // every executed trade records which receipt authorized it.
  async (client) => {
    const payments = await client.execute("PRAGMA table_info(payments)");
    if (!payments.rows.some((row) => row.name === "signal_id")) {
      await client.execute("ALTER TABLE payments ADD COLUMN signal_id TEXT REFERENCES signals(id)");
    }

    const entitlements = await client.execute("PRAGMA table_info(entitlements)");
    if (!entitlements.rows.some((row) => row.name === "signal_id")) {
      await client.execute(
        "ALTER TABLE entitlements ADD COLUMN signal_id TEXT REFERENCES signals(id)",
      );
    }

    const trades = await client.execute("PRAGMA table_info(trades)");
    if (!trades.rows.some((row) => row.name === "receipt_id")) {
      await client.execute("ALTER TABLE trades ADD COLUMN receipt_id TEXT");
    }

    await client.executeMultiple(`
      CREATE INDEX IF NOT EXISTS idx_payments_signal ON payments(signal_id);
      CREATE INDEX IF NOT EXISTS idx_entitlements_signal ON entitlements(signal_id);
      CREATE INDEX IF NOT EXISTS idx_trades_receipt ON trades(receipt_id);
    `);
  },

  // v17: Flash Advanced Orders. Preserve legacy market rows, while every new
  // receipt-gated trade records its qualifying limit order and exact expiry.
  async (client) => {
    const trades = await client.execute("PRAGMA table_info(trades)");
    const names = trades.rows.map((row) => row.name);
    for (const [name, type] of [
      ["order_type", "TEXT NOT NULL DEFAULT 'market'"],
      ["limit_price_usd", "TEXT"],
      ["order_expires_at", "TEXT"],
      ["take_profit_price_usd", "TEXT"],
      ["stop_loss_price_usd", "TEXT"],
      ["bracket_status", "TEXT"],
      ["bracket_order_id", "TEXT"],
      ["provider_status", "TEXT"],
      ["provider_close_reason", "TEXT"],
      ["fill_count", "INTEGER NOT NULL DEFAULT 0"],
      ["fill_transaction", "TEXT"],
      ["reconciled_at", "TEXT"],
      ["request_id", "TEXT"],
    ] as const) {
      if (!names.includes(name)) {
        await client.execute(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
      }
    }
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_trades_order_type ON trades(order_type, created_at)",
    );
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_request_id ON trades(request_id)",
    );
  },

  // v18: principal-level emergency pause. Pausing must be instant and must not
  // depend on World being reachable, so it is a plain column on the principal.
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(human_principals)");
    const names = cols.rows.map((row) => row.name);
    for (const [name, type] of [
      ["paused_at", "TEXT"],
      ["pause_reason", "TEXT"],
    ] as const) {
      if (!names.includes(name)) {
        try {
          await client.execute(`ALTER TABLE human_principals ADD COLUMN ${name} ${type}`);
        } catch (error) {
          // A concurrent cold start may have completed this idempotent change.
          if (!String(error).includes("duplicate column")) throw error;
        }
      }
    }
  },

  // v19: a monotonic pause generation closes the stale-resume race. This is a
  // separate migration because development databases may already have applied
  // v18 while this security review was in progress.
  async (client) => {
    const cols = await client.execute("PRAGMA table_info(human_principals)");
    if (!cols.rows.some((row) => row.name === "pause_version")) {
      try {
        await client.execute(
          "ALTER TABLE human_principals ADD COLUMN pause_version INTEGER NOT NULL DEFAULT 0",
        );
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
    }
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_trades_principal_status ON trades(principal_id, status, created_at)",
    );
  },

  // v20: immutable council deliberations and fully separate paper executions.
  // Demo records intentionally cannot carry live order/transaction identifiers.
  async (client) => {
    const trades = await client.execute("PRAGMA table_info(trades)");
    const tradeNames = trades.rows.map((row) => row.name);
    for (const [name, type] of [
      ["council_run_id", "TEXT"],
      ["execution_mode", "TEXT NOT NULL DEFAULT 'live'"],
    ] as const) {
      if (!tradeNames.includes(name)) {
        try {
          await client.execute(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
        } catch (error) {
          if (!String(error).includes("duplicate column")) throw error;
        }
      }
    }

    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS council_runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        source_signal_id TEXT,
        demo_scenario_id TEXT,
        input_hash TEXT NOT NULL,
        news_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        market_snapshot_json TEXT,
        council_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        valid_until TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_council_runs_mode_created
        ON council_runs(mode, created_at);
      CREATE INDEX IF NOT EXISTS idx_council_runs_signal
        ON council_runs(source_signal_id, created_at);

      CREATE TABLE IF NOT EXISTS paper_executions (
        id TEXT PRIMARY KEY,
        council_run_id TEXT NOT NULL REFERENCES council_runs(id),
        demo_scenario_id TEXT NOT NULL,
        asset_symbol TEXT NOT NULL,
        asset_address TEXT NOT NULL,
        action TEXT NOT NULL,
        notional_usdc TEXT NOT NULL,
        entry_price_usd TEXT,
        stop_loss_price_usd TEXT,
        take_profit_price_usd TEXT,
        provider_quote_id TEXT,
        quote_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_execution_run
        ON paper_executions(council_run_id);

      CREATE TABLE IF NOT EXISTS paper_marks (
        id TEXT PRIMARY KEY,
        paper_execution_id TEXT NOT NULL REFERENCES paper_executions(id),
        market_price_usd TEXT NOT NULL,
        provider_quote_id TEXT,
        quote_json TEXT NOT NULL,
        hypothetical_pnl_percent TEXT NOT NULL,
        outcome TEXT NOT NULL,
        marked_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_marks_execution
        ON paper_marks(paper_execution_id, marked_at);
    `);
  },

  // v21: durable Uniswap/Definitive market-integrity evidence for live orders.
  // Executable Uniswap payloads are deliberately never stored.
  async (client) => {
    const trades = await client.execute("PRAGMA table_info(trades)");
    const names = trades.rows.map((row) => row.name);
    for (const [name, type] of [
      ["market_guard_status", "TEXT"],
      ["market_guard_json", "TEXT"],
      ["uniswap_request_id", "TEXT"],
      ["uniswap_quote_id", "TEXT"],
      ["uniswap_routing", "TEXT"],
      ["uniswap_price_usd", "TEXT"],
      ["market_deviation_bps", "TEXT"],
    ] as const) {
      if (!names.includes(name)) {
        try {
          await client.execute(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
        } catch (error) {
          if (!String(error).includes("duplicate column")) throw error;
        }
      }
    }
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_trades_market_guard_status ON trades(market_guard_status, created_at)",
    );
  },
];

async function runMigrations(client: Client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const result = await client.execute(
    "SELECT COALESCE(MAX(version), 0) AS v FROM _schema_migrations",
  );
  const currentVersion = Number(result.rows[0]?.v ?? 0);

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    await MIGRATIONS[i](client);
    await client.execute({
      sql: "INSERT OR IGNORE INTO _schema_migrations (version, applied_at) VALUES (?, ?)",
      args: [i + 1, new Date().toISOString()],
    });
  }
}

export async function getDb(): Promise<DbClient> {
  if (!_dbPromise) {
    // A failed cold start must not poison this instance: clear it so the next call retries.
    _dbPromise = initDb().catch((error: unknown) => {
      _dbPromise = null;
      throw error;
    });
  }
  return _dbPromise;
}

export { schema };
