import type { DemoScenario } from "./scenarios";

export interface DemoHeraldVerification {
  label: "DEMO HERALD VERIFICATION — SIMULATED, NOT A REAL-WORLD FACT CHECK";
  simulated: true;
  verificationKind: "demo_simulation";
  scenarioId: string;
  verdict: "demo_scenario_accepted";
  notes: string;
  claimChecks: Array<{
    claimIndex: number;
    status: "predefined_demo_assumption";
    note: string;
  }>;
  verifiedAt: string;
}

/**
 * Demo-only validation. It checks scenario integrity and labels every claim as
 * an assumption; it never calls Herald's real source-verification pipeline.
 */
export function verifyDemoScenario(scenario: DemoScenario): DemoHeraldVerification {
  return {
    label: "DEMO HERALD VERIFICATION — SIMULATED, NOT A REAL-WORLD FACT CHECK",
    simulated: true,
    verificationKind: "demo_simulation",
    scenarioId: scenario.id,
    verdict: "demo_scenario_accepted",
    notes:
      "This predefined scenario passed demo-schema validation only. No source was fetched and no real-world claim was verified.",
    claimChecks: scenario.claims.map((_, index) => ({
      claimIndex: index + 1,
      status: "predefined_demo_assumption",
      note: "Fictional assumption supplied by the selected demo scenario.",
    })),
    verifiedAt: new Date().toISOString(),
  };
}
