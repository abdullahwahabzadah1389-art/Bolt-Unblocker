if (navigator.userAgent.includes("Firefox")) {
    Object.defineProperty(globalThis, "crossOriginIsolated", {
        value: true,
        writable: false,
    });
}


importScripts("/math/uv.bundle.js");
importScripts("/math/uv.config.js");
importScripts("/math/uv.sw.js");
importScripts("/learn/scramjet.all.js");
// InvisiProxy v8: bare-mux client backing the raw transport fallback used for
// accounts.google.com (mounted at /baremux/ by app.js and the dev server).
importScripts("/baremux/index.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const uv = new UVServiceWorker(self.__uv$config);
const scramjet = new ScramjetServiceWorker();


// ---- Cross-site cookie mirroring (OAuth popup breakout) ----------------------
// Cookies harvested from the native auth popup by src/scripts/oauth-popup.ts are
// posted here (type: "bolt:mirror-cookies"), stored in a persistent mirror jar,
// and re-attached as `Cookie` headers on matching proxied requests. This is what
// lets the proxy iframe pick up the fresh session created in the popup.
const MIRROR_CACHE = "bolt-cookie-mirror";
const MIRROR_KEY = "/__bolt-cookie-mirror__";

/** Map<domain, Map<name, value>> */
let mirroredCookies = new Map();

const mirrorReady = (async () => {
    try {
        const cache = await caches.open(MIRROR_CACHE);
        const res = await cache.match(MIRROR_KEY);
        if (res) {
            const data = await res.json();
            for (const [domain, entries] of data) {
                mirroredCookies.set(domain, new Map(entries));
            }
        }
    } catch (err) {
        console.error("Cookie mirror load failed:", err);
    }
})();

async function persistMirrors() {
    const cache = await caches.open(MIRROR_CACHE);
    const data = [...mirroredCookies].map(([domain, jar]) => [domain, [...jar]]);
    await cache.put(MIRROR_KEY, new Response(JSON.stringify(data)));
}

/**
 * Resolves the real destination URL of a proxied request
 * (`/maths/<xor>` for Ultraviolet, `/$/<encoded>` for Scramjet),
 * or null when the request is not a proxied document/subresource.
 */
function realTargetUrl(url) {
    try {
        const u = new URL(url);
        const uvPrefix = (self.__uv$config && self.__uv$config.prefix) || "/maths/";
        if (u.pathname.startsWith(uvPrefix)) {
            const enc = u.pathname.slice(uvPrefix.length) + u.search;
            try {
                return new URL(self.__uv$config.decodeUrl(enc));
            } catch (e) { /* fall through */ }
        }
        const sjPrefix = (scramjet && scramjet.config && scramjet.config.prefix) || "/$/";
        if (u.pathname.startsWith(sjPrefix)) {
            const enc = u.pathname.slice(sjPrefix.length) + u.search;
            try {
                return new URL(decodeURIComponent(enc));
            } catch (e) { /* fall through */ }
        }
    } catch (e) { /* not a parseable URL */ }
    return null;
}

/**
 * Builds a copy of `request` with the mirrored cookies for the request's
 * real target host merged into its `Cookie` header. Navigation requests
 * cannot be re-constructed from another Request, so they are rebuilt from
 * their URL + an arrayBuffer body instead.
 */
async function withMirroredCookies(request) {
    try {
        await mirrorReady;
        if (mirroredCookies.size === 0) return request;

        const target = realTargetUrl(request.url);
        if (!target) return request;
        const host = target.hostname.toLowerCase();

        const injected = [];
        for (const [domain, jar] of mirroredCookies) {
            if (host === domain || host.endsWith("." + domain)) {
                for (const [name, value] of jar) {
                    injected.push(name + "=" + value);
                }
            }
        }
        if (injected.length === 0) return request;

        const headers = new Headers(request.headers);
        const existing = headers.get("Cookie") || "";
        const already = new Set(
            existing.split(";").map((part) => part.split("=")[0].trim()).filter(Boolean),
        );
        const extra = injected.filter((pair) => !already.has(pair.split("=")[0]));
        if (extra.length === 0) return request;
        headers.set("Cookie", existing ? existing + "; " + extra.join("; ") : extra.join("; "));

        if (request.mode === "navigate" || request.method === "GET" || request.method === "HEAD") {
            let body;
            if (request.method !== "GET" && request.method !== "HEAD") {
                try {
                    body = await request.clone().arrayBuffer();
                } catch (e) {
                    body = undefined;
                }
            }
            return new Request(request.url, {
                method: request.method,
                headers,
                body,
                credentials: request.credentials,
                redirect: request.redirect,
                referrer: request.referrer,
                referrerPolicy: request.referrerPolicy,
            });
        }
        return new Request(request, { headers });
    } catch (error) {
        console.error("Cookie mirror patch failed:", error);
        return request;
    }
}

// ---- Client-side stealth injection -------------------------------------------
// public/stealth.js is inlined as the FIRST <script> of every proxied HTML
// document, before the UV/Scramjet handlers and any target-authored script.
let stealthCodePromise = null;

function getStealthCode() {
    if (!stealthCodePromise) {
        stealthCodePromise = fetch("/stealth.js")
            .then((r) => (r.ok ? r.text() : ""))
            .catch(() => "");
    }
    return stealthCodePromise;
}

async function maybeInjectStealth(request, response) {
    try {
        if (!response || !response.ok) return response;
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) return response;
        if (request.method && request.method !== "GET") return response;

        const code = await getStealthCode();
        if (!code) return response;

        const html = await response.text();
        const tag = "<script>" + code + "</script>";
        const scriptIdx = html.search(/<script[\s>]/i);
        const headIdx = html.search(/<head[^>]*>/i);
        let injected;
        if (scriptIdx !== -1) {
            // before the first script: runs ahead of UV/Scramjet handlers and
            // every target-authored script; doctype stays first
            injected = html.slice(0, scriptIdx) + tag + html.slice(scriptIdx);
        } else if (headIdx !== -1) {
            const headEnd = html.indexOf(">", headIdx) + 1;
            injected = html.slice(0, headEnd) + tag + html.slice(headEnd);
        } else {
            injected = tag + html;
        }

        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        headers.delete("content-security-policy");
        headers.delete("content-security-policy-report-only");
        return new Response(injected, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    } catch (error) {
        console.error("Stealth injection failed:", error);
        return response;
    }
}

// ---- InvisiProxy v8: raw transport for authentication endpoints -------------
// When a request resolves to accounts.google.com it is relayed as a raw stream
// over the primary bare-mux transport (LibcurlTransport, configured in
// src/scripts/proxy.ts). No Ultraviolet/Scramjet wrapper, variable override, or
// service-worker structural handler is injected into the document context —
// only the DOM-masquerading layer (public/stealth.js) applied by
// maybeInjectStealth, so runtime signatures match an unmodified browser while
// the auth traffic stays tunneled behind this origin.
const AUTH_HOST = "accounts.google.com";
let rawTransportClient = null;

function getRawTransportClient() {
    if (!rawTransportClient && self.BareMux && self.BareMux.BareClient) {
        rawTransportClient = new self.BareMux.BareClient();
    }
    return rawTransportClient || null;
}

/**
 * Resolves the true accounts.google.com target for a request, or null when the
 * request is not part of the auth flow. Covers the auth document, its absolute
 * accounts.google.com subresources, and its same-origin relative subresources
 * (the raw document is served on this origin under
 * /$/https://accounts.google.com/…, so relative URLs resolve here and are
 * re-targeted to the auth host — no document rewriting involved).
 */
function authTargetFor(request) {
    const direct = realTargetUrl(request.url);
    if (direct && direct.hostname === AUTH_HOST) return direct;
    try {
        const u = new URL(request.url);
        if (u.hostname === AUTH_HOST) return u;
    } catch (e) { /* not parseable */ }

    try {
        if (request.mode === "navigate" || !request.referrer) return null;
        const refTarget = realTargetUrl(request.referrer);
        if (!refTarget || refTarget.hostname !== AUTH_HOST) return null;
        const u = new URL(request.url);
        if (u.origin !== self.location.origin) return null;
        const uvPrefix = (self.__uv$config && self.__uv$config.prefix) || "/maths/";
        const sjPrefix = (scramjet && scramjet.config && scramjet.config.prefix) || "/$/";
        if (u.pathname.startsWith(uvPrefix) || u.pathname.startsWith(sjPrefix)) return null;
        return new URL(u.pathname + u.search, "https://" + AUTH_HOST + "/");
    } catch (e) { return null; }
}

/**
 * Aligns the relayed request with what an unmodified browser sends directly to
 * the auth host: transport-managed/hop-by-hop headers are dropped, and
 * Origin/Referer/Sec-Fetch reflect a native same-origin request to
 * accounts.google.com so the tunneled traffic matches a direct browser stack.
 */
function normalizeAuthHeaders(request, target, headers) {
    for (const h of ["host", "connection", "content-length", "accept-encoding"]) {
        headers.delete(h);
    }
    const isNav = request.mode === "navigate";
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    if (hasBody) headers.set("origin", target.origin);
    else headers.delete("origin");

    if (isNav && !hasBody) headers.delete("referer"); // fresh document load
    else headers.set("referer", target.origin + "/");

    if (isNav) {
        headers.set("sec-fetch-site", hasBody ? "same-origin" : "none");
        headers.set("sec-fetch-mode", "navigate");
        headers.set("sec-fetch-user", "?1");
        headers.set("sec-fetch-dest", "document");
        headers.set("upgrade-insecure-requests", "1");
    } else {
        headers.set("sec-fetch-site", "same-origin");
        headers.delete("sec-fetch-user");
    }
    return headers;
}

/** Relays a request to `target` as a raw transport stream (no rewriter layer). */
async function fetchViaRawTransport(request, target) {
    const client = getRawTransportClient();
    if (!client) return null;
    try {
        const patched = await withMirroredCookies(request);
        const headers = normalizeAuthHeaders(request, target, new Headers(patched.headers));
        const init = { method: patched.method, headers, redirect: "manual" };
        if (patched.method !== "GET" && patched.method !== "HEAD") {
            init.body = await patched.clone().arrayBuffer();
        }
        return await client.fetch(target.href, init);
    } catch (error) {
        console.error("Raw auth transport failed:", error);
        return null;
    }
}

async function handleRequest(event) {
    try {
        await scramjet.loadConfig().catch(err => console.error("Scramjet Config Load Failed", err));

        // InvisiProxy v8: authentication endpoints use the raw transport only —
        // never the Ultraviolet/Scramjet rewriters or their injected handlers.
        const authTarget = authTargetFor(event.request);
        if (authTarget) {
            const raw = await fetchViaRawTransport(event.request, authTarget);
            if (raw) return await maybeInjectStealth(event.request, raw);
            // transport not ready — fall through to the normal proxy path
        }

        if (uv.route(event)) {
            const patched = await withMirroredCookies(event.request);
            const ev = patched === event.request ? event : { request: patched, clientId: event.clientId };
            return await maybeInjectStealth(event.request, await uv.fetch(ev));
        }


        if (scramjet.route(event)) {
            const patched = await withMirroredCookies(event.request);
            const ev = patched === event.request ? event : { request: patched, clientId: event.clientId };
            return await maybeInjectStealth(event.request, await scramjet.fetch(ev));
        }
    } catch (error) {
        console.error("Proxy Error:", error);
    }


    return fetch(event.request);
}



self.addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event));
});

