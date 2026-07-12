// Minimal MyJDownloader cloud API client.
//
// Talks to https://api.jdownloader.org directly with fetch + lib/crypto.js.
// No jQuery, no RequireJS, no offscreen document — this runs as-is inside the
// MV3 service worker. The request/response shapes mirror the official
// vendor/js/jdapi.js (connect, server calls, device calls) which is the
// reference implementation this ecosystem uses.
//
// A session is a plain, JSON-serializable object (no CryptoJS WordArrays), so
// it can be stored in chrome.storage and rehydrated directly:
//   { email, sessionToken, regainToken,
//     serverEncryptionToken: hex, deviceEncryptionToken: hex, deviceSecret: hex }

import {
    utf8ToBytes, bytesToHex, hexToBytes,
    deriveLoginSecret, deriveDeviceSecret, deriveEncryptionToken,
    signQuery, encryptPayload, decryptPayload,
} from './crypto.js';

export const API_ROOT = 'https://api.jdownloader.org';
export const APP_KEY = 'jdrop';

// Monotonic millisecond request id, echoed back by the server (replay guard).
let lastRid = 0;
function nextRid() {
    let rid = Date.now();
    if (rid <= lastRid) rid = lastRid + 1;
    lastRid = rid;
    return rid;
}

export class ApiError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

export class MyJDApi {
    // fetchImpl is injectable so tests can drive it without a network.
    constructor({ fetchImpl = globalThis.fetch.bind(globalThis), session = null } = {}) {
        this._fetch = fetchImpl;
        this.session = session; // null until connect()/restore()
    }

    isConnected() {
        return !!(this.session && this.session.sessionToken && this.session.serverEncryptionToken);
    }

    restore(session) {
        this.session = session;
    }

    // --- login ---------------------------------------------------------

    async connect(email, password) {
        const loginSecret = await deriveLoginSecret(email, password);
        const deviceSecret = await deriveDeviceSecret(email, password);

        // Order matters: email, appkey, rid — must match what gets signed.
        const rid = 0;
        const query = '/my/connect?email=' + encodeURIComponent(email) +
            '&appkey=' + encodeURIComponent(APP_KEY) +
            '&rid=' + rid;
        const signature = await signQuery(loginSecret, query);

        const decoded = await this._post(API_ROOT + query + '&signature=' + signature, null, loginSecret);
        if (decoded.rid !== rid) {
            throw new ApiError('connect: rid mismatch (possible replay)', { body: decoded });
        }

        const sessionToken = decoded.sessiontoken;
        const serverToken = await deriveEncryptionToken(loginSecret, sessionToken);
        const deviceToken = await deriveEncryptionToken(deviceSecret, sessionToken);

        this.session = {
            email,
            sessionToken,
            regainToken: decoded.regaintoken,
            serverEncryptionToken: bytesToHex(serverToken),
            deviceEncryptionToken: bytesToHex(deviceToken),
            deviceSecret: bytesToHex(deviceSecret),
        };
        return this.session;
    }

    async disconnect() {
        if (!this.isConnected()) { this.session = null; return; }
        try {
            await this._serverCall('/my/disconnect');
        } catch {
            // Best effort — clear the local session regardless.
        }
        this.session = null;
    }

    // Refresh an expired session using the stored regain token. The server
    // returns a new session token; both encryption tokens are re-derived from
    // it (server token from the old server token, device token from the stored
    // device secret) — mirroring the official jdapi reconnect flow.
    async reconnect() {
        this._assertConnected();
        if (!this.session.regainToken || !this.session.deviceSecret) {
            throw new ApiError('cannot reconnect: session incomplete, please sign in again');
        }
        const oldServerToken = hexToBytes(this.session.serverEncryptionToken);
        const deviceSecret = hexToBytes(this.session.deviceSecret);
        const rid = nextRid();
        const query = '/my/reconnect?appkey=' + encodeURIComponent(APP_KEY) +
            '&sessiontoken=' + this.session.sessionToken +
            '&regainToken=' + this.session.regainToken +
            '&rid=' + rid;
        const signature = await signQuery(oldServerToken, query);

        const decoded = await this._post(API_ROOT + query + '&signature=' + signature, null, oldServerToken);
        const newSessionToken = decoded.sessiontoken;
        const newServerToken = await deriveEncryptionToken(oldServerToken, newSessionToken);
        const newDeviceToken = await deriveEncryptionToken(deviceSecret, newSessionToken);

        this.session = {
            ...this.session,
            sessionToken: newSessionToken,
            regainToken: decoded.regaintoken,
            serverEncryptionToken: bytesToHex(newServerToken),
            deviceEncryptionToken: bytesToHex(newDeviceToken),
        };
        return this.session;
    }

