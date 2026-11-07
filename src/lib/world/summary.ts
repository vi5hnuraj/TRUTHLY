import { formatUsdcAtomic } from "@/lib/usdc";
import {
  hashAuthorizationPayload,
  type JsonValue,
  type WorldAction,
} from "./actions";

/**
 * Human-readable rendering of an exact authorization.
 *
 * The only input is the canonical payload that was hashed into the stored
 * `payload_hash` — never a hint, a label or a separate display object. If the
 * payload changes, the summary changes with it, so what a human reads cannot
 * drift from what they are approving.
 */

export interface SummaryField {
  label: string;
  value: string;
  emphasis?: boolean;
}

export interface AuthorizationSummary {
  title: string;
  headline: string;
  fields: SummaryField[];
  /** Re-hash of the payload against the stored digest. */
  integrity: { valid: boolean; expected: string; actual: string };
}

const text = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(text).join(", ") : "—";
  return JSON.stringify(value);
};

const usdc = (value: unknown): string => {
  const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  if (!/^\d+$/.test(raw)) return text(value);
  try {
    return `$${formatUsdcAtomic(raw)}`;
  } catch {
    return text(value);
  }
};

const price = (value: unknown): string => {
  const raw = typeof value === "string" ? value : "";
  return raw && !Number.isNaN(Number(raw)) ? `$${raw}` : text(value);
};

const reason = (value: unknown) => text(value);

function allBoundFields(
  payload: Record<string, JsonValue>,
  fields: SummaryField[],
  shownKeys: string[],
): SummaryField[] {
  const shown = new Set(shownKeys);
  return [
    ...fields,
    ...Object.entries(payload)
      .filter(([key]) => !shown.has(key))
      .map(([key, value]) => ({
        label: `Bound ${key.replace(/_/g, " ")}`,
        value: text(value),
      })),
  ];
}

