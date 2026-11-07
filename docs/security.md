# Security model

TRUTHLY treats reporter text, model output, market-provider responses, wallet
input, and callback parameters as untrusted.

## Core invariants

1. Invalid evidence is rejected before an x402 challenge.
2. Paid content is served only after settlement or a valid same-story receipt.
3. Reporter news cannot select an order or spend a mandate.
4. Models can recommend but cannot sign, approve, reserve, or submit.
5. Demo records cannot be supplied to the live route.
6. Only a fresh live BUY with valid entry, stop, and target can unlock execution.
7. The order cannot outlive its Council decision.
8. Uniswap evidence must describe the same market and notional as Definitive.
9. Provider divergence, stale quotes, and distant limits fail closed.
10. Provider typed data is checked against the exact approved request.
11. Token approvals are bounded; unlimited or redirected approvals are rejected.
12. Idempotency prevents ambiguous retries from becoming duplicate orders.
13. Pause is checked before authorization and at the provider-submission boundary.
14. World authorizations are exact, expiring, same-principal, and one-use.
15. Private keys and API credentials remain server-only.

## Live versus demo

Demo Mode uses predefined fictional news, real read-only market quotes, genuine
Council orchestration, and physically separate paper tables. It cannot import or
call the live execution function and never stores an order ID or transaction
hash.

## Market-provider data

The Uniswap adapter discards permits, calldata, encoded orders, signatures, and
transaction objects. The Definitive adapter validates order identity and stores
only the fields needed for execution audit and reconciliation.

## Human authority

IDKit signal binding is combined with a one-use wallet signature. Agent Pass
OIDC validates issuer, audience, nonce, ACR, expiry, and fresh authentication
time. Raw World subjects and nullifiers are not stored.

## Operational guidance

- Use separate treasury and limited execution wallets.
- Keep the execution wallet funded only for the intended demonstration amount.
- Use a remote Turso database and stable HTTPS callback URL in deployment.
- Disable World simulator and local mocks in production.
- Run `npm run preflight:deploy` before deployment.
- Reconcile every submitted or ambiguous provider order before another attempt.
