/**
 * Production preflight: validates configuration without printing any secret.
 *
 * Loads .env.local for a local check. On CI/Vercel, injected process variables
 * win. This script performs no deployment, payment, signature or network call.
 */
import { config } from "dotenv";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

config({ path: ".env.local", override: false, quiet: true });

const PUBLIC_DEFINITIVE_KEY = "dpka_513a2bd7_57a2_46d2_927b_2a3857fe271b";
const failures: string[] = [];
const warnings: string[] = [];

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) failures.push(`${name} is missing`);
  return value;
}

function secret(name: string, minLength = 32): string {
  const value = required(name);
  if (value && value.length < minLength) failures.push(`${name} is too short`);
  return value;
}

function accountFrom(name: string) {
  const raw = required(name);
  if (!raw) return null;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    failures.push(`${name} is not a 32-byte EVM private key`);
    return null;
  }
  try {
    return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
  } catch {
    failures.push(`${name} is not a valid secp256k1 private key`);
    return null;
  }
}

function httpsUrl(name: string): string {
  const raw = required(name);
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") failures.push(`${name} must use https in production`);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      failures.push(`${name} must not point to localhost`);
    }
  } catch {
    failures.push(`${name} is not a valid URL`);
  }
  return raw.replace(/\/$/, "");
}

const databaseUrl = required("TURSO_DATABASE_URL");
if (databaseUrl.startsWith("libsql://")) required("TURSO_AUTH_TOKEN");
else failures.push("TURSO_DATABASE_URL must be a deployed libsql:// database");

secret("EDITOR_API_KEY");
secret("CRON_SECRET");
const treasuryAddress = required("TREASURY_ADDRESS");
let normalizedTreasury = "";
try {
  if (treasuryAddress) normalizedTreasury = getAddress(treasuryAddress);
} catch {
  failures.push("TREASURY_ADDRESS is not a valid EVM address");
}
const treasury = accountFrom("TREASURY_PRIVATE_KEY");
if (
  treasury &&
  normalizedTreasury &&
  treasury.address.toLowerCase() !== normalizedTreasury.toLowerCase()
) {
  failures.push("TREASURY_PRIVATE_KEY does not control TREASURY_ADDRESS");
}

required("HERALD_MODEL");
const heraldCap = Number(process.env.HERALD_MAX_ATOMIC ?? "30000");
if (!Number.isInteger(heraldCap) || heraldCap <= 0 || heraldCap > 1_000_000) {
  failures.push("HERALD_MAX_ATOMIC must be an integer from 1 to 1000000");
}

if ((process.env.X402_NETWORK ?? "") !== "eip155:8453") {
  failures.push("X402_NETWORK must be eip155:8453 for the Base mainnet demo");
}
required("X402_FACILITATOR_URL");
const publicBase = httpsUrl("NEXT_PUBLIC_BASE_URL");
const truthlyBase = httpsUrl("TRUTHLY_URL");
if (publicBase && truthlyBase && publicBase !== truthlyBase) {
  failures.push("NEXT_PUBLIC_BASE_URL and TRUTHLY_URL must identify the same deployment");
}

const flashKey = required("FLASH_API_KEY");
if (flashKey === PUBLIC_DEFINITIVE_KEY) {
  failures.push("FLASH_API_KEY is the public development key; create your own Definitive integrator key");
}
const flashFunder = accountFrom("FLASH_FUNDER_PRIVATE_KEY");
if (flashFunder && treasury && flashFunder.address === treasury.address) {
  failures.push("FLASH_FUNDER_PRIVATE_KEY must be a separate limited burner, not the treasury");
}
const tradeCap = Number(process.env.FLASH_MAX_TRADE_USD ?? "5");
if (!Number.isFinite(tradeCap) || tradeCap <= 0 || tradeCap > 5) {
  failures.push("FLASH_MAX_TRADE_USD must be greater than 0 and no more than 5 for the demo");
}
const liveCouncilAuto = process.env.LIVE_COUNCIL_AUTO_RUN === "1";
if (liveCouncilAuto) secret("COUNCIL_GROQ_API_KEY", 8);
const liveCouncilLimit = Number(process.env.LIVE_COUNCIL_CRON_LIMIT ?? "3");
if (!Number.isInteger(liveCouncilLimit) || liveCouncilLimit < 1 || liveCouncilLimit > 10) {
  failures.push("LIVE_COUNCIL_CRON_LIMIT must be an integer from 1 to 10");
}
const liveCouncilNotional = Number(
  process.env.LIVE_COUNCIL_NOTIONAL_USDC ?? process.env.FLASH_MAX_TRADE_USD ?? "5",
);
if (
  !Number.isFinite(liveCouncilNotional) ||
  liveCouncilNotional <= 0 ||
  liveCouncilNotional > tradeCap
) {
  failures.push("LIVE_COUNCIL_NOTIONAL_USDC must be positive and no greater than FLASH_MAX_TRADE_USD");
}
secret("UNISWAP_API_KEY", 8);
const uniswapDeviation = Number(process.env.UNISWAP_MAX_DEVIATION_BPS ?? "100");
if (!Number.isInteger(uniswapDeviation) || uniswapDeviation < 1 || uniswapDeviation > 2_000) {
  failures.push("UNISWAP_MAX_DEVIATION_BPS must be an integer from 1 to 2000");
}
const uniswapQuoteAge = Number(process.env.UNISWAP_QUOTE_MAX_AGE_MS ?? "30000");
if (!Number.isInteger(uniswapQuoteAge) || uniswapQuoteAge < 5_000 || uniswapQuoteAge > 120_000) {
  failures.push("UNISWAP_QUOTE_MAX_AGE_MS must be an integer from 5000 to 120000");
}

for (const name of [
  "WORLDID_ISSUER",
  "WORLDID_CLIENT_ID",
  "WORLDID_CLIENT_SECRET",
  "IDKIT_APP_ID",
  "IDKIT_RP_ID",
  "IDKIT_SIGNING_KEY",
  "IDKIT_ACTION",
]) required(name);
if (process.env.IDKIT_ALLOW_SIMULATOR === "1") {
  failures.push("IDKIT_ALLOW_SIMULATOR must not be enabled in production");
}

for (const optional of ["RESEND_API_KEY", "GITHUB_TOKEN", "SNAPSHOT_API_KEY"]) {
  if (!process.env[optional]?.trim()) warnings.push(`${optional} is not configured`);
}

console.log("TRUTHLY production preflight");
console.log(`  database: ${databaseUrl.startsWith("libsql://") ? "remote libSQL" : "invalid"}`);
console.log(`  treasury signer: ${treasury ? treasury.address : "not ready"}`);
console.log(`  Flash limited burner: ${flashFunder ? flashFunder.address : "not ready"}`);
console.log(`  Uniswap market guard: ${process.env.UNISWAP_API_KEY?.trim() ? "configured" : "not ready"}`);
console.log(`  automatic live Council: ${liveCouncilAuto ? "enabled" : "disabled"}`);
console.log(`  public URL: ${publicBase || "not ready"}`);
console.log(`  Herald model: ${process.env.HERALD_MODEL?.trim() || "not ready"}`);
for (const warning of warnings) console.log(`  warning: ${warning}`);

if (failures.length) {
  console.error(`\nFAILED (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\nPASS — configuration is ready for a credentialed deployment and funded rehearsal.");
}
