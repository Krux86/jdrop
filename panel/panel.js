'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const isPopup = params.get('popup') === '1';

if (isPopup) document.documentElement.classList.add('win');

// In standalone-window mode, ask the service worker to resize the window to fit
// the current content (so few links -> small window, many -> taller, capped).
function fitWindow() {
    if (!isPopup) return;
    requestAnimationFrame(() => {
        const card = document.querySelector('.card');
        if (!card) return;
        const frame = Math.max(0, window.outerHeight - window.innerHeight);
        const height = Math.round(card.offsetHeight + frame);
        send({ type: 'panel:resize', tabId, height });
    });
}

function setStatus(text, kind) {
    const el = $('status');
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
    fitWindow();
}

function renderItems(items) {
    const list = $('items');
    list.innerHTML = '';
    if (!items || items.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No links queued.';
        list.appendChild(li);
        $('send-btn').disabled = true;
        fitWindow();
        return;
    }
    $('send-btn').disabled = false;
    for (const it of items) {
        const li = document.createElement('li');

        const tag = document.createElement('span');
        tag.className = 'tag' + (it.type === 'cnl' ? ' cnl' : '');
        tag.textContent = it.type === 'cnl' ? 'CNL' : 'link';

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = it.title || (typeof it.content === 'string' ? it.content : 'CNL package');
        title.title = title.textContent;

        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '✕';
        remove.title = 'Remove';
        remove.addEventListener('click', async () => {
            await send({ type: 'panel:remove', tabId, id: it.id });
            loadQueue();
        });

        li.append(tag, title, remove);
        list.appendChild(li);
    }
    fitWindow();
}

function renderDevices(devices) {
    const sel = $('device');
    sel.innerHTML = '';
    if (!devices || devices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No devices online';
        sel.appendChild(opt);
        sel.disabled = true;
        $('send-btn').disabled = true;
        fitWindow();
        return;
    }
    sel.disabled = false;
    for (const d of devices) {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.name || d.id;
        sel.appendChild(opt);
    }
    // Pre-select the device used last time, if it's still online.
    if (panelDefaults.defaultDeviceId && devices.some((d) => d.id === panelDefaults.defaultDeviceId)) {
        sel.value = panelDefaults.defaultDeviceId;
    }
    fitWindow();
}

let panelDefaults = { defaultDeviceId: null, rememberedOptions: {} };

async function loadDefaults() {
    const res = await send({ type: 'panel:getDefaults' });
    panelDefaults = {
        defaultDeviceId: res && res.defaultDeviceId,
        rememberedOptions: (res && res.rememberedOptions) || {},
    };
}

// Pre-fill the sticky options (autostart, destination folder) from last time.
// packageName/downloadPassword are never remembered - those vary per item.
function applyRememberedOptions() {
    const { autostart, destinationFolder } = panelDefaults.rememberedOptions;
    if (autostart) $('opt-autostart').checked = true;
    if (destinationFolder) $('opt-folder').value = destinationFolder;
    if (autostart || destinationFolder) {
        const details = document.querySelector('.controls details');
        if (details) details.open = true;
    }
    fitWindow();
}

async function loadQueue() {
    const res = await send({ type: 'panel:getQueue', tabId });
    renderItems(res && res.items);
}

async function loadDevices() {
    const status = await send({ type: 'popup:status' });
    if (!status || !status.connected) {
        setStatus('Not signed in — open the toolbar icon to connect.', 'err');
        renderDevices([]);
        return;
    }
    const res = await send({ type: 'listDevices' });
    if (res && res.ok) renderDevices(res.devices);
    else { setStatus('Could not load devices.', 'err'); renderDevices([]); }
}

$('close-btn').addEventListener('click', () => send({ type: 'panel:close', tabId }));

// Expanding/collapsing the options section changes the height — refit.
const optionsDetails = document.querySelector('.controls details');
if (optionsDetails) optionsDetails.addEventListener('toggle', fitWindow);

$('clear-btn').addEventListener('click', async () => {
    await send({ type: 'panel:clear', tabId });
    loadQueue();
});

$('send-btn').addEventListener('click', async () => {
    const deviceId = $('device').value;
    if (!deviceId) { setStatus('Pick a device first.', 'err'); return; }
    const btn = $('send-btn');
    btn.disabled = true;
    setStatus('Sending…');

    const options = {
        packageName: $('opt-package').value.trim() || undefined,
        downloadPassword: $('opt-password').value.trim() || undefined,
        destinationFolder: $('opt-folder').value.trim() || undefined,
        autostart: $('opt-autostart').checked || undefined,
    };

    const res = await send({ type: 'panel:send', tabId, deviceId, options });
    if (res && res.ok) {
        setStatus(`Sent ${res.count} item(s) to JDownloader.`, 'ok');
        setTimeout(() => send({ type: 'panel:close', tabId }), 1200);
    } else {
        btn.disabled = false;
        const map = { not_connected: 'Not signed in.', empty: 'Nothing to send.' };
        setStatus('Failed: ' + (map[res && res.error] || (res && res.error) || 'unknown'), 'err');
    }
});

(async () => {
    window.MyJDTheme.loadAndApply();
    await loadDefaults();
    applyRememberedOptions();
    loadQueue();
    loadDevices();
})();
