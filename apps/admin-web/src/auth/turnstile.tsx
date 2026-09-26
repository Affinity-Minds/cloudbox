// Owner: WT-1. Cloudflare Turnstile, shown only after the API answers `challenge_required`
// (review T-1), so normal sign-ins never see it. Tokens are single use and short-lived
// (agent-notes cloudflare-workers trap 2): the parent takes one token per request and calls
// `reset` after using it; expired tokens refresh automatically.
import { useEffect, useRef } from "react";

type TurnstileApi = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"));
    script.onerror = () => {
      loading = null;
      reject(new Error("turnstile"));
    };
    document.head.append(script);
  });
  return loading;
}

export function TurnstileChallenge({
  siteKey,
  onToken,
  resetSignal,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  /** Change it to get a fresh token after the previous one was used. */
  resetSignal: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const tokenCallback = useRef(onToken);
  tokenCallback.current = onToken;

  useEffect(() => {
    let cancelled = false;
    void loadTurnstile().then((turnstile) => {
      if (cancelled || !el.current) return;
      widget.current = turnstile.render(el.current, {
        sitekey: siteKey,
        "refresh-expired": "auto",
        callback: (token: string) => tokenCallback.current(token),
        "expired-callback": () => {
          tokenCallback.current(null);
          turnstile.reset(widget.current ?? undefined);
        },
        "error-callback": () => tokenCallback.current(null),
      });
    });
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetSignal > 0 && widget.current) window.turnstile?.reset(widget.current);
  }, [resetSignal]);

  return <div ref={el} className="min-h-[65px]" />;
}
