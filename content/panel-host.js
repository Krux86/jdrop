// Panel host — isolated world.
//
// Owns the in-page panel iframe (the little overlay where you pick a device and
// send). The service worker tells it when to show/hide via runtime messages.

(function () {
    if (window.__jdropPanelHost) return;
    window.__jdropPanelHost = true;

    const FRAME_ID = 'jdrop-panel-frame';

    function showPanel(tabId) {
        let frame = document.getElementById(FRAME_ID);
        if (!frame) {
            frame = document.createElement('iframe');
            frame.id = FRAME_ID;
            frame.src = chrome.runtime.getURL('panel/panel.html') + '?tabId=' + encodeURIComponent(tabId);
            frame.setAttribute(
                'style',
                'position:fixed;top:12px;right:12px;width:360px;height:520px;max-height:90vh;' +
                'border:0;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);' +
                'z-index:2147483647;background:transparent;color-scheme:light dark;'
            );
            (document.body || document.documentElement).appendChild(frame);
        } else {
            frame.style.display = 'block';
        }
    }

    function hidePanel() {
        const frame = document.getElementById(FRAME_ID);
        if (frame) frame.remove();
    }

    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'panel:open') showPanel(msg.tabId);
        else if (msg.type === 'panel:close') hidePanel();
    });
})();