let playgroundData;
self.addEventListener("message", (event) => {
    const data = event.data || {};

    if (data.type === "playgroundData") {
        playgroundData = data;
        return;
    }

    // Cookie mirror updates from the OAuth popup interceptor
    if (data.type === "bolt:mirror-cookies") {
        const domain = String(data.domain || "").replace(/^\./, "").toLowerCase();
        const list = Array.isArray(data.cookies) ? data.cookies : [];
        if (!domain || list.length === 0) return;

        const done = (async () => {
            await mirrorReady;
            let jar = mirroredCookies.get(domain);
            if (!jar) {
                jar = new Map();
                mirroredCookies.set(domain, jar);
            }
            for (const cookie of list) {
                if (!cookie || !cookie.name) continue;
                if (cookie.delete || cookie.value === null || cookie.value === undefined) {
                    jar.delete(String(cookie.name));
                } else {
                    jar.set(String(cookie.name), String(cookie.value));
                }
            }
            await persistMirrors();
        })();
        if (event.waitUntil) event.waitUntil(done);
    }
});

scramjet.addEventListener("request", (e) => {
    if (playgroundData && e.url.href.startsWith(playgroundData.origin)) {
        const headers = {};
        const origin = playgroundData.origin;
        if (e.url.href === origin + "/") {
            headers["content-type"] = "text/html";
            e.response = new Response(playgroundData.html, { headers });
        } else if (e.url.href === origin + "/style.css") {
            headers["content-type"] = "text/css";
            e.response = new Response(playgroundData.css, { headers });
        } else if (e.url.href === origin + "/script.js") {
            headers["content-type"] = "application/javascript";
            e.response = new Response(playgroundData.js, { headers });
        } else {
            e.response = new Response("empty response", { headers });
        }
        e.response.rawHeaders = headers;
        e.response.rawResponse = {
            body: e.response.body,
            headers: headers,
            status: e.response.status,
            statusText: e.response.statusText,
        };
        e.response.finalURL = e.url.toString();
    } else {
        return;
    }
});
