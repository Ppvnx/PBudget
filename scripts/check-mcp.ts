// The MCP's write boundary (owner, 2026-11-22): read everything, write only what the
// Review and Vendors pages offer — never connect/sync/re-auth/remove a bank, edit a
// transaction, categories, billing or the account. Pins (1) exactly which route handlers
// lib/mcp.ts can reach, (2) the tool list, (3) no token = 401. Widening any of them must
// be done here on purpose. No DB, no network. Run: npm run check:mcp
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS, handle } from "../src/lib/mcp";

const src = readFileSync("src/lib/mcp.ts", "utf8");
const reachable = Object.fromEntries(
  [...src.matchAll(/import \{([^}]+)\} from "@\/app\/api\/([^"]+)\/route"/g)].map((m) => [
    m[2],
    m[1].split(",").map((s) => s.trim().split(/\s+/)[0]).sort().join(" "),
  ])
);
assert.deepEqual(reachable, {
  review: "GET",
  "review/analyze": "POST",
  "accounts/transactions": "GET",
  "transactions/[id]": "GET PATCH", // PATCH only via set_transfer_category (open unmatched_transfer flag)
  vendors: "DELETE GET PATCH POST",
  "vendors/refs": "GET",
  "vendors/reorder": "POST",
  "vendors/sharing": "POST",
  categories: "GET",
  merge: "GET POST",
  "merge/[id]": "PATCH",
  "merge/[id]/confirm": "POST",
  "merge/[id]/dissolve": "POST",
  "flags/[id]/dismiss": "POST",
  splits: "DELETE POST",
  catalog: "GET",
  "catalog/instantiate": "POST",
  dashboard: "GET",
});

assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
  "adopt_catalog_vendor", "confirm_merge_group", "create_vendor", "delete_vendor", "dissolve_merge_group",
  "get_dashboard", "get_review", "get_transaction", "list_accounts", "list_categories", "list_merge_groups",
  "list_transactions", "list_vendors", "mark_valid", "merge_transactions", "reorder_vendors", "run_analysis",
  "search_catalog", "set_transfer_category", "split_transaction", "unsplit_transaction", "update_vendor",
  "vendor_refs", "vendor_sharing",
]);

(async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const authorization of [undefined, "Bearer nope", "Bearer pbm_" + "0".repeat(63)]) {
    const res = await handle(new Request("http://x/api/mcp", { method: "POST", body, headers: authorization ? { authorization } : {} }));
    assert.equal(res.status, 401, `no valid token must be refused (${authorization})`);
  }
  console.log("check:mcp OK");
})();
