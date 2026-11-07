import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EDITION_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_ID = "22222222-2222-4222-8222-222222222222";
const TRADE_REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const COUNCIL_RUN_ID = "55555555-5555-4555-8555-555555555555";
const ADDRESS = `0x${"a".repeat(40)}`;

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function resultJson(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test("all eight MCP tools use current Truthly routes", async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      paymentSignature: request.headers["payment-signature"] ?? null,
      authorization: request.headers.authorization ?? null,
      body,
    });

    if (url.pathname === "/api/editions") {
      return json(response, 200, {
        editions: [{ id: EDITION_ID, number: 1, title: "Test edition" }],
      });
    }
    if (url.pathname === `/api/editions/${EDITION_ID}`) {
      return json(response, 200, {
        edition: { id: EDITION_ID, number: 1, title: "Test edition" },
        signals: [],
      });
    }
    if (url.pathname === `/api/editions/${EDITION_ID}/full`) {
      if (request.headers["payment-signature"] === "edition-signature") {
        return json(response, 200, { edition: { id: EDITION_ID }, signals: [] }, {
          "payment-response": "edition-receipt",
        });
      }
      return json(response, 402, { error: "payment required" }, {
        "payment-required": "edition-challenge",
      });
    }
    if (url.pathname === "/api/signals" && request.method === "GET") {
      return json(response, 200, { signals: [] });
    }
    if (url.pathname === `/api/signals/${SIGNAL_ID}` && request.method === "GET") {
      return json(response, 200, {
        signal: { id: SIGNAL_ID, headline: "Protocol X approves fee sharing" },
        excerpt: "Protocol X voters approved proposal 42…",
        price: { cents: 2, usd: "0.02", endpoint: `GET /api/intel/${SIGNAL_ID}` },
        diy_vs_buy: { price_cents: 2 },
      });
    }
    if (url.pathname === `/api/intel/${SIGNAL_ID}` && request.method === "GET") {
      if (request.headers["x-receipt"] === "intel-receipt") {
        return json(response, 200, {
          signal: { id: SIGNAL_ID },
          receipt: { receipt_id: "intel-receipt", signal_id: SIGNAL_ID },
        });
      }
      if (request.headers["payment-signature"] === "intel-signature") {
        return json(
          response,
          200,
          {
            signal: { id: SIGNAL_ID },
            receipt: { receipt_id: "intel-receipt", signal_id: SIGNAL_ID },
          },
          { "payment-response": "intel-settlement" },
        );
      }
      return json(response, 402, { error: "payment required" }, {
        "payment-required": "intel-challenge",
      });
    }
    if (url.pathname === "/api/scout/candidates") {
      return json(response, 200, { candidates: [] });
    }
    if (url.pathname === "/api/x402/signals" && request.method === "POST") {
      if (request.headers["payment-signature"] === "filing-signature") {
        return json(response, 201, { signal: { id: SIGNAL_ID, status: "submitted" } }, {
          "payment-response": "filing-receipt",
        });
      }
      return json(response, 402, { error: "payment required" }, {
        "payment-required": "filing-challenge",
      });
    }
    if (url.pathname === `/api/reporters/${ADDRESS}`) {
      return json(response, 200, { address: ADDRESS, found: true });
    }
    if (url.pathname === "/api/appeal") {
      return json(response, 200, { queue: [], ledger: [] });
    }
    if (url.pathname === "/api/flash/trade" && request.method === "POST") {
      if (request.headers.authorization === "Bearer apm_paused-delegated-agent-token") {
        return json(response, 423, {
          error: "principal_paused",
          detail: "The controlling human paused all agents.",
        });
      }
      return json(response, 409, {
        traded: false,
        reason: "approval_required",
        approval: JSON.parse(body),
      });
    }
    return json(response, 404, { error: `unexpected route ${request.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TRUTHLY_URL: `http://127.0.0.1:${address.port}`,
    },
  });
  const client = new Client({ name: "truthly-route-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "truthly_appeal_status",
        "truthly_file_signal",
        "truthly_front_page",
        "truthly_read_edition",
        "truthly_read_signal",
        "truthly_reporter_profile",
        "truthly_trade_signal",
        "truthly_wire",
      ],
    );
    for (const tool of listed.tools) {
      assert.equal(
        typeof tool._meta?.["truthly/policy"],
        "object",
        `${tool.name} must publish its authorization policy in tools/list`,
      );
      assert.equal(
        typeof tool._meta?.["truthly/policy"]?.principal_pause,
        "string",
        `${tool.name} must publish how principal pause applies`,
      );
    }
    assert.equal(
      listed.tools.find((tool) => tool.name === "truthly_trade_signal")
        ?._meta?.["truthly/policy"]?.access,
      "delegated_mandate",
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === "truthly_trade_signal")
        ?._meta?.["truthly/policy"]?.uniswap_market_integrity,
      "fresh_same_notional_v2_v3_v4_reference_required_before_live_submission",
      "trade tool must publish the Uniswap execution-integrity gate",
    );

    await client.callTool({ name: "truthly_front_page", arguments: {} });
    await client.callTool({
      name: "truthly_wire",
      arguments: { limit: 10, include_scout_candidates: true },
    });

    const filing = {
      headline: "Protocol X approves a fee-sharing governance proposal",
      body: "Protocol X voters approved proposal 42 after the published governance vote concluded on Sunday.",
      beat: "defi",
      sources: [
        "https://governance.example/proposal-42",
        "https://reuters.example/protocol-x-fees",
      ],
      source_metadata: [
        {
          url: "https://governance.example/proposal-42",
          title: "Protocol X proposal 42",
          publisher: "Protocol X DAO",
          published_at: "2026-11-01T10:00:00.000Z",
          source_type: "primary",
        },
        {
          url: "https://reuters.example/protocol-x-fees",
          title: "Protocol X approves fee sharing",
          publisher: "Reuters",
          published_at: "2026-11-01T11:00:00.000Z",
          source_type: "secondary",
        },
      ],
      claims: [
        {
          claim: "Protocol X voters approved proposal 42.",
          citations: [
            "https://governance.example/proposal-42",
            "https://reuters.example/protocol-x-fees",
          ],
        },
      ],
      tags: ["governance", "fees"],
      approve_payment: false,
    };
    const challenge = resultJson(
      await client.callTool({ name: "truthly_file_signal", arguments: filing }),
    );
    assert.equal(challenge.payment_required, true);
    assert.equal(challenge.x402.payment_required_header, "filing-challenge");

    const beforeRefusedSignature = requests.length;
    const refused = await client.callTool({
      name: "truthly_file_signal",
      arguments: { ...filing, payment_signature: "filing-signature" },
    });
    assert.equal(refused.isError, true);
    assert.equal(requests.length, beforeRefusedSignature, "unapproved signature must not be sent");

    const filed = resultJson(
      await client.callTool({
        name: "truthly_file_signal",
        arguments: {
          ...filing,
          approve_payment: true,
          payment_signature: "filing-signature",
        },
      }),
    );
    assert.equal(filed.signal.id, SIGNAL_ID);
    assert.equal(filed.x402_payment_response, "filing-receipt");

    const editionChallenge = resultJson(
      await client.callTool({
        name: "truthly_read_edition",
        arguments: { edition_id: EDITION_ID, approve_payment: false },
      }),
    );
    assert.equal(editionChallenge.payment_required, true);
    assert.equal(editionChallenge.free_preview.edition.id, EDITION_ID);

    const edition = resultJson(
      await client.callTool({
        name: "truthly_read_edition",
        arguments: {
          edition_id: EDITION_ID,
          approve_payment: true,
          payment_signature: "edition-signature",
        },
      }),
    );
    assert.equal(edition.edition.id, EDITION_ID);
    assert.equal(edition.x402_payment_response, "edition-receipt");

    // Individual intelligence: free teaser first, then the x402 challenge.
    const intelChallenge = resultJson(
      await client.callTool({
        name: "truthly_read_signal",
        arguments: { signal_id: SIGNAL_ID, approve_payment: false },
      }),
    );
    assert.equal(intelChallenge.payment_required, true);
    assert.equal(intelChallenge.x402.payment_required_header, "intel-challenge");
    assert.equal(intelChallenge.free_teaser.signal.id, SIGNAL_ID);

    const intel = resultJson(
      await client.callTool({
        name: "truthly_read_signal",
        arguments: {
          signal_id: SIGNAL_ID,
          approve_payment: true,
          payment_signature: "intel-signature",
        },
      }),
    );
    assert.equal(intel.receipt.receipt_id, "intel-receipt");
    assert.equal(intel.x402_payment_response, "intel-settlement");

    // The receipt re-reads the same story without paying again.
    const reread = resultJson(
      await client.callTool({
        name: "truthly_read_signal",
        arguments: { signal_id: SIGNAL_ID, receipt: "intel-receipt" },
      }),
    );
    assert.equal(reread.receipt.receipt_id, "intel-receipt");
    assert.equal(
      requests.filter((item) => item.path === `/api/intel/${SIGNAL_ID}`).some(
        (item) => item.paymentSignature === null,
      ),
      true,
      "a receipt re-read must not carry a payment signature",
    );

    await client.callTool({
      name: "truthly_reporter_profile",
      arguments: { address: ADDRESS },
    });
    await client.callTool({
      name: "truthly_appeal_status",
      arguments: { signal_id: SIGNAL_ID },
    });
    const trade = resultJson(
      await client.callTool({
        name: "truthly_trade_signal",
        arguments: {
          request_id: TRADE_REQUEST_ID,
          signal_id: SIGNAL_ID,
          receipt: "intel-receipt",
          token: "ETH",
          side: "buy",
          max_spend_usdc: "1",
          order_type: "limit",
          limit_price_usd: "3500",
          take_profit_price_usd: "4000",
          stop_loss_price_usd: "3000",
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          rationale: "The supported upgrade is expected to increase protocol usage.",
          council_run_id: COUNCIL_RUN_ID,
          mandate_token: "apm_test-delegated-agent-token",
          approved: false,
        },
      }),
    );
    assert.equal(trade.reason, "approval_required");
    assert.equal(trade.approval.receipt, "intel-receipt");
    assert.equal(trade.approval.order_type, "limit");
    assert.equal(trade.approval.take_profit_price_usd, "4000");

    const pausedTrade = await client.callTool({
      name: "truthly_trade_signal",
      arguments: {
        request_id: "44444444-4444-4444-8444-444444444444",
        signal_id: SIGNAL_ID,
        receipt: "intel-receipt",
        token: "ETH",
        side: "buy",
        max_spend_usdc: "1",
        order_type: "limit",
        limit_price_usd: "3500",
        take_profit_price_usd: "4000",
        stop_loss_price_usd: "3000",
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        rationale: "This request must be refused while its principal is paused.",
        council_run_id: COUNCIL_RUN_ID,
        mandate_token: "apm_paused-delegated-agent-token",
        approved: true,
      },
    });
    assert.equal(pausedTrade.isError, true);
    assert.equal(resultJson(pausedTrade).error, "principal_paused");

    assert(requests.some((item) => item.method === "POST" && item.path === "/api/x402/signals"));
    assert(requests.some((item) => item.path === `/api/editions/${EDITION_ID}/full`));
    assert(requests.some((item) => item.path === "/api/flash/trade"));
    assert.equal(
      requests.some((item) => item.path === "/api/agents/register"),
      false,
      "retired registration route must never be called",
    );
    assert.equal(
      requests.some((item) => item.method === "POST" && item.path === "/api/signals"),
      false,
      "retired filing route must never be called",
    );
  } finally {
    await client.close().catch(() => undefined);
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
