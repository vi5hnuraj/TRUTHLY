# World integration feedback — TRUTHLY

## Integration used

- IDKit 4 Proof of Human for one durable TRUTHLY human principal.
- Human Continuity / Agent Pass OIDC authorization-code flow with PKCE S256.
- Backend ID-token validation: RS256 via issuer JWKS, exact issuer/audience/nonce, required Orb ACR, expiry and fresh `auth_time`.
- Exact, expiring, one-use authorization for a consequential newsroom action.

## What worked well

- Standard OIDC discovery and JWKS validation fit a Next.js backend cleanly.
- IDKit's signal binding is useful for tying the uniqueness proof to the intended owner wallet.
- Keeping uniqueness (IDKit) separate from fresh consent (Agent Pass) produces a much clearer security model than using either as generic login.
- Machine-readable pending state lets an MCP agent pause, show an authorization URL, and retry rather than bypassing the human.

## Friction found

1. **Serverless persistence is easy to miss.** Sample implementations often keep OIDC state, PKCE verifier and IDKit request nonces in a `Map`. A callback can land on another instance, so the production recipe should explicitly require a durable one-use store.
2. **The hosted ceremony needs operation context.** The ID token can be bound to an operation through `nonce`, but the human also needs a first-class, tamper-evident way to see “approve a $2 ETH buy for story X” inside the World surface. TRUTHLY currently shows its own exact-authorization page immediately before redirect.
3. **Stable sandbox continuity users are important.** Same-subject and wrong-subject paths are core Agent Pass behavior; deterministic sandbox personas would make these much easier to test end to end.
4. **IDKit uniqueness is not wallet ownership.** Signal binding prevents using the proof for a different signal, but an app should also prove control of the signaled wallet. TRUTHLY asks that wallet to sign the RP's one-time nonce before accepting the World result.
5. **Error taxonomy should be documented together.** `access_denied`, expired device/code state, Portal verification failures, nonce reuse and nullifier reuse are currently learned across different guides.

## Requested improvements

1. Let the OIDC request provide signed, human-readable operation details rendered by World.
2. Provide stable sandbox identities plus explicit wrong-human/cancel/expire test controls.
3. Publish one production checklist covering durable state, nonce consumption, PKCE, JWKS, `auth_time`, ACR and subject continuity.
4. Return typed IDKit errors with clear guidance for “already used by this same principal” versus an actual conflicting principal.
5. Document a recommended “IDKit once, Agent Pass for consequential actions” architecture.

## Validation approach

`npm run test:world` covers success, wrong-human, expiry, cancellation,
payload mutation, replay, anti-Sybil principal creation, pause, and gated resume.
Production evidence should additionally retain the backend-validated World
authorization ID and its public attempt audit; simulated identities must remain
clearly separated from production results.
