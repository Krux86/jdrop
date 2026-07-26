// Tests the CAPTCHA helpers in lib/captcha.js (pure logic) and the wire
// protocol of lib/api.js's CAPTCHA deviceCall wrappers against a small fake
// MyJDownloader server (same technique as tests/api.test.js: independently
// re-derive secrets, verify signatures, decrypt bodies).
//
// NOT covered here (see the UNVERIFIED notes in lib/captcha.js and
// lib/api.js): the actual shape of the /captcha/get "rawtoken" response.
// That has never been confirmed against a real pending job, so
// parseRawTokenResponse is only tested against made-up input here - it
// documents the current best-effort guess, not a confirmed contract.
//
// Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { MyJDApi, API_ROOT } from '../lib/api.js';
import {
    SKIP_TYPES, isValidSkipType, CHALLENGE_TYPES,
    diffNewJobs, addSeenIds, pruneSeenIds,
    resolveWidgetKind, parseRawTokenResponse,
} from '../lib/captcha.js';

// ---- lib/captcha.js: pure logic -----------------------------------------

test('SKIP_TYPES only contains the real SkipRequest enum names', () => {
    assert.deepEqual(Object.values(SKIP_TYPES).sort(), [
        'BLOCK_ALL_CAPTCHAS', 'BLOCK_HOSTER', 'BLOCK_PACKAGE',
        'REFRESH', 'SINGLE', 'STOP_CURRENT_ACTION', 'TIMEOUT',
    ].sort());
});

test('isValidSkipType accepts real enum names and rejects the old extension\'s lowercase ones', () => {
    assert.ok(isValidSkipType('SINGLE'));
    assert.ok(isValidSkipType('BLOCK_HOSTER'));
    assert.ok(!isValidSkipType('single'));
    assert.ok(!isValidSkipType('hoster'));
    assert.ok(!isValidSkipType('not_a_real_type'));
});

test('diffNewJobs only returns jobs not already in the seen list', () => {
    const jobs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.deepEqual(diffNewJobs(jobs, [1, 3]), [{ id: 2 }]);
    assert.deepEqual(diffNewJobs(jobs, []), jobs);
    assert.deepEqual(diffNewJobs([], [1]), []);
});

test('addSeenIds appends and caps growth to the most recent entries', () => {
    const seen = [1, 2, 3];
    assert.deepEqual(addSeenIds(seen, [4, 5]), [1, 2, 3, 4, 5]);
    assert.deepEqual(addSeenIds(seen, [4, 5], { max: 4 }), [2, 3, 4, 5]);
});

test('pruneSeenIds drops ids no longer present in the active job list', () => {
    const seen = [1, 2, 3];
    const active = [{ id: 2 }, { id: 3 }, { id: 4 }];
    assert.deepEqual(pruneSeenIds(seen, active), [2, 3]);
});

test('resolveWidgetKind classifies challenge type strings', () => {
    assert.deepEqual(resolveWidgetKind(CHALLENGE_TYPES.RECAPTCHA_V2), { library: 'recaptcha-v2', enterprise: false });
    assert.deepEqual(resolveWidgetKind(CHALLENGE_TYPES.RECAPTCHA_V3), { library: 'recaptcha-v3', enterprise: false });
    assert.deepEqual(resolveWidgetKind(CHALLENGE_TYPES.HCAPTCHA), { library: 'hcaptcha', enterprise: false });
    assert.deepEqual(resolveWidgetKind('recaptchav2enterprise'), { library: 'recaptcha-v2', enterprise: true });
    assert.deepEqual(resolveWidgetKind('recaptchav3enterprise'), { library: 'recaptcha-v3', enterprise: true });
    assert.deepEqual(resolveWidgetKind(''), { library: 'recaptcha-v2', enterprise: false }); // unknown -> safest default
});

test('parseRawTokenResponse extracts the fields the solver needs (UNVERIFIED shape - see module header)', () => {
    const job = { id: 42, hoster: 'example-hoster.com', challengeType: 'recaptchav2' };
    const raw = { siteKey: 'SITE_KEY_ABC', siteUrl: 'https://example-hoster.com/download/1' };
    const details = parseRawTokenResponse(raw, job);
    assert.equal(details.id, 42);
    assert.equal(details.hoster, 'example-hoster.com');
    assert.equal(details.siteKey, 'SITE_KEY_ABC');
    assert.equal(details.library, 'recaptcha-v2');
    assert.equal(details.targetUrl, 'https://example-hoster.com/download/1');
});

