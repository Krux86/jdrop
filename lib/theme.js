'use strict';

// Shared theme helper for the popup and panel (classic script, not a module —
// loaded via <script src>). Applies the user's theme choice by stamping
// data-theme on <html>; 'auto' removes it so prefers-color-scheme takes over.
// The chosen value is stored via the service worker so both UIs stay in sync.

(function () {
    function applyTheme(theme) {
        const el = document.documentElement;
        if (theme === 'light' || theme === 'dark') el.setAttribute('data-theme', theme);
        else el.removeAttribute('data-theme');
    }

    async function loadAndApply() {
        let theme = 'auto';
        try {
            const res = await chrome.runtime.sendMessage({ type: 'getTheme' });
            if (res && res.theme) theme = res.theme;
        } catch { /* worker asleep — fall back to auto */ }
        applyTheme(theme);
        return theme;
    }

    async function setTheme(theme) {
        applyTheme(theme);
        try { await chrome.runtime.sendMessage({ type: 'setTheme', theme }); } catch { /* ignore */ }
    }

    window.MyJDTheme = { apply: applyTheme, loadAndApply, setTheme };
})();
