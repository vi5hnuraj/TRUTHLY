import { NextResponse } from "next/server";
import { retryRead } from "@/lib/db/retry";
import { getDb, schema } from "@/lib/db";
import { sql } from "drizzle-orm";
import { currentAgent } from "@/lib/era";

async function readOnlyGET() {
  const db = await getDb();

  const [agents, delegations] = await Promise.all([db
    .select({
      name: schema.agents.name,
      address: schema.agents.address,
      accountId: schema.agents.accountId,
      totalSignals: schema.agents.totalSignals,
      signalsIncluded: schema.agents.signalsIncluded,
      currentStreak: schema.agents.currentStreak,
      totalEarnedCents: schema.agents.totalEarnedCents,
      ens_name: schema.agents.ensName, // verified ENSv2 byline (on-chain checked)
    })
    .from(schema.agents)
    .where(currentAgent)
    .all(), db
      .select({
        principalId: schema.delegatedAgents.principalId,
        wallet: schema.delegatedAgents.agentWallet,
      })
      .from(schema.delegatedAgents)
      .where(sql`${schema.delegatedAgents.status} != 'revoked'`)
      .all()]);

  const principalByWallet = new Map(
    delegations.map((row) => [row.wallet.toLowerCase(), row.principalId]),
  );
  const groups = new Map<string, (typeof agents)[number] & { wallets: string[]; principalId: string | null }>();
  for (const agent of agents) {
    const principalId = principalByWallet.get(agent.address.toLowerCase()) ?? null;
    const key = principalId ?? "unbound_unknown_origin";
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        ...agent,
        name: principalId ? agent.name : "Unverified reporter pool",
        wallets: [agent.address.toLowerCase()],
        principalId,
      });
      continue;
    }
    group.wallets.push(agent.address.toLowerCase());
    group.totalSignals += agent.totalSignals;
    group.signalsIncluded += agent.signalsIncluded;
    group.totalEarnedCents += agent.totalEarnedCents;
    group.currentStreak = Math.max(group.currentStreak, agent.currentStreak);
    if (!group.ens_name && agent.ens_name) group.ens_name = agent.ens_name;
  }

  const leaderboard = [...groups.values()]
    .map((group) => ({
      ...group,
      score:
        group.signalsIncluded * 20 +
        group.totalSignals * 5 +
        group.currentStreak * 5,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  const ranked = leaderboard.map((agent, i) => ({
    rank: i + 1,
    ...agent,
    independence_group: agent.principalId,
    delegated_wallet_count: agent.wallets.length,
  }));

  return NextResponse.json({ leaderboard: ranked });
}

/** Read-only handler: retried once on a transient DB failure. */
export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
