import { NextResponse } from "next/server";
import { gate, isDemo, demoBlocked } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { exchangePublicToken } from "@/lib/plaid";
import { entitledConnections, countConnections, upgradeCTA } from "@/lib/stripe";
import { enqueue } from "@/lib/jobs";

// Exchange a Plaid Link public_token for an access token, then queue the item's first
// sync (a job: lib/plaid.ts syncJob creates the item). The token rides in the job's
// args, sealed at rest (db.ts). ponytail: the item row only exists once that job has
// run, so a second NEW link inside that minute isn't counted against the limit yet.
export async function POST(req: Request) {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  if (isDemo(g.user!)) return demoBlocked();
  const { public_token } = await req.json().catch(() => ({}));
  if (!public_token) return NextResponse.json({ error: "Missing public_token" }, { status: 400 });

  try {
    const { accessToken, itemId } = await exchangePublicToken(public_token);
    // Gate only NEW connections: re-linking an existing item (update mode) upserts
    // the same itemId and is always allowed. A new item at/over the limit is 402'd
    // before syncItem creates it.
    const existing = await prisma.plaidItem.findUnique({ where: { itemId }, include: { institution: true } });
    if (!existing) {
      const used = await countConnections(g.user!.id);
      if (used >= entitledConnections(g.user!)) {
        return NextResponse.json(upgradeCTA(g.user!.plan, used), { status: 402 });
      }
    }
    const job = await enqueue(g.user!.id, "sync", {
      key: itemId,
      label: existing?.institution.name ?? "",
      args: { token: accessToken },
    });
    return NextResponse.json({ job });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Plaid error" }, { status: 500 });
  }
}
