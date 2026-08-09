"use client";
import { useEffect, useState } from "react";

// Native capability the website cannot have.
//
// PBudget ships as a thin shell around https://pbudget.ppvnx.com, and Apple 4.2.2
// rejects exactly that when the app does nothing Safari can't — HDive, same shape,
// was rejected 2026-08-06 ("does not sufficiently differ from a web browsing
// experience") with ~70 other checks green. A splash screen doesn't answer it: chrome
// is not function. The system share sheet and the Taptic Engine do — neither is
// reachable from a web page in the webview.
//
// Every entry point is a DYNAMIC import, matching AuthForm/BillingSection: the web
// build must never pull a Capacitor plugin into its bundle, and on web these all
// resolve to a no-op rather than throwing.

/**
 * Is a given native plugin actually REGISTERED in the running binary?
 *
 * "Is this a native platform" is not enough, and the difference is not theoretical here.
 * The plugin's JS ships inside the WEB bundle, so `import("@capacitor/share")` resolves
 * happily inside an OLD binary with no Share bridge compiled in — the call then fails at
 * the bridge and the button does nothing. Because PBudget is a server.url shell, the site
 * updates the instant it deploys while the binary only changes when a new build clears
 * review, so every installed copy is briefly newer in JS than in native code. Gate the UI
 * on the capability, never on the platform.
 */
export async function hasPlugin(name: "Share" | "Haptics"): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(name);
  } catch {
    return false;
  }
}

/** Render an affordance only where its plugin exists. false during SSR, on web, and on old binaries. */
export function useHasPlugin(name: "Share" | "Haptics"): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    hasPlugin(name).then((v) => alive && setOk(v));
    return () => {
      alive = false;
    };
  }, [name]);
  return ok;
}

/**
 * Taptic feedback for a state change the user drove. Deliberately swallows everything:
 * haptics are off system-wide on some devices and unsupported in the simulator, and a
 * missing buzz must never take an interaction down with it.
 */
export async function haptic(): Promise<void> {
  try {
    if (!(await hasPlugin("Haptics"))) return;
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* no haptics on this device — not worth a broken tap */
  }
}

/**
 * System share sheet. Returns false when it didn't open (web) or the user dismissed it
 * — Share.share() REJECTS on cancel, which is a normal outcome, not an error worth
 * surfacing. Callers use the boolean only to decide whether to fall back.
 */
export async function shareText(o: { title: string; text: string; dialogTitle?: string }): Promise<boolean> {
  try {
    if (!(await hasPlugin("Share"))) return false;
    const { Share } = await import("@capacitor/share");
    await Share.share(o);
    return true;
  } catch {
    return false;
  }
}