    // Run an API call; if it fails with 403 (expired session), reconnect once
    // and retry. `onSessionRefreshed` lets the caller persist the new tokens.
    async _withReconnect(fn) {
        try {
            return await fn();
        } catch (e) {
            if (e instanceof ApiError && e.status === 403 && this.session && this.session.regainToken) {
                try {
                    await this.reconnect();
                } catch {
                    // Regain token no longer valid — a fresh sign-in is required.
                    const err = new ApiError('session expired — please sign in again', { status: 401 });
                    err.needsLogin = true;
                    throw err;
                }
                const result = await fn();
                if (this.onSessionRefreshed) {
                    try { await this.onSessionRefreshed(this.session); } catch { /* ignore */ }
                }
                return result;
            }
            throw e;
        }
    }

    // --- server calls --------------------------------------------------

    async listDevices() {
        return this._withReconnect(async () => {
            const res = await this._serverCall('/my/listdevices');
            return Array.isArray(res.list) ? res.list : [];
        });
    }

    // --- device calls --------------------------------------------------

    // params is the array of positional arguments the device method expects.
    // For /linkgrabberv2/addLinks that is a single AddLinksQuery object.
    //
    // The MyJD device API expects each argument in `params` to be *individually
    // JSON-encoded* (i.e. an array of JSON strings), not raw nested objects.
    // Passing an object here would produce a malformed call that JDownloader
    // silently ignores.
    async deviceCall(deviceId, action, params = []) {
        this._assertConnected();
        return this._withReconnect(async () => {
            const deviceToken = hexToBytes(this.session.deviceEncryptionToken);
            const rid = nextRid();
            const encodedParams = params.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)));
            const payload = { url: action, params: encodedParams, apiVer: 1, rid };
            const body = await encryptPayload(deviceToken, payload);
            const url = API_ROOT + '/t_' + this.session.sessionToken + '_' + deviceId + action;

            const decoded = await this._post(url, body, deviceToken);
            if (decoded && decoded.rid !== undefined && decoded.rid !== rid) {
                throw new ApiError('device call: rid mismatch', { body: decoded });
            }
            return decoded;
        });
    }

    // Add links/containers to a device's linkgrabber. `query` is an
    // AddLinksQuery, e.g. { links, packageName, autostart, destinationFolder, ... }.
    addLinks(deviceId, query) {
        return this.deviceCall(deviceId, '/linkgrabberv2/addLinks', [query]);
    }

    // --- internals -----------------------------------------------------

    _assertConnected() {
        if (!this.isConnected()) throw new ApiError('not connected');
    }

    async _serverCall(action, params = {}) {
        this._assertConnected();
        const serverToken = hexToBytes(this.session.serverEncryptionToken);
        const rid = nextRid();
        const query = action + '?sessiontoken=' + this.session.sessionToken + '&rid=' + rid;

        const unencrypted = { apiVer: 1, params: [], url: query, rid };
        if (Object.keys(params).length > 0) unencrypted.params = [params];

        const body = await encryptPayload(serverToken, unencrypted);
        const signature = await signQuery(serverToken, query);
        const url = API_ROOT + query + '&signature=' + signature;

        const decoded = await this._post(url, body, serverToken);
        if (decoded && decoded.rid !== undefined && decoded.rid !== rid) {
            throw new ApiError('server call: rid mismatch', { body: decoded });
        }
        return decoded;
    }

    // POST `body` (a base64 string or null) and decrypt the response with
    // `decryptToken` (raw bytes). Returns the parsed JSON object.
    async _post(url, body, decryptToken) {
        let resp;
        try {
            resp = await this._fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/aesjson-jd; charset=utf-8' },
                body: body === null ? undefined : body,
            });
        } catch (e) {
            throw new ApiError('network error: ' + e.message);
        }

        const text = await resp.text();
        if (!resp.ok) {
            // Error bodies come back as plain JSON (not encrypted).
            let parsed;
            try { parsed = JSON.parse(text); } catch { parsed = text; }
            throw new ApiError('HTTP ' + resp.status, { status: resp.status, body: parsed });
        }

        let plaintext;
        try {
            plaintext = await decryptPayload(decryptToken, text);
        } catch (e) {
            throw new ApiError('failed to decrypt response: ' + e.message, { body: text });
        }
        try {
            return JSON.parse(plaintext);
        } catch (e) {
            throw new ApiError('response was not JSON: ' + e.message, { body: plaintext });
        }
    }
}
