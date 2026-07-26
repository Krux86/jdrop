// CAPTCHA solver - isolated world.
//
// UNVERIFIED end-to-end: this depends on the shape background.js's
// parseRawTokenResponse (lib/captcha.js) produces from the CAPTCHA "rawtoken"
// API response, which has never been confirmed against a real pending job.
// Do not treat this as working until checked against a live account.
//
// Activates only on a tab background.js itself opened for CAPTCHA solving,
// identified by a '#jdrop-captcha=<json>' URL fragment it sets when creating
// the tab (site keys are domain-locked, so this runs on the real hoster page,
// not an extension page - see openCaptchaTab in background.js).

(function () {
    if (window.__jdropCaptchaSolver) return;
    window.__jdropCaptchaSolver = true;

    const MARKER = '#jdrop-captcha=';
    if (!window.location.hash.startsWith(MARKER)) return;

    let job;
    try {
        job = JSON.parse(decodeURIComponent(window.location.hash.slice(MARKER.length)));
    } catch (e) {
        console.error('[JDrop] captcha-solver: could not parse job from URL fragment', e);
        return;
    }

    console.log('[JDrop] captcha-solver active for job', job.id, job.library);

    let pollHandle = null;

    function send(msg) {
        chrome.runtime.sendMessage(msg).catch(() => { /* worker asleep / tab closing - fine */ });
    }

    function injectWidget() {
        const container = document.createElement('div');
        container.id = 'jdrop-captcha-widget';
        container.style.cssText = 'position:fixed;top:16px;left:16px;z-index:2147483647;background:#fff;padding:16px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.3);';

        const label = document.createElement('div');
        label.textContent = 'JDrop: solve this CAPTCHA for ' + (job.hoster || 'JDownloader');
        label.style.cssText = 'font:13px sans-serif;margin-bottom:8px;color:#222;';
        container.appendChild(label);

        const widget = document.createElement('div');
        const script = document.createElement('script');
        if (job.library === 'hcaptcha') {
            widget.className = 'h-captcha';
            widget.setAttribute('data-sitekey', job.siteKey);
            script.src = 'https://hcaptcha.com/1/api.js';
        } else {
            widget.className = 'g-recaptcha';
            widget.setAttribute('data-sitekey', job.siteKey);
            if (job.library === 'recaptcha-v3') widget.setAttribute('data-size', 'invisible');
            script.src = job.enterprise
                ? 'https://www.google.com/recaptcha/enterprise.js'
                : 'https://www.google.com/recaptcha/api.js';
        }
        container.appendChild(widget);

        if (job.library === 'recaptcha-v3') {
            script.addEventListener('load', () => {
                send({ type: 'captcha:execute', siteKey: job.siteKey, v3action: job.v3action, enterprise: job.enterprise });
            });
        }
        container.appendChild(script);

        const skipBtn = document.createElement('button');
        skipBtn.textContent = 'Skip';
        skipBtn.style.cssText = 'margin-top:8px;font:13px sans-serif;';
        skipBtn.addEventListener('click', () => {
            stopPolling();
            send({ type: 'captcha:skip', skipType: 'SINGLE' });
        });
        container.appendChild(skipBtn);

        (document.body || document.documentElement).appendChild(container);
    }

    function startTokenPolling() {
        pollHandle = setInterval(() => {
            const recaptchaTextareas = document.querySelectorAll('textarea[id^="g-recaptcha-response"]');
            for (const el of recaptchaTextareas) {
                if (el.value && el.value.length > 30) { onSolved(el.value); return; }
            }
            const hcaptchaTextareas = document.querySelectorAll('textarea[name="h-captcha-response"]');
            for (const el of hcaptchaTextareas) {
                if (el.value && el.value.length > 30) { onSolved(el.value); return; }
            }
        }, 500);
    }

    function stopPolling() {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    }

    function onSolved(token) {
        stopPolling();
        send({ type: 'captcha:solved', token });
    }

    window.addEventListener('beforeunload', stopPolling);

    injectWidget();
    startTokenPolling();
})();
