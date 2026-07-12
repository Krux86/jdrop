// CNL interceptor — MAIN world.
//
// Runs in the page's own JS realm (manifest `world: "MAIN"`) so it can override
// the page's window.fetch / XMLHttpRequest and intercept classic form submits
// to 127.0.0.1:9666. It has no access to chrome.*, so captured payloads are
// handed to the isolated-world bridge via window.postMessage.

(function () {
    if (window.__jdropCnlMain) return;
    window.__jdropCnlMain = true;

    console.log('[JDrop/CNL] main-world interceptor active on', window.location.href);

    // Many CNL hosters detect a running JDownloader by checking the global
    // `window.jdownloader` (normally set when jdcheck.js loads from localhost).
    // Our faked jdcheck response may not execute as a script (CSP / data: URL),
    // so set the flag directly — this is what makes the hoster's "Send to
    // JDownloader" button actually fire its localhost request.
    try {
        window.jdownloader = true;
        window.jdownloaderVersion = '9.9.9';
    } catch (e) { /* ignore */ }

    const HOSTS = ['localhost:9666', '127.0.0.1:9666'];
    const BRIDGE = '__jdrop_cnl__';

    const isCnl = (url) => {
        const hit = HOSTS.some((h) => String(url).includes(h));
        if (hit) console.log('[JDrop/CNL] saw localhost request:', String(url));
        return hit;
    };
    const endpoint = (url) => {
        url = String(url);
        if (url.includes('/jdcheck.js')) return 'JD_CHECK';
        if (url.includes('/crossdomain.xml')) return 'CROSSDOMAIN';
        if (url.includes('/flash/addcrypted2')) return 'ADD_CRYPTED';
        if (url.includes('/flash/add')) return 'ADD';
        return 'UNKNOWN';
    };

    const CROSSDOMAIN = '<?xml version="1.0"?>\n<cross-domain-policy>\n  <allow-access-from domain="*"/>\n</cross-domain-policy>';

    function captureForm(data) {
        if (!data) return null;
        if (data instanceof FormData || data instanceof URLSearchParams) {
            const out = {};
            for (const [k, v] of data.entries()) out[k] = v instanceof Blob ? '[blob]' : v;
            return out;
        }
        if (typeof data === 'string') {
            try { return JSON.parse(data); }
            catch { return Object.fromEntries(new URLSearchParams(data).entries()); }
        }
        if (typeof data === 'object' && !(data instanceof Blob) && !(data instanceof ArrayBuffer)) return data;
        return { rawData: String(data) };
    }

    function handoff(type, formData, sourceUrl) {
        try {
            window.postMessage({ [BRIDGE]: true, type, formData, sourceUrl, timestamp: Date.now() }, window.location.origin);
        } catch (e) {
            console.error('[JDrop/CNL] postMessage failed', e);
        }
    }

    // ---- fetch ----
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isCnl(url)) {
            const t = endpoint(url);
            if (t === 'JD_CHECK') return Promise.resolve(new Response('var jdownloader = true;', { status: 200, headers: { 'Content-Type': 'text/javascript' } }));
            if (t === 'CROSSDOMAIN') return Promise.resolve(new Response(CROSSDOMAIN, { status: 200, headers: { 'Content-Type': 'text/xml' } }));
            if (t === 'ADD' || t === 'ADD_CRYPTED') {
                handoff(t, captureForm(init && init.body), window.location.href);
                return Promise.resolve(new Response('success', { status: 200 }));
            }
        }
        return origFetch.apply(this, arguments);
    };

    // ---- XMLHttpRequest ----
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
        const xhr = new OrigXHR();
        let url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, u) { url = u; return origOpen.apply(this, arguments); };
        const origSend = xhr.send;
        xhr.send = function (body) {
            if (isCnl(url)) {
                const t = endpoint(url);
                const fake = (text) => {
                    Object.defineProperty(xhr, 'responseText', { get: () => text });
                    Object.defineProperty(xhr, 'response', { get: () => text });
                    Object.defineProperty(xhr, 'status', { get: () => 200 });
                    Object.defineProperty(xhr, 'readyState', { get: () => 4 });
                    setTimeout(() => {
                        if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
                        if (typeof xhr.onload === 'function') xhr.onload();
                    }, 0);
                };
                if (t === 'JD_CHECK') return fake('var jdownloader = true;');
                if (t === 'CROSSDOMAIN') return fake(CROSSDOMAIN);
                if (t === 'ADD' || t === 'ADD_CRYPTED') {
                    handoff(t, captureForm(body), window.location.href);
                    return fake('success');
                }
            }
            return origSend.apply(this, arguments);
        };
        return xhr;
    };
    window.XMLHttpRequest.prototype = OrigXHR.prototype;
    Object.setPrototypeOf(window.XMLHttpRequest, OrigXHR);

    // ---- classic <form> submit ----
    function handleForm(form) {
        if (!form || !form.action || !isCnl(form.action)) return false;
        const t = endpoint(form.action);
        if (t !== 'ADD' && t !== 'ADD_CRYPTED') return false;
        const formData = {};
        for (const el of Array.from(form.elements || [])) if (el.name) formData[el.name] = el.value;
        handoff(t, formData, window.location.href);
        return true;
    }
    const origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
        if (handleForm(this)) return;
        return origSubmit.apply(this, arguments);
    };
    window.addEventListener('submit', (e) => {
        if (handleForm(e.target)) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // ---- window.open (some CNL scripts open the localhost URL as a popup) ----
    const origWindowOpen = window.open;
    window.open = function (url) {
        if (url && isCnl(url)) {
            const t = endpoint(url);
            if (t === 'ADD' || t === 'ADD_CRYPTED') {
                try {
                    const u = new URL(url, window.location.href);
                    const form = {};
                    for (const [k, v] of u.searchParams.entries()) form[k] = v;
                    handoff(t, form, window.location.href);
                } catch (e) { /* ignore */ }
                return null;
            }
            if (t === 'JD_CHECK' || t === 'CROSSDOMAIN') return null;
        }
        return origWindowOpen.apply(this, arguments);
    };
})();
