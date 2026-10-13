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

/**
 * Window clients belonging to the main application (tagged via the
 * `bolt:tag-client` message from src/scripts/proxy.ts). OAuth popups spawned
 * by the interceptor never run app scripts, so they are NOT tagged and their
 * accounts.google.com navigations stay fully proxied.
 */
const taggedClients = new Set();

async function handleRequest(event) {
    try {
        await scramjet.loadConfig().catch(err => console.error("Scramjet Config Load Failed", err));

        // Main-app clients load accounts.google.com natively: no
        // Ultraviolet/Scramjet interception and no injected hooks. Requests
        // from untagged clients (e.g. the proxied auth popup) stay proxied.
        if (event.request.mode === "navigate" && taggedClients.has(event.clientId)) {
            const navTarget = realTargetUrl(event.request.url);
            if (navTarget && navTarget.hostname === "accounts.google.com") {
                return Response.redirect(navTarget.href, 302);
            }
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

self.addEventListener("activate", (event) => {
    // Client ids are lost when this worker restarts: ask every window client
    // to re-tag itself so the accounts.google.com native-load gate keeps
    // working without ever tagging auth popups.
    const retag = self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((cs) => {
            for (const client of cs) client.postMessage({ type: "bolt:request-tag" });
        })
        .catch(() => { });
    if (event.waitUntil) event.waitUntil(retag);
});

let playgroundData;
self.addEventListener("message", (event) => {
    const data = event.data || {};

    if (data.type === "playgroundData") {
        playgroundData = data;
        return;
    }

    // Main-app windows identify themselves so the accounts.google.com
    // native-load gate applies to them (and their app iframes) only
    if (data.type === "bolt:tag-client") {
        if (event.source && event.source.id) {
            taggedClients.add(event.source.id);
        }
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
