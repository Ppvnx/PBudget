"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/context";

// Customizations → Agent access: the MCP token an AI agent (agent.ppvnx.com) connects
// with (lib/mcp.ts). The plaintext exists only in the POST answer, so it's shown once.
export default function AgentAccess() {
  const t = useT();
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/settings/mcp-token")
      .then((r) => r.json())
      .then((d) => setCreatedAt(d.createdAt ?? null))
      .catch(() => {});
  }, []);

  const act = async (method: "POST" | "DELETE") => {
    if (createdAt && !window.confirm(t(method === "POST" ? "cust.agent.replaceConfirm" : "cust.agent.revokeConfirm"))) return;
    setError("");
    setCopied(false);
    const res = await fetch("/api/settings/mcp-token", { method });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setError(d.error ?? t("common.genericError"));
    setToken(d.token ?? "");
    setCreatedAt(d.createdAt ?? null);
  };

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>{t("cust.agent.help")}</p>
      <div className="card">
        <div className="card-header">{t("cust.agent.url")}</div>
        <code style={{ wordBreak: "break-all" }}>{origin}/api/mcp</code>
        <p className="muted" style={{ fontSize: 12 }}>{t("cust.agent.auth")}</p>

        {token && (
          <div className="banner">
            <div>{t("cust.agent.copyNow")}</div>
            <code style={{ display: "block", wordBreak: "break-all", margin: "8px 0", userSelect: "all" }}>{token}</code>
            <button
              className="btn btn-sm"
              onClick={() => navigator.clipboard.writeText(token).then(() => setCopied(true), () => {})}
            >
              {copied ? t("cust.agent.copied") : t("cust.agent.copy")}
            </button>
          </div>
        )}

        <p>{createdAt ? t("cust.agent.created", { date: new Date(createdAt).toLocaleString() }) : t("cust.agent.none")}</p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" onClick={() => act("POST")}>
            {createdAt ? t("cust.agent.replace") : t("cust.agent.create")}
          </button>
          {createdAt && (
            <button className="btn" style={{ color: "var(--danger)" }} onClick={() => act("DELETE")}>
              {t("cust.agent.revoke")}
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
