// pbudget.ppvnx.com as an MCP server, so the owner's agent (agent.ppvnx.com) can work the
// Review queue. Streamable HTTP, stateless: every POST is one JSON-RPC message answered with
// plain JSON (no SSE, no sessions) — the media.ppvnx.com shape (MediaDownloader lib/mcp.ts).
//
// Scope (owner, 2026-11-22): READ everything, WRITE only what the Review and Vendors pages
// offer. Each tool runs the SAME route handler the page's button calls, as the token's user
// (actingUser, lib/auth.ts), so validation and side effects (rematch, re-analyze, demo
// read-only) are the UI's. Connect / sync / re-auth / remove a bank, editing transactions,
// categories, billing and the account are unreachable: no tool calls them. The tool list is
// pinned by scripts/check-mcp.ts.
import type { User } from "@prisma/client";
import { prisma } from "./db";
import { actingUser, mcpTokenUser, MCP_HISTORY_MS } from "./auth";
import { RULES } from "./analysis/constants";
import { GET as reviewGet } from "@/app/api/review/route";
import { POST as analyzePost } from "@/app/api/review/analyze/route";
import { GET as accountTxnsGet } from "@/app/api/accounts/transactions/route";
import { GET as txnGet, PATCH as txnPatch } from "@/app/api/transactions/[id]/route";
import { GET as vendorsGet, POST as vendorsPost, PATCH as vendorsPatch, DELETE as vendorsDelete } from "@/app/api/vendors/route";
import { GET as refsGet } from "@/app/api/vendors/refs/route";
import { POST as reorderPost } from "@/app/api/vendors/reorder/route";
import { POST as sharingPost } from "@/app/api/vendors/sharing/route";
import { GET as categoriesGet } from "@/app/api/categories/route";
import { GET as mergeGet, POST as mergePost } from "@/app/api/merge/route";
import { PATCH as mergeTitlePatch } from "@/app/api/merge/[id]/route";
import { POST as mergeConfirmPost } from "@/app/api/merge/[id]/confirm/route";
import { POST as mergeDissolvePost } from "@/app/api/merge/[id]/dissolve/route";
import { POST as dismissPost } from "@/app/api/flags/[id]/dismiss/route";
import { POST as splitPost, DELETE as splitDelete } from "@/app/api/splits/route";
import { GET as catalogGet } from "@/app/api/catalog/route";
import { POST as instantiatePost } from "@/app/api/catalog/instantiate/route";
import { GET as dashboardGet } from "@/app/api/dashboard/route";

const INSTRUCTIONS = `PBudget (pbudget.ppvnx.com): the owner's budget, fed by their banks through Plaid. You work its Review queue for them.
Amounts are stored Plaid-style: POSITIVE = money out (spend), negative = money in. Split parts use the same sign.
Read: get_review is the queue (unmatched, conflicts, suspicion flags, pending merge groups, splits). list_accounts, list_transactions and get_transaction are the raw data. list_vendors, list_categories and vendor_refs are the rules. search_catalog finds community vendor rules. get_dashboard is spend per month.
Working the queue:
- Unmatched: every transaction should belong to a vendor. Prefer an existing vendor (update_vendor with addMatchConditions), then the catalog (adopt_catalog_vendor), else create_vendor. A match condition is usually {"merchantOp":"contains","merchantValue":"<merchant>"} or {"nameOp":"contains","nameValue":"<name>"}. Every vendor change re-matches all transactions, so re-read get_review afterwards.
- Conflicts: two vendors match one transaction and the higher priority wins. Narrow one vendor's conditions, or reorder_vendors.
- Suspicion: duplicate_charge and unusual_amount get mark_valid when they're fine (or merge / split). An unmatched_transfer can't be marked valid: give it a category with set_transfer_category and a reason.
- Pending merge groups (auto-detected): confirm_merge_group or dissolve_merge_group.
You can't connect, sync, re-authenticate or remove banks, edit transactions, or change categories, billing or the account: tell the owner when one of those is needed. Ask the owner before deleting a vendor or sharing one to the catalog.`;

