// Thin promise wrappers over chrome.storage for session + settings.
//
// - The MyJD session (tokens, no password) lives in chrome.storage.local so it
//   survives browser restarts.
// - The per-tab link queue lives in chrome.storage.session so it is cleared
//   when the browser closes but survives service-worker suspension.

const SESSION_KEY = 'myjd_session';
const SETTINGS_KEY = 'myjd_settings';
const QUEUE_KEY = 'myjd_request_queue';

export const DEFAULT_SETTINGS = {
    contextMenu: true,
    clickNLoad: true,
    theme: 'auto', // 'auto' | 'light' | 'dark'
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