test('parseRawTokenResponse throws a clear error when the site key field is missing', () => {
    assert.throws(() => parseRawTokenResponse({ siteUrl: 'https://x/y' }, { id: 1 }), /site key/);
});

test('parseRawTokenResponse throws a clear error on an empty response', () => {
    assert.throws(() => parseRawTokenResponse(null, { id: 1 }), /empty or non-object/);
});

// ---- lib/api.js CAPTCHA calls: wire protocol ----------------------------
//
// Minimal fake server: only needs connect() + device calls under /captcha/*.
// Mirrors tests/api.test.js's crypto reference implementation.

function sha256(bytes) { return new Uint8Array(nodeCrypto.createHash('sha256').update(bytes).digest()); }
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
    return Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]).toString('base64');
}
function decrypt(token, base64) {
    const { iv, key } = halves(token);
    const d = nodeCrypto.createDecipheriv('aes-128-cbc', key, iv);
    const pt = Buffer.concat([d.update(Buffer.from(base64, 'base64')), d.final()]);
    return JSON.parse(pt.toString('utf8'));
}

const EMAIL = 'user@example.com';
const PASSWORD = 'hunter2';
const SESSION_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DEVICE_ID = 'DEVICE-1';

function makeFakeServer() {
    const loginSecret = hashPassword(EMAIL, PASSWORD, 'server');
    const deviceSecret = hashPassword(EMAIL, PASSWORD, 'device');
    const deviceToken = deriveToken(deviceSecret, SESSION_TOKEN);
    const serverToken = deriveToken(loginSecret, SESSION_TOKEN);
    const calls = [];

    function ok(base64) { return { ok: true, status: 200, text: async () => base64 }; }

    async function fetchImpl(url, init) {
        calls.push({ url, init });
        const u = new URL(url);
        const path = u.pathname;
        const rid = Number(u.searchParams.get('rid'));

        if (path === '/my/connect') {
            return ok(encrypt(loginSecret, { rid, sessiontoken: SESSION_TOKEN, regaintoken: 'REGAIN' }));
        }
        if (path.startsWith('/t_')) {
            const rest = path.slice(3);
            const underscore = rest.indexOf('_');
            const afterSession = rest.slice(underscore + 1);
            const slash = afterSession.indexOf('/');
            const action = afterSession.slice(slash);

            const reqBody = decrypt(deviceToken, init.body);
            assert.equal(reqBody.url, action);
            assert.ok(Array.isArray(reqBody.params));
            for (const p of reqBody.params) assert.equal(typeof p, 'string', 'every param must be an individually JSON-encoded string');

            return ok(encrypt(deviceToken, { data: { action, params: reqBody.params.map((p) => JSON.parse(p)) }, rid: reqBody.rid }));
        }
        throw new Error('unexpected path in fake server: ' + path);
    }

    return { fetchImpl, calls, serverToken, deviceToken };
}

test('listCaptchaJobs calls /captcha/list with no params', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);

    const res = await api.listCaptchaJobs(DEVICE_ID);
    assert.equal(res.data.action, '/captcha/list');
    assert.deepEqual(res.data.params, []);
    assert.ok(server.calls.at(-1).url.startsWith(API_ROOT + '/t_' + SESSION_TOKEN + '_' + DEVICE_ID + '/captcha/list'));
});

test('getCaptchaRawToken calls /captcha/get with [id, "rawtoken"], both individually JSON-encoded', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);

    const res = await api.getCaptchaRawToken(DEVICE_ID, 42);
    assert.equal(res.data.action, '/captcha/get');
    assert.deepEqual(res.data.params, [42, 'rawtoken']);
});

test('solveCaptcha calls /captcha/solve with [id, result]', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);

    const res = await api.solveCaptcha(DEVICE_ID, 42, '03AGdBq27abcSOLVEDTOKEN');
    assert.equal(res.data.action, '/captcha/solve');
    assert.deepEqual(res.data.params, [42, '03AGdBq27abcSOLVEDTOKEN']);
});

test('skipCaptcha calls /captcha/skip with [id, type] using the real SkipRequest enum name', async () => {
    const server = makeFakeServer();
    const api = new MyJDApi({ fetchImpl: server.fetchImpl });
    await api.connect(EMAIL, PASSWORD);

    const res = await api.skipCaptcha(DEVICE_ID, 42, SKIP_TYPES.BLOCK_HOSTER);
    assert.equal(res.data.action, '/captcha/skip');
    assert.deepEqual(res.data.params, [42, 'BLOCK_HOSTER']);
});
