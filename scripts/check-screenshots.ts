// Gate for transactions from screenshots (lib/screenshots.ts + lib/agy.ts + lib/langfuse.ts).
// Asserts: the model's answer is parsed and every bad row dropped; reconcile adds each
// (date, amount) as often as ONE screenshot shows it, skips pending rows, leaves out what
// Plaid already has (same day first, then within 3 days) and keeps ids stable; in the dev
// SQLite DB the same screenshot twice adds nothing, deleting or editing one fixes the
// transactions, an override survives a recompute, and the analyze job runs it; the read
// job speaks ACP to a fake `agy` that is refused every tool permission and sees none of
// this process's environment; Langfuse gets one OTLP generation span.
// Run: npm run check:screenshots
import assert from "assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { ACTIVE, enqueue, waitJob } from "../src/lib/jobs";
import { cleanRow, parseAnswer, readJob, reconcile, reconcileUser, screenshotsAllowed, ID_PREFIX, type ShotRow } from "../src/lib/screenshots";

const TODAY = "2026-11-23";
const row = (date: string, amount: number, description = "X", pending = false): ShotRow => ({ date, description, amount, pending });

function checkParse() {
  const answer = 'Sure:\n```json\n{"rows":[' +
    '{"date":"2026-11-20","description":" TIM  HORTONS ","amount":"3.45","direction":"out","pending":false},' +
    '{"date":"2026-11-20","description":"Payroll","amount":"2,150.00","direction":"in","pending":false},' +
    '{"date":"2026-11-23","description":"UBER","amount":"23.40","direction":"out","pending":true},' +
    '{"date":"2026-12-25","description":"future","amount":"1.00","direction":"out"},' +
    '{"date":"2026-02-31","description":"no such day","amount":"1.00","direction":"out"},' +
    '{"date":"2026-11-19","description":"zero","amount":"0.00","direction":"out"},' +
    '{"date":"2026-11-19","description":"which way","amount":"5.00","direction":"sideways"},' +
    '{"date":"2026-11-19","description":"","amount":"5.00","direction":"out"},' +
    '{"date":"2026-11-19","description":"three decimals","amount":"5.001","direction":"out"}]}\n```';
  const { rows, dropped } = parseAnswer(answer, TODAY);
  assert.deepEqual(rows, [row("2026-11-20", 3.45, "TIM HORTONS"), row("2026-11-20", -2150, "Payroll"), row("2026-11-23", 23.4, "UBER", true)], "good rows parsed, sign from direction");
  assert.equal(dropped, 6, "every bad row is dropped and counted");
  assert.throws(() => parseAnswer("I can't read that.", TODAY), /JSON/, "an answer that isn't JSON fails the read");
  assert.equal(cleanRow({ date: "2026-11-20", description: "edit", amount: -12.5 }, TODAY)?.amount, -12.5, "a user's edit passes");
  assert.equal(cleanRow({ date: "2026-11-20", description: "edit", amount: "12" }, TODAY), null, "an amount must be a number");
}

function checkReconcile() {
  const A = "acct";
  const s1 = [row("2026-11-20", 3.45, "TIM"), row("2026-11-20", 3.45, "TIM"), row("2026-11-18", 87.16, "LOBLAWS"), row("2026-11-23", 23.4, "UBER", true)];
  const one = reconcile(A, [s1], []);
  assert.equal(one.length, 3, "two equal rows in one screenshot are two; pending waits");
  assert.deepEqual(reconcile(A, [s1, s1], []), one, "the same screenshot twice adds nothing");
  const s2 = [row("2026-11-18", 87.16, "LOBLAWS 1029"), row("2026-11-17", 9.99, "NETFLIX")];
  const both = reconcile(A, [s1, s2], []);
  assert.equal(both.length, 4, "an overlapping screenshot adds only its new row");
  assert.equal(both.find((w) => w.cents === 8716)?.description, "LOBLAWS 1029", "the latest screenshot names a row");
  for (const w of one) assert.ok(both.some((b) => b.id === w.id), "ids stay put when other rows arrive");
  assert.equal(new Set(both.map((w) => w.id)).size, 4, "ids are unique");

  // Rows the account already has from Plaid.
  assert.equal(reconcile(A, [s1], [{ date: "2026-11-20", cents: 345 }]).filter((w) => w.cents === 345).length, 1, "one coffee is already synced");
  assert.equal(reconcile(A, [s1], [{ date: "2026-11-16", cents: 8716 }]).some((w) => w.cents === 8716), false, "2 days apart is the same row");
  assert.equal(reconcile(A, [s2], [{ date: "2026-11-10", cents: 999 }]).some((w) => w.cents === 999), true, "a week apart is not");
  const exactFirst = reconcile(A, [[row("2026-11-18", 5), row("2026-11-20", 5)]], [{ date: "2026-11-20", cents: 500 }]);
  assert.deepEqual(exactFirst.map((w) => w.date), ["2026-11-18"], "an exact match is never taken by a near one");
  assert.equal(reconcile("other", [s1], [])[0].id === one[0].id, false, "ids are per account");
}

