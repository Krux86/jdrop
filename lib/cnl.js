// Click'N'Load (CNL) helpers — the heart of the "works with a remote
// JDownloader" behaviour.
//
// A local JDownloader on 127.0.0.1:9666 is unreachable when JD runs on another
// machine (Docker/NAS). Instead of talking CNL over the network, we capture the
// raw CNL form data the hoster page would have POSTed, wrap it into a
// dummycnl.jdownloader.org URL, and hand that to the device over the cloud API
// via /linkgrabberv2/addLinks. JDownloader recognizes that URL and decrypts the
// embedded CNL2 payload locally. This mirrors the mechanism proven end-to-end
// in the upstream extension fix.
//
// Pure functions only (no chrome.*), so this is unit-tested directly.

import { utf8ToBytes, bytesToHex } from './crypto.js';

// The localhost endpoints a CNL-enabled hoster hits.
const CNL_HOSTS = ['localhost:9666', '127.0.0.1:9666'];

export const CNL_ENDPOINTS = {
    JD_CHECK: '/jdcheck.js',
    CROSSDOMAIN: '/crossdomain.xml',
    ADD_CRYPTED: '/flash/addcrypted2',
    ADD: '/flash/add',
};

export function isCnlUrl(url) {
    return CNL_HOSTS.some((host) => url.includes(host));
}

export function cnlEndpointType(url) {
    if (url.includes(CNL_ENDPOINTS.JD_CHECK)) return 'JD_CHECK';
    if (url.includes(CNL_ENDPOINTS.CROSSDOMAIN)) return 'CROSSDOMAIN';
    if (url.includes(CNL_ENDPOINTS.ADD_CRYPTED)) return 'ADD_CRYPTED';
    if (url.includes(CNL_ENDPOINTS.ADD)) return 'ADD';
    return 'UNKNOWN';
}

// A CNL "add" request carries an actual payload we can forward. jdcheck.js and
// crossdomain.xml are just presence probes.
export function isCnlPayloadType(type) {
    return type === 'ADD' || type === 'ADD_CRYPTED';
}

// Normalize captured form data: some transports hand arrays (e.g. ["v"]) per
// key, some hand plain strings. Collapse to plain strings.
export function normalizeCnlFormData(formData) {
    const out = {};
    if (!formData) return out;
    for (const [key, value] of Object.entries(formData)) {
        out[key] = Array.isArray(value) ? value[0] : value;
    }
    return out;
}

// True if the captured data actually carries links/containers worth forwarding.
export function hasForwardablePayload(formData) {
    const f = normalizeCnlFormData(formData);
    return !!(f.crypted || f.dlc || f.urls);
}

// Encode raw CNL form data into a dummycnl URL that JDownloader decrypts
// locally. Matches the upstream encoding: hex(UTF-8(JSON(formData))).
export function buildDummyCnlUrl(formData) {
    const normalized = normalizeCnlFormData(formData);
    const hex = bytesToHex(utf8ToBytes(JSON.stringify(normalized)));
    return 'https://dummycnl.jdownloader.org/#' + encodeURIComponent(hex);
}

// Build the AddLinksQuery for a captured CNL request. When the payload is a
// plain `urls` list (unencrypted CNL), forward those directly; otherwise wrap
// the encrypted CNL2 data in the dummycnl URL.
export function cnlToAddLinksQuery(formData, { sourceUrl } = {}) {
    const f = normalizeCnlFormData(formData);
    const query = {};

    if (f.crypted || f.dlc) {
        query.links = buildDummyCnlUrl(f);
    } else if (f.urls) {
        query.links = f.urls;
    } else {
        query.links = '';
    }

    if (f.source) query.sourceUrl = f.source;
    else if (sourceUrl) query.sourceUrl = sourceUrl;

    if (f.package) query.packageName = f.package;
    if (f.passwords) query.downloadPassword = f.passwords;

    return query;
}
