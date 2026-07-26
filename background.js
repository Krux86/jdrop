// JDrop — service worker (MV3, ES module).
//
// Ties together: context menu -> per-tab link queue -> in-page panel -> cloud
// API. CNL requests to a (possibly unreachable) local JDownloader are faked at
// the network layer and their payload is rerouted through the same panel/device
// flow. All crypto/API logic lives in lib/*; this file is orchestration only.

import { MyJDApi } from './lib/api.js';
import { cnlToAddLinksQuery, hasForwardablePayload } from './lib/cnl.js';
import {
    loadSession, saveSession, clearSession,
    loadSettings, saveSettings, DEFAULT_SETTINGS,
    loadQueue, saveQueue,
    loadSeenCaptchaIds, saveSeenCaptchaIds,
} from './lib/storage.js';
import { diffNewJobs, addSeenIds, pruneSeenIds, parseRawTokenResponse, SKIP_TYPES } from './lib/captcha.js';

// ---- API instance (rehydrated from storage on each worker wake) ----

let apiPromise = null;
async function getApi() {
    if (!apiPromise) {
        apiPromise = (async () => {
            const session = await loadSession();
            const api = new MyJDApi({ session });
            // Persist refreshed tokens whenever the client transparently reconnects.
            api.onSessionRefreshed = (s) => saveSession(s);
            return api;
        })();
    }
    return apiPromise;
}

async function persistSession(api) {
    if (api.session) await saveSession(api.session);
    else await clearSession();
}

// ---- context menu ----

const MENU_ID = 'jdrop-send';

async function setupContextMenu() {
    const settings = await loadSettings();
    await chrome.contextMenus.removeAll();
    if (settings.contextMenu) {
        chrome.contextMenus.create({
            id: MENU_ID,
            title: 'Send to JDownloader',
            contexts: ['link', 'page', 'selection', 'image', 'video', 'audio'],
        });
    }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || tab.id === undefined) return;
    const url = info.linkUrl || info.srcUrl || info.selectionText || info.pageUrl || tab.url;
    if (!url) return;
    enqueue(tab, {
        type: 'link',
        title: tab.title || url,
        content: url,
        sourceUrl: tab.url,
    });
});

// ---- keyboard shortcut ----

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'send-current-tab') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined || !tab.url) return;
    enqueue(tab, {
        type: 'link',
        title: tab.title || tab.url,
        content: tab.url,
        sourceUrl: tab.url,
    });
});

// ---- per-tab request queue ----

