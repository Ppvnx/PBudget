import { NextResponse } from "next/server";
import { gate, isDemo, demoBlocked } from "@/lib/guard";
import { prisma } from "@/lib/db";

// POST — the user allowed screenshots to be sent to Google Gemini (asked in the app, in
// the Screenshots panel, before the first one goes: Apple 5.1.1(i)).
export async function POST() {
  const g = await gate({ verified: true });
  if (g.error) return g.error;
  if (isDemo(g.user!)) return demoBlocked();
  await prisma.user.update({ where: { id: g.user!.id }, data: { aiConsentAt: new Date() } });
  return NextResponse.json({ ok: true });
}
