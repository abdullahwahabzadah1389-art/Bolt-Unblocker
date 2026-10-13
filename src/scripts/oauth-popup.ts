/**
 * OAuth / Login popup interception override.
 *
 * Proxied sites (ChatGPT, Gemini, Discord, ...) bounce users to OAuth/login
 * pages on accounts.google.com, apple.com or auth0.com. Those pages break
 * inside the proxied iframe (third-party cookies, framing, bot checks), so
 * this module intercepts the navigation and instead opens the real,
 * unproxied URL in a native browser popup:
 *
 *     window.open(url, '_blank', 'width=500,height=600')
 *
 * Once the popup finishes authenticating and is closed, the proxy iframe is
 * reloaded so the target site re-requests its session and picks up the
 * freshly generated cookies.
 */
import dummyProxy from "./encoding";

/** Host fragments that mark a URL as an OAuth / login destination. */
const AUTH_MARKERS = ["accounts.google.com", "://apple.com", "auth0.com"];

/** Iframes that currently have an auth popup open. */
const pendingPopups = new WeakSet<HTMLIFrameElement>();

/** Message type the popup bridge uses to hand tokens back to the proxy tab. */
const OAUTH_TOKEN_MESSAGE = "bolt:oauth-tokens";

/** Storage snapshot captured from the popup destination before it closes. */
interface HarvestedState {
    url: string;
    cookies: string;
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
}

/**
 * Converts a possibly proxied URL (`/$/...` for Scramjet, `/maths/...` for
 * Ultraviolet) back into the real destination URL. Plain URLs pass through.
 */
export function toRealUrl(url: string): string {
    if (!url) return url;
    try {
        if (dummyProxy.isProxiedUrl(url)) {
            return dummyProxy.decodeProxiedUrl(url);
        }
    } catch {
        // fall through and return the original
    }
    return url;
}

/**
 * Returns true when the URL (real or proxied-encoded) points at an OAuth /
 * login provider: accounts.google.com, ://apple.com or auth0.com.
 */
export function isAuthUrl(url: string): boolean {
    if (!url) return false;
    let real: string;
    try {
        real = toRealUrl(url);
    } catch {
        real = url;
    }
    const lower = real.toLowerCase();
    return AUTH_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Encodes a real destination URL through the active proxy engine so the
 * popup loads in a proxied context under the application's own domain.
 *
 * Ultraviolet: uses the standard UV encoding format
 *   `__uv$config.prefix + __uv$config.encodeUrl(url)`
 * when the UV config is loaded, otherwise the app's identical xor encoder.
 * Scramjet: wraps the URL with the Scramjet controller's own encodeUrl.
 */
function encodePopupUrl(realUrl: string): string {
    try {
        const engine = dummyProxy.getProxyEngine();

        if (engine === "ultraviolet") {
            const uv = (window as any).__uv$config;
            if (uv && typeof uv.encodeUrl === "function") {
                return String(uv.prefix ?? "/maths/") + uv.encodeUrl(realUrl);
            }
            return dummyProxy.encodeUrl(realUrl);
        }

        // Scramjet: same controller factory the app's proxy pipeline uses
        const load = (window as any).$scramjetLoadController;
        if (typeof load === "function") {
            const loaded = load() as { ScramjetController?: new (cfg: unknown) => { encodeUrl(u: string): string } };
            if (typeof loaded?.ScramjetController === "function") {
                const instance = new loaded.ScramjetController({
                    files: {
                        wasm: "/learn/scramjet.wasm.wasm",
                        all: "/learn/scramjet.all.js",
                        sync: "/learn/scramjet.sync.js",
                    },
                    prefix: "/$/",
                });
                return instance.encodeUrl(realUrl);
            }
        }
    } catch {
        // fall through to the app's engine-aware encoder
    }
    return dummyProxy.encodeUrl(realUrl);
}

/**
 * Opens the auth URL in a popup window, encoded through the active proxy
 * engine so its traffic is proxied under the application domain:
 *   window.open(encodedUrl, "_blank", "width=500,height=600")
 * Returns the popup Window, or null if the browser blocked it.
 */
export function openAuthPopup(url: string): Window | null {
    const real = toRealUrl(url);
    return window.open(encodePopupUrl(real), "_blank", "width=500,height=600");
}

/**
 * Polls the popup until the user closes it, then fires onClosed.
 * Each tick also calls onTick (used to harvest cookies/tokens while the
 * popup is still open). Cross-origin popups don't emit close events, so
 * polling is required.
 */
export function watchPopupClose(
    popup: Window,
    onClosed: () => void,
    onTick?: (popup: Window) => void,
): void {
    const timer = window.setInterval(() => {
        try {
            if (popup.closed) {
                window.clearInterval(timer);
                onClosed();
                return;
            }
            onTick?.(popup);
        } catch {
            window.clearInterval(timer);
            onClosed();
        }
    }, 500);
}

// ---- Cookie / token mirroring ------------------------------------------------

function collectStorage(storage: Storage): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key !== null) out[key] = storage.getItem(key) ?? "";
        }
    } catch {
 // storage inaccessible
    }
    return out;
}