// A route handler the page calls, run as `user`. Its own gate() sees the user via
// actingUser, so the call is exactly the browser's minus the cookie.
type Handler = (req: Request, ctx: any) => Promise<Response>;
async function call(
  user: User,
  h: Handler,
  o: { query?: Record<string, unknown>; body?: unknown; params?: Record<string, string> } = {}
): Promise<any> {
  const url = new URL("http://mcp.internal/");
  for (const [k, v] of Object.entries(o.query ?? {})) if (v != null) url.searchParams.set(k, String(v));
  const req = new Request(url, {
    method: o.body === undefined ? "GET" : "POST", // handlers never read req.method
    headers: { "content-type": "application/json" },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const res = await actingUser.run(user, () => h(req, { params: o.params ?? {} }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `failed (HTTP ${res.status})`);
  return data;
}

const str = { type: "string" };
const int = { type: "integer" };
const list = (description: string) => ({ type: "array", description });
const conditions =
  "rows of {nameOp?, nameValue?, merchantOp?, merchantValue? (op: contains|regex), amountMin?, amountMax?, accountId?, daysOfMonth?: number[], paymentChannel?, plaidPrimary?, plaidDetailed?, plaidConfidence?}; a row matches when all its set fields do";

type Tool = { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, any>; required?: string[] }; run: (u: User, a: any) => Promise<unknown> };
const tool = (name: string, description: string, properties: Record<string, any>, required: string[], run: Tool["run"]): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties, required },
  run,
});

