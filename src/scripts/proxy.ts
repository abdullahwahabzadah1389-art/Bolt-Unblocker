import { BareMuxConnection } from '@mercuryworkshop/bare-mux';// InvisiProxy v8 primary network hook.
// LibcurlTransport is the single network path for every proxied request — the
// window, the Ultraviolet/Scramjet workers, and the raw accounts.google.com
// auth fallback in public/sw.js all share this one bare-mux channel, so the
// `setTransport` call below is the only place the transport is selected.
const PRIMARY_TRANSPORT = "/libcurl/index.mjs";

const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
const bareUrl = (location.protocol === "https:" ? "https" : "http") + "://" + location.host + "/bare/";


const { ScramjetController } = typeof $scramjetLoadController !== 'undefined' ? $scramjetLoadController() : {
    ScramjetController: class {
        init() { }
        encodeUrl(url: string) { return url; }
    } as any
};


const scramjet = new ScramjetController({
    files: {
        wasm: "/learn/scramjet.wasm.wasm",
        all: "/learn/scramjet.all.js",
        sync: "/learn/scramjet.sync.js",
    },
    flags: {
        rewriterLogs: false,
        scramitize: false,
        cleanErrors: true,
        sourcemaps: true,
    },
    siteFlags: {

    },
    prefix: '/$/'
});

if (scramjet.init) scramjet.init();
export const swReady = new Promise<void>((resolve) => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(() => {
            if (navigator.serviceWorker.controller) {
                resolve();
            } else {
                navigator.serviceWorker.addEventListener('controllerchange', () => resolve());
            }
        });
    } else {
        resolve();
    }
});

const bmc = new BareMuxConnection("/baremux/worker.js");
(async () => {
    // Install the primary network hook whenever nothing is selected yet or the
    // active transport is not the primary, so a stale/foreign transport can
    // never become the network path. Idempotent for the common case.
    const active = await bmc.getTransport();
    if (!active || active.indexOf("libcurl") === -1) {
        await bmc.setTransport(PRIMARY_TRANSPORT, [{ wisp: wispUrl }]);
    }
})();

function getProxyEngine(): string {
    try {
        const settings = JSON.parse(localStorage.getItem('bolt-settings') || '{}');
        return settings.proxyEngine || 'scramjet';
    } catch {
        return 'scramjet';
    }
}

function encodeUrl(url: string): string {
    const engine = getProxyEngine();

    if (engine === 'ultraviolet') {
        const encoded = uvXorEncode(url);
        return '/maths/' + encoded;
    }

    return scramjet.encodeUrl(url);
}

function uvXorEncode(str: string): string {
    if (!str) return str;
    let result = '';
    for (let i = 0; i < str.length; i++) {
        if (i % 2) {
            result += String.fromCharCode(str.charCodeAt(i) ^ 2);
        } else {
            result += str[i];
        }
    }
    return encodeURIComponent(result);
}

function decodeProxiedUrl(proxiedUrl: string): string {
    const engine = getProxyEngine();

    if (engine === 'ultraviolet' && proxiedUrl.includes('/maths/')) {
        const encoded = proxiedUrl.split('/maths/')[1];
        if (encoded) {
            return uvXorDecode(encoded);
        }
    }

    if (proxiedUrl.includes('/$/')) {
        return decodeURIComponent(proxiedUrl.split('/$/')[1] || proxiedUrl);
    }

    return proxiedUrl;
}

function uvXorDecode(str: string): string {
    if (!str) return str;
    let [input, ...search] = str.split('?');

    let decodedInput = decodeURIComponent(input);
    let result = '';
    for (let i = 0; i < decodedInput.length; i++) {
        if (i % 2) {
            result += String.fromCharCode(decodedInput.charCodeAt(i) ^ 2);
        } else {
            result += decodedInput[i];
        }
    }
    return result + (search.length ? '?' + search.join('?') : '');
}

function isProxiedUrl(url: string): boolean {
    return url.includes('/$/') || url.includes('/maths/');
}

function getProxyPrefix(): string {
    return getProxyEngine() === 'ultraviolet' ? '/maths/' : '/$/';
}

const proxy = {
    encodeUrl,
    decodeProxiedUrl,
    isProxiedUrl,
    getProxyPrefix,
    getProxyEngine,
    scramjet,
};

export default proxy;