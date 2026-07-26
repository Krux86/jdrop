// Clipboard-observer helpers - pure, tested.
//
// content/clipboard-observer.js can't import this directly (content scripts
// here are classic scripts, not ES modules - same constraint noted in
// content/captcha-solver.js), so it carries an inline copy of extractUrls.
// This module is the tested, canonical version; keep the two in sync.

const URL_LINE = /^https?:\/\/\S+$/;

// Returns the list of URLs if every non-empty line of `text` is URL-shaped,
// otherwise null (e.g. a sentence, a mix of prose and a link, empty input).
export function extractUrls(text) {
    if (!text) return null;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const urls = lines.filter((l) => URL_LINE.test(l));
    return urls.length === lines.length ? urls : null;
}