function fieldsFor(
  action: WorldAction,
  payload: Record<string, JsonValue>,
): { title: string; headline: string; fields: SummaryField[] } {
  switch (action) {
    case "execute_trade":
      return {
        title: "Execute trade",
        headline: `${text(payload.side).toUpperCase()} ${text(payload.token_symbol)} — ${usdc(payload.maximum_spend_atomic)} maximum`,
        fields: allBoundFields(
          payload,
          [
            { label: "Asset symbol", value: text(payload.token_symbol), emphasis: true },
            { label: "Asset contract", value: text(payload.token_address), emphasis: true },
            { label: "Side", value: text(payload.side).toUpperCase(), emphasis: true },
            { label: "Maximum spend", value: `${usdc(payload.maximum_spend_atomic)} USDC`, emphasis: true },
            { label: "Order type", value: text(payload.order_type) },
            { label: "Limit price", value: price(payload.limit_cross_price) },
            { label: "Take profit", value: price(payload.take_profit_notional_price) },
            { label: "Stop loss", value: price(payload.stop_loss_notional_price) },
            { label: "Network", value: "Base (8453)" },
            { label: "Delegated agent", value: text(payload.delegated_agent) },
            { label: "Signal", value: text(payload.signal_id) },
            { label: "Edition", value: text(payload.edition_id) },
            { label: "Paid-intel receipt", value: text(payload.receipt_id) },
            { label: "Request id", value: text(payload.request_id) },
            { label: "Signed rationale", value: text(payload.rationale_hash) },
            { label: "Order expires", value: text(payload.expire_time) },
            { label: "Maximum price impact", value: text(payload.maximum_price_impact) },
            { label: "Approval expires", value: text(payload.expires_at) },
            { label: "Approval nonce", value: text(payload.nonce) },
          ],
          [
            "token_symbol",
            "token_address",
            "side",
            "maximum_spend_atomic",
            "order_type",
            "limit_cross_price",
            "take_profit_notional_price",
            "stop_loss_notional_price",
            "delegated_agent",
            "signal_id",
            "edition_id",
            "receipt_id",
            "request_id",
            "rationale_hash",
            "expire_time",
            "maximum_price_impact",
            "expires_at",
            "nonce",
          ],
        ),
      };
    case "change_mandate":
      return {
        title: "Create or change a delegated mandate",
        headline: `Grant ${text(payload.agent_wallet)} authority over ${text(payload.owner_wallet)}'s newsroom`,
        fields: allBoundFields(
          payload,
          [
            { label: "Operation", value: text(payload.operation) },
            { label: "Owner (human)", value: text(payload.owner_wallet) },
            { label: "Delegated agent", value: text(payload.agent_wallet), emphasis: true },
            { label: "Label", value: text(payload.label) },
            { label: "Roles", value: text(payload.roles), emphasis: true },
            { label: "Beats", value: text(payload.allowed_beats) },
            { label: "Daily filings", value: text(payload.daily_filings) },
            { label: "Daily stake budget", value: `${usdc(payload.daily_stake_atomic)} USDC` },
            { label: "Per-trade cap", value: `${usdc(payload.max_trade_atomic)} USDC` },
            {
              label: "Fresh approval above",
              value: `${usdc(payload.fresh_pass_above_atomic)} USDC`,
            },
            { label: "Current agent status", value: text(payload.current_agent_status) },
            { label: "Current mandate", value: text(payload.current_mandate_id) },
            { label: "Current mandate version", value: text(payload.current_mandate_version) },
            { label: "Mandate expires", value: text(payload.mandate_expires_at) },
            { label: "Approval expires", value: text(payload.expires_at) },
            { label: "Approval nonce", value: text(payload.nonce) },
          ],
          [
            "operation",
            "owner_wallet",
            "agent_wallet",
            "label",
            "roles",
            "allowed_beats",
            "daily_filings",
            "daily_stake_atomic",
            "max_trade_atomic",
            "fresh_pass_above_atomic",
            "current_agent_status",
            "current_mandate_id",
            "current_mandate_version",
            "mandate_expires_at",
            "expires_at",
            "nonce",
          ],
        ),
      };
    case "revoke_agent":
      return {
        title: "Revoke a delegated agent",
        headline: `Remove all authority from ${text(payload.agent_wallet)}`,
        fields: allBoundFields(
          payload,
          [
            { label: "Operation", value: text(payload.operation) },
            { label: "Owner (human)", value: text(payload.owner_wallet) },
            { label: "Delegated agent", value: text(payload.agent_wallet), emphasis: true },
            { label: "Current status", value: text(payload.current_agent_status) },
            { label: "Active mandate", value: text(payload.current_mandate_id) },
            { label: "Active mandate version", value: text(payload.current_mandate_version) },
            { label: "Reason", value: reason(payload.reason), emphasis: true },
            { label: "Approval expires", value: text(payload.expires_at) },
            { label: "Approval nonce", value: text(payload.nonce) },
          ],
          [
            "operation",
            "owner_wallet",
            "agent_wallet",
            "current_agent_status",
            "current_mandate_id",
            "current_mandate_version",
            "reason",
            "expires_at",
            "nonce",
          ],
        ),
      };
    case "resume_principal":
      return {
        title: "Resume all agents",
        headline: "Restore authority for every delegated agent of this human",
        fields: allBoundFields(
          payload,
          [
            { label: "Owner (human)", value: text(payload.owner_wallet), emphasis: true },
            { label: "Pause generation", value: text(payload.pause_version), emphasis: true },
            { label: "Paused at", value: text(payload.paused_at) },
            { label: "Pause reason", value: text(payload.pause_reason) },
            { label: "Resume reason", value: reason(payload.reason) },
            { label: "Approval expires", value: text(payload.expires_at) },
            { label: "Approval nonce", value: text(payload.nonce) },
          ],
          [
            "owner_wallet",
            "pause_version",
            "paused_at",
            "pause_reason",
            "reason",
            "expires_at",
            "nonce",
          ],
        ),
      };
    case "change_payout":
      return {
        title: "Change payout destination",
        headline: `Pay this byline's revenue to ${text(payload.new_payout_wallet)}`,
        fields: allBoundFields(
          payload,
          [
            { label: "Byline wallet", value: text(payload.byline_wallet) },
            { label: "New payout wallet", value: text(payload.new_payout_wallet), emphasis: true },
            { label: "Previous payout wallet", value: text(payload.current_payout_wallet) },
            { label: "Reason", value: reason(payload.reason) },
            { label: "Approval expires", value: text(payload.expires_at) },
            { label: "Approval nonce", value: text(payload.nonce) },
          ],
          [
            "byline_wallet",
            "new_payout_wallet",
            "current_payout_wallet",
            "reason",
            "expires_at",
            "nonce",
          ],
        ),
      };
    case "correct_story":
    case "retract_story":
      return {
        title: action === "correct_story" ? "Correct a published story" : "Retract a published story",
        headline: `${action === "correct_story" ? "Correct" : "Retract"} ${text(payload.signal_id)}`,
        fields: allBoundFields(
          payload,
          [
            { label: "Story", value: text(payload.signal_id), emphasis: true },
            { label: "Current headline", value: text(payload.current_headline) },
            { label: "Current revision hash", value: text(payload.current_revision_hash) },
            { label: "New headline", value: text(payload.headline) },
            { label: "New revision hash", value: text(payload.revision_hash) },
            { label: "Reason", value: reason(payload.reason), emphasis: true },
            { label: "Approval expires", value: text(payload.expires_at) },
            { label: "Approval nonce", value: text(payload.nonce) },
          ],
          [
            "signal_id",
            "current_headline",
            "current_revision_hash",
            "headline",
            "revision_hash",
            "reason",
            "expires_at",
            "nonce",
          ],
        ),
      };
    default:
      return {
        title: action,
        headline: action,
        fields: Object.entries(payload).map(([label, value]) => ({ label, value: text(value) })),
      };
  }
}

export function describeAuthorization(
  action: WorldAction,
  payload: Record<string, JsonValue>,
  storedHash: string,
): AuthorizationSummary {
  const actual = hashAuthorizationPayload(action, payload);
  return {
    ...fieldsFor(action, payload),
    integrity: {
      valid: actual === storedHash,
      expected: storedHash,
      actual,
    },
  };
}
