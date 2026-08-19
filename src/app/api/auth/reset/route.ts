import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword, verifyEmailCode } from "@/lib/auth";
import { normalizeEmail, validatePassword } from "@/lib/validate";

// Second half of the reset: the email that asked for the code, the code itself, and the
// new password — all posted from the same /forgot screen that requested it. Unauthenticated
// by nature; the code is the proof, capped at 5 wrong tries by verifyEmailCode.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const password = validatePassword(body.password);
  if (!password) {
    return NextResponse.json({ error: "Password must be 8–200 characters" }, { status: 400 });
  }
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Enter the 6-digit code" }, { status: 400 });
  }

  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  // An unknown address answers exactly like a wrong code — the reset half must not leak
  // what /forgot deliberately hides. It also consumes the code and marks the address
  // verified, which receiving the code just proved.
  const result = user ? await verifyEmailCode(user.id, code) : "invalid";
  if (result === "no_code") {
    return NextResponse.json(
      { error: "That code expired or was tried too many times — request a new one" },
      { status: 400 },
    );
  }
  if (result !== "ok") {
    return NextResponse.json({ error: "Incorrect code" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: user!.id },
    data: { passwordHash: await hashPassword(password) },
  });
  // Kill every existing session: a password change logs out all devices, so a leaked/old
  // session can't survive the reset.
  await prisma.session.deleteMany({ where: { userId: user!.id } });
  return NextResponse.json({ ok: true });
}
