import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { recordLedgerEntry } from "@/lib/ledger";
import { Resend } from "resend";
import { verifyEditorAuth } from "@/lib/editor-auth";

function escapeEmailHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function POST(req: NextRequest) {
  const auth = await verifyEditorAuth(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401 },
    );
  }

  const db = await getDb();

  const edition = await db
    .select()
    .from(schema.editions)
    .orderBy(sql`${schema.editions.number} DESC`)
    .limit(1)
    .get();

  if (!edition) {
    return NextResponse.json(
      { error: "No editions to publish. Run /api/editor/compile first." },
      { status: 400 },
    );
  }

  // Idempotency: if already published, return cached result
  if (edition.status === "published") {
    return NextResponse.json({
      message: `Edition #${edition.number} already published`,
      emailsSent: 0,
      subscriberCount: 0,
      revenueCents: edition.revenueCents,
      alreadyPublished: true,
      edition: {
        id: edition.id,
        number: edition.number,
        title: edition.title,
        signalCount: edition.signalCount,
        url: `/editions/${edition.id}`,
      },
    });
  }

  // Only compiled or delivery_failed editions can be published
  if (edition.status !== "compiled" && edition.status !== "delivery_failed") {
    return NextResponse.json(
      {
        error: `Edition #${edition.number} is in '${edition.status}' state, expected 'compiled' or 'delivery_failed'`,
      },
      { status: 409 },
    );
  }

  // Record publication event in ledger (check for existing expense entry specifically)
  const existingExpense = await db
    .select({ id: schema.ledger.id })
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.editionId, edition.id),
        eq(schema.ledger.type, "expense"),
      ),
    )
    .get();

  if (!existingExpense) {
    await recordLedgerEntry({
      type: "expense",
      amountCents: 0,
      description: `Published Edition #${edition.number} — ${edition.signalCount} signals distributed`,
      editionId: edition.id,
    });
  }

  // Revenue is tracked via actual x402 payments (recordPayment), not estimates.
  // Get subscriber count for email delivery only.
  const subCount =
    (
      await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(schema.subscribers)
        .where(eq(schema.subscribers.active, 1))
        .get()
    )?.count ?? 0;

  // Send notification emails to active subscribers
  let emailsSent = 0;
  const emailErrors: string[] = [];

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);

    const subscribers = await db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.active, 1))
      .all();

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

    for (const sub of subscribers) {
      try {
        await resend.emails.send({
          from: "TRUTHLY <onboarding@resend.dev>",
          to: sub.email,
          subject: `TRUTHLY #${edition.number}: ${edition.title}`,
          html: `
            <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #111;">
              <h1 style="font-size: 24px; border-bottom: 2px solid #E85D04; padding-bottom: 12px;">
                Agent<span style="color: #E85D04; font-style: italic;">Press</span>
              </h1>
              <h2 style="font-size: 20px; margin-top: 24px;">${escapeEmailHtml(edition.title)}</h2>
              ${edition.summary ? `<p style="color: #666; font-style: italic;">${escapeEmailHtml(edition.summary)}</p>` : ""}
              <p style="margin-top: 16px;">${edition.signalCount} signals curated by our autonomous editor.</p>
              <a href="${baseUrl}/editions/${edition.id}"
                 style="display: inline-block; background: #111; color: #F4F1EC; padding: 12px 24px; text-decoration: none; font-family: monospace; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin-top: 16px;">
                Read Edition &rarr;
              </a>
              <p style="margin-top: 32px; font-size: 12px; color: #999; font-family: monospace; text-transform: uppercase; letter-spacing: 1px;">
                 Powered by x402 micropayments on Base
              </p>
            </div>
          `,
        });
        emailsSent++;
      } catch (err) {
        emailErrors.push(
          `${sub.email}: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }
  }

  // Determine final status
  // Any email failure → delivery_failed so operator can retry for missed recipients
  const hasEmailFailures = emailErrors.length > 0 && process.env.RESEND_API_KEY;
  const finalStatus = hasEmailFailures ? "delivery_failed" : "published";

  // Always mark status — prevents duplicate work on retry
  await db
    .update(schema.editions)
    .set({
      status: finalStatus,
      ...(emailsSent > 0 ? { emailedAt: new Date().toISOString() } : {}),
    })
    .where(eq(schema.editions.id, edition.id))
    .run();

  return NextResponse.json({
    message: `Edition #${edition.number} ${finalStatus === "published" ? "published" : "publish failed — emails not delivered"}`,
    emailsSent,
    subscriberCount: subCount,
    revenueCents: edition.revenueCents,
    status: finalStatus,
    ...(emailErrors.length > 0 ? { emailErrors } : {}),
    edition: {
      id: edition.id,
      number: edition.number,
      title: edition.title,
      signalCount: edition.signalCount,
      url: `/editions/${edition.id}`,
    },
  });
}
