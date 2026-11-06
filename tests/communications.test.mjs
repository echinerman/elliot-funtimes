import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEmail, safePreview, validateSupportInput, plainEmailText, replyEnvelope, correlationIds, classifySendResult, normalizeGmailMessage, mailReferenceKey, isUnread } from '../communications-model.mjs';
import { runCommunicationOperation } from '../infrastructure/n8n/communications-db.mjs';
import { buildCommunicationWorkflows, buildCommunicationMailboxCheck } from '../infrastructure/n8n/communications.workflow.mjs';
import { buildAcceptanceWorkflows } from '../infrastructure/n8n/communications-acceptance.workflow.mjs';

const now = Date.parse('2026-11-02T15:00:00Z');
const threadId = 'comm_fixture_thread_0001';
const valid = { clientRequestId: '12345678-1234-1234-1234-123456789012', subject: 'Help with my TV', body: 'The guide is not loading.', category: 'support', licenseId: 'license-1' };
const identity = { users: [{ localId: 'auth-1', email: 'friend@example.com' }] };
const fv = value => value === null ? { nullValue: null } : typeof value === 'boolean' ? { booleanValue: value } : typeof value === 'number' ? { integerValue: String(value) } : Array.isArray(value) ? { arrayValue: { values: value.map(fv) } } : typeof value === 'object' ? { mapValue: { fields: encode(value) } } : { stringValue: value };
const encode = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, fv(value)]));
const dv = v => v.stringValue ?? v.booleanValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : v.arrayValue ? (v.arrayValue.values || []).map(dv) : v.mapValue ? decode(v.mapValue.fields) : null);
const decode = fields => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, dv(value)]));

function memoryStore(extra = {}) {
    const data = new Map(Object.entries({
        'communication_config/runtime': { enabled: true, sending_enabled: true, notifications_enabled: true },
        'account_links/auth-1': { account_id: 'account-1' }, 'users/account-1': { full_name: 'Example Friend', email: 'friend@example.com' },
        'strong8k_profiles/account-1': { licenses: [{ id: 'license-1', username_8k: 'frienduser', password_8k: 'hiddenpass' }] }, ...extra
    }));
    const root = 'projects/elliotvip/databases/(default)/documents/';
    const raw = (path, value) => ({ name: root + path, fields: encode(value), updateTime: new Date(now).toISOString() });
    const calls = []; let conflicts = 0;
    async function request(req) {
        calls.push(req);
        const path = req.url.split('/documents')[1];
        if (path === ':beginTransaction') return { status: 200, body: { transaction: 'tx' } };
        if (path === ':rollback') return { status: 200, body: {} };
        if (path === ':batchGet') return { status: 200, body: req.body.documents.map(name => { const path = name.slice(root.length); return data.has(path) ? { found: raw(path, data.get(path)) } : { missing: name }; }) };
        if (path === ':runQuery') {
            const q = req.body.structuredQuery, filter = q.where?.fieldFilter;
            return { status: 200, body: [...data].filter(([path, value]) => path.split('/').length === 2 && path.startsWith(q.from[0].collectionId + '/') && (!filter || value[filter.field.fieldPath] === dv(filter.value))).slice(0, q.limit).map(([path, value]) => ({ document: raw(path, value) })) };
        }
        if (path === ':commit') {
            if (conflicts > 0) { conflicts--; return { status: 409, body: { error: { status: 'ABORTED' } } }; }
            for (const write of req.body.writes) {
                const key = write.update.name.slice(root.length);
                if (write.currentDocument?.exists === false && data.has(key)) return { status: 409, body: { error: { status: 'ALREADY_EXISTS' } } };
                if (write.currentDocument?.exists === true && !data.has(key)) return { status: 404, body: { error: { status: 'NOT_FOUND' } } };
            }
            for (const write of req.body.writes) {
                const key = write.update.name.slice(root.length), value = decode(write.update.fields);
                data.set(key, write.updateMask ? { ...data.get(key), ...value } : value);
            }
            return { status: 200, body: { commitTime: new Date(now).toISOString(), writeResults: req.body.writes.map(() => ({ updateTime: new Date(now).toISOString() })) } };
        }
        const key = path.slice(1);
        return data.has(key) ? { status: 200, body: raw(key, data.get(key)) } : { status: 404, body: {} };
    }
    const run = (op, args = {}, id = threadId) => runCommunicationOperation(op, args, { now, id, request });
    return { data, calls, run, request, conflict: count => { conflicts = count; } };
}

