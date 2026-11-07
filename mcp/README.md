# TRUTHLY MCP

Payment-safe Model Context Protocol access to TRUTHLY's verified-intelligence
and protected-decision APIs.

## Run locally

```bash
npm install
npm run build
TRUTHLY_URL=http://localhost:3000 npm start
```

Example client configuration:

```json
{
  "mcpServers": {
    "truthly": {
      "command": "node",
      "args": ["/absolute/path/to/truthly/mcp/dist/index.js"],
      "env": { "TRUTHLY_URL": "http://localhost:3000" }
    }
  }
}
```

The Next.js application also exposes the same server through Streamable HTTP at
`POST /api/mcp`.

## Tools

| Tool | Policy |
|---|---|
| `truthly_front_page` | Public verified-edition preview |
| `truthly_wire` | Public filed wire and unpaid Scout candidates |
| `truthly_file_signal` | Explicit `$0.01` x402 filing |
| `truthly_read_edition` | Explicit `$0.05` x402 edition purchase |
| `truthly_read_signal` | Explicit `$0.02` purchase or receipt re-read |
| `truthly_reporter_profile` | Public reporter record |
| `truthly_appeal_status` | Public appeal docket |
| `truthly_trade_signal` | Receipt + live Council + mandate + approval |

Every tool publishes machine-readable access policy under
`_meta["truthly/policy"]`.

## Payment safety

Paid tools return the x402 challenge before payment. A client must display it to
the wallet owner and call again with `approve_payment=true` plus a
wallet-produced payment signature. The MCP server never holds a user key and
never silently approves payment.

## Trade safety

The trade tool requires:

- the receipt from `truthly_read_signal` for the same story;
- an unexpired executable live Council BUY;
- exact Council entry, stop, and target levels;
- a delegated mandate credential;
- explicit approval and fresh Agent Pass when policy requires it.

Changed receipts, levels, expiry, amount, authorization, or idempotency key are
revalidated and rejected when they no longer match.

## Development

```bash
npm test
```

The route test runs all eight tools against a local fixture API and verifies
payment, receipt, mandate, and policy metadata behavior.
