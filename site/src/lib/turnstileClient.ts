/**
 * Cloudflare Turnstile in the browser, loaded once per page whichever form asks first (the
 * ratings form, the suggestion box, /submit's own tag): loading its script twice makes it warn and
 * can misbehave. Resolves to undefined if the script fails to load.
 */
export type Turnstile = {
  render: (el: HTMLElement, o: { sitekey: string; size?: string }) => string | undefined;
  getResponse: (id?: string) => string | undefined;
  reset: (id?: string) => void;
};

const API = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const now = () => (window as unknown as { turnstile?: Turnstile }).turnstile;
let loading: Promise<Turnstile | undefined> | undefined;

export function loadTurnstile(): Promise<Turnstile | undefined> {
  const t = now();
  if (t) return Promise.resolve(t);
  loading ??= new Promise((done) => {
    const old = document.querySelector<HTMLScriptElement>(`script[src^="${API}"]`);
    const s = old ?? document.createElement("script");
    s.addEventListener("load", () => done(now()));
    s.addEventListener("error", () => done(undefined));
    if (!old) {
      s.src = `${API}?render=explicit`;
      s.async = true;
      document.head.append(s);
    }
  });
  return loading;
}
