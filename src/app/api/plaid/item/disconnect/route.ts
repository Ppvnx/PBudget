import { NextResponse } from "next/server";
import { gate } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { disconnectItem } from "@/lib/plaid";

// Disconnect a bank from Plaid: the item is removed at Plaid (its data there deleted),
// while its accounts + transactions are KEPT here. Distinct from /remove, which also
// deletes everything here.
export async function POST(req: Request) {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  const { item_id } = await req.json().catch(() => ({}));
  if (!item_id) return NextResponse.json({ error: "Missing item_id" }, { status: 400 });

  const item = await prisma.plaidItem.findUnique({ where: { itemId: item_id } });
  if (!item || item.userId !== g.user!.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (item.disconnectedAt) return NextResponse.json({ ok: true });
  try {
    await disconnectItem(item.itemId, item.accessToken);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Disconnect failed" }, { status: 502 });
  }
}
