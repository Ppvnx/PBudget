import { NextResponse } from "next/server";
import { gate } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { canSyncItem, upgradeCTA } from "@/lib/stripe";
import { enqueue } from "@/lib/jobs";

export async function POST(req: Request) {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  const { item_id } = await req.json().catch(() => ({}));
  if (!item_id) return NextResponse.json({ error: "Missing item_id" }, { status: 400 });

  const item = await prisma.plaidItem.findUnique({ where: { itemId: item_id }, include: { institution: true } });
  if (!item || item.userId !== g.user!.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // A removed connection (billing expiry) keeps its data but can't sync — resubscribe
  // and relink to refresh it.
  if (item.disconnectedAt) {
    return NextResponse.json({ error: "This connection was removed. Subscribe and relink to sync it again." }, { status: 409 });
  }
  // FR10: after a downgrade the oldest `limit` connections keep syncing; excess
  // items are read-only until upgrade or disconnect.
  const sync = await canSyncItem(g.user!, item.itemId);
  if (!sync.ok) {
    return NextResponse.json(upgradeCTA(g.user!.plan, sync.used), { status: 402 });
  }
  // The pull itself (minutes: Plaid's refresh) runs on a worker, then the analyzer
  // (FR1) — lib/plaid.ts syncJob. The jobs panel follows it.
  const job = await enqueue(g.user!.id, "sync", {
    key: item.itemId,
    label: item.institution.name,
    args: { itemId: item.itemId, refresh: true },
  });
  return NextResponse.json({ job });
}
