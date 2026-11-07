import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { readFlashOrder } from "@/lib/flash/trade";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalFailure = new Set([
  "ORDER_STATUS_CANCELLED",
  "ORDER_STATUS_REJECTED",
  "ORDER_STATUS_TERMINATED",
]);

const sameAddress = (left: string | null | undefined, right: string | null | undefined) =>
  Boolean(left && right && left.toLowerCase() === right.toLowerCase());

function sameDecimal(left: string | null | undefined, right: string | null | undefined) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * GET /api/flash/trade/[id] — reconcile one local intent against Flash.
 *
 * Provider identity and every approved advanced-order level are checked before
 * the local row is updated. This endpoint is safe to repeat and never submits,
 * signs, cancels or updates an order.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const limited = checkRateLimit(req, 20);
  if (limited) return limited;
  const { id } = await params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "invalid_trade_id" }, { status: 400 });
  }

  const db = await getDb();
  const trade = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, id))
    .get();
  if (!trade) return NextResponse.json({ error: "trade_not_found" }, { status: 404 });
  if (!trade.orderId || !trade.funder || trade.funder === "pending") {
    return NextResponse.json(
      {
        trade,
        reconciled: false,
        reason: "provider_order_id_unavailable",
        detail:
          "This submission has no provider order id. It remains blocked from retry and needs operator review.",
      },
      { status: 409 },
    );
  }

  let provider;
  try {
    provider = await readFlashOrder(trade.orderId, trade.funder);
  } catch (error) {
    console.error(
      "Flash reconciliation failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { trade, reconciled: false, reason: "provider_read_failed" },
      { status: 502 },
    );
  }

  const order = provider.order;
  const attached = order.attachedBracket;
  const identityMatches =
    order.orderId === trade.orderId &&
    order.orderType === trade.orderType &&
    order.side === trade.side &&
    sameAddress(order.funderAddress, trade.funder) &&
    sameAddress(order.targetAsset?.address, trade.targetAsset) &&
    sameAddress(order.contraAsset?.address, trade.contraAsset) &&
    sameDecimal(order.limitCrossPrice, trade.limitPriceUsd) &&
    Date.parse(order.expiresAt ?? "") === Date.parse(trade.orderExpiresAt ?? "") &&
    sameDecimal(attached?.takeProfit?.notionalPrice, trade.takeProfitPriceUsd) &&
    sameDecimal(attached?.stopLoss?.notionalPrice, trade.stopLossPriceUsd);

  if (!identityMatches) {
    console.error("Flash reconciliation identity mismatch for trade", trade.id);
    return NextResponse.json(
      { trade, reconciled: false, reason: "provider_identity_mismatch" },
      { status: 502 },
    );
  }

  const lastFinalized = [...provider.fills]
    .reverse()
    .find((fill) => fill.status === "CHAIN_STATUS_FINALIZED");
  const localStatus =
    terminalFailure.has(order.status) && provider.fills.length === 0
      ? "failed"
      : "submitted";
  const reconciledAt = new Date().toISOString();
  await db
    .update(schema.trades)
    .set({
      status: localStatus,
      providerStatus: order.status,
      providerCloseReason: order.closeReason,
      bracketStatus: attached?.status ?? trade.bracketStatus,
      bracketOrderId: attached?.bracketOrderId ?? trade.bracketOrderId,
      fillCount: provider.fills.length,
      fillTransaction: lastFinalized?.transactionId ?? trade.fillTransaction,
      reconciledAt,
      error: localStatus === "failed" ? order.closeReason ?? order.status : null,
    })
    .where(eq(schema.trades.id, trade.id))
    .run();

  return NextResponse.json({
    reconciled: true,
    trade_id: trade.id,
    order_id: order.orderId,
    provider_status: order.status,
    close_reason: order.closeReason,
    bracket: attached
      ? {
          status: attached.status,
          order_id: attached.bracketOrderId,
          take_profit: attached.takeProfit,
          stop_loss: attached.stopLoss,
        }
      : null,
    fills: provider.fills.map((fill) => ({
      status: fill.status,
      notional: fill.notional,
      venues: fill.venues,
      transaction_id: fill.transactionId,
      target_amount: fill.targetAmount,
      contra_amount: fill.contraAmount,
      fill_price: fill.fillPrice,
      filled_at: fill.filledAt,
    })),
    reconciled_at: reconciledAt,
  });
}
