const USDC_SCALE = BigInt(1_000_000);

/** Parse a human USDC amount without ever crossing floating point. */
export function parseUsdcAtomic(value: string): bigint | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdcAtomic(value: bigint | string): string {
  const atomic = typeof value === "bigint" ? value : BigInt(value);
  const whole = atomic / USDC_SCALE;
  const fraction = (atomic % USDC_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function isAtomicAmount(value: string): boolean {
  return /^\d+$/.test(value);
}