async function enqueue(tab, item, present = 'inpage', { skipAutoSend = false } = {}) {
    // Auto-send (opt-in, off by default): skip the panel entirely and send
    // straight to the remembered device with the remembered options. Falls
    // through to the normal panel flow if not connected, no remembered device
    // yet, or the send itself fails - so the user always has a way to recover.
    // skipAutoSend forces the review panel regardless of that setting - used
    // by the clipboard observer, since a copy is far more incidental than an
    // explicit right-click or CNL click and should never send silently.
    if (!skipAutoSend && await tryAutoSend(tab, item)) return;

    const queue = await loadQueue();
    const key = String(tab.id);
    if (!queue[key]) queue[key] = [];

    const full = {
        id: `${tab.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        time: Date.now(),
        favIconUrl: tab.favIconUrl || '',
        ...item,
    };

    // De-dupe identical entries.
    const dupe = queue[key].some(
        (it) => it.type === full.type && JSON.stringify(it.content) === JSON.stringify(full.content)
    );
    if (!dupe) {
        queue[key].push(full);
        await saveQueue(queue);
    }
    console.log('[JDrop] enqueued', full.type, 'for tab', tab.id, '- present:', present);
    // CNL comes from hostile hoster pages that rewrite/navigate themselves and
    // would destroy an in-page overlay, so present it in a separate window.
    if (present === 'window') await openPanelWindow(tab.id);
    else await openPanel(tab.id);
}

async function tryAutoSend(tab, item) {
    const settings = await loadSettings();
    if (!settings.autoSend || !settings.defaultDeviceId) return false;

    const api = await getApi();
    if (!api.isConnected()) return false;

    try {
        const query = buildQuery(item, settings.rememberedOptions || {});
        console.log('[JDrop] auto-send ->', settings.defaultDeviceId, query);
        await api.addLinks(settings.defaultDeviceId, query);
        flashBadge(tab.id, '✓', '#2e9e5b');
        console.log('[JDrop] auto-send OK');
        return true;
    } catch (e) {
        console.error('[JDrop] auto-send failed, falling back to panel:', e);
        return false;
    }
}

async function getTabQueue(tabId) {
    const queue = await loadQueue();
    return queue[String(tabId)] || [];
}

async function removeFromQueue(tabId, itemId) {
    const queue = await loadQueue();
    const key = String(tabId);
    if (queue[key]) {
        queue[key] = queue[key].filter((it) => it.id !== itemId);
        await saveQueue(queue);
    }
}

async function clearTabQueue(tabId, reason = '') {
    const queue = await loadQueue();
    if (queue[String(tabId)]) {
        console.log('[JDrop] clearing queue for tab', tabId, reason ? '(' + reason + ')' : '');
        delete queue[String(tabId)];
        await saveQueue(queue);
    }
}

// Briefly flash a confirmation on the toolbar badge (used by auto-send, since
// there's no panel to confirm anything happened), then clear it.
function flashBadge(tabId, text, color, ms = 1500) {
    chrome.action.setBadgeText({ text, tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
    setTimeout(() => {
        chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    }, ms);
}

chrome.tabs.onRemoved.addListener((tabId) => {
    // A CNL capture often originates from a short-lived popunder tab that the
    // hoster closes moments later. If a standalone panel window is still showing
    // this tab's captures, keep the queue so the user can send when ready.
    if (panelWindows[tabId] !== undefined) {
        console.log('[JDrop] tab', tabId, 'closed but its panel window is open — keeping queue');
        return;
    }
    clearTabQueue(tabId, 'tab closed');

    // CAPTCHA tab closed without solving/skipping through the UI (e.g. the
    // user just closed it) - clean up the CSP rule and send a courtesy
    // single-skip so the job doesn't sit stuck on JDownloader's side.
    const info = activeCaptchaTabs[tabId];
    if (info) {
        delete activeCaptchaTabs[tabId];
        removeCaptchaCspStrippingRule(info.cspRuleId);
        (async () => {
            try {
                const api = await getApi();
                await api.skipCaptcha(info.deviceId, info.jobId, SKIP_TYPES.SINGLE);
                console.log('[JDrop] CAPTCHA tab', tabId, 'closed, sent skip(single) for job', info.jobId);
            } catch (e) {
                console.error('[JDrop] could not send skip after CAPTCHA tab close for job', info.jobId, e);
            }
        })();
    }
});

// ---- in-page panel ----

async function openPanel(tabId) {
    const openMsg = { type: 'panel:open', tabId };
    try {
        await chrome.tabs.sendMessage(tabId, openMsg);
        console.log('[JDrop] panel:open delivered to tab', tabId);
    } catch {
        // Content script not present yet — inject it, then retry.
        try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content/panel-host.js'] });
            await chrome.tabs.sendMessage(tabId, openMsg);
            console.log('[JDrop] panel:open delivered after injecting host into tab', tabId);
        } catch (e) {
            console.error('[JDrop] could not open panel in tab', tabId, e);
        }
    }
}

// A standalone panel window, immune to the host page navigating or rewriting
// itself. Reused per source tab so repeated CNL captures focus the same window.
const panelWindows = {}; // tabId -> windowId

async function openPanelWindow(tabId) {
    const existing = panelWindows[tabId];
    if (existing !== undefined) {
        try {
            await chrome.windows.update(existing, { focused: true, drawAttention: true });
            console.log('[JDrop] focused existing panel window for tab', tabId);
            return;
        } catch {
            delete panelWindows[tabId]; // window was closed — fall through and recreate
        }
    }
    try {
        // Rough initial height from the queue length; the panel fine-tunes it
        // to its real content once loaded (see the 'panel:resize' handler).
        const count = (await getTabQueue(tabId)).length;
        const initialHeight = Math.max(260, Math.min(680, 260 + Math.min(count, 6) * 46));
        const url = chrome.runtime.getURL('panel/panel.html') + '?tabId=' + tabId + '&popup=1';
        const win = await chrome.windows.create({ url, type: 'popup', width: 360, height: initialHeight, focused: true });
        panelWindows[tabId] = win.id;
        console.log('[JDrop] opened panel window', win.id, 'for tab', tabId);
    } catch (e) {
        console.error('[JDrop] could not open panel window for tab', tabId, e);
    }
}

chrome.windows.onRemoved.addListener((windowId) => {
    for (const [tabId, id] of Object.entries(panelWindows)) {
        if (id === windowId) {
            delete panelWindows[tabId];
            // The window is gone — its captures are no longer actionable, clean up.
            clearTabQueue(tabId, 'panel window closed');
        }
    }
});

// ---- CNL network-layer faking (declarativeNetRequest) ----

const CNL_RULE_IDS = [1, 2, 3, 4, 5, 6];
const CNL_RESOURCE_TYPES = ['sub_frame', 'xmlhttprequest', 'script', 'ping', 'other', 'object', 'media', 'image'];

function dataUrl(mime, content) {
    return `data:${mime};charset=utf-8,` + encodeURIComponent(content);
}

const CNL_JDCHECK = 'var jdownloader = true;\nvar jdownloaderVersion = "9.9.9";';
const CNL_CROSSDOMAIN = '<?xml version="1.0"?>\n<cross-domain-policy>\n  <allow-access-from domain="*"/>\n</cross-domain-policy>';

function cnlRules() {
    const jd = { type: 'redirect', redirect: { url: dataUrl('text/javascript', CNL_JDCHECK) } };
    const xml = { type: 'redirect', redirect: { url: dataUrl('text/xml', CNL_CROSSDOMAIN) } };
    const ok = { type: 'redirect', redirect: { url: dataUrl('text/plain', 'success') } };
    const cond = (filter) => ({ urlFilter: filter, resourceTypes: CNL_RESOURCE_TYPES });
    return [
        { id: 1, priority: 1, action: jd, condition: cond('*://localhost:9666/jdcheck.js*') },
        { id: 2, priority: 1, action: jd, condition: cond('*://127.0.0.1:9666/jdcheck.js*') },
        { id: 3, priority: 1, action: xml, condition: cond('*://localhost:9666/crossdomain.xml*') },
        { id: 4, priority: 1, action: xml, condition: cond('*://127.0.0.1:9666/crossdomain.xml*') },
        { id: 5, priority: 1, action: ok, condition: cond('*://localhost:9666/flash/add*') },
        { id: 6, priority: 1, action: ok, condition: cond('*://127.0.0.1:9666/flash/add*') },
    ];
}

async function enableCnl() {
    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: CNL_RULE_IDS,
            addRules: cnlRules(),
        });
        console.log('[JDrop] CNL redirect rules active');
    } catch (e) {
        console.error('[JDrop] enableCnl failed:', e);
    }
}
async function disableCnl() {
    try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: CNL_RULE_IDS });
    } catch (e) {
        console.error('[JDrop] disableCnl failed:', e);
    }
}

// ---- CNL payload capture (webRequest, observational) ----

function parseCnlBody(details) {
    const form = {};
    if (details.requestBody) {
        if (details.requestBody.formData) {
            for (const [k, v] of Object.entries(details.requestBody.formData)) form[k] = v[0];
            return form;
        }
        if (details.requestBody.raw && details.requestBody.raw.length) {
            try {
                const decoder = new TextDecoder('utf-8');
                const raw = details.requestBody.raw.map((c) => (c.bytes ? decoder.decode(c.bytes) : '')).join('');
                const params = new URLSearchParams(raw);
                let any = false;
                for (const [k, v] of params.entries()) { form[k] = v; any = true; }
                if (any) return form;
            } catch (e) {
                console.warn('JDrop: failed to decode CNL POST body', e);
            }
        }
    }
    try {
        const u = new URL(details.url);
        let any = false;
        for (const [k, v] of u.searchParams.entries()) { form[k] = v; any = true; }
        if (any) return form;
    } catch { /* ignore */ }
    return null;
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        console.log('[JDrop] webRequest saw CNL request:', details.url, 'tab', details.tabId);
        const form = parseCnlBody(details);
        if (!hasForwardablePayload(form)) {
            console.log('[JDrop] …no forwardable payload (crypted/dlc/urls), skipping');
            return;
        }
        if (details.tabId < 0) return;
        chrome.tabs.get(details.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return;
            enqueue(tab, {
                type: 'cnl',
                title: (form.package && (Array.isArray(form.package) ? form.package[0] : form.package)) || tab.title || 'CNL',
                content: { formData: form, sourceUrl: details.documentUrl || details.initiator || tab.url },
                sourceUrl: tab.url,
            }, 'window');
        });
    },
    { urls: ['http://127.0.0.1:9666/flash/*', 'http://localhost:9666/flash/*'] },
    ['requestBody']
);

// ---- sending ----

function buildQuery(item, options) {
    let query;
    if (item.type === 'cnl') {
        query = cnlToAddLinksQuery(item.content.formData, { sourceUrl: item.content.sourceUrl });
    } else {
        query = { links: item.content };
        if (item.sourceUrl) query.sourceUrl = item.sourceUrl;
    }
    if (options.packageName) query.packageName = options.packageName;
    if (options.downloadPassword) query.downloadPassword = options.downloadPassword;
    if (options.destinationFolder) query.destinationFolder = options.destinationFolder;
    if (options.autostart !== undefined) query.autostart = options.autostart;
    return query;
}

async function sendItems({ tabId, deviceId, options }) {
    const api = await getApi();
    if (!api.isConnected()) return { ok: false, error: 'not_connected' };

    const items = await getTabQueue(tabId);
    if (items.length === 0) return { ok: false, error: 'empty' };

    try {
        for (const item of items) {
            const query = buildQuery(item, options);
            console.log('[JDrop] addLinks ->', deviceId, query);
            await api.addLinks(deviceId, query);
        }
        await clearTabQueue(tabId);

        // Remember the device + these two options for next time (auto-send and
        // the panel's pre-fill both read this). packageName/downloadPassword are
        // intentionally never remembered - those vary per item, not globally.
        const settings = await loadSettings();
        settings.defaultDeviceId = deviceId;
        settings.rememberedOptions = {
            autostart: !!options.autostart,
            destinationFolder: options.destinationFolder || '',
        };
        await saveSettings(settings);

        console.log('[JDrop] sent', items.length, 'item(s) OK');
        return { ok: true, count: items.length };
    } catch (e) {
        console.error('[JDrop] send failed:', e);
        if (e.needsLogin) { api.session = null; await clearSession(); }
        return { ok: false, error: e.message, needsLogin: !!e.needsLogin };
    }
}

// ---- CAPTCHA solving ----
//
// UNVERIFIED end-to-end: the /captcha/get "rawtoken" response shape that
// parseRawTokenResponse (lib/captcha.js) depends on has never been confirmed
// against a real pending job (see lib/api.js's getCaptchaRawToken). Polling,
// job de-duplication, and the solve/skip API calls are independently correct
// and tested; the widget-rendering path built on top of that parser is not
// trustworthy until checked against a live account.

const activeCaptchaTabs = {}; // tabId -> { jobId, deviceId, cspRuleId }

// Rule id is derived from the tab id itself (CNL rules use fixed ids 1-6,
// this stays well clear of those) rather than an incrementing counter. A
// counter only lives in the service worker's memory, but session
// declarativeNetRequest rules survive a worker restart - after a restart a
// fresh counter starting over collides with a still-registered rule from
// before. Deriving the id from the tab id is both collision-free (tab ids
// are unique) and naturally idempotent for the same tab.
function captchaCspRuleId(tabId) {
    return 20000 + tabId;
}

async function addCaptchaCspStrippingRule(tabId) {
    const ruleId = captchaCspRuleId(tabId);
    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            // removeRuleIds first in case a stale rule for this id survived
            // an earlier service worker lifetime without being cleaned up.
            removeRuleIds: [ruleId],
            addRules: [{
                id: ruleId,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    responseHeaders: [
                        { header: 'Content-Security-Policy', operation: 'remove' },
                        { header: 'Content-Security-Policy-Report-Only', operation: 'remove' },
                    ],
                },
                condition: { tabIds: [tabId], resourceTypes: ['main_frame', 'sub_frame', 'script'] },
            }],
        });
        return ruleId;
    } catch (e) {
        console.error('[JDrop] addCaptchaCspStrippingRule failed:', e);
        return null;
    }
}

async function removeCaptchaCspStrippingRule(ruleId) {
    if (ruleId == null) return;
    try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    } catch (e) {
        console.error('[JDrop] removeCaptchaCspStrippingRule failed:', e);
    }
}

// Opens a real browser tab on the CAPTCHA's actual target page (site keys are
// domain-locked, so the widget must render there, not on an extension page),
// with a URL fragment marker the content script uses to find its job. Strips
// CSP on that tab so an injected recaptcha/hcaptcha script tag isn't blocked.
async function openCaptchaTab(api, deviceId, job) {
    let details;
    try {
        const raw = await api.getCaptchaRawToken(deviceId, job.id);
        // UNVERIFIED shape (see lib/captcha.js header) - log it raw every time
        // so the first real job tells us what it actually looks like, instead
        // of only finding out via a parse failure.
        console.log('[JDrop] raw CAPTCHA rawtoken response for job', job.id, JSON.stringify(raw));
        details = parseRawTokenResponse(raw, job);
    } catch (e) {
        console.error('[JDrop] could not fetch/parse CAPTCHA details for job', job.id, e);
        return;
    }
    await createCaptchaTab(deviceId, job.id, details);
}

// The actual tab-creation tail, split out from openCaptchaTab so a debug
// path can drive it with a hand-built `details` object (skipping the real
// API call) to test CSP-stripping and the rest of the real tab lifecycle
// without a live pending CAPTCHA job.
async function createCaptchaTab(deviceId, jobId, details) {
    if (!details.targetUrl) {
        console.error('[JDrop] CAPTCHA job', jobId, 'has no target URL to open (see UNVERIFIED note on parseRawTokenResponse)');
        return;
    }

    const url = details.targetUrl + '#jdrop-captcha=' + encodeURIComponent(JSON.stringify({ deviceId, ...details }));
    let tab;
    try {
        // Create the tab blank first so we have its id, and can strip CSP for
        // it, before the real navigation (and the CSP header that comes with
        // it) happens. Creating it with the target url directly would start
        // that navigation immediately, too early for a rule keyed on tab.id
        // to apply to it.
        tab = await chrome.tabs.create({ url: 'about:blank' });
    } catch (e) {
        console.error('[JDrop] could not open CAPTCHA tab for job', jobId, e);
        return;
    }
    const cspRuleId = await addCaptchaCspStrippingRule(tab.id);
    activeCaptchaTabs[tab.id] = { jobId, deviceId, cspRuleId };
    await chrome.tabs.update(tab.id, { url });
    console.log('[JDrop] opened CAPTCHA tab', tab.id, 'for job', jobId, details.library);
}

// Shared by the 1-minute alarm and the popup's manual "check now" button.
// Always logs something on the way through - a silent "found nothing" looks
// identical to a silent failure, which is exactly the bug this project's
// whole CAPTCHA investigation kept running into elsewhere. Don't repeat it.
async function pollCaptchas() {
    const api = await getApi();
    if (!api.isConnected()) {
        console.log('[JDrop] pollCaptchas: not connected, skipping');
        return;
    }
    let devices;
    try {
        devices = await api.listDevices();
    } catch (e) {
        console.error('[JDrop] pollCaptchas: listDevices failed:', e);
        return;
    }
    if (devices.length === 0) {
        console.log('[JDrop] pollCaptchas: no devices online');
        return;
    }

    for (const device of devices) {
        let jobs;
        try {
            jobs = await api.listCaptchaJobs(device.id);
        } catch (e) {
            console.error('[JDrop] pollCaptchas: listCaptchaJobs failed for', device.id, e);
            continue;
        }
        if (!Array.isArray(jobs) || jobs.length === 0) {
            console.log('[JDrop] pollCaptchas: no pending CAPTCHAs on', device.id);
            continue;
        }

        const seen = await loadSeenCaptchaIds();
        const fresh = diffNewJobs(jobs, seen);
        if (fresh.length === 0) {
            console.log('[JDrop] pollCaptchas:', jobs.length, 'pending CAPTCHA(s) on', device.id, '- all already seen');
            continue;
        }

        console.log('[JDrop] pollCaptchas: found', fresh.length, 'new CAPTCHA job(s) on', device.id);
        for (const job of fresh) await openCaptchaTab(api, device.id, job);

        await saveSeenCaptchaIds(pruneSeenIds(addSeenIds(seen, fresh.map((j) => j.id)), jobs));
    }
}

chrome.alarms.create('captcha-poll', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'captcha-poll') pollCaptchas().catch((e) => console.error('[JDrop] pollCaptchas crashed:', e));
});

async function finishCaptchaTab(tabId, { close = true } = {}) {
    const info = activeCaptchaTabs[tabId];
    if (!info) return;
    delete activeCaptchaTabs[tabId];
    await removeCaptchaCspStrippingRule(info.cspRuleId);
    if (close) {
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 2000);
    }
    return info;
}

// ---- message routing ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id) return false;
    console.log('[JDrop] message:', msg.type);

    (async () => {
        switch (msg.type) {
            case 'popup:status': {
                const api = await getApi();
                sendResponse({
                    connected: api.isConnected(),
                    email: api.session ? api.session.email : null,
                });
                break;
            }
            case 'popup:login': {
                const api = await getApi();
                try {
                    await api.connect(msg.email, msg.password);
                    await persistSession(api);
                    const devices = await api.listDevices();
                    console.log('[JDrop] login OK,', devices.length, 'device(s)');
                    sendResponse({ ok: true, devices });
                } catch (e) {
                    console.error('[JDrop] login failed:', e);
                    sendResponse({ ok: false, error: e.message });
                }
                break;
            }
            case 'popup:logout': {
                const api = await getApi();
                await api.disconnect();
                await persistSession(api);
                sendResponse({ ok: true });
                break;
            }
            case 'listDevices': {
                const api = await getApi();
                try {
                    sendResponse({ ok: true, devices: await api.listDevices() });
                } catch (e) {
                    if (e.needsLogin) { api.session = null; await clearSession(); }
                    sendResponse({ ok: false, error: e.message, needsLogin: !!e.needsLogin });
                }
                break;
            }
            case 'getTheme': {
                const settings = await loadSettings();
                sendResponse({ theme: settings.theme || 'auto' });
                break;
            }
            case 'setTheme': {
                const settings = await loadSettings();
                settings.theme = msg.theme;
                await saveSettings(settings);
                sendResponse({ ok: true });
                break;
            }
            case 'settings:get': {
                sendResponse({ settings: await loadSettings() });
                break;
            }
            case 'settings:setAutoSend': {
                const settings = await loadSettings();
                settings.autoSend = !!msg.value;
                await saveSettings(settings);
                sendResponse({ ok: true });
                break;
            }
            case 'settings:setClipboardObserver': {
                const settings = await loadSettings();
                settings.clipboardObserver = !!msg.value;
                await saveSettings(settings);
                sendResponse({ ok: true });
                break;
            }
            case 'settings:setRememberedEmail': {
                const settings = await loadSettings();
                settings.rememberedEmail = msg.value || '';
                await saveSettings(settings);
                sendResponse({ ok: true });
                break;
            }
            case 'panel:getDefaults': {
                const settings = await loadSettings();
                sendResponse({
                    defaultDeviceId: settings.defaultDeviceId,
                    rememberedOptions: settings.rememberedOptions || {},
                });
                break;
            }
            case 'cnl-captured': {
                // MAIN-world interceptor path (complements the webRequest path).
                const tab = sender.tab;
                if (tab && hasForwardablePayload(msg.formData)) {
                    const pkg = msg.formData.package;
                    await enqueue(tab, {
                        type: 'cnl',
                        title: (Array.isArray(pkg) ? pkg[0] : pkg) || tab.title || 'CNL',
                        content: { formData: msg.formData, sourceUrl: msg.sourceUrl || tab.url },
                        sourceUrl: tab.url,
                    }, 'window');
                }
                sendResponse({ ok: true });
                break;
            }
            case 'clipboard-captured': {
                // content/clipboard-observer.js already checked the
                // clipboardObserver setting and that the selection was
                // URL-shaped; skipAutoSend so a copy never sends silently.
                const tab = sender.tab;
                if (tab) {
                    const lines = msg.links.split('\n');
                    await enqueue(tab, {
                        type: 'clipboard',
                        title: lines[0] + (lines.length > 1 ? ' (+' + (lines.length - 1) + ' more)' : ''),
                        content: msg.links,
                        sourceUrl: msg.sourceUrl || tab.url,
                    }, 'inpage', { skipAutoSend: true });
                }
                sendResponse({ ok: true });
                break;
            }
            case 'panel:resize': {
                const winId = panelWindows[msg.tabId];
                if (winId !== undefined && typeof msg.height === 'number') {
                    const height = Math.max(240, Math.min(760, Math.round(msg.height)));
                    chrome.windows.update(winId, { height }).catch(() => {});
                }
                sendResponse({ ok: true });
                break;
            }
            case 'panel:getQueue': {
                sendResponse({ items: await getTabQueue(msg.tabId) });
                break;
            }
            case 'panel:remove': {
                await removeFromQueue(msg.tabId, msg.id);
                sendResponse({ ok: true });
                break;
            }
            case 'panel:clear': {
                await clearTabQueue(msg.tabId);
                sendResponse({ ok: true });
                break;
            }
            case 'panel:close': {
                // In-page overlay: tell the content script to remove the iframe.
                chrome.tabs.sendMessage(msg.tabId, { type: 'panel:close' }).catch(() => {});
                // Standalone window: close it if one is tracked for this tab.
                const winId = panelWindows[msg.tabId];
                if (winId !== undefined) {
                    delete panelWindows[msg.tabId];
                    chrome.windows.remove(winId).catch(() => {});
                }
                sendResponse({ ok: true });
                break;
            }
            case 'panel:send': {
                sendResponse(await sendItems(msg));
                break;
            }
            case 'captcha:solved': {
                const info = sender.tab && activeCaptchaTabs[sender.tab.id];
                if (!info) { sendResponse({ ok: false, error: 'no_active_captcha_tab' }); break; }
                const api = await getApi();
                try {
                    await api.solveCaptcha(info.deviceId, info.jobId, msg.token);
                    console.log('[JDrop] CAPTCHA', info.jobId, 'solved and submitted');
                    await finishCaptchaTab(sender.tab.id);
                    sendResponse({ ok: true });
                } catch (e) {
                    console.error('[JDrop] solveCaptcha failed for job', info.jobId, e);
                    sendResponse({ ok: false, error: e.message });
                }
                break;
            }
            case 'captcha:skip': {
                const info = sender.tab && activeCaptchaTabs[sender.tab.id];
                if (!info) { sendResponse({ ok: false, error: 'no_active_captcha_tab' }); break; }
                const api = await getApi();
                try {
                    await api.skipCaptcha(info.deviceId, info.jobId, msg.skipType);
                    console.log('[JDrop] CAPTCHA', info.jobId, 'skipped:', msg.skipType);
                    await finishCaptchaTab(sender.tab.id);
                    sendResponse({ ok: true });
                } catch (e) {
                    console.error('[JDrop] skipCaptcha failed for job', info.jobId, e);
                    sendResponse({ ok: false, error: e.message });
                }
                break;
            }
            case 'captcha:execute': {
                // v3/invisible (and Enterprise) CAPTCHAs need an explicit
                // grecaptcha.execute() call in the page's MAIN world - the
                // isolated-world content script can't reach `grecaptcha` itself.
                if (!sender.tab) { sendResponse({ ok: false, error: 'no_sender_tab' }); break; }
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: sender.tab.id },
                        world: 'MAIN',
                        args: [msg.siteKey, msg.v3action || '', !!msg.enterprise],
                        func: (siteKey, v3action, enterprise) => {
                            const g = enterprise ? (window.grecaptcha && window.grecaptcha.enterprise) : window.grecaptcha;
                            if (!g) return;
                            g.ready(() => {
                                const opts = v3action ? { action: v3action } : {};
                                g.execute(siteKey, opts);
                            });
                        },
                    });
                    sendResponse({ ok: true });
                } catch (e) {
                    console.error('[JDrop] captcha:execute failed:', e);
                    sendResponse({ ok: false, error: e.message });
                }
                break;
            }
            default:
                sendResponse({ ok: false, error: 'unknown_action' });
        }
    })();

    return true; // async sendResponse
});

// ---- settings changes ----

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.myjd_settings) return;
    const s = changes.myjd_settings.newValue || DEFAULT_SETTINGS;
    setupContextMenu();
    if (s.clickNLoad) enableCnl(); else disableCnl();
});

// ---- init ----

async function init() {
    try {
        const settings = await loadSettings();
        await setupContextMenu();
        if (settings.clickNLoad) await enableCnl(); else await disableCnl();
        console.log('[JDrop] service worker initialized');
    } catch (e) {
        console.error('[JDrop] init failed:', e);
    }
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
console.log('[JDrop] service worker loaded');
