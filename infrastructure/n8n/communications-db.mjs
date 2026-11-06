import { cleanText, normalizeEmail, safePreview, validateSupportInput, replyEnvelope, correlationIds } from '../../communications-model.mjs';

// Pure orchestration: n8n executes each requested Firestore call using its credential.
// The replay adapter records completed calls, so replay never repeats a completed write.
export async function runCommunicationOperation(operation, args, io) {
    const root = 'projects/elliotvip/databases/(default)/documents';
    const base = `https://firestore.googleapis.com/v1/${root}`;
    const now = io.now;
    const stamp = new Date(now).toISOString();
    const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
    const field = value => {
        if (value === null) return { nullValue: null };
        if (typeof value === 'boolean') return { booleanValue: value };
        if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
        if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
        if (typeof value === 'object') return { mapValue: { fields: fields(value) } };
        return { stringValue: String(value ?? '') };
    };
    const fields = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, field(value)]));
    const decode = value => {
        if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
        if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
        if ('integerValue' in value) return Number(value.integerValue);
        if ('doubleValue' in value) return value.doubleValue;
        if ('booleanValue' in value) return value.booleanValue;
        return value.stringValue ?? value.timestampValue ?? null;
    };
    const decodeFields = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, decode(value)]));
    const document = raw => raw?.fields ? { ...decodeFields(raw.fields), id: raw.name.split('/').at(-1), _update: raw.updateTime } : null;
    const call = async (path, method = 'GET', body) => {
        const result = await io.request({ url: base + path, method, body: body ?? {} });
        if (result.status === 404 && method === 'GET') return null;
        if (result.status < 200 || result.status >= 300) {
            const error = new Error('Communication storage is unavailable. Retry shortly.');
            error.status = result.status;
            error.code = result.body?.error?.status;
            throw error;
        }
        return result.body;
    };
    const get = async path => document(await call('/' + path));
    const find = async (collectionId, key, value, count = 20) => {
        const structuredQuery = { from: [{ collectionId }], limit: count };
        if (key) structuredQuery.where = { fieldFilter: { field: { fieldPath: key }, op: 'EQUAL', value: field(value) } };
        const result = await call(':runQuery', 'POST', { structuredQuery });
        return (result || []).map(item => document(item.document)).filter(Boolean);
    };
    const write = (path, data, merge = false) => ({
        update: { name: `${root}/${path}`, fields: fields(data) },
        ...(merge ? { updateMask: { fieldPaths: Object.keys(data) }, currentDocument: { exists: true } } : { currentDocument: { exists: false } })
    });
    const transact = async work => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const { transaction } = await call(':beginTransaction', 'POST', {});
            const read = async paths => {
                const records = await call(':batchGet', 'POST', { documents: paths.map(path => `${root}/${path}`), transaction });
                return paths.map(path => document(records.find(item => item.found?.name === `${root}/${path}`)?.found));
            };
            const outcome = await work(read);
            if (!outcome.writes?.length) {
                await call(':rollback', 'POST', { transaction });
                return outcome.value;
            }
            try {
                const acknowledgement = await call(':commit', 'POST', { transaction, writes: outcome.writes });
                if (!acknowledgement?.commitTime || !Array.isArray(acknowledgement.writeResults) || acknowledgement.writeResults.length !== outcome.writes.length) fail('The storage write was not confirmed. Retry after checking the conversation.', 503);
                return outcome.value;
            } catch (error) {
                if (error.code !== 'ABORTED' && error.status !== 409) throw error;
            }
        }
        fail('This conversation changed while saving. Retry.', 409);
    };
    const runtime = await get('communication_config/runtime');
    if (operation === 'initialize') {
        return transact(async read => {
            const [existing] = await read(['communication_config/runtime']);
            if (existing) {
                const defaults = { gmail_label: 'goelliot-inbox', gmail_processed_label: 'goelliot-processed', ha_url: 'http://100.70.117.124:8123', ha_notify_service: 'mobile_app_elliot_s_s24' };
                const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in existing)));
                return { writes: Object.keys(missing).length ? [write('communication_config/runtime', missing, true)] : [], value: { ok: true, created: false, enabled: existing.enabled === true, repaired_fields: Object.keys(missing) } };
            }
            return { writes: [write('communication_config/runtime', {
                enabled: false, sending_enabled: false, notifications_enabled: false,
                gmail_label: 'goelliot-inbox', gmail_processed_label: 'goelliot-processed',
                ha_url: 'http://100.70.117.124:8123', ha_notify_service: 'mobile_app_elliot_s_s24',
                created_at: stamp, updated_at: stamp
            })], value: { ok: true, created: true, enabled: false } };
        });
    }
    if (operation === 'storage_check') {
        // Two harmless reads exercise the workflow's HTTP replay loop without accessing customers.
        await get('communication_config/runtime');
        return { ok: true, configured: Boolean(runtime), enabled: runtime?.enabled === true, sending_enabled: runtime?.sending_enabled === true };
    }
    if (runtime?.enabled !== true && !operation.startsWith('finish_')) return { ok: false, httpStatus: 503, message: 'Messaging is not enabled yet. Email info@goelliot.vip instead.' };
    if (operation === 'settings') return { ok: true, enabled: true, gmail_label: runtime.gmail_label || 'goelliot-inbox', gmail_processed_label: runtime.gmail_processed_label || 'goelliot-processed' };
    const secretValues = profile => (profile?.licenses || []).flatMap(license => [license.username_8k, license.password_8k]);
    const noticeWrite = (messageId, threadId, preview) => write(`communication_notifications/${messageId}`, {
        thread_id: threadId, preview, status: 'queued', created_at: stamp, updated_at: stamp, attempts: 0
    });
    const inbound = async ({ id, threadId, email, subject, body, accountId = '', licenseId = '', category = 'support', source, metadata = {}, secrets = [], rateKey = '', review = false, renewalId = '' }) => {
        const preview = safePreview(body, secrets);
        const title = safePreview(subject, secrets, 160) || 'Customer message';
        const result = await transact(async read => {
            const paths = [`communication_ingest/${id}`, `communication_threads/${threadId}`];
            paths.push(rateKey ? `communication_rate_limits/${rateKey}` : 'communication_rate_limits/unused');
            if (metadata.rfc_message_id) paths.push(`communication_mail_references/${metadata.reference_key}`);
            const [lock, thread, rate, mailReference] = await read(paths);
            if (lock) return { value: { ok: true, duplicate: true, threadId: lock.thread_id, httpStatus: 200 } };
            if (thread && normalizeEmail(thread.participant_email) !== email) fail('Conversation sender mismatch.', 409);
            if (rate && Number(rate.count) >= 5) fail('Please wait a minute before sending another message.', 429);
            const threadData = thread ? {
                status: review ? 'needs_review' : 'open', last_inbound_id: id,
                last_message_at: stamp, updated_at: stamp, preview, notification_id: id, notification_status: 'queued', notification_error: ''
            } : {
                subject: title, participant_email: email, account_id: accountId, license_id: licenseId,
                category, source, status: review ? 'needs_review' : 'open', preview,
                last_inbound_id: id, last_read_inbound_id: '', last_message_at: stamp,
                created_at: stamp, updated_at: stamp, renewal_request_id: renewalId, notification_id: id, notification_status: 'queued', notification_error: ''
            };
            const record = { direction: 'inbound', source, body: cleanText(body), sender_email: email, created_at: stamp, status: 'received', ...metadata };
            const writes = [write(`communication_threads/${threadId}`, threadData, Boolean(thread)),
                write(`communication_threads/${threadId}/messages/${id}`, record),
                write(`communication_ingest/${id}`, { thread_id: threadId, created_at: stamp }), noticeWrite(id, threadId, preview)];
            if (rateKey) writes.push(write(`communication_rate_limits/${rateKey}`, { count: Number(rate?.count || 0) + 1, updated_at: stamp }, Boolean(rate)));
            if (metadata.rfc_message_id && !mailReference) writes.push(write(`communication_mail_references/${metadata.reference_key}`, { thread_id: threadId, participant_email: email, rfc_message_id: metadata.rfc_message_id, created_at: stamp }));
            return { writes, value: { ok: true, duplicate: false, threadId, httpStatus: 201 } };
        });
        return result;
    };

    if (operation === 'support') {
        const input = validateSupportInput(args.input);
        const identity = args.identity?.users?.[0];
        if (!identity?.localId || !normalizeEmail(identity.email) || identity.disabled) fail('Sign in again before sending your message.', 401);
        const uid = identity.localId;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uid)) fail('Invalid account.', 401);
        const link = await get(`account_links/${uid}`);
        const accountId = link?.account_id || uid;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) fail('Invalid account link.', 403);
        const user = await get(`users/${accountId}`);
        if (!user || user.deleted || normalizeEmail(user.email) !== normalizeEmail(identity.email)) fail('Your account could not be verified.', 403);
        const profile = await get(`strong8k_profiles/${accountId}`);
        if (input.licenseId && !(profile?.licenses || []).some(license => license.id === input.licenseId)) fail('The selected license does not belong to this account.', 403);
        return inbound({ id: `portal_${uid}_${input.clientRequestId}`, threadId: io.id,
            email: normalizeEmail(identity.email), subject: input.subject, body: input.body, accountId,
            licenseId: input.licenseId, category: input.category, source: 'portal', secrets: secretValues(profile),
            rateKey: `${uid}_${Math.floor(now / 60000)}` });
    }

    if (operation === 'ingest') {
        const message = args.message;
        if (!/^[a-f0-9]{8,64}$/i.test(message?.gmail_message_id || '')) fail('Invalid Gmail message ID.');
        const id = `gmail_${message.gmail_message_id}`;
        const existing = await get(`communication_ingest/${id}`);
        if (existing) return { ok: true, duplicate: true, threadId: existing.thread_id };
        const email = normalizeEmail(message.from);
        if (!email || email === 'info@goelliot.vip' || /^info\+[^@]+@goelliot\.vip$/.test(email)) return { ok: true, ignored: true };
        if (message.auto_submitted || message.is_bounce) return { ok: true, ignored: true };
        const explicit = correlationIds(message);
        let matched = null;
        let review = explicit.length > 1 || Boolean(message.reply_to && normalizeEmail(message.reply_to) !== email);
        for (const id of explicit.slice(0, 3)) {
            const thread = await get(`communication_threads/${id}`);
            if (thread && thread.participant_email === email) { matched = thread; break; }
            review = true;
        }
        if (!matched) {
            for (const key of (message.reference_keys || []).slice(-5).reverse()) {
                const reference = await get(`communication_mail_references/${key}`);
                if (reference?.participant_email === email) {
                    matched = await get(`communication_threads/${reference.thread_id}`);
                    if (matched?.participant_email === email) break;
                    matched = null;
                }
            }
        }
        const users = await find('users', null, null, 500);
        const matches = users.filter(user => !user.deleted && normalizeEmail(user.email) === email);
        const accountId = matched?.account_id || (matches.length === 1 ? matches[0].id : '');
        const profile = accountId ? await get(`strong8k_profiles/${accountId}`) : null;
        return inbound({ id, threadId: matched?.id || io.id, email, subject: message.subject, body: message.body,
            accountId, source: 'email', secrets: secretValues(profile), review: review || matches.length > 1,
            metadata: { gmail_message_id: message.gmail_message_id, rfc_message_id: message.rfc_message_id || '',
                reference_key: message.reference_key || '', attachments: message.attachments || [],
                reply_to: normalizeEmail(message.reply_to), truncated: Boolean(message.truncated) } });
    }

    if (operation === 'renewals') {
        const requests = await find('strong8k_renewal_requests', 'status', 'payment_reported', 50);
        for (const request of requests) {
            const id = `renewal_${request.id}`;
            if (await get(`communication_ingest/${id}`)) continue;
            const user = await get(`users/${request.account_id}`);
            const email = normalizeEmail(user?.email || request.customer_email);
            if (!email) continue;
            return inbound({ id, threadId: id, email, accountId: request.account_id, licenseId: request.license_id,
                category: 'renewal', source: 'renewal_request', renewalId: request.id,
                subject: `Payment reported: ${request.product_name || 'renewal'}`,
                body: `Customer reported payment for ${request.product_name || 'a renewal'} (${Number(request.duration_months || 0)} months). Verify payment separately before renewing. This message does not approve or purchase a license.` });
        }
        return { ok: true, idle: true };
    }

    if (operation === 'claim_send' || operation === 'claim_notice') {
        const sending = operation === 'claim_send';
        if (runtime[sending ? 'sending_enabled' : 'notifications_enabled'] !== true) return { ok: true, idle: true };
        const collection = sending ? 'communication_outbox' : 'communication_notifications';
        const stale = await find(collection, 'status', 'sending', 20);
        for (const entry of stale) {
            if (Date.parse(entry.lease_until) > now) continue;
            await transact(async read => {
                const [current, thread] = await read([`${collection}/${entry.id}`, `communication_threads/${entry.thread_id}`]);
                if (current?.status !== 'sending' || Date.parse(current.lease_until) > now) return { value: null };
                const patch = { status: sending ? 'uncertain' : 'failed', error_code: 'LEASE_EXPIRED', updated_at: stamp };
                const writes = [write(`${collection}/${entry.id}`, patch, true)];
                if (sending) {
                    writes.push(write(`communication_threads/${current.thread_id}/messages/${entry.id}`, patch, true));
                    writes.push(write(`communication_threads/${current.thread_id}`, { status: 'needs_review', updated_at: stamp }, true));
                } else if (thread?.notification_id === entry.id) {
                    writes.push(write(`communication_threads/${entry.thread_id}`, { notification_status: 'failed', notification_error: 'LEASE_EXPIRED' }, true));
                }
                return { writes, value: null };
            });
        }
        const pending = await find(collection, 'status', 'queued', 20);
        for (const item of pending) {
            const claimed = await transact(async read => {
                const paths = [`${collection}/${item.id}`, `communication_threads/${item.thread_id}`];
                if (sending) paths.push(`communication_threads/${item.thread_id}/messages/${item.id}`);
                const [entry, thread, message] = await read(paths);
                if (entry?.status !== 'queued' || !thread) return { value: null };
                if (sending && (!message || message.body !== entry.body || message.direction !== 'outbound')) fail('Outbox message does not match its conversation.', 409);
                const lease = { status: 'sending', lease_id: io.id, lease_until: new Date(now + 300000).toISOString(), updated_at: stamp, attempts: Number(entry.attempts || 0) + 1 };
                const envelope = sending ? replyEnvelope(thread, entry.body) : null;
                if (sending && entry.to_email !== envelope.to) {
                    return { writes: [write(`${collection}/${entry.id}`, { status: 'failed', error_code: 'RECIPIENT_CHANGED', updated_at: stamp }, true),
                        write(`communication_threads/${entry.thread_id}/messages/${entry.id}`, { status: 'failed', error_code: 'RECIPIENT_CHANGED', updated_at: stamp }, true)], value: null };
                }
                const writes = [write(`${collection}/${item.id}`, lease, true)];
                if (sending) writes.push(write(`communication_threads/${entry.thread_id}/messages/${item.id}`, { status: 'sending' }, true));
                return { writes, value: { ok: true, id: item.id, thread_id: entry.thread_id, lease_id: io.id, envelope,
                    inbound_at_claim: thread.last_inbound_id || '', preview: safePreview(entry.preview || ''),
                    notify_service: runtime.ha_notify_service || '', ha_url: runtime.ha_url || '' } };
            });
            if (claimed) return claimed;
        }
        return { ok: true, idle: true };
    }

    if (operation === 'finish_send' || operation === 'finish_notice') {
        const sending = operation === 'finish_send';
        const collection = sending ? 'communication_outbox' : 'communication_notifications';
        const claim = args.claim;
        const result = args.result;
        if (!claim?.id || !claim?.thread_id || !['sent', 'failed', 'uncertain'].includes(result?.status)) fail('Invalid delivery result.');
        return transact(async read => {
            const [entry, thread] = await read([`${collection}/${claim.id}`, `communication_threads/${claim.thread_id}`]);
            if (entry?.lease_id !== claim.lease_id || entry?.status !== 'sending') return { value: { ok: false, stale: true } };
            const patch = { status: result.status, error_code: cleanText(result.error_code, 100), provider_message_id: cleanText(result.provider_message_id, 500), updated_at: stamp, lease_until: '' };
            const writes = [write(`${collection}/${claim.id}`, patch, true)];
            if (sending) {
                writes.push(write(`communication_threads/${claim.thread_id}/messages/${claim.id}`, patch, true));
                const status = result.status !== 'sent' ? 'needs_review' : thread.last_inbound_id === claim.inbound_at_claim ? 'waiting_on_customer' : 'open';
                writes.push(write(`communication_threads/${claim.thread_id}`, { status, updated_at: stamp, last_message_at: stamp }, true));
                if (result.reference_key && result.provider_message_id) writes.push(write(`communication_mail_references/${result.reference_key}`, {
                    thread_id: claim.thread_id, participant_email: thread.participant_email, rfc_message_id: result.provider_message_id, created_at: stamp
                }));
            } else if (thread?.notification_id === claim.id) {
                writes.push(write(`communication_threads/${claim.thread_id}`, { notification_status: result.status, notification_error: patch.error_code }, true));
            }
            return { writes, value: { ok: true, status: result.status } };
        });
    }
    fail('Unknown communication operation.');
}
