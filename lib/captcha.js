// CAPTCHA helpers - job de-duplication, skip-type validation, and (once
// verified) parsing the "rawtoken" CAPTCHA response into what the solver
// content script needs to render a widget.
//
// Pure functions only (no chrome.*), so this is unit-tested directly, same as
// lib/cnl.js.

// The real jd.controlling.captcha.SkipRequest enum names (confirmed against
// JDownloader's own source). The old extension's UI used different, lowercase
// strings for its local-HTTP transport - those don't apply to this cloud API.
export const SKIP_TYPES = Object.freeze({
    SINGLE: 'SINGLE',
    BLOCK_HOSTER: 'BLOCK_HOSTER',
    BLOCK_ALL_CAPTCHAS: 'BLOCK_ALL_CAPTCHAS',
    BLOCK_PACKAGE: 'BLOCK_PACKAGE',
    REFRESH: 'REFRESH',
    STOP_CURRENT_ACTION: 'STOP_CURRENT_ACTION',
    TIMEOUT: 'TIMEOUT',
});

export function isValidSkipType(type) {
    return Object.values(SKIP_TYPES).includes(type);
}

// The three challenge-type strings the old extension's own code uses
// (confirmed via its captcha URL-path regex). "Enterprise" is not a distinct
// value anywhere in that reference - it is treated as a v2/v3 variant with a
// different script URL, see resolveWidgetKind below.
export const CHALLENGE_TYPES = Object.freeze({
    RECAPTCHA_V2: 'recaptchav2',
    RECAPTCHA_V3: 'recaptchav3',
    HCAPTCHA: 'hcaptcha',
});

// --- job de-duplication -------------------------------------------------
//
// The poller runs on a timer and must not re-open a tab for a job it already
// surfaced. `seenIds` is a plain array (JSON-serializable for chrome.storage).

export function diffNewJobs(jobs, seenIds) {
    const seen = new Set(seenIds || []);
    return (jobs || []).filter((job) => !seen.has(job.id));
}

export function addSeenIds(seenIds, newIds, { max = 200 } = {}) {
    const merged = [...(seenIds || []), ...newIds];
    // Cap growth - only the tail (most recent) matters for de-duplication.
    return merged.length > max ? merged.slice(merged.length - max) : merged;
}

// Drop ids that are no longer in the device's active job list, so the seen-set
// doesn't grow forever with jobs that were solved/skipped/expired long ago.
export function pruneSeenIds(seenIds, activeJobs) {
    const active = new Set((activeJobs || []).map((job) => job.id));
    return (seenIds || []).filter((id) => active.has(id));
}

// --- rawtoken response parsing ------------------------------------------
//
// UNVERIFIED: the shape of /captcha/get(id, "rawtoken") is not documented
// anywhere and has never been confirmed against a live pending job (see
// getCaptchaRawToken in lib/api.js). This parser encodes a best-effort guess
// at plausible field names and MUST be corrected against a real response
// before being trusted. Do not treat its output as reliable.

export function resolveWidgetKind(challengeType) {
    const t = (challengeType || '').toLowerCase();
    if (t.includes('hcaptcha')) return { library: 'hcaptcha', enterprise: false };
    if (t.includes('enterprise')) {
        return { library: t.includes('v3') || t.includes('invisible') ? 'recaptcha-v3' : 'recaptcha-v2', enterprise: true };
    }
    if (t.includes('v3') || t.includes('invisible')) return { library: 'recaptcha-v3', enterprise: false };
    return { library: 'recaptcha-v2', enterprise: false };
}

// UNVERIFIED - see module header. Field names (`siteKey`/`sitekey`, `type`,
// `action`) are a guess based on the equivalent fields used elsewhere in the
// old extension's job data, not a confirmed rawtoken shape.
export function parseRawTokenResponse(raw, job) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('parseRawTokenResponse: empty or non-object rawtoken response - UNVERIFIED shape, inspect a real response and fix this parser');
    }
    const siteKey = raw.siteKey || raw.sitekey || raw.key;
    if (!siteKey) {
        throw new Error('parseRawTokenResponse: no recognizable site key field in rawtoken response - UNVERIFIED shape, inspect a real response and fix this parser');
    }
    const challengeType = raw.challengeType || raw.type || (job && job.challengeType) || '';
    const { library, enterprise } = resolveWidgetKind(challengeType);
    return {
        id: job && job.id,
        hoster: (job && job.hoster) || raw.hoster || '',
        siteKey,
        challengeType,
        library,
        enterprise,
        v3action: raw.action || raw.v3action || '',
        // The actual hoster page to navigate the solving tab to (site keys are
        // domain-locked, so the widget must render on this real URL, not an
        // extension page) - field name guessed from the old extension's
        // captchaJob.siteUrl/.contextUrl usage, equally unverified.
        targetUrl: raw.siteUrl || raw.contextUrl || raw.targetUrl || raw.url || '',
    };
}
