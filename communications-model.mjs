export const COMMUNICATION_LIMITS = Object.freeze({ subject: 160, body: 12000, inbound: 48000, preview: 180 });
export const THREAD_STATES = ['open', 'waiting_on_customer', 'resolved', 'needs_review'];
export const MESSAGE_CATEGORIES = ['support', 'setup', 'renewal', 'other'];
export const SENDER_ADDRESS = 'info@goelliot.vip';

export function prospectStarter(user) {
    const firstName = cleanText(user?.full_name, 100).trim().split(/\s+/)[0] || 'there';
    return {
        subject: 'A hand getting set up',
        body: `Hi ${firstName}, glad you're here! If you'd like a hand getting set up, reply with what you're hoping to do and which device you'll be using. We can work out what makes sense together.\n\nElliot`
    };
}

export function validateProspectDraft({ email, subject, body }) {
    const recipient = normalizeEmail(email);
    if (!recipient || recipient === SENDER_ADDRESS || /^info\+[^@]+@goelliot\.vip$/.test(recipient)) throw new Error('Add a valid personal email to this profile before sending. You can still copy the message for Messenger.');
    const input = validateSupportInput({ subject, body, clientRequestId: 'prospect_draft_validation', category: 'setup' });
    return { email: recipient, subject: input.subject, body: input.body };
}

export function cleanText(value, limit = 48000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
}

export function plainEmailText(value) {
    return cleanText(String(value || '')
        .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(?:br\s*\/?|\/p|\/div|\/li)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
            const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
            return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
        })
        .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[entity])))
        .replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeEmail(value) {
    const raw = String(value || '').trim();
    if (/[\r\n]/.test(raw)) return '';
    const email = (raw.match(/<([^<>]+)>/)?.[1] || raw).trim().toLowerCase();
    return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email) ? email : '';
}

export function safePreview(value, knownSecrets = [], limit = COMMUNICATION_LIMITS.preview) {
    let text = cleanText(value).replace(/https?:\/\/[^\s<>]+/gi, '[link]');
    for (const secret of knownSecrets) {
        if (String(secret || '').length >= 3) text = text.split(String(secret)).join('[private]');
    }
    text = text.replace(/\b(password|passwd|pwd|username|user_name|api[ _-]?key|token|secret|authorization)\b\s*(?:is\s+|[:=]\s*|\s+)[^\s,;]+/gi, '$1: [private]');
    text = text.replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, '[private]');
    return text.split(/\n\s*(?:On .+wrote:|_{3,}|-{3,}\s*Original|>)/i)[0].replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function validateSupportInput(input) {
    const subject = cleanText(input?.subject).trim();
    const body = cleanText(input?.body).trim();
    const category = input?.category || 'support';
    const clientRequestId = String(input?.clientRequestId || '');
    const licenseId = String(input?.licenseId || '');
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(clientRequestId)) throw new Error('A valid request identifier is required.');
    if (!MESSAGE_CATEGORIES.includes(category)) throw new Error('Choose a valid topic.');
    if (!subject || subject.length > COMMUNICATION_LIMITS.subject || /[\r\n]/.test(subject)) throw new Error('Use a subject of 1 to 160 characters on one line.');
    if (!body || body.length > COMMUNICATION_LIMITS.body) throw new Error('Write a message of 1 to 12,000 characters.');
    if (licenseId && !/^[a-zA-Z0-9_-]{1,128}$/.test(licenseId)) throw new Error('Choose a valid license.');
    return { subject, body, category, clientRequestId, licenseId };
}

export function replyEnvelope(thread, body) {
    const text = cleanText(body).trim();
    const recipient = normalizeEmail(thread?.participant_email);
    if (!recipient || recipient === SENDER_ADDRESS || /^info\+[^@]+@goelliot\.vip$/.test(recipient)) throw new Error('This conversation has no valid customer email.');
    if (!/^[a-z0-9_-]{16,80}$/i.test(thread.id || '')) throw new Error('Invalid conversation identifier.');
    if (!text || text.length > COMMUNICATION_LIMITS.body) throw new Error('Write a reply of 1 to 12,000 characters.');
    const subject = cleanText(thread.subject, COMMUNICATION_LIMITS.subject).replace(/[\r\n]+/g, ' ').replace(/\s*\[GE-[a-z0-9_-]+\]/gi, '').trim();
    return {
        from: `goelliot.vip <${SENDER_ADDRESS}>`, to: recipient,
        reply_to: `info+${thread.id}@goelliot.vip`,
        subject: `Re: ${subject.replace(/^Re:\s*/i, '')} [GE-${thread.id}]`, body: text
    };
}