test('validates bounded support inputs and rejects header injection', () => {
    assert.deepEqual(validateSupportInput(valid), valid);
    for (const patch of [{ subject: 'hello\nBcc:x' }, { body: 'a'.repeat(12001) }, { clientRequestId: '../bad' }, { licenseId: '../other' }, { category: 'admin' }]) assert.throws(() => validateSupportInput({ ...valid, ...patch }));
    assert.equal(normalizeEmail('Friend <Friend@Example.com>'), 'friend@example.com');
    assert.equal(normalizeEmail('friend@example.com\nBcc: evil@example.com'), '');
});

test('mailbox readiness checks only identity and label names, never mail content', () => {
    const workflow = buildCommunicationMailboxCheck();
    assert.equal(workflow.active, false);
    const urls = workflow.nodes.filter(node => node.type.endsWith('.httpRequest')).map(node => node.parameters.url);
    assert.deepEqual(urls, ['https://gmail.googleapis.com/gmail/v1/users/me/profile', 'https://gmail.googleapis.com/gmail/v1/users/me/labels']);
    for (const node of workflow.nodes.filter(node => node.type.endsWith('.code'))) assert.doesNotThrow(() => new Function(node.parameters.jsCode));
});

test('generated JSON requests explicitly declare their HTTP content type', () => {
    for (const workflow of [...buildCommunicationWorkflows(), ...buildAcceptanceWorkflows('18abcde0123')]) {
        for (const node of workflow.nodes.filter(node => node.type.endsWith('.httpRequest') && node.parameters.sendBody)) {
            assert.equal(node.parameters.contentType, 'json', node.name);
            assert.equal(node.parameters.specifyBody, 'json', node.name);
            assert.equal(node.parameters.sendBody, true, node.name);
        }
    }
});

test('manual acceptance helpers refuse arbitrary messages and contain no scheduled triggers', () => {
    assert.throws(() => buildAcceptanceWorkflows('../mail'));
    const workflows = buildAcceptanceWorkflows('18abcde0123');
    assert.equal(workflows.length, 6);
    for (const workflow of workflows) {
        assert.equal(workflow.active, false);
        assert.ok(!workflow.nodes.some(node => node.type.endsWith('.scheduleTrigger')));
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        for (const node of workflow.nodes.filter(node => node.type.endsWith('.code'))) assert.doesNotThrow(() => new AsyncFunction(node.parameters.jsCode));
    }
    const guard = workflows[1].nodes.find(node => node.name === 'Claimed email').parameters.jsCode;
    assert.match(guard, /e\.chinerman@gmail\.com/);
    assert.match(guard, /acceptance_reply_20261103A/);
    assert.match(workflows[2].nodes.find(node => node.name === 'Normalize email').parameters.jsCode, /Cloudflare delivery is not yet proven/);
    const resetGuard = new Function('$json', workflows[3].nodes.find(node => node.name === 'Protect unrelated live activation').parameters.jsCode);
    const reset = resetGuard({ statusCode: 404 })[0].json;
    assert.ok(['enabled','sending_enabled','notifications_enabled'].every(key => reset.fields[key].booleanValue === false));
    assert.throws(() => resetGuard({statusCode:200,body:{fields:{enabled:{booleanValue:true},acceptance_session:{stringValue:''}}}}), /Refusing to disable/);
});

test('setup is disabled by default and never overwrites an existing runtime', async () => {
    const store = memoryStore(); store.data.delete('communication_config/runtime');
    assert.equal((await store.run('initialize')).created, true);
    assert.equal(store.data.get('communication_config/runtime').enabled, false);
    assert.equal(store.data.get('communication_config/runtime').sending_enabled, false);
    store.data.set('communication_config/runtime', { enabled: true, sending_enabled: true });
    assert.equal((await store.run('initialize')).created, false);
    assert.equal(store.data.get('communication_config/runtime').sending_enabled, true);
});

