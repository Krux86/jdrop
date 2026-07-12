// Cross-checks lib/crypto.js (Web Crypto API) against Node's OpenSSL-backed
// node:crypto for identical inputs. Two independent crypto stacks agreeing on
// every byte is strong evidence the MyJDownloader handshake is implemented
// correctly. Run with: node --test
//
// No third-party dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import {
    utf8ToBytes, bytesToHex, hexToBytes, concatBytes,
    sha256, hmacSha256, aesCbcEncrypt, aesCbcDecrypt,
    deriveLoginSecret, deriveDeviceSecret, deriveEncryptionToken,
    splitToken, signQuery, encryptPayload, decryptPayload,
} from '../lib/crypto.js';

// ---- reference helpers using node:crypto (independent implementation) ----

function refSha256(bytes) {
    return new Uint8Array(nodeCrypto.createHash('sha256').update(bytes).digest());
}
function refHmac(keyBytes, msgBytes) {
    return new Uint8Array(nodeCrypto.createHmac('sha256', keyBytes).update(msgBytes).digest());
}
function refAesEncrypt(keyBytes, ivBytes, plaintextBytes) {
    const c = nodeCrypto.createCipheriv('aes-128-cbc', keyBytes, ivBytes);
    return new Uint8Array(Buffer.concat([c.update(plaintextBytes), c.final()]));
}

// ---- hex / byte helpers ----

test('bytesToHex / hexToBytes round-trip', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa5, 0xff, 0x10]);
    assert.equal(bytesToHex(bytes), '000fa5ff10');
    assert.deepEqual(hexToBytes('000fa5ff10'), bytes);
});

test('concatBytes joins in order', () => {
    assert.deepEqual(
        concatBytes(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
        new Uint8Array([1, 2, 3, 4])
    );
});

// ---- hashing / signing vs node:crypto ----

test('sha256 matches node:crypto', async () => {
    const msg = utf8ToBytes('the quick brown fox');
    assert.deepEqual(await sha256(msg), refSha256(msg));
});

test('hmacSha256 matches node:crypto', async () => {
    const key = utf8ToBytes('secret-key-material');
    const msg = utf8ToBytes('/my/connect?email=a&appkey=b&rid=123');
    assert.deepEqual(await hmacSha256(key, msg), refHmac(key, msg));
});

// ---- MyJDownloader secret derivation ----

test('deriveLoginSecret = SHA256(email.toLowerCase()+password+"server")', async () => {
    const email = 'User@Example.COM';
    const password = 'hunter2';
    const expected = refSha256(utf8ToBytes('user@example.com' + 'hunter2' + 'server'));
    assert.deepEqual(await deriveLoginSecret(email, password), expected);
});

test('deriveDeviceSecret uses the "device" domain', async () => {
    const expected = refSha256(utf8ToBytes('user@example.com' + 'hunter2' + 'device'));
    assert.deepEqual(await deriveDeviceSecret('User@Example.COM', 'hunter2'), expected);
});

test('deriveEncryptionToken = SHA256(oldToken || sessionTokenBytes)', async () => {
    const loginSecret = await deriveLoginSecret('user@example.com', 'hunter2');
    const sessionTokenHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const expected = refSha256(concatBytes(loginSecret, hexToBytes(sessionTokenHex)));
    assert.deepEqual(await deriveEncryptionToken(loginSecret, sessionTokenHex), expected);
});

// ---- token split ----

test('splitToken splits a 32-byte token into 16-byte iv + 16-byte key', () => {
    const token = new Uint8Array(32).map((_, i) => i);
    const { iv, key } = splitToken(token);
    assert.equal(iv.length, 16);
    assert.equal(key.length, 16);
    assert.deepEqual(iv, token.slice(0, 16));
    assert.deepEqual(key, token.slice(16));
});

// ---- AES-128-CBC vs node:crypto ----

test('aesCbcEncrypt matches node:crypto (PKCS#7 padding)', async () => {
    const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const iv = hexToBytes('101112131415161718191a1b1c1d1e1f');
    const plaintext = utf8ToBytes('{"apiVer":1,"params":[]}');
    assert.deepEqual(await aesCbcEncrypt(key, iv, plaintext), refAesEncrypt(key, iv, plaintext));
});

test('aesCbcDecrypt reverses aesCbcEncrypt', async () => {
    const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const iv = hexToBytes('101112131415161718191a1b1c1d1e1f');
    const plaintext = utf8ToBytes('some payload of arbitrary length 12345');
    const ct = await aesCbcEncrypt(key, iv, plaintext);
    assert.deepEqual(await aesCbcDecrypt(key, iv, ct), plaintext);
});

// ---- query signing ----

test('signQuery = hex(HMAC-SHA256(token, query))', async () => {
    const token = await deriveLoginSecret('user@example.com', 'hunter2');
    const query = '/my/connect?email=user%40example.com&appkey=jdrop&rid=1700000000000';
    const expected = bytesToHex(refHmac(token, utf8ToBytes(query)));
    assert.equal(await signQuery(token, query), expected);
});

// ---- payload encrypt / decrypt round-trip and cross-decrypt ----

test('encryptPayload / decryptPayload round-trips a JS value', async () => {
    const token = await deriveEncryptionToken(
        await deriveDeviceSecret('user@example.com', 'hunter2'),
        'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    );
    const value = { apiVer: 1, url: '/linkgrabberv2/addLinks', params: [{ links: 'http://x/y.zip' }], rid: 42 };
    const body = await encryptPayload(token, value);
    const decoded = JSON.parse(await decryptPayload(token, body));
    assert.deepEqual(decoded, value);
});

test('decryptPayload can decode a body encrypted by node:crypto', async () => {
    const token = await deriveEncryptionToken(
        await deriveLoginSecret('user@example.com', 'hunter2'),
        'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    );
    const { iv, key } = splitToken(token);
    const value = { sessiontoken: 'abc', regaintoken: 'def' };
    const ct = refAesEncrypt(key, iv, utf8ToBytes(JSON.stringify(value)));
    const base64 = Buffer.from(ct).toString('base64');
    assert.deepEqual(JSON.parse(await decryptPayload(token, base64)), value);
});
