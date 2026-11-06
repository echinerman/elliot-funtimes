import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProviderReconciliationSnapshot,
    buildReconciliationDifferences,
    buildStrong8kUrls,
    normalizeProviderBaseUrl,
    normalizeStrong8kDate,
    reconciliationBaselineMatches,
    selectedFieldsWithDependencies
} from '../strong8k-reconciliation.mjs';

test('normalizes provider URLs and dates', () => {
    assert.equal(normalizeProviderBaseUrl(' HTTPS://Example.COM/path/// '), 'https://example.com/path');
    assert.equal(normalizeProviderBaseUrl('ftp://example.com'), '');
    assert.equal(normalizeProviderBaseUrl('http:///get.php?username=elliot'), '');
    assert.equal(normalizeStrong8kDate('2027-05-22T12:00:00Z'), '2027-05-22');
});

test('preserves saved URLs when the provider omits a usable domain', () => {
    const result = buildProviderReconciliationSnapshot({
        domain_8k: '',
        m3u_url_8k: 'https://saved.example.com/get.php?username=old',
        epg_url_8k: 'https://saved.example.com/xmltv.php?username=old'
    }, {
        username_8k: 'elliot',
        password_8k: 'secret',
        expiry_date: '2027-05-22',
        status: 'Active',
        domain_8k: ''
    });

    assert.equal(result.domain_8k, '');
    assert.equal(result.m3u_url_8k, 'https://saved.example.com/get.php?username=old');
    assert.equal(result.epg_url_8k, 'https://saved.example.com/xmltv.php?username=old');
});

test('builds encoded M3U and EPG URLs', () => {
    assert.deepEqual(buildStrong8kUrls('https://example.com/', 'name+one', 'p&ss'), {
        m3u_url_8k: 'https://example.com/get.php?username=name%2Bone&password=p%26ss&type=m3u_plus&output=ts',
        epg_url_8k: 'https://example.com/xmltv.php?username=name%2Bone&password=p%26ss'
    });
});

test('finds canonical profile differences', () => {
    const differences = buildReconciliationDifferences({
        username_8k: 'elliot',
        password_8k: 'old',
        expiry_date: '2027-01-01',
        status: 'Active',
        domain_8k: 'https://example.com/'
    }, {
        username_8k: 'elliot',
        password_8k: 'new',
        expiry_date: '2028-01-01',
        status: 'Disabled',
        domain_8k: 'https://example.com'
    });
    assert.deepEqual(differences.map(item => item.key), ['password_8k', 'expiry_date', 'status']);
});

test('locks generated URLs to selected source changes', () => {
    const differences = [
        { key: 'username_8k' },
        { key: 'm3u_url_8k' },
        { key: 'epg_url_8k' }
    ];
    assert.deepEqual(
        selectedFieldsWithDependencies(['username_8k'], differences).sort(),
        ['epg_url_8k', 'm3u_url_8k', 'username_8k']
    );
});

test('detects a stale reconciliation baseline', () => {
    const baseline = {
        username_8k: 'elliot',
        password_8k: 'secret',
        expiry_date: '2027-01-01',
        status: 'Active',
        domain_8k: 'https://example.com',
        m3u_url_8k: 'one',
        epg_url_8k: 'two'
    };
    assert.equal(reconciliationBaselineMatches(baseline, { ...baseline }), true);
    assert.equal(reconciliationBaselineMatches(baseline, { ...baseline, expiry_date: '2027-02-01' }), false);
});