test('readiness is read-only and a missing commit is a failure, not success', async () => {
    const store = memoryStore();
    assert.equal((await store.run('storage_check')).ok, true);
    assert.ok(store.calls.every(call => call.method === 'GET'));
    await assert.rejects(runCommunicationOperation('support', { input: valid, identity }, { now, id: threadId, request: async req => req.url.endsWith(':commit') ? { status: 404, body: { error: { status: 'NOT_FOUND' } } } : store.request(req) }), /storage is unavailable/);
    await assert.rejects(runCommunicationOperation('support', { input: valid, identity }, { now, id: threadId, request: async req => req.url.endsWith(':commit') ? { status: 200, body: {} } : store.request(req) }), /write was not confirmed/);
});

test('redacts preview credentials and strips executable email HTML', () => {
    const preview = safePreview('Username: test Password: hiddenpass https://host/get.php?password=secret Token: abc123', ['hiddenpass']);
    assert.doesNotMatch(preview, /hiddenpass|abc123|https|test/);
    assert.equal(plainEmailText('<style>x</style><p>Hello &amp; welcome</p><script>bad()</script>'), 'Hello & welcome');
});

test('outgoing sender and reply correlation cannot be overridden', () => {
    const envelope = replyEnvelope({ id: threadId, participant_email: 'friend@example.com', subject: 'Help' }, 'Try restarting.');
    assert.equal(envelope.from, 'goelliot.vip <info@goelliot.vip>');
    assert.equal(envelope.reply_to, `info+${threadId}@goelliot.vip`);
    assert.deepEqual(correlationIds({ to: envelope.reply_to, subject: envelope.subject }), [threadId]);
    assert.throws(() => replyEnvelope({ id: threadId, participant_email: 'info+loop@goelliot.vip' }, 'hello'));
});

test('SMTP uncertainty never becomes an automatic retry', () => {
    assert.equal(classifySendResult({ accepted: ['friend@example.com'], messageId: '<a@b>' }).status, 'sent');
    assert.equal(classifySendResult({ error: { code: 'EAUTH' } }).status, 'failed');
    assert.equal(classifySendResult({ error: { code: 'ETIMEDOUT', command: 'DATA' } }).status, 'uncertain');
    assert.equal(classifySendResult({ error: 'An unknown error occurred' }).status, 'uncertain');
});

test('Gmail parsing never downloads attachment content and keeps identifiers', () => {
    const parsed = normalizeGmailMessage({ id: '18abcde0123', payload: { headers: [{ name: 'From', value: 'friend@example.com' }, { name: 'Message-ID', value: '<hello@example.com>' }], parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Hello').toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'receipt.pdf', body: { attachmentId: 'secret-id', size: 100 } }
    ] } }, value => Buffer.from(value, 'base64url').toString());
    assert.equal(parsed.body, 'Hello'); assert.equal(parsed.attachments[0].filename, 'receipt.pdf');
    assert.doesNotMatch(JSON.stringify(parsed), /secret-id/);
    assert.ok(mailReferenceKey(parsed.rfc_message_id));
});

test('support submission atomically stores thread, message, lock and notification; retry is idempotent', async () => {
    const store = memoryStore();
    const first = await store.run('support', { input: valid, identity });
    assert.equal(first.httpStatus, 201);
    const second = await store.run('support', { input: valid, identity }, 'comm_other_generated_id');
    assert.equal(second.duplicate, true); assert.equal(second.threadId, threadId);
    assert.equal([...store.data.keys()].filter(key => key.startsWith('communication_threads/')).length, 2);
    assert.equal([...store.data.keys()].filter(key => key.startsWith('communication_notifications/')).length, 1);
    assert.equal(store.data.get(`communication_threads/${threadId}`).account_id, 'account-1');
});

test('customer identity, license ownership and disabled runtime are enforced server-side', async () => {
    const store = memoryStore();
    await assert.rejects(store.run('support', { input: { ...valid, licenseId: 'other-license' }, identity }), /does not belong/);
    await assert.rejects(store.run('support', { input: valid, identity: { users: [{ localId: 'auth-1', email: 'intruder@example.com' }] } }), /could not be verified/);
    await assert.rejects(store.run('support', { input: valid, identity: {} }), /Sign in again/);
    store.data.set('communication_config/runtime', { enabled: false });
    assert.equal((await store.run('support', { input: valid, identity })).httpStatus, 503);
    assert.equal([...store.data.keys()].filter(key => key.startsWith('communication_threads/')).length, 0);
});

