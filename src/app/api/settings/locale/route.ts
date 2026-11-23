import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isDemo } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { normalizeLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// POST /api/settings/locale { locale } — persist the logged-in user's language
// choice. Logged-out callers no-op (the cookie the switcher set already carries
// their choice; locale is not sensitive so no 401 needed).
// The shared demo/reviewer account never stores one: a stored zh-Hans outranks every
// reviewer's device and got PBudget rejected (Apple 2.1(a), 2026-07-31; recurred
// 2026-11-23). null = the browser's cookie decides, so its switcher still works per device.
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: true });
  const body = await req.json().catch(() => null);
  await prisma.user.update({
    where: { id: user.id },
    data: { locale: isDemo(user) ? null : normalizeLocale(body?.locale) },
  });
  return NextResponse.json({ ok: true });
}
