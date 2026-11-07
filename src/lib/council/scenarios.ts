export const DEMO_SCENARIOS = [
  {
    id: "agent-wallet-funding-base",
    tone: "bullish",
    label: "DEMO NEWS — BULLISH",
    headline: "DEMO NEWS: Simulated agent wallet funding rail accelerates autonomous commerce on Base",
    body:
      "This fictional scenario assumes a wallet funding product adds instant USDC and ETH funding for autonomous agents on Base. It also assumes x402 payment activity and WETH/USDC demand rise materially after several major agent frameworks integrate the rail. No such launch or market reaction is asserted as real.",
    claims: [
      "The scenario assumes agents can fund Base wallets through a new funding rail.",
      "The scenario assumes several agent frameworks integrate the funding product.",
      "The scenario assumes x402 activity and WETH/USDC demand increase.",
    ],
    assetSymbol: "ETH",
  },
  {
    id: "ethereum-staking-inflows",
    tone: "bullish",
    label: "DEMO NEWS — BULLISH",
    headline: "DEMO NEWS: Simulated institutional staking program locks a large new supply of ETH",
    body:
      "This fictional scenario assumes regulated custodians introduce an institutional ETH staking program and a meaningful quantity of liquid ETH moves into long-duration staking. It is a predefined catalyst used only to test bullish council reasoning.",
    claims: [
      "The scenario assumes regulated custodians launch an ETH staking program.",
      "The scenario assumes a material quantity of ETH becomes long-duration staked supply.",
      "The scenario assumes available liquid supply declines.",
    ],
    assetSymbol: "ETH",
  },
  {
    id: "defi-liquidation-cascade",
    tone: "bearish",
    label: "DEMO NEWS — BEARISH",
    headline: "DEMO NEWS: Simulated DeFi liquidation cascade creates broad ETH selling pressure",
    body:
      "This fictional scenario assumes a rapid ETH price move liquidates several large leveraged positions across lending markets. It also assumes liquidity thins and collateral sales create additional short-term pressure. It is not a report of a real liquidation event.",
    claims: [
      "The scenario assumes several large leveraged ETH positions are liquidated.",
      "The scenario assumes collateral sales add short-term ETH supply.",
      "The scenario assumes market liquidity becomes thinner.",
    ],
    assetSymbol: "ETH",
  },
  {
    id: "base-bridge-security-incident",
    tone: "bearish",
    label: "DEMO NEWS — BEARISH",
    headline: "DEMO NEWS: Simulated bridge security incident causes a temporary Base ecosystem risk-off move",
    body:
      "This fictional scenario assumes a widely used bridge pauses after detecting suspicious activity, while no loss is yet confirmed. It assumes traders reduce exposure to Base ecosystem assets and demand for WETH liquidity falls temporarily.",
    claims: [
      "The scenario assumes a bridge pauses after suspicious activity is detected.",
      "The scenario does not assume that a loss has been confirmed.",
      "The scenario assumes traders temporarily reduce Base ecosystem exposure.",
    ],
    assetSymbol: "ETH",
  },
  {
    id: "world-agent-pass-adoption",
    tone: "neutral",
    label: "DEMO NEWS — NEUTRAL",
    headline: "DEMO NEWS: Simulated World Agent Pass rollout improves agent controls without changing ETH economics",
    body:
      "This fictional scenario assumes major agent platforms adopt fresh human authorization for high-risk actions using a World Agent Pass-style flow. The product improves safety and accountability, but the scenario specifies no immediate change to Ethereum fees, supply or demand.",
    claims: [
      "The scenario assumes agent platforms adopt fresh human authorization.",
      "The scenario assumes risky agent actions gain stronger controls.",
      "The scenario specifies no immediate ETH supply or demand change.",
    ],
    assetSymbol: "ETH",
  },
  {
    id: "ethereum-governance-unchanged",
    tone: "neutral",
    label: "DEMO NEWS — NEUTRAL",
    headline: "DEMO NEWS: Simulated Ethereum governance review leaves network economics unchanged",
    body:
      "This fictional scenario assumes a governance and research review concludes without changing issuance, fee burning, validator rewards or the near-term roadmap. It is designed to test whether the council can choose HOLD when a story lacks a direct market catalyst.",
    claims: [
      "The scenario assumes the review concludes without a policy change.",
      "The scenario assumes issuance and validator rewards remain unchanged.",
      "The scenario assumes the near-term roadmap remains unchanged.",
    ],
    assetSymbol: "ETH",
  },
] as const;

export type DemoScenario = (typeof DEMO_SCENARIOS)[number];
export type DemoScenarioId = DemoScenario["id"];

export function demoScenario(id: string): DemoScenario | null {
  return DEMO_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