async function checkDb() {
  const U = "shots-test-user";
  await prisma.jobLock.deleteMany({ where: { userId: U } });
  await prisma.user.deleteMany({ where: { id: U } });
  await prisma.plaidInstitution.upsert({ where: { institutionId: "ins_shots" }, create: { institutionId: "ins_shots", name: "Test Bank" }, update: {} });
  await prisma.user.create({ data: { id: U, email: `${U}@t.local`, passwordHash: "x" } });
  await prisma.plaidItem.create({ data: { itemId: "item_shots", userId: U, institutionId: "ins_shots", accessToken: "", lastForceRefreshed: new Date() } });
  const A = "acct_shots";
  await prisma.plaidAccount.create({ data: { accountId: A, itemId: "item_shots", name: "Chequing", accountType: "depository", isoCurrencyCode: "CAD" } });
  await prisma.plaidTransaction.create({
    data: { transactionId: "plaid_1", accountId: A, amount: 87.16, datetime: new Date("2026-11-17T00:00:00Z"), name: "LOBLAWS", paymentChannel: "in store", pending: false },
  });
  const shotTxns = () =>
    prisma.plaidTransaction.findMany({ where: { accountId: A, transactionId: { startsWith: ID_PREFIX } }, orderBy: [{ datetime: "asc" }, { transactionId: "asc" }] });
  const add = (rows: ShotRow[], sha: string, status = "read") =>
    prisma.screenshot.create({ data: { userId: U, accountId: A, sha256: sha, status, rows: JSON.stringify(rows) } });

  const s1 = [row("2026-11-20", 3.45, "TIM"), row("2026-11-20", 3.45, "TIM"), row("2026-11-18", 87.16, "LOBLAWS"), row("2026-11-19", -2150, "Payroll")];
  const first = await add(s1, "a");
  await reconcileUser(U);
  let txns = await shotTxns();
  assert.equal(txns.length, 3, "two coffees + payroll; Loblaws is already synced a day off");
  assert.equal(txns.find((t) => Number(t.amount) === -2150)?.name, "Payroll", "names are stored (and read back decrypted)");

  // A category override on a screenshot row survives the same screenshot again + a recompute.
  const coffee = txns.find((t) => Number(t.amount) === 3.45)!;
  await prisma.plaidTransaction.update({ where: { transactionId: coffee.transactionId }, data: { categoryOverride: "Coffee" } });
  await add(s1, "a-again");
  await add([row("2026-11-21", 12, "LUNCH")], "failed", "failed");
  await reconcileUser(U);
  txns = await shotTxns();
  assert.equal(txns.length, 3, "the same rows again add nothing; a failed screenshot adds nothing");
  assert.equal((await prisma.plaidTransaction.findUnique({ where: { transactionId: coffee.transactionId } }))?.categoryOverride, "Coffee", "the override stays on its row");

  // A misread fixed by editing: payroll was really 2,105.00.
  for (const id of [first.id]) await prisma.screenshot.update({ where: { id }, data: { rows: JSON.stringify([...s1.slice(0, 3), row("2026-11-19", -2105, "Payroll")]) } });
  await prisma.screenshot.deleteMany({ where: { sha256: "a-again" } }); // the copy still says 2,150
  await reconcileUser(U);
  txns = await shotTxns();
  assert.deepEqual(txns.map((t) => Number(t.amount)).sort(), [-2105, 3.45, 3.45], "editing + deleting the copy corrects the amount");

  // The analyze job recomputes first; deleting the last screenshot removes everything it added.
  await prisma.screenshot.deleteMany({ where: { userId: U } });
  const job = await enqueue(U, "analyze");
  assert.equal((await waitJob(job.id, 30_000))?.state, "done", "analyze runs with the recompute");
  assert.equal((await shotTxns()).length, 0, "no screenshots, no screenshot transactions");
  assert.equal(await prisma.plaidTransaction.count({ where: { accountId: A } }), 1, "Plaid's own row is untouched");
  return { U, A };
}