export const TOOLS: Tool[] = [
  // --- Read -------------------------------------------------------------------
  tool("get_review", "The Review queue: counters, unmatched (paged, searchable), conflicts, suspicion flags by rule, pending merge groups, splits.", { page: int, q: { type: "string", description: "search the unmatched list" } }, [], (u, a) =>
    call(u, reviewGet, { query: a })),
  tool("list_accounts", "Connected banks and their accounts: balance, currency, transaction count, and whether the bank needs the owner to sign in again.", {}, [], async (u) =>
    (
      await prisma.plaidItem.findMany({
        where: { userId: u.id },
        include: { institution: true, accounts: { include: { _count: { select: { transactions: true } } } } },
        orderBy: { createdAt: "asc" },
      })
    ).map((i) => ({
      institution: i.institution.name,
      lastUpdated: i.lastUpdated,
      loginRequired: !!i.loginRequiredAt,
      disconnected: !!i.disconnectedAt,
      accounts: i.accounts.map((x) => ({ accountId: x.accountId, name: x.name, current: x.current == null ? null : Number(x.current), currency: x.isoCurrencyCode, transactions: x._count.transactions })),
    }))),
  tool("list_transactions", "One account's (or one vendor's) transactions, newest first, paged, each with its resolved vendor and category. Give account_id or vendor_id.", { account_id: str, vendor_id: str, page: int }, [], (u, a) =>
    call(u, accountTxnsGet, { query: a })),
  tool("get_transaction", "One transaction in full: raw Plaid fields, vendor, resolved category, override and its reason.", { transaction_id: str }, ["transaction_id"], (u, a) =>
    call(u, txnGet, { params: { id: a.transaction_id } })),
  tool("list_vendors", "The owner's vendors (priority order) with their match conditions and category rules. Without page: all of them.", { page: int, q: str, category: str }, [], (u, a) =>
    call(u, vendorsGet, { query: a })),
  tool("list_categories", "The owner's categories with budgets.", {}, [], (u) => call(u, categoriesGet)),
  tool("vendor_refs", "Values vendor conditions can use: account ids and the Plaid primary/detailed/confidence values seen in the owner's transactions.", {}, [], (u) => call(u, refsGet)),
  tool("list_merge_groups", "Confirmed merge groups (several transactions counted as one).", {}, [], (u) => call(u, mergeGet)),
  tool("search_catalog", "Community-shared vendor rules, to adopt instead of writing one.", { q: str, user_id: str }, [], (u, a) =>
    call(u, catalogGet, { query: { q: a.q, userId: a.user_id } })),
  tool("get_dashboard", "Dashboard numbers: spend trend, budgets and top vendors for a month (default: this month).", { month: { type: "string", description: "YYYY-MM" } }, [], (u, a) =>
    call(u, dashboardGet, { query: a })),

  // --- Review page ------------------------------------------------------------
  tool("run_analysis", "Re-run the analyzer (auto-match, re-match, suspicion rules) — Review's Analysis button.", {}, [], (u) => call(u, analyzePost, { body: {} })),
  tool("mark_valid", "Mark suspicion flags valid (dismissed for good). Not for unmatched_transfer, unmatched or conflict items.", { flag_ids: list("flagId values from get_review") }, ["flag_ids"], async (u, a) => {
    const ids: string[] = a.flag_ids.map(String);
    // Review offers no Mark valid on an unmatched transfer (it needs a category); the route itself would allow it.
    if (await prisma.transactionFlag.count({ where: { id: { in: ids }, userId: u.id, rule: RULES.unmatchedTransfer } }))
      throw new Error("unmatched_transfer flags can't be marked valid: use set_transfer_category");
    for (const id of ids) await call(u, dismissPost, { params: { id }, body: {} });
    return { ok: true, dismissed: ids.length };
  }),
  tool("set_transfer_category", "Resolve an unmatched_transfer flag by giving its transaction a category, with the reason (Review's Set category).", { transaction_id: str, category: str, reason: str }, ["transaction_id", "category", "reason"], async (u, a) => {
    // The only transaction edit Review offers: scoped to an open unmatched_transfer flag.
    const flag = await prisma.transactionFlag.findFirst({ where: { userId: u.id, rule: RULES.unmatchedTransfer, transactionId: a.transaction_id, status: "open" } });
    if (!flag) throw new Error("no open unmatched_transfer flag on that transaction (only those can be given a category here)");
    if (!a.category.trim() || !a.reason.trim()) throw new Error("category and reason are required");
    return call(u, txnPatch, { params: { id: a.transaction_id }, body: { categoryName: a.category, reason: a.reason } });
  }),
  tool("merge_transactions", "Merge 2+ posted, same-currency transactions into one item (Review's Merge), optionally titled.", { transaction_ids: list("transaction ids"), title: str }, ["transaction_ids"], async (u, a) => {
    const r = await call(u, mergePost, { body: { transactionIds: a.transaction_ids } });
    if (a.title?.trim()) await call(u, mergeTitlePatch, { params: { id: r.group.id }, body: { title: a.title } });
    return r;
  }),
  tool("confirm_merge_group", "Confirm an auto-detected (pending) merge group.", { group_id: str }, ["group_id"], (u, a) =>
    call(u, mergeConfirmPost, { params: { id: a.group_id }, body: {} })),
  tool("dissolve_merge_group", "Dissolve an auto-detected (pending) merge group back into its transactions.", { group_id: str }, ["group_id"], async (u, a) => {
    // Review dissolves only pending groups; confirmed ones are managed in Customizations.
    const g = await prisma.mergeGroup.findFirst({ where: { id: a.group_id, userId: u.id } });
    if (g?.status !== "auto") throw new Error("only a pending (auto-detected) merge group can be dissolved here");
    return call(u, mergeDissolvePost, { params: { id: a.group_id }, body: {} });
  }),
  tool("split_transaction", "Split one posted transaction into 2+ parts (Review's Split). Parts sum exactly to the transaction's amount, same sign.", { transaction_id: str, parts: list("[{amount, label?, categoryName?}]") }, ["transaction_id", "parts"], (u, a) =>
    call(u, splitPost, { body: { parentTransactionId: a.transaction_id, parts: a.parts } })),
  tool("unsplit_transaction", "Undo a split (Review's Unsplit).", { transaction_id: str }, ["transaction_id"], (u, a) =>
    call(u, splitDelete, { body: { parentTransactionId: a.transaction_id } })),

  // --- Vendors page (Review's create / add-to-vendor use the same calls) --------
  tool("create_vendor", "Create a vendor. It claims every transaction its match conditions match.", { name: str, link: str, iconLink: str, categoryName: { type: "string", description: "default category" }, matchConditions: list(conditions), categoryRules: list(`${conditions}, plus categoryName (the category it sets)`) }, ["name", "matchConditions"], async (u, a) =>
    call(u, vendorsPost, { body: a })),
  tool("update_vendor", "Edit a vendor. Fields you leave out keep their value. matchConditions/categoryRules REPLACE the vendor's rows; to add a row, use addMatchConditions.", { id: str, name: str, link: str, iconLink: str, categoryName: str, matchConditions: list(conditions), addMatchConditions: list("rows appended to the current match conditions"), categoryRules: list("category rule rows") }, ["id"], async (u, a) => {
    const cur = ((await call(u, vendorsGet)).vendors as any[]).find((v) => v.id === a.id);
    if (!cur) throw new Error("no such vendor (ids come from list_vendors)");
    const pick = (k: string) => (a[k] !== undefined ? a[k] : cur[k]);
    return call(u, vendorsPatch, {
      body: {
        id: a.id,
        name: pick("name"),
        link: pick("link"),
        iconLink: pick("iconLink"),
        categoryName: pick("categoryName"),
        matchConditions: [...pick("matchConditions"), ...(a.addMatchConditions ?? [])],
        categoryRules: pick("categoryRules"),
      },
    });
  }),
  tool("delete_vendor", "Delete a vendor; its transactions go back to unmatched.", { id: str }, ["id"], (u, a) => call(u, vendorsDelete, { body: { id: a.id } })),
  tool("reorder_vendors", "Set vendor priority: every vendor id that has a priority, highest first (list_vendors order).", { order: list("vendor ids") }, ["order"], (u, a) =>
    call(u, reorderPost, { body: { order: a.order } })),
  tool("vendor_sharing", "share/unshare a vendor in the community catalog, resync a linked one from its source, or detach it into an editable copy.", { id: str, action: { type: "string", enum: ["share", "unshare", "resync", "detach"] } }, ["id", "action"], (u, a) =>
    call(u, sharingPost, { body: a })),
  tool("adopt_catalog_vendor", "Adopt a catalog vendor rule: clone = editable copy, link = snapshot that can resync.", { vendor_id: str, mode: { type: "string", enum: ["clone", "link"] } }, ["vendor_id"], (u, a) =>
    call(u, instantiatePost, { body: { vendorId: a.vendor_id, mode: a.mode } })),
];