/**
 * Best-effort read of the popup's cookies + storage. Only works once the
 * popup has navigated back onto our (same-origin) proxy origin, e.g. the
 * OAuth callback routed through the proxy. Native cross-origin popups
 * (real accounts.google.com) throw and are skipped.
 */
function tryHarvestPopup(popup: Window): HarvestedState | null {
    try {
        const doc = popup.document; // throws when cross-origin
        const href = popup.location.href;
        if (!href || href.startsWith("about:") || href.startsWith("data:")) return null;
        return {
            url: href,
            cookies: doc.cookie || "",
            localStorage: collectStorage(popup.localStorage),
            sessionStorage: collectStorage(popup.sessionStorage),
        };
    } catch {
        return null; // still cross-origin (native login page)
    }
}

/**
 * Injects a tiny bridge into the popup (once it is same-origin) that posts
 * its cookies + storage tokens back to this window via window.postMessage()
 * on every relevant lifecycle event, so nothing is lost when it closes.
 */
function installPopupBridge(popup: Window): void {
    try {
        const doc = popup.document; // throws when cross-origin
        if (doc.getElementById("bolt-oauth-bridge")) return;
        const origin = location.origin;
        const script = doc.createElement("script");
        script.id = "bolt-oauth-bridge";
        script.textContent =
            "(function(){" +
            "function collect(s){var o={};try{for(var i=0;i<s.length;i++){var k=s.key(i);o[k]=s.getItem(k);}}catch(e){}return o;}" +
            "function post(){try{if(!window.opener)return;window.opener.postMessage({type:" +
            JSON.stringify(OAUTH_TOKEN_MESSAGE) +
            ",url:location.href,cookies:document.cookie||\"\",localStorage:collect(window.localStorage),sessionStorage:collect(window.sessionStorage)}," +
            JSON.stringify(origin) + ");}catch(e){}}" +
            "post();" +
            "window.addEventListener(\"pagehide\",post);" +
            "window.addEventListener(\"beforeunload\",post);" +
            "})()";
        (doc.head || doc.documentElement).appendChild(script);
    } catch {
        // still cross-origin; the bridge installs once the popup returns to
        // our origin via the OAuth callback redirect
    }
}

/**
 * Mirrors a harvested cookie/token snapshot into the proxy's sandbox:
 *  - cookies go to the service worker mirror jar (public/sw.js), which
 *    re-attaches them as `Cookie` headers on matching proxied requests;
 *  - the localStorage/sessionStorage snapshot is stored per target host in
 *    this (top-window) storage so the proxy tab can restore it after reload.
 */
function deliverHarvest(state: HarvestedState): void {
    try {
        let domain = "";
        if (state.url) {
            try {
                domain = new URL(toRealUrl(state.url)).hostname.toLowerCase();
            } catch {
                domain = "";
            }
        }
        if (!domain) return;

        const cookies = state.cookies
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const eq = part.indexOf("=");
                if (eq < 0) return null;
                return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
            })
            .filter((c): c is { name: string; value: string } => c !== null && c.name !== "");

        if (cookies.length > 0) {
            const message = { type: "bolt:mirror-cookies", domain, cookies };
            const controller = navigator.serviceWorker?.controller;
            if (controller) {
                controller.postMessage(message);
            } else {
                navigator.serviceWorker?.ready.then((reg) => reg.active?.postMessage(message));
            }
        }

        const snapshot = {
            savedAt: Date.now(),
            url: state.url,
            cookies: state.cookies,
            localStorage: state.localStorage,
            sessionStorage: state.sessionStorage,
        };
        try {
            localStorage.setItem("bolt-oauth-tokens:" + domain, JSON.stringify(snapshot));
        } catch {
            // storage full or unavailable — mirroring already happened above
        }
    } catch (err) {
        console.error("OAuth token delivery failed:", err);
    }
}