export function correlationIds(message) {
    const ids = [];
    const addresses = String(message.to || '') + ' ' + String(message.original_to || '');
    for (const match of addresses.matchAll(/info\+([a-z0-9_-]{16,80})@goelliot\.vip/gi)) ids.push(match[1]);
    for (const match of String(message.subject || '').matchAll(/\[GE-([a-z0-9_-]{16,80})\]/gi)) ids.push(match[1]);
    return [...new Set(ids)];
}

export function isUnread(thread) {
    return Boolean(thread.last_inbound_id && thread.last_inbound_id !== thread.last_read_inbound_id);
}

export function classifySendResult(result) {
    if (Array.isArray(result?.accepted) && result.accepted.length) {
        return { status: 'sent', error_code: '', provider_message_id: cleanText(result.messageId || '', 500) };
    }
    const error = result?.error || result || {};
    const code = String(error.code || '');
    const command = String(error.command || '').toUpperCase();
    const responseCode = Number(error.responseCode || 0);
    // A transport error without proof of rejection may have occurred after SMTP accepted DATA.
    if (['EAUTH', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND'].includes(code) ||
        (responseCode >= 400 && responseCode < 600) || ['CONN', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(command)) {
        return { status: 'failed', error_code: code || `SMTP_${responseCode || 'REJECTED'}`, provider_message_id: '' };
    }
    return { status: 'uncertain', error_code: 'SMTP_OUTCOME_UNKNOWN', provider_message_id: '' };
}

export function gmailMessageLink(messageId) {
    return /^[a-f0-9]{8,64}$/i.test(messageId || '') ? `https://mail.google.com/mail/u/?authuser=e.chinerman%40gmail.com#all/${messageId}` : '';
}

export function mailReferenceKey(value) {
    const text = String(value || '').trim();
    return /^<[^\s<>]{1,300}>$/.test(text) ? 'r_' + Array.from(text).map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('') : '';
}

export function normalizeGmailMessage(raw, decodeBase64) {
    const headers = Object.fromEntries((raw.payload?.headers || []).map(header => [header.name.toLowerCase(), header.value]));
    const plain = [], html = [], attachments = [];
    const walk = part => {
        if (part.filename) attachments.push({ filename: cleanText(part.filename, 240), mime_type: cleanText(part.mimeType, 100), size: Number(part.body?.size || 0) });
        else if (part.body?.data && part.mimeType === 'text/plain') plain.push(decodeBase64(part.body.data));
        else if (part.body?.data && part.mimeType === 'text/html') html.push(plainEmailText(decodeBase64(part.body.data)));
        for (const child of part.parts || []) walk(child);
    };
    walk(raw.payload || {});
    const text = (plain.length ? plain : html).join('\n\n');
    const rfcId = String(headers['message-id'] || '').trim();
    const refs = [...String(headers.references || '').matchAll(/<[^<>]+>/g)].map(match => match[0]);
    if (headers['in-reply-to']) refs.push(headers['in-reply-to'].trim());
    return { gmail_message_id: raw.id, from: headers.from || '', to: headers.to || '',
        original_to: [headers['x-original-to'], headers['delivered-to'], headers.cc].filter(Boolean).join(' '),
        reply_to: headers['reply-to'] || '', subject: cleanText(headers.subject, 160),
        body: cleanText(text), truncated: text.length > 48000, attachments: attachments.slice(0, 50),
        rfc_message_id: mailReferenceKey(rfcId) ? rfcId : '', reference_key: mailReferenceKey(rfcId),
        reference_keys: refs.map(mailReferenceKey).filter(Boolean),
        auto_submitted: Boolean(headers['auto-submitted'] && headers['auto-submitted'].toLowerCase() !== 'no'),
        is_bounce: raw.payload?.mimeType === 'multipart/report' || /mailer-daemon|postmaster/i.test(headers.from || '') };
}
