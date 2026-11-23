import { NextResponse } from "next/server";
import { gate, isDemo, demoBlocked } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { cleanRow, screenshotsAllowed } from "@/lib/screenshots";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

async function own(id: string) {
  const g = await gate({ verified: true });
  if (g.error) return { error: g.error };
  if (!screenshotsAllowed(g.user!)) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const shot = await prisma.screenshot.findFirst({
    where: { id, userId: g.user!.id },
    select: { id: true, accountId: true, account: { select: { item: { select: { institution: { select: { name: true } } } } } } },
  });
  if (!shot) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  return { user: g.user!, shot };
}

// GET — the screenshot's image (kept 30 days).
export async function GET(_req: Request, { params }: Params) {
  const o = await own(params.id);
  if (o.error) return o.error;
  const img = await prisma.screenshotImage.findUnique({ where: { screenshotId: o.shot.id } });
  if (!img) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new Response(Buffer.from(img.image, "base64"), {
    headers: { "content-type": img.mime, "cache-control": "private, max-age=3600" },
  });
}

// PATCH {rows} — the user's corrections to what Gemini read (replace the rows wholesale);
// PATCH {reread: true} — have Gemini read it again (edits are replaced). Either way the
// account's transactions are recomputed by the analyze that follows.
export async function PATCH(req: Request, { params }: Params) {
  const o = await own(params.id);
  if (o.error) return o.error;
  if (isDemo(o.user)) return demoBlocked();
  const body = await req.json().catch(() => ({}));
  if (body?.reread === true) {
    if (!o.user.aiConsentAt) return NextResponse.json({ error: "Allow Google Gemini to read screenshots first.", consent: true }, { status: 428 });
    await prisma.screenshot.update({ where: { id: o.shot.id }, data: { status: "reading", error: null } });
    await enqueue(o.user.id, "screenshot", { key: o.shot.id, label: o.shot.account.item.institution.name, args: { screenshotId: o.shot.id } });
    return NextResponse.json({ ok: true });
  }
  if (!Array.isArray(body?.rows) || body.rows.length > 500) return NextResponse.json({ error: "Missing rows" }, { status: 400 });
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const [i, r] of body.rows.entries()) {
    const row = cleanRow(r, today);
    if (!row) return NextResponse.json({ error: `Row ${i + 1} needs a real date (not in the future), a description and a non-zero amount.` }, { status: 400 });
    rows.push(row);
  }
  await prisma.screenshot.update({ where: { id: o.shot.id }, data: { status: "read", rows: JSON.stringify(rows), error: null } });
  await enqueue(o.user.id, "analyze");
  return NextResponse.json({ ok: true });
}

// DELETE — the screenshot goes, and with it every transaction only it showed.
export async function DELETE(_req: Request, { params }: Params) {
  const o = await own(params.id);
  if (o.error) return o.error;
  if (isDemo(o.user)) return demoBlocked();
  await prisma.screenshot.delete({ where: { id: o.shot.id } });
  await enqueue(o.user.id, "analyze");
  return NextResponse.json({ ok: true });
}
