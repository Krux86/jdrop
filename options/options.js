'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function initAutoSendSetting() {
    const checkbox = $('opt-autosend');
    const res = await send({ type: 'settings:get' });
    checkbox.checked = !!(res && res.settings && res.settings.autoSend);
    checkbox.addEventListener('change', () => {
        send({ type: 'settings:setAutoSend', value: checkbox.checked });
    });
}

async function initClipboardObserverSetting() {
    const checkbox = $('opt-clipboard');
    const res = await send({ type: 'settings:get' });
    checkbox.checked = !!(res && res.settings && res.settings.clipboardObserver);
    checkbox.addEventListener('change', () => {
        send({ type: 'settings:setClipboardObserver', value: checkbox.checked });
    });
}

(async () => {
    window.MyJDTheme.loadAndApply(); // match the theme chosen in the popup; toggle lives there only
    initAutoSendSetting();
    initClipboardObserverSetting();
})();