/** Points the iframe back at a safe (non-auth) URL. */
function restoreIframe(iframe: HTMLIFrameElement, restoreUrl: string): void {
    if (!restoreUrl) return;
    const src = restoreUrl.startsWith("bolt://")
        ? "/" + restoreUrl.slice("bolt://".length)
        : restoreUrl;
    try {
        const absolute = new URL(src, window.location.href).href;
        if (iframe.src !== absolute) {
            iframe.src = src;
        }
    } catch {
        iframe.src = src;
    }
}

/** Reloads the proxy iframe so the site re-checks its session cookies. */
function reloadIframe(iframe: HTMLIFrameElement): void {
    try {
        iframe.contentWindow?.location.reload();
    } catch {
        iframe.src = iframe.src;
    }
}

/**
 * Core interception: the iframe landed on (or is navigating to) an auth URL.
 * Opens the native popup, bounces the iframe back to `restoreUrl`, and
 * reloads the iframe once the popup is closed.
 *
 * Returns false when the popup was blocked, so the caller can fall back to
 * loading the page inside the iframe as before.
 */
export function interceptAuthNavigation(
    iframe: HTMLIFrameElement,
    currentUrl: string,
    restoreUrl: string,
): boolean {
    // Already authenticating in a popup for this tab: just bounce back.
    if (pendingPopups.has(iframe)) {
        restoreIframe(iframe, restoreUrl);
        return true;
    }

    const popup = openAuthPopup(currentUrl);
    if (!popup) return false; // popup blocked — let the caller continue normally

    pendingPopups.add(iframe);
    restoreIframe(iframe, restoreUrl);

    // Hand tokens back from the popup to this (proxy) window via postMessage
    const onTokenMessage = (event: MessageEvent) => {
        if (event.source !== popup) return;
        const data = event.data as Partial<HarvestedState> & { type?: string };
        if (!data || data.type !== OAUTH_TOKEN_MESSAGE) return;
        deliverHarvest({
            url: String(data.url ?? ""),
            cookies: String(data.cookies ?? ""),
            localStorage: data.localStorage ?? {},
            sessionStorage: data.sessionStorage ?? {},
        });
    };
    window.addEventListener("message", onTokenMessage);

    watchPopupClose(
        popup,
        () => {
            // Final harvest in case the last bridge post raced the close
            const last = tryHarvestPopup(popup);
            if (last) deliverHarvest(last);

            // Keep listening briefly so late teardown messages still land
            window.setTimeout(() => window.removeEventListener("message", onTokenMessage), 3000);

            pendingPopups.delete(iframe);
            // Reload the proxy iframe: the service worker intercepts this
            // navigation and injects the mirrored cookies, so the site sees
            // the session created in the popup.
            reloadIframe(iframe);
        },
        (p) => {
            installPopupBridge(p);
            const harvested = tryHarvestPopup(p);
            if (harvested) deliverHarvest(harvested);
        },
    );

    return true;
}

/**
 * Installs in-page interception inside a proxy iframe: anchor clicks and form
 * submissions that target an auth URL are diverted to the native popup before
 * the proxied navigation ever starts. Re-run on every iframe load (each load
 * creates a fresh document).
 */
export function installIframeAuthHooks(iframe: HTMLIFrameElement): void {
    iframe.addEventListener("load", () => {
        try {
            const win = iframe.contentWindow;
            const doc = win?.document;
            if (!win || !doc) return;

            doc.addEventListener(
                "click",
                (e) => {
                    const anchor = (e.target as HTMLElement | null)?.closest?.(
                        "a[href]",
                    ) as HTMLAnchorElement | null;
                    if (!anchor || !isAuthUrl(anchor.href)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (!openAuthPopup(anchor.href)) {
                        // Popup blocked — fall through to the proxied navigation.
                        win.location.href = anchor.href;
                    }
                },
                true,
            );

            doc.addEventListener(
                "submit",
                (e) => {
                    const form = e.target as HTMLFormElement;
                    if (!form?.action || !isAuthUrl(form.action)) return;
                    e.preventDefault();
                    if (!openAuthPopup(form.action)) {
                        // Popup blocked — submit natively through the proxy.
                        HTMLFormElement.prototype.submit.call(form);
                    }
                },
                true,
            );
        } catch {
            /* inaccessible (cross-origin) document — the onload URL check in
               browser.ts still covers navigations that get that far */
        }
    });
}
