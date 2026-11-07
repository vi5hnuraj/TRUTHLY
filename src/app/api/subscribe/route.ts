import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const limited = checkRateLimit(req, 10);
  if (limited) return limited;
  let body: { email: string; account_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!body.email || !emailRegex.test(body.email)) {
    return NextResponse.json(
      { error: "Valid email required" },
      { status: 400 },
    );
  }

  const db = await getDb();

  const existing = await db
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.email, body.email))
    .get();

  if (existing) {
    return NextResponse.json({ message: "Already subscribed" });
  }

  const subscriber = {
    id: uuid(),
    email: body.email,
    accountId: body.account_id ?? null,
    subscribedAt: new Date().toISOString(),
    active: 1,
  };

  await db.insert(schema.subscribers).values(subscriber).run();

  return NextResponse.json(
    { message: "Subscribed successfully", id: subscriber.id },
    { status: 201 },
  );
}
