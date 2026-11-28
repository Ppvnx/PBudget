"use client";
import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PlaidOpener from "./PlaidOpener";
import { VendorIcon } from "./VendorIcon";
import TransactionBrowser from "./TransactionBrowser";
import ScreenshotPanel from "./ScreenshotPanel";
import { jobsChanged } from "./JobsPanel";
import { useT } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n";
import type { UpgradeCTA } from "@/lib/stripe";

type AccountLite = {
  accountId: string;
  name: string;
  current: number | null;
  currency: string | null;
  transactionCount: number;
};
type ItemLite = {
  itemId: string;
  institutionName: string;
  institutionLogo: string | null;
  lastUpdated: string;
  syncAllowed: boolean;
  disconnected: boolean; // not connected to Plaid: disconnected by the user or on billing expiry (data preserved)
  loginRequired: boolean; // Plaid says the bank needs the user to sign in again
  accounts: AccountLite[];
};
type Connect = { canAdd: boolean; cta: UpgradeCTA | null };

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function InstitutionLogo({ logo, name }: { logo: string | null; name: string }) {
  if (logo) {
    const src = logo.startsWith("http") || logo.startsWith("data:") ? logo : `data:image/png;base64,${logo}`;
    return <img src={src} alt="" width={28} height={28} style={{ borderRadius: 6, objectFit: "contain" }} />;
  }
  return <VendorIcon name={name} size={28} />;
}

