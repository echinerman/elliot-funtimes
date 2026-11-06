import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const workflow = JSON.parse(execFileSync(
    process.execPath,
    ['infrastructure/n8n/strong8k-renewal-request.workflow.mjs'],
    { encoding: 'utf8' }
))[0];

const nodeCode = name => workflow.nodes.find(node => node.name === name).parameters.jsCode;

function runCode(name, json, nodeValues = {}) {
    const lookup = nodeName => ({ item: { json: nodeValues[nodeName] || {} } });
    return new Function('$json', '$', nodeCode(name))(json, lookup)[0].json;
}

const account = {
    ok: true,
    uid: 'auth-user',
    email: 'friend@example.com',
    accountId: 'profile-1',
    productId: '12_month',
    licenseId: 'license-1'
};

test('uses a POST production webhook and does not retain execution payloads', () => {
    const webhook = workflow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
    assert.equal(webhook.parameters.httpMethod, 'POST');
    assert.equal(webhook.parameters.path, 'strong8k-renewal-request');
    assert.equal(webhook.parameters.responseMode, 'responseNode');
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
    assert.equal(workflow.settings.saveDataErrorExecution, 'none');
});

test('derives credits from duration and ignores any mismatched catalog credits', () => {
    const result = runCode('Prepare request', {
        ok: true,
        source: 'canonical',
        name: '1 Year VIP',
        price: 70,
        duration_months: 12,
        credits: 99,
        kind: 'renewal',
        active: true
    }, { 'Authorize membership': account });

    assert.equal(result.ok, true);
    assert.equal(result.request.duration_months, 12);
    assert.equal(result.request.credits, 12);
    assert.equal(result.request.price, 70);
    assert.equal(result.request.account_id, 'profile-1');
    assert.equal(result.request.license_id, 'license-1');
    assert.equal(result.request.status, 'payment_reported');
});

test('supports a valid legacy renewal package by its linked credit duration', () => {
    const result = runCode('Prepare request', {
        ok: true,
        source: 'legacy',
        name: '6 Month Access',
        price: 40,
        credits: 6
    }, {
        'Authorize membership': { ...account, productId: '6_month' }
    });

    assert.equal(result.ok, true);
    assert.equal(result.request.duration_months, 6);
    assert.equal(result.request.credits, 6);
});

test('rejects inactive or unsupported products before any write', () => {
    const inactive = runCode('Prepare request', {
        ok: true,
        name: '1 Year VIP',
        price: 70,
        duration_months: 12,
        kind: 'renewal',
        active: false
    }, { 'Authorize membership': account });
    const unsupported = runCode('Prepare request', {
        ok: true,
        name: 'Demo',
        price: 0,
        credits: 0
    }, { 'Authorize membership': { ...account, productId: 'demo_1day' } });

    assert.equal(inactive.ok, false);
    assert.equal(inactive.code, 'PACKAGE_NOT_AVAILABLE');
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'PACKAGE_NOT_AVAILABLE');
});

test('builds one atomic request-and-lock commit without license credentials', () => {
    const result = runCode('Prepare request', {
        ok: true,
        name: '3 Month Renewal',
        price: 25,
        duration_months: 3,
        kind: 'renewal',
        active: true
    }, {
        'Authorize membership': { ...account, productId: '3_month' }
    });

    assert.equal(result.commitBody.writes.length, 2);
    assert.equal(result.commitBody.writes[0].currentDocument.exists, false);
    assert.equal(result.commitBody.writes[1].currentDocument.exists, false);
    assert.match(result.commitBody.writes[0].update.name, /strong8k_renewal_requests/);
    assert.match(result.commitBody.writes[1].update.name, /strong8k_renewal_request_locks/);
    assert.doesNotMatch(JSON.stringify(result), /password_8k|m3u_url_8k|epg_url_8k/);
});

test('turns an atomic lock collision into a friendly duplicate response', () => {
    const result = runCode('Normalize commit', {
        error: { httpCode: 409, message: 'ALREADY_EXISTS' }
    }, {
        'Prepare request': { ok: true, request: { id: 'renewal-test' } }
    });

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 409);
    assert.equal(result.code, 'DUPLICATE_REQUEST');
});
