/**
 * A signal can point a reading agent at its next move: a World
 * prediction-market search and the tokens the story is about. They are stored
 * as prefixed tags so no schema change is needed, and split out on read.
 */
const WORLD = "world:";
const TOKEN = "token:";

export interface ActOn {
  world_market_search: string | null;
  tokens: string[];
}

export const isActOnTag = (tag: string) => tag.startsWith(WORLD) || tag.startsWith(TOKEN);

export function encodeActOn(tags: string[], worldQuery?: string, tokens?: string[]): string[] {
  return [
    ...tags,
    ...(worldQuery ? [`${WORLD}${worldQuery}`] : []),
    ...(tokens ?? []).map((token) => `${TOKEN}${token}`),
  ];
}

export function splitTags(all: string[]): { tags: string[]; actOn: ActOn } {
  const world = all.find((tag) => tag.startsWith(WORLD));
  return {
    tags: all.filter((tag) => !isActOnTag(tag)),
    actOn: {
      world_market_search: world ? world.slice(WORLD.length) : null,
      tokens: all.filter((tag) => tag.startsWith(TOKEN)).map((tag) => tag.slice(TOKEN.length)),
    },
  };
}
