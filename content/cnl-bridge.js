// CNL interceptor — isolated-world bridge.
//
// The MAIN-world script (cnl-main.js) can see the page's network calls but not
// chrome.*. This script is the reverse: it can talk to the service worker but
// not touch the page's fetch/XHR. It relays captured CNL payloads across.

(function () {
    if (window.__jdropCnlBridge) return;
    window.__jdropCnlBridge = true;

    const BRIDGE = '__jdrop_cnl__';

    window.addEventListener('message', (event) => {
        // Only accept messages from this exact window (our MAIN-world script).
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data[BRIDGE] !== true) return;

        chrome.runtime.sendMessage({
            type: 'cnl-captured',
            cnlType: data.type,
            formData: data.formData,
            sourceUrl: data.sourceUrl,
        }).catch(() => { /* worker asleep / navigating — fine */ });
    });
})();
