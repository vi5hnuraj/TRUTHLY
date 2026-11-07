export const demoModeEnabled = () => process.env.TRUTHLY_DEMO_MODE === "1";

export const demoDisabledResponse = () =>
  Response.json(
    {
      error: "demo_mode_disabled",
      detail: "Set TRUTHLY_DEMO_MODE=1 explicitly to expose predefined demo scenarios.",
    },
    { status: 404 },
  );
