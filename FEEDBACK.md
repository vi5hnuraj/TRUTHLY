# Uniswap Developer Feedback — TRUTHLY

## Integration

TRUTHLY uses the Uniswap Trading API as an independent Base market-integrity
layer for an AI-controlled newsroom and advanced-order workflow. Definitive is
the explicitly approved execution venue; Uniswap V2/V3/V4 liquidity prices the
same USDC → WETH notional and can veto unsafe execution.

The architecture and safety boundaries are documented in
[`docs/architecture.md`](./docs/architecture.md) and
[`docs/security.md`](./docs/security.md).

## Time to first success

The request adapter, schema validation, security policy, UI and deterministic
tests were implemented from the official Markdown documentation and OpenAPI
specification. The first credentialed read-only rehearsal then succeeded through
the same production adapter on November 6, 2026.

- Cross-market fetch latency: **875 ms** (Definitive and Uniswap requested concurrently)
- Uniswap request ID: `f3b3811f9be06ac2423e219dea5f621e`
- Uniswap quote ID: `01a1b20d-09eb-8000-97cb-88c415360100`
- Routing: `CLASSIC`
- Protocol selected by Uniswap: `V4`
- Base block: `53990929`
- Definitive price: `$2230.04429087`
- Uniswap price: `$2224.56472993`
- Divergence: **24.63 bps**, inside the 100-bps execution policy
- Safe-payload checks: **8/8 passed**

No swap, order, permit, approval, signature or transaction was requested.

A separate quote-only check at Demo Mode's $100 paper notional selected a V3
route at Base block `53991332`, returned request ID
`9799f5967a345c4395aaf7d2c25e3b01`, and placed the providers only **5.00 bps**
apart. It completed in 914 ms and also requested no transaction.

The complete TRUTHLY Demo Lab then ran through the same adapter at $100:

- Council run: `eda757c6-8f60-4769-b4c5-ef31d53e9dce`
- Uniswap request ID: `ca7b9c99b1d37450af3b20c18e16019f`
- Uniswap route: `CLASSIC` through V3 at Base block `53992062`
- Definitive price: `$2225.44386720`
- Uniswap price: `$2223.92445682`
- Divergence: **6.83 bps**, verified
- Five independent model opinions returned
- Final action: `HOLD` (unanimous for the neutral scenario)
- Paper notional: `$100`
- Order ID and transaction hash: `null`

An earlier $1 reference rehearsal produced roughly 133–135 bps divergence,
while $2 produced roughly 70 bps and $5 produced roughly 25–31 bps. We did not
loosen the 100-bps policy just to make a test pass. The product correctly blocks
economically poor micro-order pricing and the sponsor rehearsal uses the
project's existing $5 live trade cap.

## What worked well

1. The developer site exposes agent-readable Markdown and a full OpenAPI spec.
   That made it possible to validate exact request fields rather than infer a
   response shape from examples.
2. `/quote` supports Base and lets the integration explicitly request V2, V3
   and V4 under `BEST_PRICE`.
3. `requestId`, `quoteId`, route protocols, block number, price impact and gas
   estimates provide useful evidence for an autonomous-agent audit trail.
4. `X-Agent-Info` is unusually useful for an agentic product because traffic can
   be attributed without sending a wallet, user ID or other personal data.
5. The documentation clearly distinguishes CLASSIC, UniswapX and chained routes
   and publishes stable error codes for quote failures.

## Friction encountered

1. A market-reference use case needs only a safe indicative quote, but `/quote`
   may also return permit and executable transaction material. Integrators must
   deliberately strip those fields before persistence or browser serialization.
2. Quote-only callers intentionally using an unfunded address can receive
   `TRANSFER_FROM_FAILED`. The documentation explains this, but a dedicated
   price-reference mode would make the security boundary clearer.
3. The quote response is a union across CLASSIC, multiple UniswapX versions,
   bridge, wrap and chained routes. A smaller documented common market-data
   interface (`input`, `output`, `quoteId`, `requestId`, route provenance) would
   simplify strict validation.
4. Universal Router versioning is important for calldata consumers. Although
   TRUTHLY never persists calldata, pinning the version still requires
   finding the deployment/version guidance in a separate page.
5. The difference between a benign quote-only simulation failure and an unsafe
   route failure deserves a compact table directly on the `/quote` reference.

## Missing capability

A first-class **reference quote** mode would help risk engines, analytics tools
and autonomous agents that need route-backed market evidence but must never be
given executable calldata or permit material.

Suggested request field:

```json
{ "responseMode": "MARKET_REFERENCE" }
```

Suggested response:

```json
{
  "requestId": "…",
  "quoteId": "…",
  "chainId": 8453,
  "input": { "token": "…", "amount": "…" },
  "output": { "token": "…", "amount": "…" },
  "routing": "CLASSIC",
  "protocols": ["V3", "V4"],
  "blockNumber": "…",
  "priceImpact": 0.01
}
```

No balance/allowance simulation, permit, calldata, encoded order or transaction
object would be returned in this mode.

## One improvement with the greatest impact

Add the reference-only response mode above. It would make Uniswap a safer and
more obvious market-integrity primitive for agents, intent systems, risk engines
and multi-venue execution products while reducing response size and accidental
handling of executable payloads.

## Before form submission

- [x] Validate with a real project API key.
- [x] Add first successful request ID and measured credential-to-quote latency.
- [x] Confirm `X-Agent-Info` is accepted (no `malformed` response header).
- [ ] Add the public GitHub URL for this file.
- [ ] Submit <https://developers.uniswap.org/hackathon-feedback> with that URL.
