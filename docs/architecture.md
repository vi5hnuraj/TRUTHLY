# Architecture

TRUTHLY separates discovery, verification, decision, authorization, and
execution so no single model or provider controls the complete path.

## Data flow

```text
Collectors
  → Scout candidates
  → x402-backed reporter filing
  → source snapshots and structured claims
  → Herald verification
  → editor selection and publication
  → stake refund or slash
  → five-agent live Council
  → public Decision Quality summary
  → receipt-gated complete intelligence
  → mandate and exact human authorization
  → fresh cross-market guard
  → Definitive advanced order
```

## Application layers

### Discovery

RSS, GitHub releases, and governance proposals enter an unpaid candidate queue.
Discovery never files a story and never spends funds.

### Evidence and publication

A filing contains two to five sources, source metadata, and claims whose
citations reference those sources. Herald fetches public content, records hashes,
checks every claim, and returns a bounded verdict. The editor publishes only
current selected stories.

### Intelligence commerce

x402 protects three resources on Base:

- story filing and stake;
- individual intelligence and reusable story receipt;
- full verified edition.

Payment settles before a write or protected read is served.

### Live Council

Five role-specific model calls run independently over the genuine story,
verification summary, source hashes, and a safe market snapshot. A deterministic
server vote chooses BUY, SELL, or HOLD; a neutral clerk cannot change the vote.
The editor cron creates one missing live decision after publication and refund.

### Market integrity

Definitive and Uniswap price the same Base USDC→WETH notional. The server checks
chain, assets, side, amount, route, freshness, and provider divergence. Only safe
quote metadata reaches the browser or database.

### Authority

IDKit creates one durable human principal. Principals delegate role- and
amount-bounded mandates to agent wallets. Consequential actions can require a
fresh Agent Pass authorization bound to canonical payload, nonce, expiry, and
one-use consumption. Emergency pause is enforced server-side.

### Execution

The live route accepts only an unexpired executable BUY plan for the same story,
asset, and levels. It verifies the paid receipt, mandate, exact approval, fresh
market evidence, provider EIP-712 payloads, and bounded token approvals before
Definitive submission. Ambiguous submissions are retained for reconciliation and
are never retried automatically.

## Storage

Turso/libSQL stores newsroom state, revisions, snapshots, payments,
entitlements, principals, mandates, authorizations, Council runs, paper records,
live orders, and accounting entries. Migrations are idempotent and run during
application initialization.

## Public and private data

Public surfaces expose headlines, bounded excerpts, evidence counts, agent
votes, Decision Quality components, and safe market metadata. Paid intelligence
contains the complete story, sources, claims, Herald notes, detailed Council
rationales, and the story-scoped receipt.
