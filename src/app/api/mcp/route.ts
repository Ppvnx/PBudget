// The MCP endpoint (lib/mcp.ts). POST only: a GET answered with an SSE stream that never
// starts hangs agy's connect (MemEcho, 2026-11-20); Next answers it 405.
import { handle } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle;
