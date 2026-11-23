import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { gate, isDemo, demoBlocked } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { DAILY_LIMIT, MAX_IMAGE_BYTES, screenshotsAllowed, storedRows } from "@/lib/screenshots";

export const dynamic = "force-dynamic";

// What the bytes are, whatever the upload claims: only these go on to Gemini.
function sniff(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

async function ownedAccount(userId: string, accountId: unknown) {
  if (typeof accountId !== "string" || !accountId) return null;
  return prisma.plaidAccount.findFirst({
    where: { accountId, item: { userId } },
    select: { accountId: true, item: { select: { institution: { select: { name: true } } } } },
  });
}

// GET /api/accounts/screenshots?account_id=X — the account's screenshots, newest first,
// with the rows read from each; `consent` = the user has allowed Gemini to read them.
export async function GET(req: Request) {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  const user = g.user!;
  if (!screenshotsAllowed(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const account = await ownedAccount(user.id, new URL(req.url).searchParams.get("account_id"));
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const shots = await prisma.screenshot.findMany({
    where: { accountId: account.accountId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, rows: true, error: true, createdAt: true, image: { select: { screenshotId: true } } },
  });
  return NextResponse.json({
    consent: !!user.aiConsentAt,
    screenshots: shots.map((s) => ({
      id: s.id,
      status: s.status,
      rows: storedRows(s.rows),
      error: s.error,
      createdAt: s.createdAt.toISOString(),
      hasImage: !!s.image,
    })),
  });
}

// POST /api/accounts/screenshots (multipart: account_id, file) — add one screenshot and
// queue Gemini's read of it. The same file again into the same account is the same
// screenshot (answered with it, nothing re-read unless its last read failed).
export async function POST(req: Request) {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  const user = g.user!;
  if (isDemo(user)) return demoBlocked();
  if (!screenshotsAllowed(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Apple 5.1.1(i): nothing goes to Gemini before the user allowed it in the app.
  if (!user.aiConsentAt) return NextResponse.json({ error: "Allow Google Gemini to read screenshots first.", consent: true }, { status: 428 });

  const form = await req.formData().catch(() => null);
  const account = await ownedAccount(user.id, form?.get("account_id"));
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const file = form?.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  if (file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: "That image is too large." }, { status: 413 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = sniff(bytes);
  if (!mime) return NextResponse.json({ error: "That isn't a JPEG, PNG or WebP image." }, { status: 415 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const label = account.item.institution.name;

  const same = await prisma.screenshot.findUnique({
    where: { accountId_sha256: { accountId: account.accountId, sha256 } },
    select: { id: true, status: true },
  });
  if (same) {
    if (same.status === "failed") {
      await prisma.screenshot.update({ where: { id: same.id }, data: { status: "reading", error: null } });
      await enqueue(user.id, "screenshot", { key: same.id, label, args: { screenshotId: same.id } });
    }
    return NextResponse.json({ id: same.id, duplicate: true });
  }

  const today = await prisma.screenshot.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 86400000) } } });
  if (today >= DAILY_LIMIT) {
    return NextResponse.json({ error: `That's ${DAILY_LIMIT} screenshots in 24 hours — try again tomorrow.` }, { status: 429 });
  }
  const shot = await prisma.screenshot.create({ data: { userId: user.id, accountId: account.accountId, sha256 }, select: { id: true } });
  // Its own write (not a nested create) so db.ts seals the image.
  await prisma.screenshotImage.create({ data: { screenshotId: shot.id, mime, image: bytes.toString("base64") } });
  await enqueue(user.id, "screenshot", { key: shot.id, label, args: { screenshotId: shot.id } });
  return NextResponse.json({ id: shot.id });
}
