import { sql } from "drizzle-orm";
import { schema } from "./db";

/**
 * Everything before this instant is legacy testnet data (Base Sepolia, seeded
 * demo stories and reporters). It stays in the database for the record,
 * but it is never listed, counted, ranked or sold in the mainnet newsroom.
 */
export const ERA_START = "2026-10-01T00:00:00.000Z";

export const currentEdition = sql`${schema.editions.createdAt} >= ${ERA_START}`;
export const publishedEdition = sql`${schema.editions.createdAt} >= ${ERA_START} AND ${schema.editions.status} = 'published'`;
export const currentSignal = sql`${schema.signals.createdAt} >= ${ERA_START}`;
export const currentAgent = sql`${schema.agents.registeredAt} >= ${ERA_START}`;

const currentEditionIds = sql`(SELECT id FROM editions WHERE created_at >= ${ERA_START})`;

export const currentLedger = sql`${schema.ledger.createdAt} >= ${ERA_START} AND (${schema.ledger.editionId} IS NULL OR ${schema.ledger.editionId} IN ${currentEditionIds})`;
export const currentPayment = sql`${schema.payments.paidAt} >= ${ERA_START} AND ${schema.payments.editionId} IN ${currentEditionIds}`;
