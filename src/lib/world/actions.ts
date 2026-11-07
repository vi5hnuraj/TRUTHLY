import { createHash } from "node:crypto";

export const WORLD_ACTIONS = [
  "execute_trade",
  "correct_story",
  "retract_story",
  "change_payout",
  "change_mandate",
  "revoke_agent",
  // Restoring authority is itself a fresh human decision.
  "resume_principal",
] as const;

export type WorldAction = (typeof WORLD_ACTIONS)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const purposeForAction: Record<WorldAction, string> = {
  execute_trade: "authorize_trade",
  correct_story: "correct_story",
  retract_story: "retract_story",
  change_payout: "change_payout",
  change_mandate: "change_mandate",
  revoke_agent: "revoke_agent",
  resume_principal: "resume_principal",
};

export function isWorldAction(value: string): value is WorldAction {
  return (WORLD_ACTIONS as readonly string[]).includes(value);
}

/**
 * Actions that only reduce or restore authority. They stay available while a
 * principal is paused so the human can always revoke an agent or come back.
 */
export const PAUSE_EXEMPT_ACTIONS: ReadonlySet<WorldAction> = new Set([
  "resume_principal",
  "revoke_agent",
]);

export const pauseAllows = (action: WorldAction) => PAUSE_EXEMPT_ACTIONS.has(action);

/** RFC-8785-like canonical JSON for the JSON values accepted by our schemas. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("authorization payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function hashAuthorizationPayload(action: WorldAction, payload: JsonValue): string {
  return sha256(`truthly/world-authorization/v1\n${action}\n${canonicalJson(payload)}`);
}

export function hashPrivateText(value: string): string {
  return sha256(`truthly/private-text/v1\n${value}`);
}
