# Demo guide

This guide exercises the product without hiding failed gates or paper/live
boundaries.

## Preparation

```bash
npm install
npm run verify
npm run preflight:deploy
```

Use a dedicated demo database and limited wallets. Confirm the configured
treasury key controls `TREASURY_ADDRESS`, the reporter payout address is not the
treasury, and the execution wallet has only the intended Base gas and USDC.

## Product walkthrough

1. **Scout** — show `/api/scout/candidates`; candidates are unpaid discoveries.
2. **File** — submit structured evidence and show the explicit x402 challenge.
3. **Verify** — run the editor pipeline and inspect Herald claim checks.
4. **Settle** — show the reporter stake refund or an honest pending error.
5. **Publish** — open the public story and evidence summary.
6. **Council** — open `/trades` and show Decision Quality, five votes, and market evidence.
7. **Purchase** — use `truthly_read_signal` and re-read with its receipt.
8. **Authority** — show the mandate and exact World authorization when required.
9. **Review** — preview the immutable Council-locked order without submission.
10. **Execute intentionally** — only when a real funded order is explicitly desired.
11. **Reconcile** — show provider status, bracket, fills, and Base transaction.

## Safe Council demonstration

Open `/demo`, select a predefined scenario, and run the analysis. The page must
remain labelled simulated/paper-only. It shows real provider quotes and agent
votes but cannot submit an order.

## Read-only verification

```bash
npm run verify:market
```

Expected evidence includes Definitive quote ID, Uniswap request and quote IDs,
selected protocols, prices, divergence, freshness, and confirmation that no
executable provider payload was retained.

## Injected execution-boundary verification

```bash
npm run verify:flash
```

This uses an isolated database and injected signing/submission hooks. It proves
receipt, mandate, authorization, idempotency, bracket, and reconciliation
boundaries without broadcasting a live transaction.

## Claims to avoid

- Do not describe paper marks or quote notionals as realized P&L.
- Do not describe Decision Quality as win probability.
- Do not claim a live order without a real provider order ID and chain evidence.
- Do not hide HOLD, failed, expired, or adverse outcomes.
