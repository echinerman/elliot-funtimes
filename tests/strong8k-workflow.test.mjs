import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const workflow = JSON.parse(execFileSync(
    process.execPath,
    ['infrastructure/n8n/strong8k-device-info.workflow.mjs'],
    { encoding: 'utf8' }
))[0];
const normalizer = workflow.nodes.find(node => node.name === 'Normalize provider response').parameters.jsCode;

function runNormalizer(provider, prepared = {}) {
    return new Function('$json', '$', normalizer)(provider, () => ({
        item: {
            json: {
                profileId: 'profile-1',
                licenseId: 'license-1',
                baseline: {},
                ...prepared
            }
        }
    }))[0].json;
}

test('normalizes a valid device_info response without the URL global', () => {
    assert.doesNotMatch(normalizer, /new URL/);
    const result = runNormalizer({
        username: 'joea',
        password: 'saved-password',
        expire: '2027-10-09',
        enabled: 1,
        status: true,
        url: 'http://cf.example.test/player_api.php?username=joea',
        user_id: 42,
        country: 'CA',
        note: ''
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider.domain_8k, 'http://cf.example.test');
    assert.equal(result.provider.expiry_date, '2027-10-09');
    assert.equal(result.provider.status, 'Active');
});

test('uses a Cloudflare-safe dependency status for incomplete provider data', () => {
    const result = runNormalizer({ enabled: 1, expire: '2027-10-09', status: true });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 424);
    assert.equal(result.code, 'INVALID_PROVIDER_RESPONSE');
});

test('preserves saved optional metadata when device_info omits it', () => {
    const result = runNormalizer({
        username: 'joea',
        password: 'saved-password',
        expire: '2027-10-09',
        status: true
    }, {
        baseline: {
            domain_8k: 'https://saved.example.test/',
            status: 'Disabled'
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider.domain_8k, 'https://saved.example.test');
    assert.equal(result.provider.status, 'Disabled');
    assert.match(result.provider.m3u_url_8k, /^https:\/\/saved\.example\.test\/get\.php/);
});

test('normalizes boolean enabled metadata when provided', () => {
    const result = runNormalizer({
        username: 'joea',
        password: 'saved-password',
        expire: '2027-10-09',
        enabled: true,
        status: true,
        url: 'https://provider.example.test/player_api.php'
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider.status, 'Active');
});

test('does not promote a malformed provider path into a domain', () => {
    const result = runNormalizer({
        username: 'joea',
        password: 'saved-password',
        expire: '2027-10-09',
        enabled: 1,
        status: true,
        url: 'http:///get.php?username=joea'
    }, {
        baseline: {
            domain_8k: '',
            m3u_url_8k: 'https://saved.example.test/get.php?username=joea',
            epg_url_8k: 'https://saved.example.test/xmltv.php?username=joea'
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider.domain_8k, '');
    assert.equal(result.provider.m3u_url_8k, 'https://saved.example.test/get.php?username=joea');
    assert.equal(result.provider.epg_url_8k, 'https://saved.example.test/xmltv.php?username=joea');
});
