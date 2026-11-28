// Gate for the one-time email code (lib/auth verifyEmailCode — email verification AND the
// unauthenticated password reset): a code gets 5 tries in total, however they arrive.
// Guesses sent in parallel must each pay for a try (the cap was read-compare-increment,
// which gave every request in a burst a free one). Run against the dev DB: npm run check:otp
import assert from "assert";
import { prisma } from "../src/lib/db";
import { createVerificationToken, verifyEmailCode } from "../src/lib/auth";

const U = "otp-test-user";
const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

async function main() {
  await prisma.user.deleteMany({ where: { id: U } });
  await prisma.user.create({ data: { id: U, email: `${U}@t.local`, passwordHash: "x" } });

  // The right code works, marks the address verified and is consumed.
  let code = await createVerificationToken(U);
  assert.equal(await verifyEmailCode(U, code), "ok", "the right code is accepted");
  assert.ok((await prisma.user.findUnique({ where: { id: U } }))?.emailVerified, "the address is verified");
  assert.equal(await verifyEmailCode(U, code), "no_code", "a used code is gone");

  // Four wrong tries leave one: the right code still works on the fifth.
  code = await createVerificationToken(U);
  for (let i = 0; i < 4; i++) assert.equal(await verifyEmailCode(U, wrong(code)), "invalid", `wrong try ${i + 1}`);
  assert.equal(await verifyEmailCode(U, code), "ok", "the fifth try may still be right");

  // Five wrong tries use the code up: the sixth is refused even when it is right.
  code = await createVerificationToken(U);
  for (let i = 0; i < 5; i++) assert.equal(await verifyEmailCode(U, wrong(code)), "invalid", `wrong try ${i + 1}`);
  assert.equal(await verifyEmailCode(U, code), "no_code", "the sixth try is refused");

  // A burst of parallel guesses gets 5 tries between them, not one each.
  code = await createVerificationToken(U);
  const burst = await Promise.all(Array.from({ length: 20 }, () => verifyEmailCode(U, wrong(code))));
  const compared = burst.filter((r) => r === "invalid").length;
  assert.ok(compared <= 5, `a parallel burst compared ${compared} guesses (max 5)`);
  assert.equal((await prisma.emailOtp.findFirst({ where: { userId: U } }))?.attempts, 5, "the burst used the code up");
  assert.equal(await verifyEmailCode(U, code), "no_code", "the right code after the burst is refused");

  await prisma.user.deleteMany({ where: { id: U } });
  console.log("check:otp OK");
  process.exit(0);
}

main();