// A stand-in `agy acp`: asks for a tool permission, then answers with what it was told.
const FAKE_AGY = `#!/usr/bin/env node
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let promptId = null;
process.stdin.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } });
    else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1" } });
    else if (m.method === "session/set_model") send({ id: m.id, result: {} });
    else if (m.method === "session/prompt") {
      promptId = m.id;
      const img = m.params.prompt.find((p) => p.type === "image");
      globalThis.saw = img && img.mimeType + ":" + img.data.length;
      send({ id: 900, method: "session/request_permission", params: { toolCall: { title: "File /etc/hosts" }, options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
    } else if (m.id === 900) {
      const leak = Object.keys(process.env).filter((k) => !["PATH", "HOME"].includes(k) && !k.startsWith("__CF")).join(",");
      const desc = "COFFEE perm=" + m.result.outcome.optionId + " env=" + (leak || "clean") + " img=" + globalThis.saw;
      send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ rows: [{ date: "2026-11-20", description: desc, amount: "3.45", direction: "out", pending: false }] }) } } } });
      send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
    }
  }
});
`;

async function checkRead(U: string, A: string) {
  const bin = mkdtempSync(join(tmpdir(), "fake-agy-"));
  writeFileSync(join(bin, "agy"), FAKE_AGY);
  chmodSync(join(bin, "agy"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.AGY_HOME = mkdtempSync(join(tmpdir(), "agy-home-"));
  process.env.AGY_TOKEN_FILE = "";

  const spans: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      spans.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  server.unref(); // a failed assertion must still let the process exit
  process.env.LANGFUSE_HOST = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.LANGFUSE_PUBLIC_KEY = "pk";
  process.env.LANGFUSE_SECRET_KEY = "sk";

  const s = await prisma.screenshot.create({ data: { userId: U, accountId: A, sha256: "img" } });
  await prisma.screenshotImage.create({ data: { screenshotId: s.id, mime: "image/jpeg", image: Buffer.from("not really a jpeg").toString("base64") } });
  const result = await readJob(U, { screenshotId: s.id });
  assert.deepEqual(result, { rows: 1, dropped: 0 }, "the read job answers with its counts");
  const after = await prisma.job.findMany({ where: { userId: U, kind: "analyze", state: { in: ACTIVE } } });
  assert.equal(after.length, 1, "a read queues an analyze");
  assert.equal((await waitJob(after[0].id, 30_000))?.state, "done");
  assert.equal(await prisma.plaidTransaction.count({ where: { accountId: A, transactionId: { startsWith: ID_PREFIX } } }), 1, "…which adds the row read");
  const read = await prisma.screenshot.findUnique({ where: { id: s.id } });
  assert.equal(read?.status, "read");
  const desc = JSON.parse(read!.rows!)[0].description as string;
  assert.match(desc, /perm=no/, "every tool permission is refused");
  assert.match(desc, /env=clean/, "agy sees no environment beyond PATH and HOME");
  assert.match(desc, /img=image\/jpeg:24/, "the image goes as an ACP image block");
  const stored = await prisma.$queryRawUnsafe<{ image: string }[]>(`SELECT image FROM ScreenshotImage WHERE screenshotId = '${s.id}'`);
  assert.notEqual(stored[0].image, Buffer.from("not really a jpeg").toString("base64"), "the image is sealed at rest");

  assert.equal(spans.length, 1, "one span per read");
  assert.equal(spans[0].url, "/api/public/otel/v1/traces", "OTLP endpoint, not /ingestion");
  assert.equal(spans[0].auth, `Basic ${Buffer.from("pk:sk").toString("base64")}`);
  const attrs = Object.fromEntries(spans[0].body.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: any) => [a.key, a.value.stringValue]));
  assert.equal(attrs["langfuse.observation.type"], "generation");
  assert.equal(attrs["langfuse.trace.name"], "screenshot.read");
  assert.equal(attrs["user.id"], U);
  assert.ok(!attrs["langfuse.observation.input"].includes(Buffer.from("not really a jpeg").toString("base64")), "the image itself isn't traced");
  server.close();
}

async function main() {
  checkParse();
  checkReconcile();
  const { U, A } = await checkDb();
  await checkRead(U, A);
  process.env.SCREENSHOT_EMAILS = " Owner@Example.com ,x@y.z";
  assert.equal(screenshotsAllowed({ email: "owner@example.com" }), true, "allowlisted (any case)");
  assert.equal(screenshotsAllowed({ email: "someone@example.com" }), false, "everyone else is not");
  delete process.env.SCREENSHOT_EMAILS;
  assert.equal(screenshotsAllowed({ email: "owner@example.com" }), false, "unset = nobody");
  await prisma.user.deleteMany({ where: { id: U } });
  console.log("check:screenshots OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
