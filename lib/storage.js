// Thin promise wrappers over chrome.storage for session + settings.
//
// - The MyJD session (tokens, no password) lives in chrome.storage.local so it
//   survives browser restarts.
// - The per-tab link queue lives in chrome.storage.session so it is cleared
//   when the browser closes but survives service-worker suspension.

const SESSION_KEY = 'myjd_session';
const SETTINGS_KEY = 'myjd_settings';
const QUEUE_KEY = 'myjd_request_queue';
const SEEN_CAPTCHA_IDS_KEY = 'myjd_seen_captcha_ids';

export const DEFAULT_SETTINGS = {
    contextMenu: true,
    clickNLoad: true,
    theme: 'auto', // 'auto' | 'light' | 'dark'
    autoSend: false, // send immediately without opening the panel - off by default
    defaultDeviceId: null, // remembered from the last successful send
    rememberedOptions: { autostart: false, destinationFolder: '' }, // NOT packageName/downloadPassword - those are per-item, not sticky
    rememberedEmail: '', // login form pre-fill - never the password
};

export async function loadSession() {
    const res = await chrome.storage.local.get(SESSION_KEY);
    return res[SESSION_KEY] || null;
}

export async function saveSession(session) {
    await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function clearSession() {
    await chrome.storage.local.remove(SESSION_KEY);
}

export async function loadSettings() {
    const res = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
}

export async function saveSettings(settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadQueue() {
    const res = await chrome.storage.session.get(QUEUE_KEY);
    return res[QUEUE_KEY] || {};
}

export async function saveQueue(queue) {
    await chrome.storage.session.set({ [QUEUE_KEY]: queue });
}

// CAPTCHA job ids the poller has already surfaced (opened a tab for), so a
// repeat poll doesn't re-open one. Session-scoped like the queue - a fresh
// browser session re-polls everything currently pending, which is fine since
// jobs are re-fetched from the device each time anyway.
export async function loadSeenCaptchaIds() {
    const res = await chrome.storage.session.get(SEEN_CAPTCHA_IDS_KEY);
    return res[SEEN_CAPTCHA_IDS_KEY] || [];
}

export async function saveSeenCaptchaIds(ids) {
    await chrome.storage.session.set({ [SEEN_CAPTCHA_IDS_KEY]: ids });
}