test('transaction conflicts retry safely and rate limits exclude duplicate retries', async () => {
    const store = memoryStore(); store.conflict(1);
    for (let i = 0; i < 5; i++) await store.run('support', { input: { ...valid, clientRequestId: valid.clientRequestId + i }, identity }, threadId + i);
    await store.run('support', { input: { ...valid, clientRequestId: valid.clientRequestId + '0' }, identity });
    await assert.rejects(store.run('support', { input: { ...valid, clientRequestId: valid.clientRequestId + '6' }, identity }), /wait a minute/);
    assert.equal([...store.data.keys()].filter(key => key.startsWith('communication_ingest/')).length, 5);
});

test('known email sender matches exactly; unknown sender remains unlinked; spoofed thread is isolated', async () => {
    const store = memoryStore();
    const message = { gmail_message_id: '18abcde0123', from: 'friend@example.com', body: 'Hello', subject: 'Help' };
    await store.run('ingest', { message });
    assert.equal(store.data.get(`communication_threads/${threadId}`).account_id, 'account-1');
    await store.run('ingest', { message: { ...message, gmail_message_id: '18abcde0124', from: 'unknown@example.com', to: `info+${threadId}@goelliot.vip` } }, threadId + '_other');
    const other = store.data.get(`communication_threads/${threadId}_other`);
    assert.equal(other.account_id, ''); assert.equal(other.status, 'needs_review');
    assert.equal(store.data.get(`communication_threads/${threadId}`).last_inbound_id, 'gmail_18abcde0123');
});

test('replies reopen resolved threads, unread state uses last inbound ID', async () => {
    const store = memoryStore({ [`communication_threads/${threadId}`]: { participant_email: 'friend@example.com', status: 'resolved', last_inbound_id: 'old', last_read_inbound_id: 'old' } });
    await store.run('ingest', { message: { gmail_message_id: '18abcde0123', from: 'friend@example.com', body: 'Thanks', subject: `[GE-${threadId}]` } });
    const thread = store.data.get(`communication_threads/${threadId}`);
    assert.equal(thread.status, 'open'); assert.equal(isUnread(thread), true);
});

function outgoingStore() {
    return memoryStore({ [`communication_threads/${threadId}`]: { participant_email: 'friend@example.com', subject: 'Help', status: 'open', last_inbound_id: 'original' },
        'communication_outbox/message-1': { thread_id: threadId, body: 'Try again.', to_email: 'friend@example.com', status: 'queued', attempts: 0 },
        [`communication_threads/${threadId}/messages/message-1`]: { direction: 'outbound', body: 'Try again.', status: 'queued' } });
}

test('outbox lease prevents duplicate sends and rejects stale completion', async () => {
    const store = outgoingStore();
    const claim = await store.run('claim_send');
    assert.equal(claim.envelope.to, 'friend@example.com');
    assert.equal((await store.run('claim_send', {}, 'second-worker-attempt')).idle, true);
    const stale = await store.run('finish_send', { claim: { ...claim, lease_id: 'wrong' }, result: { status: 'sent' } });
    assert.equal(stale.stale, true);
    await store.run('finish_send', { claim, result: { status: 'sent' } });
    assert.equal(store.data.get('communication_outbox/message-1').status, 'sent');
    assert.equal(store.data.get(`communication_threads/${threadId}`).status, 'waiting_on_customer');
});

test('a manually started prospect conversation uses the existing outbox and reply correlation', async () => {
    const store = outgoingStore();
    Object.assign(store.data.get(`communication_threads/${threadId}`), {
        category: 'setup', source: 'admin_portal', last_inbound_id: '', last_read_inbound_id: '', subject: 'A hand getting set up'
    });
    const claim = await store.run('claim_send');
    assert.equal(claim.envelope.from, 'goelliot.vip <info@goelliot.vip>');
    assert.equal(claim.envelope.reply_to, `info+${threadId}@goelliot.vip`);
    assert.match(claim.envelope.subject, /A hand getting set up/);
    assert.equal((await store.run('claim_send', {}, 'second-attempt')).idle, true);
    await store.run('finish_send', { claim, result: { status: 'sent' } });
    assert.equal(store.data.get(`communication_threads/${threadId}`).status, 'waiting_on_customer');
    assert.equal(store.data.has('strong8k_private/account-1'), false, 'sending never changes prospect or license state');
});

