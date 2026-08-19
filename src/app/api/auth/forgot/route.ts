import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createVerificationToken } from "@/lib/auth";
import { normalizeEmail } from "@/lib/validate";
import { sendPasswordResetEmail } from "@/lib/email";
import { emailRateLimited, emailDims, clientIp } from "@/lib/rateLimit";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  // Always return ok — never reveal whether an email is registered. A rate-limited
  // send is silently skipped (same as a non-existent email) so it leaks nothing.
  if (email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !(await emailRateLimited(emailDims(email, clientIp(req))))) {
      // A 6-digit code, never a link: a link opens in the mail client's own browser —
      // a different session from the app that asked — and inside the native shell it
      // leaves the app entirely. The code is typed back into /forgot, which is still open.
      const code = await createVerificationToken(user.id);
      await sendPasswordResetEmail(email, code);
    }
  }
  return NextResponse.json({ ok: true });
}
