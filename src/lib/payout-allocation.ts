export interface OriginPayoutMember {
  key: string;
  groupId: string;
  position: number;
}

/**
 * Split by independent human origin first, then across that origin's stories.
 * This preserves the total exactly while preventing extra wallets/bylines from
 * creating extra top-level shares.
 */
export function allocatePayoutByOrigin(
  totalCents: number,
  members: OriginPayoutMember[],
): Map<string, number> {
  const allocation = new Map<string, number>();
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || members.length === 0) {
    return allocation;
  }
  const groups = new Map<string, OriginPayoutMember[]>();
  for (const member of members) {
    groups.set(member.groupId, [...(groups.get(member.groupId) ?? []), member]);
  }
  const ordered = [...groups.entries()]
    .map(([groupId, groupMembers]) => [
      groupId,
      [...groupMembers].sort((a, b) => a.position - b.position),
    ] as const)
    .sort(([, a], [, b]) => a[0].position - b[0].position);
  const basePerGroup = Math.floor(totalCents / ordered.length);
  const groupRemainder = totalCents - basePerGroup * ordered.length;
  for (let groupIndex = 0; groupIndex < ordered.length; groupIndex++) {
    const [, groupMembers] = ordered[groupIndex];
    const groupTotal = basePerGroup + (groupIndex < groupRemainder ? 1 : 0);
    const basePerMember = Math.floor(groupTotal / groupMembers.length);
    const memberRemainder = groupTotal - basePerMember * groupMembers.length;
    for (let memberIndex = 0; memberIndex < groupMembers.length; memberIndex++) {
      allocation.set(
        groupMembers[memberIndex].key,
        basePerMember + (memberIndex < memberRemainder ? 1 : 0),
      );
    }
  }
  return allocation;
}
