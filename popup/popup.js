'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const loginView = $('login-view');
const connectedView = $('connected-view');
const badge = $('status-badge');

function showConnected(email, devices) {
    loginView.hidden = true;
    connectedView.hidden = false;
    badge.textContent = 'connected';
    badge.className = 'badge ok';
    $('account-email').textContent = email || '';
    renderDevices(devices);
}

function showLogin() {
    connectedView.hidden = true;
    loginView.hidden = false;
    badge.textContent = 'signed out';
    badge.className = 'badge off';
}

function renderDevices(devices) {
    const list = $('device-list');
    list.innerHTML = '';
    if (!devices || devices.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No devices online.';
        list.appendChild(li);
        return;
    }
    for (const d of devices) {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = d.name || d.id;
        const type = document.createElement('span');
        type.className = 'type';
        type.textContent = d.type || '';
        li.append(dot, name, type);
        list.appendChild(li);
    }
}

async function refreshDevices() {
    $('device-error').hidden = true;
    const res = await send({ type: 'listDevices' });
    if (res && res.ok) renderDevices(res.devices);
    else {
        $('device-error').textContent = 'Could not load devices: ' + ((res && res.error) || 'unknown');
        $('device-error').hidden = false;
    }
}

$('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    const err = $('login-error');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const res = await send({ type: 'popup:login', email: $('email').value.trim(), password: $('password').value });
    btn.disabled = false;
    btn.textContent = 'Connect';
    if (res && res.ok) {
        showConnected($('email').value.trim(), res.devices);
    } else {
        err.textContent = 'Login failed: ' + ((res && res.error) || 'unknown error');
        err.hidden = false;
    }
});

$('logout-btn').addEventListener('click', async () => {
    await send({ type: 'popup:logout' });
    showLogin();
});

$('refresh-btn').addEventListener('click', refreshDevices);

// Theme control
async function initTheme() {
    const toggle = $('theme-toggle');
    const mark = (value) => {
        for (const b of toggle.querySelectorAll('button')) {
            b.setAttribute('aria-pressed', String(b.dataset.themeValue === value));
        }
    };
    mark(await window.MyJDTheme.loadAndApply());
    toggle.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const value = btn.dataset.themeValue;
        mark(value);
        await window.MyJDTheme.setTheme(value);
    });
}

// Auto-send setting
async function initAutoSendSetting() {
    const checkbox = $('opt-autosend');
    const res = await send({ type: 'settings:get' });
    checkbox.checked = !!(res && res.settings && res.settings.autoSend);
    checkbox.addEventListener('change', () => {
        send({ type: 'settings:setAutoSend', value: checkbox.checked });
    });
}

// Initial state
(async () => {
    initTheme();
    initAutoSendSetting();
    const status = await send({ type: 'popup:status' });
    if (status && status.connected) {
        showConnected(status.email, null);
        refreshDevices();
    } else {
        showLogin();
    }
})();