export default function Accounts({
  items,
  connect,
  plan,
  limit,
  locale,
  screenshots,
}: {
  items: ItemLite[];
  connect: Connect;
  plan: string;
  limit: number;
  locale: Locale;
  screenshots: boolean; // may add screenshots (lib/screenshots.ts screenshotsAllowed)
}) {
  const router = useRouter();
  const t = useT();
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [reauth, setReauth] = useState<{ itemId: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openAccount, setOpenAccount] = useState<{ id: string; view: "browse" | "shots" } | null>(null);
  const [note, setNote] = useState("");
  // A limit hit surfaced from a live 402 (defensive — the server pre-computes the
  // CTA, so the button is already replaced when at the limit).
  const [limitHit, setLimitHit] = useState<UpgradeCTA | null>(connect.cta);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const startConnect = () =>
    run(async () => {
      const res = await fetch("/api/plaid/link-token", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 402) return setLimitHit(data as UpgradeCTA);
      if (!res.ok) throw new Error(data.error || "Request failed");
      setConnectToken(data.link_token);
    });

  const startReauth = (itemId: string) =>
    run(async () => {
      const { link_token } = await postJson("/api/plaid/link-token-update", { item_id: itemId });
      setReauth({ itemId, token: link_token });
    });

  // Sync is a background job (lib/jobs.ts): the request only queues it, and the jobs
  // panel shows its progress, result or Plaid error while the page stays usable.
  const sync = (itemId: string) =>
    run(async () => {
      await postJson("/api/plaid/item/sync", { item_id: itemId });
      jobsChanged();
    });

  // Permanently delete a connection + its data (revokes the item at Plaid). Confirm
  // outside run() so busy doesn't flash while the prompt is open.
  const remove = (itemId: string, name: string) => {
    if (!window.confirm(t("accounts.removeConfirm", { name }))) return;
    run(async () => {
      setNote("");
      await postJson("/api/plaid/item/remove", { item_id: itemId });
      router.refresh();
      setNote(t("accounts.removeDone", { name }));
    });
  };

  // Disconnect from Plaid: the item is removed at Plaid (its data there deleted); every
  // account + transaction stays here, and screenshots still add to them.
  const disconnect = (itemId: string, name: string) => {
    if (!window.confirm(t("accounts.disconnectConfirm", { name }))) return;
    run(async () => {
      setNote("");
      await postJson("/api/plaid/item/disconnect", { item_id: itemId });
      router.refresh();
      setNote(t("accounts.disconnectDone", { name }));
    });
  };

  // Full vendor re-match across every transaction. Vendor edits only touch the
  // edited vendor's + unmatched txns (fast); this re-resolves everything.
  const rematchAll = () =>
    run(async () => {
      setNote("");
      await postJson("/api/vendors/rematch", {});
      jobsChanged(); // a job: the panel says when it's done
    });

  const cta = limitHit && (
    <div className="banner">
      <strong>{t("accounts.limitTitle")}</strong>{" "}
      {t("accounts.limitBody", { used: limitHit.used, limit: limitHit.limit, plan: limitHit.plan })}
      <div style={{ marginTop: 10 }}>
        <Link className="btn btn-primary" href="/customizations">
          {t("accounts.upgrade")}
        </Link>
      </div>
    </div>
  );

  return (
    <div className="mobile-cards">
      <h1>{t("accounts.title")}</h1>
      <p className="muted">{t("accounts.subtitle")}</p>

      <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 12 }}>
        <button className="btn btn-sm" disabled={busy} onClick={rematchAll}>
          {t("accounts.rematchAll")}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>{t("accounts.rematchHint")}</span>
      </div>

      {error && <div className="error">{error}</div>}
      {note && (
        <div className="banner row" style={{ justifyContent: "space-between" }}>
          <span>{note}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setNote("")}>✕</button>
        </div>
      )}
      {cta}

      {items.length === 0 && <p className="muted">{t("accounts.noBanks")}</p>}

      {items.map((it) => (
        <div className="card" key={it.itemId}>
          <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <div className="row" style={{ gap: 10 }}>
              <InstitutionLogo logo={it.institutionLogo} name={it.institutionName} />
              <div>
                <div className="card-header" style={{ margin: 0 }}>{it.institutionName}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t("accounts.lastUpdated")} {new Date(it.lastUpdated).toLocaleString()}
                </div>
              </div>
            </div>
            <div className="row wrap">
              <button
                className="btn btn-sm"
                disabled={busy || !it.syncAllowed}
                title={it.syncAllowed ? undefined : it.disconnected ? t("accounts.removed") : t("accounts.syncBlocked", { limit })}
                onClick={() => sync(it.itemId)}
              >
                {t("accounts.sync")}
              </button>
              {!it.disconnected && (
                <button className="btn btn-sm" disabled={busy} onClick={() => startReauth(it.itemId)}>
                  {t("accounts.reauth")}
                </button>
              )}
              {!it.disconnected && (
                <button className="btn btn-sm" disabled={busy} onClick={() => disconnect(it.itemId, it.institutionName)}>
                  {t("accounts.disconnect")}
                </button>
              )}
              <button
                className="btn btn-sm btn-ghost"
                style={{ color: "var(--danger)" }}
                disabled={busy}
                onClick={() => remove(it.itemId, it.institutionName)}
              >
                {t("accounts.remove")}
              </button>
            </div>
          </div>

          {it.disconnected ? (
            <p style={{ marginTop: 0, color: "var(--danger)" }}>
              ⚠ {t("accounts.removed")}{" "}
              <Link href="/customizations">{t("accounts.upgrade")}</Link>
            </p>
          ) : it.loginRequired ? (
            <p style={{ marginTop: 0, color: "var(--danger)" }}>
              ⚠ {t("accounts.loginRequired")}
            </p>
          ) : !it.syncAllowed ? (
            <p style={{ marginTop: 0, color: "var(--danger)" }}>
              ⚠ {t("accounts.syncBlocked", { limit })}{" "}
              <Link href="/customizations">{t("accounts.upgrade")}</Link>
            </p>
          ) : null}

          {/* table-layout:fixed so an expanded TransactionBrowser (wide 9-col table
              in a colSpan cell) can't stretch this table past the card — it scrolls
              within its own overflow-x instead of being clipped by .card overflow:hidden. */}
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ width: "42%" }}>{t("accounts.colAccount")}</th>
                <th style={{ width: "24%" }}>{t("accounts.colCurrent")}</th>
                <th style={{ width: "18%" }}>{t("accounts.colTxns")}</th>
                <th style={{ width: "16%" }}></th>
              </tr>
            </thead>
            <tbody>
              {it.accounts.map((a) => {
                const view = openAccount?.id === a.accountId ? openAccount.view : null;
                const toggle = (v: "browse" | "shots") => setOpenAccount(view === v ? null : { id: a.accountId, view: v });
                return (
                  <Fragment key={a.accountId}>
                    <tr>
                      <td>{a.name}</td>
                      <td>{a.current == null ? "" : `${a.currency ?? ""} ${a.current.toFixed(2)}`.trim()}</td>
                      <td>{a.transactionCount}</td>
                      <td style={{ textAlign: "right" }}>
                        <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
                          <button className="btn btn-sm" onClick={() => toggle("browse")}>
                            {view === "browse" ? t("accounts.hide") : t("accounts.browse")}
                          </button>
                          {/* Screenshots only fill accounts Plaid no longer syncs: on a live one
                              they'd duplicate the synced rows. */}
                          {screenshots && it.disconnected && (
                            <button className="btn btn-sm" onClick={() => toggle("shots")}>
                              {view === "shots" ? t("accounts.hide") : t("accounts.screenshots")}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {view && (
                      <tr>
                        <td colSpan={4} style={{ background: "var(--bg)" }}>
                          {view === "browse" ? (
                            <TransactionBrowser accountId={a.accountId} locale={locale} />
                          ) : (
                            <ScreenshotPanel accountId={a.accountId} currency={a.currency} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <button
        className="btn btn-primary"
        onClick={connect.canAdd && !limitHit ? startConnect : () => setLimitHit(connect.cta ?? limitHit)}
        disabled={busy}
      >
        {t("accounts.connect")}
      </button>

      {connectToken && (
        <PlaidOpener
          token={connectToken}
          onExit={() => setConnectToken(null)}
          onSuccess={(publicToken) =>
            run(async () => {
              setConnectToken(null);
              // queues the first sync; the bank appears when it ends (the panel refreshes)
              await postJson("/api/plaid/item/update", { public_token: publicToken });
              jobsChanged();
            })
          }
        />
      )}

      {reauth && (
        <PlaidOpener
          token={reauth.token}
          onExit={() => setReauth(null)}
          onSuccess={() => {
            // Same path as the Sync button: the post-reauth sync shows in the jobs panel.
            const itemId = reauth.itemId;
            setReauth(null);
            sync(itemId);
          }}
        />
      )}
    </div>
  );
}
