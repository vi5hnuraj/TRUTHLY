/**
 * Real Uniswap/Definitive market-integrity verification.
 *
 * Read-only safety contract:
 * - Calls only Definitive /quote and Uniswap /v1/quote.
 * - Never requests /swap, /order, approvals, signatures or transactions.
 * - Prints request/quote IDs and market evidence, never API keys or calldata.
 *
 * Run after adding a free server-side UNISWAP_API_KEY:
 *   npm run verify:market
 */
import { config } from "dotenv";
import {
  assertMarketIntegrityExecutable,
  fetchMarketIntegritySnapshot,
} from "../src/lib/council/market";
import { parseUsdcAtomic } from "../src/lib/usdc";

config({ path: ".env.local", override: false, quiet: true });

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

async function main() {
  if (!process.env.UNISWAP_API_KEY?.trim()) {
    throw new Error(
      "UNISWAP_API_KEY is missing. Create a free key at https://developers.uniswap.org/dashboard/welcome and add it server-side; no fallback was used.",
    );
  }

  console.log("— real Base market reads; no execution —");
  const notionalUsdc = process.env.UNISWAP_TRIAL_NOTIONAL_USDC?.trim() || "5";
  const startedAt = Date.now();
  const snapshot = await fetchMarketIntegritySnapshot({
    requireUniswap: true,
    notionalUsdc,
    decisionOrigin: "human_mediated",
  });
  const crossMarketLatencyMs = Date.now() - startedAt;

  check("C1 Definitive returned a provider quote id", Boolean(snapshot.executionQuote.providerQuoteId));
  check("C2 Uniswap returned a provider request id", Boolean(snapshot.referenceQuote?.providerRequestId));
  check("C3 Uniswap returned a provider quote id", Boolean(snapshot.referenceQuote?.providerQuoteId));
  check("C4 Uniswap routed through V2/V3/V4", (snapshot.referenceQuote?.protocols.length ?? 0) > 0);
  check(
    "C5 both providers priced the same USDC notional",
    parseUsdcAtomic(snapshot.executionQuote.quotedSpendUsdc) ===
      parseUsdcAtomic(snapshot.referenceQuote?.quotedSpendUsdc ?? ""),
  );
  check("C6 provider divergence is inside policy", snapshot.integrity.status === "verified");
  check("C7 snapshot is fresh enough for execution", (() => {
    try {
      assertMarketIntegrityExecutable(snapshot);
      return true;
    } catch {
      return false;
    }
  })());
  const serialized = JSON.stringify(snapshot);
  check(
    "C8 no permit, calldata, signature or transaction payload survived",
    !/permitData|swapTransaction|encodedOrder|userSignature|calldata/i.test(serialized),
  );

  console.log(
    JSON.stringify(
      {
        network: snapshot.network,
        notional_usdc: snapshot.notionalUsdc,
        definitive: {
          quote_id: snapshot.executionQuote.providerQuoteId,
          implied_price_usd: snapshot.executionQuote.impliedPriceUsd,
        },
        uniswap: snapshot.referenceQuote
          ? {
              request_id: snapshot.referenceQuote.providerRequestId,
              quote_id: snapshot.referenceQuote.providerQuoteId,
              routing: snapshot.referenceQuote.routing,
              protocols: snapshot.referenceQuote.protocols,
              block_number: snapshot.referenceQuote.blockNumber,
              implied_price_usd: snapshot.referenceQuote.impliedPriceUsd,
            }
          : null,
        integrity: snapshot.integrity,
        cross_market_latency_ms: crossMarketLatencyMs,
        snapshot_hash: snapshot.snapshotHash,
      },
      null,
      2,
    ),
  );
  console.log(`\nRESULT: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
