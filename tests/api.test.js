// Exercises lib/api.js against a fake MyJDownloader server implemented with
// node:crypto. The fake server independently re-derives the same secrets,
// verifies every request signature, decrypts every request body, and encrypts
// its responses exactly as the real server would. So a passing test means the
// client's connect handshake, server-call signing, and device-call framing are
// protocol-correct — not merely shaped right. Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { MyJDApi, API_ROOT, APP_KEY } from '../lib/api.js';

// ---- crypto reference (node:crypto), mirroring the MyJD protocol ----

function sha256(bytes) {
    return new Uint8Array(nodeCrypto.createHash('sha256').update(bytes).digest());
}
function hmacHex(keyBytes, str) {
    return nodeCrypto.createHmac('sha256', keyBytes).update(Buffer.from(str, 'utf8')).digest('hex');
}
function hashPassword(email, password, domain) {
    return sha256(Buffer.from(email.toLowerCase() + password + domain.toLowerCase(), 'utf8'));
}
function deriveToken(oldToken, sessionTokenHex) {
    return sha256(Buffer.concat([Buffer.from(oldToken), Buffer.from(sessionTokenHex, 'hex')]));
}
function halves(token) {
    const iv = Buffer.from(token).subarray(0, token.length / 2);
    const key = Buffer.from(token).subarray(token.length / 2);
    return { iv, key };
}
function encrypt(token, obj) {
    const { iv, key } = halves(token);
    const c = nodeCrypto.createCipheriv('aes-128-cbc', key, iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    return ct.toString('base64');
}
function decrypt(token, base64) {
    const { iv, key } = halves(token);
    const d = nodeCrypto.createDecipheriv('aes-128-cbc', key, iv);
    const pt = Buffer.concat([d.update(Buffer.from(base64, 'base64')), d.final()]);
    return JSON.parse(pt.toString('utf8'));
}

// ---- fake MyJDownloader server as a fetch(url, init) implementation ----

const EMAIL = 'user@example.com';
const PASSWORD = 'hunter2';
const SESSION_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REGAIN_TOKEN = '0011223344556677889900aabbccddee';
const DEVICE = { name: 'jd-docker', id: 'DEVICE-1', type: 'jd' };

function makeFakeServer() {
    const loginSecret = hashPassword(EMAIL, PASSWORD, 'server');
    const deviceSecret = hashPassword(EMAIL, PASSWORD, 'device');
    const calls = [];

    // Mutable session state so we can model expiry + reconnect (token rotation).
    const state = {
        valid: true,
        sessionToken: SESSION_TOKEN,
        regainToken: REGAIN_TOKEN,
        serverToken: deriveToken(loginSecret, SESSION_TOKEN),
        deviceToken: deriveToken(deviceSecret, SESSION_TOKEN),
        failNextServerCall: false,
    };
    const initialTokens = { serverToken: state.serverToken, deviceToken: state.deviceToken };

    function ok(base64) {
        return { ok: true, status: 200, text: async () => base64 };
    }
    function fail(status, obj) {
        return { ok: false, status, text: async () => JSON.stringify(obj) };
    }

    async function fetchImpl(url, init) {
        calls.push({ url, init });
        const u = new URL(url);
        const path = u.pathname;

        // Split query into "signed part" (everything before &signature=) and signature.
        const rawQuery = u.search; // includes leading '?'
        const sigMatch = rawQuery.match(/&signature=([a-f0-9]+)$/);
        const signature = sigMatch ? sigMatch[1] : null;
        const signedQuery = sigMatch ? path + rawQuery.slice(0, sigMatch.index) : path + rawQuery;
        const rid = Number(u.searchParams.get('rid'));

        // --- connect ---
        if (path === '/my/connect') {
            assert.equal(signature, hmacHex(loginSecret, signedQuery), 'connect signature mismatch');
            return ok(encrypt(loginSecret, { rid, sessiontoken: SESSION_TOKEN, regaintoken: REGAIN_TOKEN }));
        }

        // --- reconnect (recovery path, works even while the session is invalid) ---
        if (path === '/my/reconnect') {
            assert.equal(signature, hmacHex(state.serverToken, signedQuery), 'reconnect signature mismatch');
            // Parameter names are matched verbatim, so read them the way the
            // real server does: a camelCase `regainToken` simply isn't found.
            assert.equal(u.searchParams.get('sessiontoken'), state.sessionToken,
                'reconnect: wrong or missing lower-case sessiontoken param');
            assert.equal(u.searchParams.get('regaintoken'), state.regainToken,
                'reconnect: wrong or missing lower-case regaintoken param');
            const newSession = 'ffeeddccbbaa00112233445566778899';
            const newRegain = 'aabbccddeeff00112233445566778899';
            // Response is encrypted with the OLD server token (compute before rotating).
            const resp = encrypt(state.serverToken, { rid, sessiontoken: newSession, regaintoken: newRegain });
            state.serverToken = deriveToken(state.serverToken, newSession);
            state.deviceToken = deriveToken(deviceSecret, newSession);
            state.sessionToken = newSession;
            // Single-use, like the real one: the old regain token is now dead.
            state.regainToken = newRegain;
            state.valid = true;
            return ok(resp);
        }

        // --- device call: /t_<session>_<deviceId><action> ---
        if (path.startsWith('/t_')) {
            if (!state.valid) return fail(403, { src: 'test', type: 'TOKEN_INVALID' });
            const rest = path.slice(3); // "<session>_<deviceId>/action..."
            const underscore = rest.indexOf('_');
            const session = rest.slice(0, underscore);
            const afterSession = rest.slice(underscore + 1);
            const slash = afterSession.indexOf('/');
            const deviceId = afterSession.slice(0, slash);
            const action = afterSession.slice(slash);
            assert.equal(session, state.sessionToken, 'device call: wrong session token in URL');

            const reqBody = decrypt(state.deviceToken, init.body);
            assert.equal(reqBody.url, action, 'device call: body.url should equal action');
            // Protocol requirement: each element of params must be an individually
            // JSON-encoded string, not a raw object. Decode it the way JDownloader would.
            assert.ok(Array.isArray(reqBody.params), 'device call: params must be an array');
            for (const p of reqBody.params) {
                assert.equal(typeof p, 'string', 'device call: each param must be a JSON string');
            }
            if (action === '/linkgrabberv2/addLinks') {
                const decodedArg = JSON.parse(reqBody.params[0]);
                return ok(encrypt(state.deviceToken, { data: { deviceId, added: decodedArg }, rid: reqBody.rid }));
            }
            return ok(encrypt(state.deviceToken, { data: null, rid: reqBody.rid }));
        }

        // --- server call (POST /my/...) ---
        if (!state.valid) return fail(403, { src: 'test', type: 'TOKEN_INVALID' });
        if (state.failNextServerCall) {
            state.failNextServerCall = false;
            return fail(500, { src: 'test', type: 'SERVER_ERROR' });
        }
        assert.equal(signature, hmacHex(state.serverToken, signedQuery), 'server call signature mismatch');
        const reqBody = decrypt(state.serverToken, init.body);
        assert.equal(reqBody.url, signedQuery, 'server call: body.url should match signed query');

        if (path === '/my/listdevices') {
            return ok(encrypt(state.serverToken, { list: [DEVICE], rid }));
        }
        if (path === '/my/disconnect') {
            return ok(encrypt(state.serverToken, { rid }));
        }
        return fail(404, { src: 'test', type: 'UNKNOWN_ACTION' });
    }

    return {
        fetchImpl,
        calls,
        tokens: initialTokens,
        expire: () => { state.valid = false; },
        // One-shot failure for the next server call that gets past the session
        // check - i.e. the retry that follows a successful reconnect.
        failNextServerCall: () => { state.failNextServerCall = true; },
    };
}

// ---- tests ----

test('connect performs the signed handshake and derives tokens', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });

    const session = await api.connect(EMAIL, PASSWORD);

    assert.equal(session.sessionToken, SESSION_TOKEN);
    assert.equal(session.regainToken, REGAIN_TOKEN);
    assert.ok(api.isConnected());
    // The derived server token must match what the server computed.
    assert.equal(session.serverEncryptionToken, Buffer.from(server.tokens.serverToken).toString('hex'));
    assert.equal(session.deviceEncryptionToken, Buffer.from(server.tokens.deviceToken).toString('hex'));

    // First call was POST /my/connect with the appkey in the query.
    assert.equal(server.calls[0].init.method, 'POST');
    assert.ok(server.calls[0].url.startsWith(API_ROOT + '/my/connect?'));
    assert.ok(server.calls[0].url.includes('appkey=' + APP_KEY));
});

