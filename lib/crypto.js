// MyJDownloader crypto primitives, built on the Web Crypto API.
//
// Runs unchanged in a MV3 service worker and in Node >= 18 (both expose
// globalThis.crypto.subtle). No third-party crypto library, no build step.
//
// Protocol reference: the official extension's vendor/js/jdapi.js and the
// Python library myjdapi. All hashing is SHA-256, all symmetric encryption
// is AES-128-CBC with PKCS#7 padding, where the 32-byte token is split into
// a 16-byte IV (first half) and a 16-byte key (second half).

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

// ---- byte / hex helpers ----

export function utf8ToBytes(str) {
    return encoder.encode(str);
}

export function bytesToHex(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let hex = '';
    for (let i = 0; i < arr.length; i++) {
        hex += arr[i].toString(16).padStart(2, '0');
    }
    return hex;
}

export function hexToBytes(hex) {
    if (hex.length % 2 !== 0) {
        throw new Error('hexToBytes: odd-length hex string');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

export function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

export function bytesToBase64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < arr.length; i++) {
        binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary);
}

export function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

// ---- hashing / signing ----

export async function sha256(bytes) {
    const digest = await subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
}

export async function hmacSha256(keyBytes, msgBytes) {
    const key = await subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await subtle.sign('HMAC', key, msgBytes);
    return new Uint8Array(sig);
}

// ---- AES-128-CBC (PKCS#7 padding, applied by Web Crypto) ----

export async function aesCbcEncrypt(keyBytes, ivBytes, plaintextBytes) {
    const key = await subtle.importKey(
        'raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']
    );
    const ct = await subtle.encrypt({ name: 'AES-CBC', iv: ivBytes }, key, plaintextBytes);
    return new Uint8Array(ct);
}

export async function aesCbcDecrypt(keyBytes, ivBytes, ciphertextBytes) {
    const key = await subtle.importKey(
        'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
    );
    const pt = await subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, ciphertextBytes);
    return new Uint8Array(pt);
}

// ---- MyJDownloader token derivation ----

// SHA256(email.toLowerCase() + password + domain.toLowerCase())
async function hashPassword(email, password, domain) {
    const material = utf8ToBytes(email.toLowerCase() + password + domain.toLowerCase());
    return sha256(material);
}

export function deriveLoginSecret(email, password) {
    return hashPassword(email, password, 'server');
}

export function deriveDeviceSecret(email, password) {
    return hashPassword(email, password, 'device');
}

// After connect, both encryption tokens are SHA256(oldToken || sessionTokenBytes).
// For the server token, oldToken starts as loginSecret and is re-derived on each
// reconnect; for the device token, oldToken is always deviceSecret.
export function deriveEncryptionToken(oldTokenBytes, sessionTokenHex) {
    return sha256(concatBytes(oldTokenBytes, hexToBytes(sessionTokenHex)));
}

// Split a 32-byte token into { iv: firstHalf, key: secondHalf } for AES-128-CBC.
export function splitToken(tokenBytes) {
    const half = tokenBytes.length / 2;
    return { iv: tokenBytes.slice(0, half), key: tokenBytes.slice(half) };
}

// signature = hex( HMAC-SHA256(tokenBytes, utf8(queryString)) )
export async function signQuery(tokenBytes, queryString) {
    const mac = await hmacSha256(tokenBytes, utf8ToBytes(queryString));
    return bytesToHex(mac);
}

// Encrypt a JS value as MyJD "aesjson": AES-128-CBC with the token halves,
// output base64. Used for request payloads.
export async function encryptPayload(tokenBytes, value) {
    const { iv, key } = splitToken(tokenBytes);
    const ct = await aesCbcEncrypt(key, iv, utf8ToBytes(JSON.stringify(value)));
    return bytesToBase64(ct);
}

// Decrypt a base64 "aesjson" body with the token halves, returning the UTF-8 text.
export async function decryptPayload(tokenBytes, base64Body) {
    const { iv, key } = splitToken(tokenBytes);
    const pt = await aesCbcDecrypt(key, iv, base64ToBytes(base64Body.trim()));
    return new TextDecoder().decode(pt);
}
