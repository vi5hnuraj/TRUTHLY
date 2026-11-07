export interface EnvConfig {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN?: string;
  EDITOR_API_KEY: string;
  TREASURY_ADDRESS: string;
  RESEND_API_KEY?: string;
  UNISWAP_API_KEY?: string;
  X402_FACILITATOR_URL: string;
  NEXT_PUBLIC_BASE_URL: string;
}

const REQUIRED: Array<{ key: keyof EnvConfig; fallback?: string }> = [
  { key: "TURSO_DATABASE_URL", fallback: "file:truthly.db" },
  { key: "EDITOR_API_KEY" },
  { key: "TREASURY_ADDRESS" },
  { key: "X402_FACILITATOR_URL", fallback: "https://facilitator.payai.network" },
  { key: "NEXT_PUBLIC_BASE_URL", fallback: "http://localhost:3000" },
];

const OPTIONAL: Array<keyof EnvConfig> = [
  "TURSO_AUTH_TOKEN",
  "RESEND_API_KEY",
  "UNISWAP_API_KEY",
];

export function validateEnv(): { warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const { key, fallback } of REQUIRED) {
    if (!process.env[key]) {
      if (fallback) {
        warnings.push(`${key} not set — using default: ${fallback}`);
      } else {
        missing.push(key);
      }
    }
  }

  for (const key of OPTIONAL) {
    if (!process.env[key]) {
      warnings.push(`${key} not set — feature disabled`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join("\n  ")}\n\nSet them in .env.local or your deployment environment.`
    );
  }

  return { warnings };
}