test('listDevices returns the device list from a server call', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);

    const devices = await api.listDevices();
    assert.deepEqual(devices, [DEVICE]);
});

test('addLinks issues a device call to /t_<session>_<deviceId>/linkgrabberv2/addLinks', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);

    const query = { links: 'https://example.com/file.zip', packageName: 'Test', autostart: false };
    const res = await api.addLinks('DEVICE-1', query);

    // The fake server echoes back the decrypted query, proving the device-token
    // encrypted body round-tripped correctly.
    assert.deepEqual(res.data.added, query);
    assert.equal(res.data.deviceId, 'DEVICE-1');

    const deviceCall = server.calls.at(-1);
    assert.equal(deviceCall.url, API_ROOT + '/t_' + SESSION_TOKEN + '_DEVICE-1/linkgrabberv2/addLinks');
});

test('calls before connect throw a clear error', async () => {
    const api = new MyJDApi({ fetchImpl: async () => { throw new Error('should not be called'); } });
    await assert.rejects(() => api.listDevices(), /not connected/);
});

test('a restored session can make calls without re-connecting', async () => {
    const server = makeFakeServer();
    const first = new MyJDApi({ fetchImpl: server.fetchImpl });
    const session = await first.connect(EMAIL, PASSWORD);

    // Simulate a fresh service-worker start: new client, session from storage.
    const restored = new MyJDApi({ fetchImpl: server.fetchImpl, session });
    assert.ok(restored.isConnected());
    const devices = await restored.listDevices();
    assert.deepEqual(devices, [DEVICE]);
});

