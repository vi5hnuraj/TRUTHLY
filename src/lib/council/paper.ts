import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { canonicalJson, type JsonValue } from "@/lib/world/actions";
import type { CouncilResult, MarketIntegritySnapshot } from "./types";

export function hypotheticalPnlPercent(
  action: "BUY" | "SELL" | "HOLD",
  entry: number,
  mark: number,
): number {
  if (action === "HOLD") return 0;
  if (!(entry > 0) || !(mark > 0)) throw new Error("Paper P&L requires positive prices.");
  return action === "BUY" ? ((mark - entry) / entry) * 100 : ((entry - mark) / entry) * 100;
}

function paperOutcome(
  action: "BUY" | "SELL" | "HOLD",
  mark: number,
  stop: number | null,
  takeProfit: number | null,
): "open" | "hold" | "take_profit" | "stop_loss" {
  if (action === "HOLD") return "hold";
  if (stop === null || takeProfit === null) return "open";
  if (action === "BUY") {
    if (mark >= takeProfit) return "take_profit";
    if (mark <= stop) return "stop_loss";
  } else {
    if (mark <= takeProfit) return "take_profit";
    if (mark >= stop) return "stop_loss";
  }
  return "open";
}

export async function createPaperExecution(input: {
  councilRunId: string;
  demoScenarioId: string;
  council: CouncilResult;
  market: MarketIntegritySnapshot;
  notionalUsdc?: string;
}) {
  const db = await getDb();
  const id = randomUUID();
  const status = input.council.action === "HOLD" ? "hold" : "open";
  await db
    .insert(schema.paperExecutions)
    .values({
      id,
      councilRunId: input.councilRunId,
      demoScenarioId: input.demoScenarioId,
      assetSymbol: input.council.assetSymbol,
      assetAddress: input.council.assetAddress,
      action: input.council.action,
      notionalUsdc: input.notionalUsdc ?? process.env.DEMO_PAPER_NOTIONAL_USDC ?? "100",
      // Paper execution occurs at the actual quote snapshot, not an invented fill.
      entryPriceUsd: input.council.action === "HOLD" ? null : input.market.impliedPriceUsd,
      stopLossPriceUsd: input.council.stopLossPriceUsd,
      takeProfitPriceUsd: input.council.takeProfitPriceUsd,
      providerQuoteId: input.market.providerQuoteId,
      quoteJson: canonicalJson(input.market as unknown as JsonValue),
      status,
      createdAt: new Date().toISOString(),
    })
    .run();
  return paperExecutionById(id);
}

export async function paperExecutionById(id: string) {
  const db = await getDb();
  return db.select().from(schema.paperExecutions).where(eq(schema.paperExecutions.id, id)).get();
}

export async function markPaperExecution(
  executionId: string,
  market: MarketIntegritySnapshot,
) {
  const db = await getDb();
  const execution = await paperExecutionById(executionId);
  if (!execution) throw new Error("Paper execution not found.");
  const entry = Number(execution.entryPriceUsd ?? market.impliedPriceUsd);
  const mark = Number(market.impliedPriceUsd);
  const action = execution.action as "BUY" | "SELL" | "HOLD";
  const pnl = hypotheticalPnlPercent(action, entry, mark);
  const outcome = paperOutcome(
    action,
    mark,
    execution.stopLossPriceUsd ? Number(execution.stopLossPriceUsd) : null,
    execution.takeProfitPriceUsd ? Number(execution.takeProfitPriceUsd) : null,
  );
  const markedAt = new Date().toISOString();
  const markId = randomUUID();
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.paperMarks)
      .values({
        id: markId,
        paperExecutionId: execution.id,
        marketPriceUsd: market.impliedPriceUsd,
        providerQuoteId: market.providerQuoteId,
        quoteJson: canonicalJson(market as unknown as JsonValue),
        hypotheticalPnlPercent: pnl.toFixed(6),
        outcome,
        markedAt,
      })
      .run();
    if (["take_profit", "stop_loss"].includes(outcome)) {
      await tx
        .update(schema.paperExecutions)
        .set({ status: outcome, closedAt: markedAt })
        .where(eq(schema.paperExecutions.id, execution.id))
        .run();
    }
  });
  return db.select().from(schema.paperMarks).where(eq(schema.paperMarks.id, markId)).get();
}

export async function recentPaperExecutions(limit = 20) {
  const db = await getDb();
  return db
    .select()
    .from(schema.paperExecutions)
    .orderBy(desc(schema.paperExecutions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
}

export async function paperMarksForExecution(executionId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.paperMarks)
    .where(eq(schema.paperMarks.paperExecutionId, executionId))
    .orderBy(schema.paperMarks.markedAt);
}

export function publicPaperExecution(row: typeof schema.paperExecutions.$inferSelect) {
  return {
    id: row.id,
    label: "PAPER EXECUTION — NO TRANSACTION WAS SUBMITTED",
    council_run_id: row.councilRunId,
    demo_scenario_id: row.demoScenarioId,
    asset_symbol: row.assetSymbol,
    asset_address: row.assetAddress,
    action: row.action,
    notional_usdc: row.notionalUsdc,
    entry_price_usd: row.entryPriceUsd,
    stop_loss_price_usd: row.stopLossPriceUsd,
    take_profit_price_usd: row.takeProfitPriceUsd,
    provider_quote_id: row.providerQuoteId,
    status: row.status,
    transaction_hash: null,
    order_id: null,
    created_at: row.createdAt,
    closed_at: row.closedAt,
  };
}
