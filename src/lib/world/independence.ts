import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { normalizeWallet } from "./principals";

const UNBOUND_GROUP = "unbound_unknown_origin";

/**
 * Multiple wallets delegated by one human count as one reporter origin. All
 * unbound wallets collapse into one conservative unknown-origin group and never
 * gain verified-human status merely by being present.
 */
export async function classifyReporterIndependence(wallets: string[]) {
  const normalized = [...new Set(wallets.map(normalizeWallet))];
  const db = await getDb();
  const bindings = normalized.length
    ? await db
        .select({
          wallet: schema.delegatedAgents.agentWallet,
          principalId: schema.delegatedAgents.principalId,
          status: schema.delegatedAgents.status,
        })
        .from(schema.delegatedAgents)
        .where(inArray(schema.delegatedAgents.agentWallet, normalized))
    : [];
  const byWallet = new Map(
    bindings.map((binding) => [binding.wallet.toLowerCase(), binding]),
  );
  const reporters = normalized.map((wallet) => {
    const binding = byWallet.get(wallet);
    const verified = binding?.status === "active";
    return {
      wallet,
      group_id: verified ? binding.principalId : UNBOUND_GROUP,
      verified_human_origin: verified,
      delegated_agent_status: binding?.status ?? "unbound",
    };
  });
  return {
    reporter_count: reporters.length,
    independent_reporter_groups: new Set(reporters.map((reporter) => reporter.group_id)).size,
    verified_human_groups: new Set(
      reporters
        .filter((reporter) => reporter.verified_human_origin)
        .map((reporter) => reporter.group_id),
    ).size,
    reporters,
    rule:
      "Wallets delegated by the same IDKit human principal count once. All unbound wallets collapse into one conservative unknown-origin group; World measures origin independence, not truth.",
  };
}
