// Clipboard link observer - isolated world, opt-in (off by default).
//
// Reads the live page selection at the moment of a native `copy` event
// instead of the OS clipboard - this needs no clipboard-read permission and
// works within MV3's constraints (same trick the official MyJDownloader
// extension uses in onCopyContentscript.js). Only acts on selections that
// are entirely URL-shaped lines; anything else (a sentence, a paragraph) is
// ignored. Always just queues for review in the existing panel - never
// sends anything without the user clicking Send there (see enqueue's
// skipAutoSend in background.js).

(function () {
    if (window.__jdropClipboardObserver) return;
    window.__jdropClipboardObserver = true;

    const SETTINGS_KEY = 'myjd_settings';
    const URL_LINE = /^https?:\/\/\S+$/;

    // Mirrors lib/clipboard.js's extractUrls (tested there) - content scripts
    // here can't import ES modules, see that file's header. Keep in sync.
    function extractUrls(text) {
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) return null;
        const urls = lines.filter((l) => URL_LINE.test(l));
        return urls.length === lines.length ? urls : null;
    }

    document.addEventListener('copy', () => {
        chrome.storage.local.get(SETTINGS_KEY, (res) => {
            const settings = res[SETTINGS_KEY];
            if (!settings || !settings.clipboardObserver) return;

            const urls = extractUrls(window.getSelection().toString());
            if (!urls) return;

            chrome.runtime.sendMessage({
                type: 'clipboard-captured',
                links: urls.join('\n'),
                sourceUrl: window.location.href,
            }).catch(() => { /* worker asleep - fine, next copy will retry */ });
        });
    }, true);
})();