test('new inbound during SMTP send is not marked waiting or read', async () => {
    const store = outgoingStore(); const claim = await store.run('claim_send');
    store.data.get(`communication_threads/${threadId}`).last_inbound_id = 'new';
    await store.run('finish_send', { claim, result: { status: 'sent' } });
    assert.equal(store.data.get(`communication_threads/${threadId}`).status, 'open');
});

test('stale SMTP lease is uncertain, not queued; notification failure is independent', async () => {
    const store = outgoingStore();
    Object.assign(store.data.get('communication_outbox/message-1'), { status: 'sending', lease_until: new Date(now - 1).toISOString(), lease_id: 'old' });
    await store.run('claim_send');
    assert.equal(store.data.get('communication_outbox/message-1').status, 'uncertain');
    assert.equal(store.data.get(`communication_threads/${threadId}/messages/message-1`).status, 'uncertain');
    store.data.set('communication_notifications/notice-1', { thread_id: threadId, status: 'queued', preview: 'Hello' });
    const notice = await store.run('claim_notice');
    await store.run('finish_notice', { claim: notice, result: { status: 'failed', error_code: 'HA_UNAVAILABLE' } });
    assert.equal(store.data.get('communication_notifications/notice-1').status, 'failed');
    assert.equal(store.data.get(`communication_threads/${threadId}/messages/message-1`).status, 'uncertain');
});

test('renewal inbox does not change subscription or approval records', async () => {
    const store = memoryStore({ 'strong8k_renewal_requests/test-request-0001': { account_id: 'account-1', license_id: 'license-1', status: 'payment_reported', product_name: '1 Year', duration_months: 12 } });
    assert.equal((await store.run('renewals')).ok, true);
    assert.equal((await store.run('renewals')).idle, true);
    assert.equal(store.data.get('strong8k_renewal_requests/test-request-0001').status, 'payment_reported');
});

test('generated workflows are inactive, do not retain payloads, have valid connections and parseable code', () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const workflows = buildCommunicationWorkflows(); assert.equal(workflows.length, 5);
    for (const workflow of workflows) {
        assert.equal(workflow.active, false); assert.equal(workflow.settings.saveDataSuccessExecution, 'none'); assert.equal(workflow.settings.saveDataErrorExecution, 'none');
        const names = new Set(workflow.nodes.map(node => node.name));
        for (const node of workflow.nodes) if (node.type.endsWith('.code')) assert.doesNotThrow(() => new AsyncFunction('$json', '$', 'Buffer', node.parameters.jsCode), `${workflow.name}: ${node.name}`);
        for (const [from, connection] of Object.entries(workflow.connections)) { assert.ok(names.has(from)); for (const output of connection.main) for (const edge of output || []) assert.ok(names.has(edge.node), edge.node); }
    }
    const send = workflows.flatMap(w => w.nodes).find(node => node.type.endsWith('.emailSend'));
    assert.equal(send.retryOnFail, false); assert.equal(send.parameters.fromEmail, 'goelliot.vip <info@goelliot.vip>');
});

test('n8n replay adapter never reissues completed Firestore writes', async () => {
    const workflow = buildCommunicationWorkflows()[0];
    const source = workflow.nodes.find(node => node.name === 'Support step').parameters.jsCode;
    const step = new (Object.getPrototypeOf(async function () {}).constructor)('$json', source);
    const store = memoryStore(); let input = { op: 'support', args: { input: valid, identity }, now, id: threadId, history: [] };
    for (let count = 0; count < 40; count++) {
        const output = (await step(input))[0].json;
        if (output.done) { assert.equal(output.result.ok, true); break; }
        const result = await store.request(output.request); input = { ...output, history: [...output.history, result] };
    }
    assert.equal(store.calls.filter(req => req.url.endsWith(':commit')).length, 1);
    assert.equal([...store.data.keys()].filter(key => key.startsWith('communication_notifications/')).length, 1);
});