// Hold a call to its inputSchema (agy sometimes guesses args without reading it — media 6ff3ad8).
function badArgs(t: Tool, a: unknown) {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return `${t.name}: arguments must be an object`;
  const { properties, required = [] } = t.inputSchema;
  const args = a as Record<string, unknown>;
  const bad = [
    ...required.filter((k) => args[k] == null).map((k) => `missing ${k}`),
    ...Object.entries(args).flatMap(([k, v]) => {
      const p = properties[k];
      if (!p) return [`unknown argument ${k}`];
      if (v == null) return [];
      if (p.enum && !p.enum.includes(v)) return [`${k} must be one of ${p.enum.join(", ")}`];
      const ok = ({ integer: Number.isInteger(v), string: typeof v === "string", array: Array.isArray(v) } as Record<string, boolean>)[p.type];
      return ok === false ? [`${k} must be ${p.type === "array" || p.type === "integer" ? "an" : "a"} ${p.type}`] : [];
    }),
  ];
  return bad.length ? `${t.name}: ${bad.join("; ")}` : null;
}

// The Agent page's history: one row per call, 7 days. Pruned on every call (no cron).
// ponytail: rows outlive 7 days only while NO user's agent calls anything; add a sweep if that matters.
// Never throws: a write tool already ran, and a failed answer would make the agent retry it.
async function logCall(userId: string, tool: string, args: unknown, error: string | null) {
  try {
    await prisma.mcpCall.create({ data: { userId, tool, args: JSON.stringify(args).slice(0, 2000), error: error?.slice(0, 500) ?? null } });
    await prisma.mcpCall.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - MCP_HISTORY_MS) } } });
  } catch (e) {
    console.error("mcp call log", e);
  }
}

const rpc = (id: unknown, body: object, status = 200) => Response.json({ jsonrpc: "2.0", id: id ?? null, ...body }, { status });

/** One JSON-RPC message in, one answer out. */
export async function handle(req: Request): Promise<Response> {
  const user = await mcpTokenUser(req.headers.get("authorization"));
  if (!user?.emailVerified)
    return rpc(null, { error: { code: -32001, message: "unauthorized: create a token on PBudget's Agent page (/agent)" } }, 401);
  let m: any;
  try {
    m = await req.json();
  } catch {
    return rpc(null, { error: { code: -32700, message: "parse error" } }, 400);
  }
  if (m?.id === undefined) return new Response(null, { status: 202 }); // a notification (initialized, cancelled)
  const result = (r: object) => rpc(m.id, { result: r });
  switch (m.method) {
    case "initialize":
      // ponytail: echoes the client's version; stateless JSON answers read the same in every one so far
      return result({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pbudget.ppvnx.com", version: "1.0.0" }, instructions: INSTRUCTIONS });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return rpc(m.id, { error: { code: -32602, message: `unknown tool: ${m.params?.name}` } });
      const args = m.params.arguments ?? {};
      let text = badArgs(t, args);
      let isError = !!text;
      if (!text) {
        try {
          text = JSON.stringify(await t.run(user, args));
        } catch (e: any) {
          console.error(e);
          text = e?.message ?? String(e);
          isError = true;
        }
      }
      await logCall(user.id, t.name, args, isError ? text : null);
      return result({ content: [{ type: "text", text }], ...(isError && { isError: true }) });
    }
    default:
      return rpc(m.id, { error: { code: -32601, message: `method not found: ${m.method}` } });
  }
}