test('an expired session (HTTP 403) transparently reconnects and retries', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);
    const firstSession = api.session.sessionToken;

    let refreshed = null;
    api.onSessionRefreshed = (s) => { refreshed = s; };

    server.expire(); // the server now 403s until a reconnect happens

    // listDevices should hit 403, reconnect via the regain token, and retry.
    const devices = await api.listDevices();
    assert.deepEqual(devices, [DEVICE]);

    // The session token rotated and the persist hook fired with the new tokens.
    assert.notEqual(api.session.sessionToken, firstSession);
    assert.ok(refreshed);
    assert.equal(refreshed.sessionToken, api.session.sessionToken);

    // A follow-up device call also works with the refreshed session.
    const res = await api.addLinks('DEVICE-1', { links: 'https://x/y.zip' });
    assert.equal(res.data.deviceId, 'DEVICE-1');

    // The reconnect endpoint was actually called.
    assert.ok(server.calls.some((c) => c.url.includes('/my/reconnect')));
});

test('a rotated regain token is persisted even when the retried call fails', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);

    const saved = [];
    api.onSessionRefreshed = (s) => { saved.push({ ...s }); };

    server.expire(); // first listDevices 403s, triggering the reconnect
    server.failNextServerCall(); // ...and the retry right after it blows up

    await assert.rejects(() => api.listDevices());

    // The reconnect consumed the old regain token, so the new one has to reach
    // storage regardless of the retry - otherwise the next expiry is stuck with
    // a spent token and can only be resolved by signing in again.
    assert.equal(saved.length, 1, 'the refreshed session must be persisted before the retry');
    assert.notEqual(saved[0].regainToken, REGAIN_TOKEN);
    assert.equal(saved[0].regainToken, api.session.regainToken);

    // Proof that it is genuinely usable: a later call succeeds on the new token.
    assert.deepEqual(await api.listDevices(), [DEVICE]);
});

test('reconnect fails cleanly when the session lacks a regain token', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);
    delete api.session.regainToken; // simulate an incomplete/legacy session
    server.expire();
    // Without a regain token we can't recover — the 403 should surface.
    await assert.rejects(() => api.listDevices(), (err) => {
        assert.equal(err.name, 'ApiError');
        return true;
    });
});

test('HTTP error responses surface as ApiError with status', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);
    // An unknown server action makes the fake server return 404.
    await assert.rejects(() => api._serverCall('/my/does-not-exist'), (err) => {
        assert.equal(err.name, 'ApiError');
        assert.equal(err.status, 404);
        return true;
    });
});
