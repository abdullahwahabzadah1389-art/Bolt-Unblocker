/**
 * Bolt proxy stealth override.
 *
 * public/sw.js inlines this file as the FIRST <script> of every proxied HTML
 * document, so it executes before the Ultraviolet/Scramjet handlers and before
 * any target-authored script. It hides the proxy's modifications from scripts
 * running inside the proxied iframe:
 *
 *   1. Location reads return the clean target destination URL (no /$/ or
 *      /maths/ proxy prefix, no proxy origin).
 *   2. Function.prototype.toString reports `function () { [native code] }`
 *      for proxy-authored/hooked functions, and Object.getOwnPropertyNames
 *      filters proxy-injected window properties, so runtime inspection of
 *      window/navigator looks like a stock browser.
 *
 * Everything is defensive: any defineProperty that an engine refuses is
 * skipped rather than breaking the page.
 */
(function () {
    "use strict";

    if (typeof window === "undefined" || typeof Location === "undefined") return;

    var nativeGetOwnPropertyNames = Object.getOwnPropertyNames;
    var nativeToString = Function.prototype.toString;
    var nativeDefineProperty = Object.defineProperty;

    /** Functions installed by this script (report these as native code). */
    var hooked = new WeakSet();

    // ------------------------------------------------------------------
    // 1. Clean target URL on every Location read
    // ------------------------------------------------------------------
    var locProto = Location.prototype;
    var hrefDesc = Object.getOwnPropertyDescriptor(locProto, "href");

    function xorDecode(str) {
        var input = decodeURIComponent(str);
        var out = "";
        for (var i = 0; i < input.length; i++) {
            out += i % 2 ? String.fromCharCode(input.charCodeAt(i) ^ 2) : input[i];
        }
        return out;
    }

    function rawHref() {
        try {
            if (hrefDesc && hrefDesc.get) return hrefDesc.get.call(window.location);
        } catch (e) { /* fall through */ }
        return String(window.location);
    }

    /** Returns the unprefixed destination URL for the current document. */
    function cleanTargetUrl() {
        var raw = rawHref();
        try {
            // Parse with no base: `raw` is an absolute href, and reading
            // window.location.origin here would re-enter the patched getters —
            // unbounded mutual recursion if this script ever executes twice
            // (getter chains stack, RangeError rounds never settle).
            var u = new URL(raw);
            if (u.pathname.indexOf("/$/") === 0) {
                // Scramjet: prefix + encodeURIComponent(destination href)
                try {
                    return new URL(decodeURIComponent(u.pathname.slice(3) + u.search)).href;
                } catch (e) {
                    return decodeURIComponent(u.pathname.slice(3) + u.search);
                }
            }
            if (u.pathname.indexOf("/maths/") === 0) {
                // Ultraviolet: prefix + encodeURIComponent(xor(destination href))
                return xorDecode(u.pathname.slice(7));
            }
        } catch (e) { /* fall through */ }
        return raw;
    }

    /** Derives a sub-property of the clean URL, or falls back to the raw one. */
    function cleanPart(part) {
        var clean = cleanTargetUrl();
        try {
            var u = new URL(clean);
            if (part === "toString") return clean;
            if (part === "toJSON") return clean;
            return u[part];
        } catch (e) {
            return "";
        }
    }

    /**
     * Proxy-backed view of the clean destination URL. Every property read on
     * the patched Location accessors routes through a real get-trap, so
     * `location.href`, `location.hostname`, … all resolve to the unproxied
     * target (e.g. accounts.google.com) instead of the proxy URL wrapper.
     * (The `window.location` binding itself is unforgeable, so the trap sits
     * behind the prototype accessors — the only client-side route.)
     */
    var cleanView =
        typeof Proxy === "function"
            ? new Proxy(
                {},
                {
                    get: function (_target, prop) {
                        if (prop === Symbol.toPrimitive) {
                            return function () {
                                return cleanTargetUrl();
                            };
                        }
                        return cleanPart(prop);
                    },
                },
            )
            : null;

    function patchLocationGetter(name) {
        try {
            var d = Object.getOwnPropertyDescriptor(locProto, name);
            if (!d || !d.get) return;
            var getter = function () {
                return cleanView ? cleanView[name] : cleanPart(name);
            };
            hooked.add(getter);
            var next = { configurable: true, enumerable: d.enumerable, get: getter };
            if (d.set) next.set = d.set; // keep native navigation working
            nativeDefineProperty(locProto, name, next);
        } catch (e) {
            // engine refuses (e.g. unforgeable member) — leave it native
        }
    }

    /** toString/toJSON must stay callable methods (not getters). */
    function patchLocationMethod(name) {
        try {
            var d = Object.getOwnPropertyDescriptor(locProto, name);
            if (!d) return;
            var method = function () {
                return cleanPart(name);
            };
            hooked.add(method);
            nativeDefineProperty(locProto, name, {
                value: method,
                writable: true,
                enumerable: d.enumerable,
                configurable: true,
            });
        } catch (e) {
            // leave native
        }
    }

    var LOCATION_GETTERS = [
        "href", "origin", "protocol", "host", "hostname",
        "port", "pathname", "search", "hash",
    ];
    for (var i = 0; i < LOCATION_GETTERS.length; i++) {
        patchLocationGetter(LOCATION_GETTERS[i]);
    }
    patchLocationMethod("toString");
    patchLocationMethod("toJSON");

    // ------------------------------------------------------------------
    // 2a. Function.prototype.toString -> native output for hooked functions
    // ------------------------------------------------------------------
    var PROXY_SOURCE = /\$scramjet|scramjet|__uv|uv\$|Ultraviolet|bareMux|wisp/i;

    function nativeStringFor(fn) {
        return "function " + (fn.name || "") + "() { [native code] }";
    }

    var stealthToString = function toString() {
        if (this === Function.prototype.toString) {
            return "function toString() { [native code] }";
        }
        if (this === Object.getOwnPropertyNames) {
            return "function getOwnPropertyNames() { [native code] }";
        }
        if (hooked.has(this)) {
            return nativeStringFor(this);
        }
        var source;
        try {
            source = nativeToString.call(this);
        } catch (e) {
            return "function () { [native code] }";
        }
        if (PROXY_SOURCE.test(source)) {
            return nativeStringFor(this);
        }
        return source;
    };
    hooked.add(stealthToString);

    try {
        nativeDefineProperty(Function.prototype, "toString", {
            value: stealthToString,
            writable: true,
            enumerable: false,
            configurable: true,
        });
    } catch (e) { /* leave native */ }

    // ------------------------------------------------------------------
    // 2b. Common global object queries -> hide proxy-injected window props
    //     and report authentic native signatures, so runtime inspection of
    //     window/global matches an unmodified browser stack.
    // ------------------------------------------------------------------
    var baselineWindowNames = {};
    try {
        var initial = nativeGetOwnPropertyNames(window);
        for (var j = 0; j < initial.length; j++) baselineWindowNames[initial[j]] = true;
    } catch (e) { /* ignore */ }

    var PROXY_PROP = /\$scramjet|scramjet|__uv|uv\$|Ultraviolet|bareMux|wisp/i;

    /** A window own-prop added after load that identifies the proxy. */
    function isProxyWindowProp(name) {
        return !baselineWindowNames[name] && PROXY_PROP.test(name);
    }

    /** Drops proxy-injected own-property names, keeping genuine browser props. */
    function hideProxyWindowProps(names) {
        var out = [];
        for (var k = 0; k < names.length; k++) {
            if (isProxyWindowProp(names[k])) continue;
            out.push(names[k]);
        }
        return out;
    }

    /** True for the window/global object (the only one we filter). */
    function isWindowLike(obj) {
        return obj === window || (typeof Window !== "undefined" && obj instanceof Window);
    }

    // Natives captured before any patching below, so the wrappers delegate
    // without re-entering themselves.
    var nativeGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
    var nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    var nativeGetOwnPropertySymbols = Object.getOwnPropertySymbols;
    var nativeReflectOwnKeys = Reflect.ownKeys;

    var stealthGetOwnPropertyNames = function getOwnPropertyNames(obj) {
        var names = nativeGetOwnPropertyNames.call(Object, obj);
        if (!isWindowLike(obj)) return names;
        return hideProxyWindowProps(names);
    };
    hooked.add(stealthGetOwnPropertyNames);

    var stealthGetOwnPropertySymbols = function getOwnPropertySymbols(obj) {
        var syms = nativeGetOwnPropertySymbols.call(Object, obj);
        if (!isWindowLike(obj)) return syms;
        var out = [];
        for (var s = 0; s < syms.length; s++) {
            var desc = syms[s] && syms[s].description;
            if (desc && PROXY_PROP.test(desc)) continue;
            out.push(syms[s]);
        }
        return out;
    };
    hooked.add(stealthGetOwnPropertySymbols);

    var stealthGetOwnPropertyDescriptors = function getOwnPropertyDescriptors(obj) {
        var descs = nativeGetOwnPropertyDescriptors.call(Object, obj);
        if (!isWindowLike(obj)) return descs;
        var keys = Object.keys(descs);
        for (var d = 0; d < keys.length; d++) {
            if (isProxyWindowProp(keys[d])) delete descs[keys[d]];
        }
        return descs;
    };
    hooked.add(stealthGetOwnPropertyDescriptors);

    var stealthGetOwnPropertyDescriptor = function getOwnPropertyDescriptor(obj, prop) {
        if (isWindowLike(obj) && typeof prop === "string" && isProxyWindowProp(prop)) {
            return undefined;
        }
        return nativeGetOwnPropertyDescriptor.call(Object, obj, prop);
    };
    hooked.add(stealthGetOwnPropertyDescriptor);

    var stealthOwnKeys = function ownKeys(obj) {
        var keys = nativeReflectOwnKeys.call(Reflect, obj);
        if (!isWindowLike(obj)) return keys;
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (typeof key === "string" && isProxyWindowProp(key)) continue;
            out.push(key);
        }
        return out;
    };
    hooked.add(stealthOwnKeys);

    /** Installs a native-reported value, skipping any the engine refuses. */
    function installNative(target, name, value) {
        try {
            nativeDefineProperty(target, name, {
                value: value,
                writable: true,
                enumerable: false,
                configurable: true,
            });
        } catch (e) { /* leave native */ }
    }

    installNative(Object, "getOwnPropertyNames", stealthGetOwnPropertyNames);
    installNative(Object, "getOwnPropertySymbols", stealthGetOwnPropertySymbols);
    installNative(Object, "getOwnPropertyDescriptors", stealthGetOwnPropertyDescriptors);
    installNative(Object, "getOwnPropertyDescriptor", stealthGetOwnPropertyDescriptor);
    installNative(Reflect, "ownKeys", stealthOwnKeys);

    // ------------------------------------------------------------------
    // 3. accounts.google.com hardening
    // ------------------------------------------------------------------
    function isGoogleAuthDoc() {
        try {
            return new URL(cleanTargetUrl()).hostname === "accounts.google.com";
        } catch (e) {
            return false;
        }
    }

    /**
     * Creates a function reported as native, stamped with its authentic name so
     * `fn.toString()` reads `function <name>() { [native code] }` — matching an
     * unmodified Chrome's own chrome.* APIs instead of an anonymous stub.
     */
    function anon(fn, name) {
        try {
            nativeDefineProperty(fn, "name", { value: name || "", configurable: true });
        } catch (e) { /* keep inferred name */ }
        hooked.add(fn);
        return fn;
    }

    /**
     * Stub window.chrome to match a standard Google Chrome profile so
     * Google's secure-browser check finds `runtime`, `loadTimes`, `csi`
     * and `app` with native-shaped values. Installed only when absent.
     */
    function stubChrome() {
        try {
            var existing = window.chrome;
            if (
                existing &&
                existing.runtime &&
                typeof existing.loadTimes === "function" &&
                typeof existing.csi === "function"
            ) {
                return; // native Chrome profile already present
            }

            var chromeObj = existing || {};

            if (!chromeObj.runtime) {
                chromeObj.runtime = {
                    connect: anon(function () {
                        return {
                            onMessage: { addListener: anon(function () { }, "addListener") },
                            postMessage: anon(function () { }, "postMessage"),
                            disconnect: anon(function () { }, "disconnect"),
                        };
                    }, "connect"),
                    sendRequest: anon(function () { return false; }, "sendRequest"),
                    id: undefined,
                };
            }

            if (typeof chromeObj.loadTimes !== "function") {
                chromeObj.loadTimes = anon(function () {
                    var now = Date.now() / 1000;
                    return {
                        commitLoadTime: now,
                        connectionInfo: "h2",
                        finishDocumentLoadTime: now + 0.01,
                        finishLoadTime: now + 0.02,
                        firstPaintAfterLoadTime: 0,
                        firstPaintTime: now + 0.015,
                        navigationType: "Other",
                        wasFetchedViaSpdy: true,
                        wasNpnNegotiated: true,
                        npnProtocol: "h2",
                        requestTime: now - 0.1,
                        startLoadTime: now - 0.08,
                    };
                }, "loadTimes");
            }

            if (typeof chromeObj.csi !== "function") {
                chromeObj.csi = anon(function () {
                    var now = Date.now();
                    return { startE: now - 800, onloadT: now, pageT: 1200, tran: 15 };
                }, "csi");
            }

            if (!chromeObj.app) {
                chromeObj.app = {
                    isInstalled: false,
                    getDetails: anon(function () { return null; }, "getDetails"),
                    getIsInstalled: anon(function () { return false; }, "getIsInstalled"),
                    installState: anon(function () { }, "installState"),
                    runningState: anon(function () { return "cannot_run"; }, "runningState"),
                };
            }

            if (window.chrome !== chromeObj) {
                try {
                    nativeDefineProperty(window, "chrome", {
                        value: chromeObj,
                        writable: true,
                        configurable: true,
                        enumerable: true,
                    });
                } catch (e) {
                    window.chrome = chromeObj;
                }
            }
        } catch (e) {
            // leave the native chrome object untouched
        }
    }

    /**
     * Guarantees navigator.plugins and canvas fingerprinting pass through
     * untouched: the natives are captured before any other script runs and
     * restored if a later script (or injected hook) replaces them. Stops
     * after 60 seconds so it never lingers on the page.
     */
    function preserveNativeTelemetry() {
        try {
            if (typeof HTMLCanvasElement === "undefined") return;

            var canvasNative = {
                getContext: HTMLCanvasElement.prototype.getContext,
                toDataURL: HTMLCanvasElement.prototype.toDataURL,
                toBlob: HTMLCanvasElement.prototype.toBlob,
            };

            var navNative = {};
            var NAV_PROPS = ["plugins", "mimeTypes", "pdfViewerEnabled"];
            for (var n = 0; n < NAV_PROPS.length; n++) {
                try {
                    navNative[NAV_PROPS[n]] =
                        Object.getOwnPropertyDescriptor(Navigator.prototype, NAV_PROPS[n]) ||
                        Object.getOwnPropertyDescriptor(navigator, NAV_PROPS[n]);
                } catch (e) { /* unavailable */ }
            }

            var started = Date.now();
            var timer = null;
            var check = function () {
                if (Date.now() - started > 60000) {
                    clearInterval(timer);
                    return;
                }
                try {
                    var methods = ["getContext", "toDataURL", "toBlob"];
                    for (var c = 0; c < methods.length; c++) {
                        var native = canvasNative[methods[c]];
                        if (native && HTMLCanvasElement.prototype[methods[c]] !== native) {
                            nativeDefineProperty(HTMLCanvasElement.prototype, methods[c], {
                                value: native,
                                writable: true,
                                configurable: true,
                                enumerable: false,
                            });
                        }
                    }
                } catch (e) { /* leave as-is */ }
                try {
                    for (var v = 0; v < NAV_PROPS.length; v++) {
                        var desc = navNative[NAV_PROPS[v]];
                        if (!desc) continue;
                        // remove own-property shadows so the native prototype
                        // accessor is what scripts observe again
                        if (Object.prototype.hasOwnProperty.call(navigator, NAV_PROPS[v])) {
                            try { delete navigator[NAV_PROPS[v]]; } catch (e) { /* frozen */ }
                        }
                        var current = Object.getOwnPropertyDescriptor(Navigator.prototype, NAV_PROPS[v]);
                        if (!current || (current.get !== desc.get && desc.get) || (current.value !== desc.value && desc.value)) {
                            nativeDefineProperty(Navigator.prototype, NAV_PROPS[v], desc);
                        }
                    }
                } catch (e) { /* leave as-is */ }
            };
            timer = setInterval(check, 250);
        } catch (e) {
            // telemetry passthrough unavailable — do nothing
        }
    }

    if (isGoogleAuthDoc()) {
        stubChrome();
        preserveNativeTelemetry();
    }
})();
