// Tests the pure CNL helpers in lib/cnl.js: endpoint detection, form-data
// normalization, dummycnl URL encoding, and the AddLinksQuery mapping.
// Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isCnlUrl, cnlEndpointType, isCnlPayloadType,
    normalizeCnlFormData, hasForwardablePayload,
    buildDummyCnlUrl, cnlToAddLinksQuery,
} from '../lib/cnl.js';

test('isCnlUrl matches both localhost forms', () => {
    assert.ok(isCnlUrl('http://127.0.0.1:9666/flash/addcrypted2'));
    assert.ok(isCnlUrl('http://localhost:9666/jdcheck.js'));
    assert.ok(!isCnlUrl('https://example.com/flash/add'));
});

test('cnlEndpointType classifies each endpoint', () => {
    assert.equal(cnlEndpointType('http://127.0.0.1:9666/jdcheck.js'), 'JD_CHECK');
    assert.equal(cnlEndpointType('http://127.0.0.1:9666/crossdomain.xml'), 'CROSSDOMAIN');
    assert.equal(cnlEndpointType('http://127.0.0.1:9666/flash/addcrypted2'), 'ADD_CRYPTED');
    assert.equal(cnlEndpointType('http://127.0.0.1:9666/flash/add'), 'ADD');
});

test('isCnlPayloadType only flags the add endpoints', () => {
    assert.ok(isCnlPayloadType('ADD'));
    assert.ok(isCnlPayloadType('ADD_CRYPTED'));
    assert.ok(!isCnlPayloadType('JD_CHECK'));
});

test('normalizeCnlFormData collapses array values to strings', () => {
    assert.deepEqual(
        normalizeCnlFormData({ crypted: ['AAAA'], jk: 'function f(){}', source: ['http://h/x'] }),
        { crypted: 'AAAA', jk: 'function f(){}', source: 'http://h/x' }
    );
});

test('hasForwardablePayload requires crypted, dlc, or urls', () => {
    assert.ok(hasForwardablePayload({ crypted: 'AAAA' }));
    assert.ok(hasForwardablePayload({ dlc: 'http://x/y.dlc' }));
    assert.ok(hasForwardablePayload({ urls: 'http://x/y.zip' }));
    assert.ok(!hasForwardablePayload({ jk: 'function f(){}' }));
    assert.ok(!hasForwardablePayload(null));
});

test('buildDummyCnlUrl produces a decodable hex fragment', () => {
    const form = { crypted: 'AAAA', jk: 'function f(){return "k";}' };
    const url = buildDummyCnlUrl(form);
    assert.ok(url.startsWith('https://dummycnl.jdownloader.org/#'));

    const hex = decodeURIComponent(url.split('#')[1]);
    const bytes = Buffer.from(hex, 'hex');
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), form);
});

test('cnlToAddLinksQuery wraps encrypted CNL2 data in a dummycnl URL', () => {
    const form = { crypted: 'AAAA', jk: 'function f(){}', source: 'http://hoster/x', package: 'MyPack', passwords: 'pw1' };
    const query = cnlToAddLinksQuery(form);

    assert.ok(query.links.startsWith('https://dummycnl.jdownloader.org/#'));
    assert.equal(query.sourceUrl, 'http://hoster/x');
    assert.equal(query.packageName, 'MyPack');
    assert.equal(query.downloadPassword, 'pw1');
});

test('cnlToAddLinksQuery forwards plain urls directly (unencrypted CNL)', () => {
    const query = cnlToAddLinksQuery({ urls: 'http://x/a.zip\nhttp://x/b.zip' }, { sourceUrl: 'http://hoster/page' });
    assert.equal(query.links, 'http://x/a.zip\nhttp://x/b.zip');
    assert.equal(query.sourceUrl, 'http://hoster/page');
});

test('cnlToAddLinksQuery falls back to the provided sourceUrl when the form has none', () => {
    const query = cnlToAddLinksQuery({ crypted: 'AAAA' }, { sourceUrl: 'http://hoster/page' });
    assert.equal(query.sourceUrl, 'http://hoster/page');
});
