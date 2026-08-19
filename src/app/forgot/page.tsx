"use client";
import { useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/context";
import PasswordInput from "@/components/PasswordInput";

// One screen, two steps: ask for the email, then take the emailed 6-digit code and the
// new password. Deliberately never navigates away — a magic link would open in the mail
// client's own browser (a different session) and, inside the native shell, leave the app.
export default function ForgotPage() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"email" | "code" | "done">("email");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await fetch("/api/auth/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(false);
    setStep("code"); // always the same next screen — no account enumeration
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code, password }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || t("common.genericError"));
      return;
    }
    setStep("done");
  };

  if (step === "done") {
    return (
      <div className="auth card">
        <h1>{t("reset.doneTitle")}</h1>
        <p className="muted">{t("reset.doneBody")}</p>
        <Link className="btn btn-primary" style={{ marginTop: 16 }} href="/login">
          {t("nav.login")}
        </Link>
      </div>
    );
  }

  if (step === "code") {
    return (
      <form className="auth card" onSubmit={reset}>
        <h1>{t("forgot.sentTitle")}</h1>
        <p className="muted">{t("forgot.sentBody")}</p>
        <label htmlFor="code">{t("verify.codeLabel")}</label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          style={{ letterSpacing: "8px", fontSize: 24, textAlign: "center" }}
          required
          autoFocus
        />
        <label htmlFor="password" style={{ marginTop: 16 }}>{t("reset.newPassword")}</label>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className="error">{error}</div>}
        <button
          className="btn btn-primary"
          style={{ marginTop: 16, width: "100%" }}
          disabled={busy || code.length !== 6}
        >
          {busy ? "…" : t("reset.submit")}
        </button>
        <p className="muted" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStep("email")}>
            {t("reset.requestNew")}
          </button>
        </p>
      </form>
    );
  }

  return (
    <form className="auth card" onSubmit={send}>
      <h1>{t("forgot.title")}</h1>
      <p className="muted">{t("forgot.body")}</p>
      <label htmlFor="email">{t("auth.email")}</label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <button className="btn btn-primary" style={{ marginTop: 16, width: "100%" }} disabled={busy}>
        {busy ? "…" : t("forgot.submit")}
      </button>
      <p className="muted" style={{ marginTop: 16 }}>
        <Link href="/login">{t("nav.login")}</Link>
      </p>
    </form>
  );
}
