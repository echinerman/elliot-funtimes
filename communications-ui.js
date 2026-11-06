import { escapeHtml, formatDate } from './app-model.js?v=20261027-user-workspace';
import { isUnread, replyEnvelope, gmailMessageLink, THREAD_STATES, prospectStarter, validateProspectDraft, normalizeEmail, safePreview } from './communications-model.mjs?v=20261104-prospects';
import { deriveProspectState } from './prospect-model.mjs?v=20261104-prospects';
import { collection, doc, getDoc, onSnapshot, orderBy, query, limit, runTransaction, updateDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const e = value => escapeHtml(String(value ?? ''));
const labels = { open: 'Open', waiting_on_customer: 'Waiting on customer', resolved: 'Resolved', needs_review: 'Needs review', queued: 'Queued', sending: 'Sending', sent: 'Sent to mail server', failed: 'Not sent', uncertain: 'Send outcome unknown', received: 'Received' };
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

export function createCommunicationsWorkspace({ db, auth, state, enabled, showToast, refreshInbox }) {
    const local = { active: '', threads: [], messages: [], drafts: new Map(), pendingReplies: new Map(), authorized: false, loading: true, error: '', filter: 'active', busy: false, unsubscribe: null, unsubscribeMessages: null, unsubscribeThread: null, watchedThread: '', readPending: '' };
    const byId = id => document.getElementById(id);
    const current = () => local.threads.find(item => item.id === local.active);
    const root = byId('communications-workspace');
    const outreachDrafts = new Map();
    let composeId = '';

    function bind() {
        byId('communications-directory').hidden = !enabled;
        byId('communications-filter').hidden = !enabled;
        root.addEventListener('click', handleClick);
        root.addEventListener('submit', event => {
            if (event.target.id === 'prospect-compose-form') {
                event.preventDefault(); sendProspect().catch(report); return;
            }
            if (event.target.id !== 'communication-reply-form') return;
            event.preventDefault();
            sendReply().catch(report);
        });
        root.addEventListener('input', event => {
            if (event.target.id === 'communication-reply') local.drafts.set(local.active, event.target.value);
            if (composeId && ['prospect-subject', 'prospect-body'].includes(event.target.id)) {
                const draft = outreachDrafts.get(composeId);
                draft[event.target.id === 'prospect-subject' ? 'subject' : 'body'] = event.target.value;
            }
        });
        byId('communications-directory').addEventListener('click', event => {
            const button = event.target.closest('[data-thread]');
            if (button) window.location.hash = `#inbox/${button.dataset.thread}`;
        });
        byId('communication-list-filter').addEventListener('change', event => { local.filter = event.target.value; renderDirectory(); });
        window.addEventListener('beforeunload', event => {
            if (local.busy || [...local.drafts.values()].some(value => value.trim()) || outreachDrafts.size) { event.preventDefault(); event.returnValue = ''; }
        });
    }

    function stop() {
        local.unsubscribe?.(); local.unsubscribeMessages?.(); local.unsubscribeThread?.();
        local.unsubscribe = local.unsubscribeMessages = local.unsubscribeThread = null;
        local.authorized = false; local.active = ''; local.watchedThread = ''; local.threads = []; local.messages = []; local.drafts.clear(); local.pendingReplies.clear();
        local.loading = true; local.error = '';
        composeId = ''; outreachDrafts.clear();
        root.classList.add('hidden'); root.replaceChildren();
        byId('communication-directory-list').replaceChildren();
    }

    function start() {
        if (!enabled || local.unsubscribe) return;
        local.authorized = true;
        local.unsubscribe = onSnapshot(query(collection(db, 'communication_threads'), orderBy('updated_at', 'desc'), limit(100)), snapshot => {
            local.loading = false; local.error = '';
            const activeThread = current();
            local.threads = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
            if (activeThread && !local.threads.some(item => item.id === activeThread.id)) local.threads.push(activeThread);
            refreshInbox(); renderDirectory();
            if (local.active) { renderHeader(); renderContext(); markRead(); }
            route();
        }, () => {
            local.loading = false; local.error = 'Messages could not load. Check the Firestore rules and refresh.';
            renderDirectory(); refreshInbox();
            if (local.active) root.innerHTML = `<div class="comm-empty" role="alert">${e(local.error)} <a href="#inbox">Back to inbox</a></div>`;
        });
    }

    function items() {
        if (!enabled || !local.authorized) return [];
        return local.threads.filter(thread => thread.status !== 'resolved').map(thread => ({
            category: 'message', priority: thread.status === 'needs_review' ? 4 : isUnread(thread) ? 3 : 1,
            kind: isUnread(thread) ? 'Unread' : 'Message', icon: 'fa-envelope', accent: thread.status === 'needs_review' ? '#d97706' : '#10b981',
            title: thread.subject || 'Customer message', summary: `${thread.participant_email} · ${labels[thread.status] || 'Open'}`,
            detail: thread.preview || '', userId: thread.account_id || '', threadId: thread.id
        }));
    }

    function renderDirectory() {
        if (!enabled) return;
        byId('communication-unread-count').textContent = String(local.threads.filter(isUnread).length);
        const list = byId('communication-directory-list');
        if (local.loading || local.error) { list.innerHTML = `<p class="comm-empty" role="status">${e(local.error || 'Loading conversations...')}</p>`; return; }
        const rows = local.threads.filter(thread => local.filter === 'all' || (local.filter === 'resolved' ? thread.status === 'resolved' : thread.status !== 'resolved'));
        list.innerHTML = rows.length ? rows.map(thread => `<button type="button" class="comm-thread-row" data-thread="${e(thread.id)}">
            <span><strong>${e(thread.subject || 'Customer message')}</strong><span class="comm-meta">${e(thread.participant_email)}${isUnread(thread) ? ' · Unread' : ''}</span></span>
            <span class="comm-state" data-state="${e(thread.status)}">${e(labels[thread.status] || 'Open')}</span>
            <span class="comm-meta">${e(date(thread.last_message_at))}</span>
        </button>`).join('') : '<p class="comm-empty">No conversations here yet. Email and portal messages will appear after the workflows are enabled.</p>';
    }

    async function beforeRouteChange() {
        if (composeId && window.location.hash !== `#inbox/compose/${composeId}`) {
            if (local.busy || !window.confirm('Leave this draft? It will stay here until you reload or sign out. Nothing is sent by leaving.')) {
                history.replaceState(null, '', `#inbox/compose/${composeId}`); return false;
            }
        }
        const next = window.location.hash.match(/^#inbox\/([a-zA-Z0-9_-]{16,80})$/)?.[1] || '';
        if (local.active && next !== local.active && local.busy) {
            history.replaceState(null, '', `#inbox/${local.active}`);
            showToast('Please wait for the current save to finish.', 'error');
            return false;
        }
        if (local.active && next !== local.active && local.drafts.get(local.active)?.trim() && !window.confirm('Leave this conversation? Your unsent draft will stay here until you reload or sign out.')) {
            history.replaceState(null, '', `#inbox/${local.active}`); return false;
        }
        return true;
    }

    function route() {
        if (!local.authorized) return;
        const composeMatch = window.location.hash.match(/^#inbox\/compose\/([a-zA-Z0-9_-]{1,128})$/);
        if (composeMatch) { renderProspectComposer(composeMatch[1]); return; }
        composeId = '';
        const match = window.location.hash.match(/^#inbox\/([a-zA-Z0-9_-]{16,80})$/);
        if (!match) {
            root.classList.add('hidden'); local.active = ''; local.unsubscribeMessages?.(); local.unsubscribeMessages = null;
            local.unsubscribeThread?.(); local.unsubscribeThread = null; local.watchedThread = '';
            if (window.location.hash === '#inbox') byId('admin-tab-platform')?.click();
            return;
        }
        const id = match[1];
        document.querySelectorAll('[data-admin-dashboard]').forEach(section => section.classList.add('hidden'));
        byId('admin-page-header').classList.add('hidden');
        byId('user-workspace').classList.add('hidden'); root.classList.remove('hidden');
        if (local.active === id && byId('communication-header')) return;
        local.unsubscribeMessages?.(); local.active = id; local.messages = [];
        root.innerHTML = '<p class="comm-empty" role="status">Loading conversation...</p>';
        if (local.loading) return;
        if (local.watchedThread !== id) {
            local.unsubscribeThread?.(); local.watchedThread = id;
            local.unsubscribeThread = onSnapshot(doc(db, 'communication_threads', id), snapshot => {
                if (local.active !== id || !local.authorized) return;
                if (!snapshot.exists()) { root.innerHTML = '<p class="comm-empty">Conversation not found. <a href="#inbox">Back to inbox</a></p>'; return; }
                const index = local.threads.findIndex(item => item.id === id);
                const value = { ...snapshot.data(), id };
                if (index < 0) local.threads.push(value); else local.threads[index] = value;
                if (!byId('communication-header')) route();
                else { renderHeader(); renderContext(); markRead(); }
            }, () => { if (local.active === id) report(new Error('Conversation updates could not load. Return to the inbox and reopen it.')); });
        }
        const thread = current();
        if (!thread) return;
        root.innerHTML = `<header id="communication-header" class="comm-header"></header>
            <div class="comm-columns"><div class="comm-conversation"><div id="communication-timeline" aria-live="polite"><p class="comm-empty">Loading messages...</p></div>
            <form id="communication-reply-form" class="comm-composer"><label for="communication-reply">Reply by email</label>
            <p id="communication-recipient" class="comm-meta"></p><textarea id="communication-reply" class="user-profile-field" rows="7" maxlength="12000" required placeholder="Write your reply..."></textarea>
            <div class="comm-composer-actions"><span id="communication-send-status" role="status" aria-live="polite"></span><button id="communication-send" type="submit" class="user-profile-button is-primary">Send from info@goelliot.vip</button></div></form></div>
            <aside id="communication-context" class="comm-context" aria-label="Customer context"></aside></div>`;
        byId('communication-reply').value = local.drafts.get(id) || '';
        renderHeader(); renderContext();
        byId('communication-recipient').textContent = `To: ${thread.participant_email}. Replies return to this conversation. No attachments or CC in this version.`;
        document.title = `${thread.subject || 'Conversation'} | Operations`;
        window.scrollTo({ top: 0, behavior: 'auto' });
        byId('communication-back').focus({ preventScroll: true });
        local.unsubscribeMessages = onSnapshot(query(collection(db, 'communication_threads', id, 'messages'), orderBy('created_at', 'desc'), limit(100)), snapshot => {
            if (local.active !== id) return;
            local.messages = snapshot.docs.map(item => ({ ...item.data(), id: item.id })).reverse(); renderMessages(); markRead();
        }, () => { byId('communication-timeline').innerHTML = '<p class="comm-empty" role="alert">Messages could not load. Return to the inbox and reopen this conversation.</p>'; });
    }

    function composeProspect(userId) {
        if (!enabled || !local.authorized) { showToast('The inbox is unavailable. Sign in as an administrator and try again.', 'error'); return; }
        window.location.hash = `#inbox/compose/${encodeURIComponent(userId)}`;
    }

    function renderProspectComposer(userId) {
        if (composeId === userId && byId('prospect-compose-form')) return;
        local.unsubscribeMessages?.(); local.unsubscribeMessages = null;
        local.unsubscribeThread?.(); local.unsubscribeThread = null; local.watchedThread = ''; local.active = '';
        composeId = userId;
        document.querySelectorAll('[data-admin-dashboard]').forEach(section => section.classList.add('hidden'));
        byId('admin-page-header').classList.add('hidden'); byId('user-workspace').classList.add('hidden'); root.classList.remove('hidden');
        const user = state.users.find(item => item.id === userId);
        if (!user || user.deleted) { root.innerHTML = '<p class="comm-empty">Profile not found. <a href="#inbox">Back to inbox</a></p>'; return; }
        const legacyId = user.legacy_account_id;
        const classification = deriveProspectState(state.strong8kProfiles[userId], state.strong8kPrivate?.[userId],
            legacyId ? [state.strong8kProfiles[legacyId]] : [], legacyId ? [state.strong8kPrivate?.[legacyId]] : []).status;
        const starter = prospectStarter(user);
        if (classification !== 'prospect') {
            starter.subject = 'A quick hello';
            starter.body = `Hi ${String(user.full_name || '').trim().split(/\s+/)[0] || 'there'}, is there anything I can help you with?\n\nElliot`;
        }
        if (!outreachDrafts.has(userId)) outreachDrafts.set(userId, { ...starter, email: normalizeEmail(user.email), attempt: null });
        const draft = outreachDrafts.get(userId);
        if (!draft.attempt) draft.email = normalizeEmail(user.email);
        const existing = local.threads.filter(thread => thread.account_id === userId).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
        root.innerHTML = `<header class="comm-header"><a id="prospect-compose-back" class="user-profile-button" href="#people/${e(userId)}">Back to profile</a><div class="comm-identity"><h1>Start a conversation</h1><p>${e(user.full_name || user.email)} · ${classification === 'prospect' ? 'Prospect' : classification === 'customer' ? 'Customer' : 'Profile'}</p></div></header>
            <div class="comm-columns"><form id="prospect-compose-form" class="comm-composer">
            <p class="comm-meta">From: info@goelliot.vip<br>To: ${e(draft.email || 'No valid email saved')}. Replies return to your inbox.</p>
            ${existing ? `<p class="comm-warning">There is already a conversation with this person. <a class="user-profile-button" href="#inbox/${e(existing.id)}">Open existing conversation</a></p>` : ''}
            <label for="prospect-subject">Subject</label><input id="prospect-subject" class="user-profile-field" maxlength="160" required>
            <label for="prospect-body">Message</label><textarea id="prospect-body" class="user-profile-field" rows="9" maxlength="12000" required></textarea>
            <p class="comm-meta">Review before sending. Copy for Messenger only copies the text; it does not send or record contact. Unsent drafts stay in this browser tab until reload or sign-out.</p>
            <div class="comm-composer-actions"><button id="prospect-copy" type="button" class="user-profile-button">Copy for Messenger</button><button id="prospect-send" type="submit" class="user-profile-button is-primary">${draft.attempt ? 'Verify / retry queue' : 'Send email'}</button><button id="prospect-discard" type="button" class="user-profile-button">Discard draft</button></div>
            <p id="communication-send-status" role="status" aria-live="polite"></p></form>
            <aside class="comm-context"><section><h2>A personal hello</h2><p>Ask what they need and which device they use. This message does not grant access, confirm payment, or purchase a license.</p><a class="user-profile-button" href="#people/${e(userId)}">Review profile and email</a></section></aside></div>`;
        byId('prospect-subject').value = draft.subject; byId('prospect-body').value = draft.body;
        byId('prospect-subject').readOnly = Boolean(draft.attempt); byId('prospect-body').readOnly = Boolean(draft.attempt);
        byId('prospect-send').disabled = !draft.email;
        if (draft.attempt) byId('communication-send-status').textContent = 'A previous queue attempt needs verification. Retry the same message before editing or starting another.';
        byId('prospect-copy').addEventListener('click', async () => {
            try {
                if (!draft.body.trim()) throw new Error('Write a message to copy first.');
                await navigator.clipboard.writeText(draft.body);
                byId('communication-send-status').textContent = 'Copied. Paste it into Messenger when you are ready. Nothing was sent or marked as contacted.';
            } catch (error) { report(error); }
        });
        byId('prospect-discard').addEventListener('click', async () => {
            if (local.busy || !window.confirm('Discard this unsent draft? If a queue attempt exists, its status will be checked first. An email already queued cannot be cancelled here.')) return;
            local.busy = true;
            try {
                if (draft.attempt && (await getDoc(doc(db, 'communication_outbox', draft.attempt.messageId))).exists()) {
                    outreachDrafts.delete(userId); composeId = '';
                    window.location.hash = `#inbox/${draft.attempt.threadId}`;
                    showToast('This email was already queued. Review its delivery status.'); return;
                }
                outreachDrafts.delete(userId); composeId = '';
                window.location.hash = `#people/${userId}`;
            } catch { report(new Error('Queue status could not be checked. Your draft is kept. Retry when the connection is restored.')); }
            finally { local.busy = false; }
        });
        document.title = 'Start a conversation | Operations';
        byId('prospect-compose-back').focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: 'auto' });
    }

    async function sendProspect() {
        if (local.busy || !composeId || !auth.currentUser) return;
        const userId = composeId, draft = outreachDrafts.get(userId);
        const request = draft.attempt || { ...validateProspectDraft(draft), threadId: `comm_${crypto.randomUUID()}`, messageId: crypto.randomUUID(), actor: auth.currentUser.uid };
        draft.attempt = request;
        local.busy = true;
        byId('prospect-send').disabled = true;
        byId('prospect-subject').readOnly = true; byId('prospect-body').readOnly = true;
        byId('communication-send-status').textContent = 'Queuing email...';
        try {
            await runTransaction(db, async transaction => {
                const threadRef = doc(db, 'communication_threads', request.threadId);
                const messageRef = doc(db, 'communication_threads', request.threadId, 'messages', request.messageId);
                const outboxRef = doc(db, 'communication_outbox', request.messageId);
                const config = await transaction.get(doc(db, 'communication_config', 'runtime'));
                const account = await transaction.get(doc(db, 'users', userId));
                const thread = await transaction.get(threadRef), message = await transaction.get(messageRef), outbox = await transaction.get(outboxRef);
                if (thread.exists() || message.exists() || outbox.exists()) {
                    if (!thread.exists() || !message.exists() || !outbox.exists() || thread.data().account_id !== userId || thread.data().participant_email !== request.email || thread.data().subject !== request.subject || message.data().body !== request.body || outbox.data().thread_id !== request.threadId || outbox.data().body !== request.body || outbox.data().to_email !== request.email || outbox.data().created_by !== request.actor) throw new Error('The previous email needs manual review. Open the inbox before trying again.');
                    return;
                }
                if (!config.exists() || !config.data().enabled || !config.data().sending_enabled) throw new Error('Email sending is paused. Your draft is kept; retry when sending is enabled.');
                if (!account.exists() || account.data().deleted || normalizeEmail(account.data().email) !== request.email) throw new Error('The saved email changed or the profile was archived. Return to the profile and reopen this draft before sending.');
                const now = new Date().toISOString();
                transaction.set(threadRef, { account_id: userId, participant_email: request.email, subject: request.subject, category: 'setup', source: 'admin_portal', status: 'open', preview: safePreview(request.body), created_by: request.actor, created_at: now, updated_at: now, last_message_at: now, last_inbound_id: '', last_read_inbound_id: '' });
                transaction.set(messageRef, { direction: 'outbound', source: 'admin_portal', body: request.body, to_email: request.email, sender_email: 'info@goelliot.vip', created_by: request.actor, created_at: now, updated_at: now, status: 'queued' });
                transaction.set(outboxRef, { thread_id: request.threadId, body: request.body, to_email: request.email, created_by: request.actor, created_at: now, updated_at: now, status: 'queued', attempts: 0 });
            });
            outreachDrafts.delete(userId); composeId = '';
            showToast('Email queued. Delivery status appears in the conversation.');
            window.location.hash = `#inbox/${request.threadId}`;
        } catch (error) {
            byId('communication-send-status').textContent = `${error.message} Nothing is resent automatically. Use Verify / retry queue to check the same request.`;
        } finally {
            local.busy = false;
            if (byId('prospect-send')) { byId('prospect-send').disabled = false; byId('prospect-send').textContent = 'Verify / retry queue'; }
        }
    }

    function renderHeader() {
        const thread = current(); const header = byId('communication-header');
        if (!thread || !header) return;
        const signature = JSON.stringify([thread.subject, thread.participant_email, thread.source, thread.status, thread.notification_status]);
        if (header.dataset.signature === signature) return;
        header.dataset.signature = signature;
        header.innerHTML = `<a id="communication-back" class="user-profile-button" href="#inbox">Back to inbox</a>
            <div class="comm-identity"><h1>${e(thread.subject)}</h1><p>${e(thread.participant_email)} · ${e(thread.source || 'email')}</p></div>
            <label class="comm-status-label">Conversation status<select id="communication-state" class="user-profile-field">${THREAD_STATES.map(status => `<option value="${status}" ${thread.status === status ? 'selected' : ''}>${labels[status]}</option>`).join('')}</select></label>
            <button type="button" class="user-profile-button" data-save-status>Save status</button>
            ${thread.notification_status === 'failed' ? '<p class="comm-notice-failure" role="status">The phone alert failed. Your message is safely stored here. <button type="button" class="user-profile-button" data-retry-alert>Retry phone alert</button></p>' : ''}`;
    }

    function renderContext() {
        const thread = current(); const container = byId('communication-context');
        if (!thread || !container) return;
        const user = state.users.find(item => item.id === thread.account_id);
        const profile = state.strong8kProfiles[thread.account_id];
        const requests = state.renewalRequests.filter(request => request.account_id === thread.account_id && (!thread.license_id || request.license_id === thread.license_id));
        container.innerHTML = `<section><h2>Customer</h2>${user ? `<strong>${e(user.full_name || user.email)}</strong><p>${e(user.email)}</p><a class="user-profile-button" href="#people/${e(user.id)}">Open full profile</a>` : '<p>No customer linked. Linking a profile does not change the reply address.</p>'}
            <label for="communication-link-account">Link profile</label><select id="communication-link-account" class="user-profile-field"><option value="">Unlinked</option>${state.users.map(account => `<option value="${e(account.id)}" ${thread.account_id === account.id ? 'selected' : ''}>${e(account.full_name || account.email)}</option>`).join('')}</select><button type="button" data-link-profile class="user-profile-button">Review link</button></section>
            <section><h2>Licenses</h2>${(profile?.licenses || []).map(license => `<div class="comm-context-row"><strong>${e(license.label || license.username_8k || 'License')}</strong><p>${e(license.username_8k)} · Expires ${e(formatDate(license.expiry_date))}</p>${license.id === thread.license_id ? '<span class="comm-state">Selected license</span>' : ''}</div>`).join('') || '<p>No linked license details.</p>'}</section>
            <section><h2>Renewal requests</h2>${requests.map(request => `<div class="comm-context-row"><strong>${e(request.product_name || 'Renewal')}</strong><p>${e(request.status)} · $${Number(request.price || 0).toFixed(2)}</p><p class="comm-meta">Messages never approve payment or purchase a renewal.</p></div>`).join('') || '<p>No renewal requests for this conversation.</p>'}</section>
            <section><h2>Shared setup</h2><p class="comm-body">${e(profile?.setup_notes || 'No shared setup notes.')}</p></section>`;
    }

    function renderMessages() {
        const container = byId('communication-timeline'); if (!container) return;
        container.innerHTML = local.messages.length ? local.messages.map(message => {
            const gmail = gmailMessageLink(message.gmail_message_id);
            return `<article class="comm-message" data-direction="${e(message.direction)}"><header><strong>${message.direction === 'outbound' ? 'You · info@goelliot.vip' : e(message.sender_email || 'Customer')}</strong><time>${e(date(message.created_at))}</time><span class="comm-state" data-state="${e(message.status)}">${e(labels[message.status] || message.status)}</span></header>
                <div class="comm-body">${e(message.body)}</div>${message.truncated ? '<p class="comm-warning">Long message shortened. View the original in Gmail.</p>' : ''}
                ${(message.attachments || []).length ? `<p class="comm-meta">Attachments: ${(message.attachments || []).map(item => e(item.filename || 'Attachment')).join(', ')}</p>` : ''}
                <div class="comm-message-actions">${gmail ? `<a class="user-profile-button" href="${gmail}" target="_blank" rel="noopener noreferrer">Open original in Gmail</a>` : ''}
                ${current()?.account_id ? `<button type="button" class="user-profile-button" data-save-history="${e(message.id)}">Save internal support note</button>` : ''}
                ${['failed', 'uncertain'].includes(message.status) ? `<button type="button" class="user-profile-button" data-retry="${e(message.id)}">${message.status === 'uncertain' ? 'Review and resend' : 'Retry email'}</button>` : ''}</div>
                ${message.status === 'uncertain' ? '<p class="comm-warning">Delivery could not be confirmed. Check the recipient or mail logs before resending; this may already have arrived.</p>' : ''}
                ${message.status === 'failed' ? `<p class="comm-warning">The email was not sent. ${e(message.error_code || 'Check the mail connection before retrying.')}</p>` : ''}</article>`;
        }).join('') : '<p class="comm-empty">No messages yet.</p>';
    }

    async function markRead() {
        const thread = current();
        if (!thread || !isUnread(thread) || local.readPending || !local.messages.some(message => message.id === thread.last_inbound_id)) return;
        const id = thread.id, inboundId = thread.last_inbound_id;
        local.readPending = inboundId;
        try { await updateDoc(doc(db, 'communication_threads', id), { last_read_inbound_id: inboundId }); }
        catch { showToast('Read status could not be saved. Reopen this conversation to retry.', 'error'); }
        finally { local.readPending = ''; }
    }

    async function sendReply() {
        if (local.busy || !auth.currentUser) return;
        const thread = current(); if (!thread) return;
        const envelope = replyEnvelope(thread, byId('communication-reply').value);
        const threadId = thread.id, actor = auth.currentUser.uid;
        const fingerprint = JSON.stringify([actor, threadId, envelope.to, envelope.body]);
        // Keep the same ID after an ambiguous commit response; a retry verifies instead of duplicating.
        const id = local.pendingReplies.get(fingerprint) || crypto.randomUUID();
        local.pendingReplies.set(fingerprint, id);
        local.busy = true; byId('communication-send').disabled = true;
        byId('communication-reply').disabled = true;
        byId('communication-send-status').textContent = 'Queuing reply...';
        try {
            await runTransaction(db, async transaction => {
                const threadRef = doc(db, 'communication_threads', threadId);
                const config = await transaction.get(doc(db, 'communication_config', 'runtime'));
                const latest = await transaction.get(threadRef);
                const outboxRef = doc(db, 'communication_outbox', id);
                const messageRef = doc(db, 'communication_threads', threadId, 'messages', id);
                const existing = await transaction.get(outboxRef);
                const existingMessage = await transaction.get(messageRef);
                if (existing.exists() || existingMessage.exists()) {
                    const previous = existing.data();
                    if (!existing.exists() || !existingMessage.exists() || previous.thread_id !== threadId || previous.to_email !== envelope.to || previous.body !== envelope.body || previous.created_by !== actor) throw new Error('The previous reply needs review. Reopen the conversation before sending.');
                    return;
                }
                if (!config.exists() || config.data().sending_enabled !== true || config.data().enabled !== true) throw new Error('Email sending is paused. Your draft has been kept.');
                if (!latest.exists() || latest.data().participant_email !== envelope.to) throw new Error('The recipient changed. Reopen the conversation before sending.');
                const now = new Date().toISOString();
                const message = { direction: 'outbound', source: 'admin_portal', body: envelope.body, to_email: envelope.to, sender_email: 'info@goelliot.vip', created_by: actor, created_at: now, updated_at: now, status: 'queued' };
                transaction.set(messageRef, message);
                transaction.set(outboxRef, { thread_id: threadId, body: envelope.body, to_email: envelope.to, created_by: actor, created_at: now, updated_at: now, status: 'queued', attempts: 0 });
                transaction.update(threadRef, { updated_at: now, last_message_at: now });
            });
            local.drafts.delete(threadId); byId('communication-reply').value = '';
            local.pendingReplies.delete(fingerprint);
            byId('communication-send-status').textContent = 'Queued. Delivery status appears above.';
        } finally {
            local.busy = false;
            if (byId('communication-send')) byId('communication-send').disabled = false;
            if (byId('communication-reply')) byId('communication-reply').disabled = false;
        }
    }

    async function handleClick(event) {
        const button = event.target.closest('button'); if (!button || local.busy || !current()) return;
        try {
            if (button.hasAttribute('data-save-status')) {
                const status = byId('communication-state').value;
                if (!THREAD_STATES.includes(status)) return;
                await updateDoc(doc(db, 'communication_threads', local.active), { status, updated_at: new Date().toISOString() });
                showToast('Conversation status saved.');
            } else if (button.hasAttribute('data-link-profile')) {
                const accountId = byId('communication-link-account').value;
                const user = state.users.find(item => item.id === accountId);
                if (!window.confirm(`Link this conversation to ${user?.full_name || user?.email || 'no profile'}? The reply address will remain ${current().participant_email}.`)) return;
                await updateDoc(doc(db, 'communication_threads', local.active), { account_id: accountId, license_id: '', updated_at: new Date().toISOString() });
                showToast('Profile link saved.');
            } else if (button.hasAttribute('data-retry-alert')) {
                const threadId = local.active;
                await runTransaction(db, async transaction => {
                    const threadRef = doc(db, 'communication_threads', threadId);
                    const thread = await transaction.get(threadRef);
                    const noticeRef = doc(db, 'communication_notifications', thread.data().notification_id);
                    const notice = await transaction.get(noticeRef);
                    if (!notice.exists() || notice.data().status !== 'failed') throw new Error('This alert is already queued or delivered.');
                    transaction.update(noticeRef, { status: 'queued', error_code: '', updated_at: new Date().toISOString() });
                    transaction.update(threadRef, { notification_status: 'queued', notification_error: '' });
                });
                showToast('Phone alert queued. No email will be resent.');
            } else if (button.dataset.retry) {
                const id = button.dataset.retry;
                const message = local.messages.find(item => item.id === id);
                if (!window.confirm(message.status === 'uncertain' ? 'This email may already have arrived. Have you checked delivery and decided it is safe to send it again?' : 'Retry this email with the same recipient and body?')) return;
                const threadId = local.active;
                await runTransaction(db, async transaction => {
                    const ref = doc(db, 'communication_outbox', id);
                    const snapshot = await transaction.get(ref);
                    if (!snapshot.exists() || !['failed', 'uncertain'].includes(snapshot.data().status)) throw new Error('This email is already queued, sending, or sent.');
                    const patch = { status: 'queued', error_code: '', updated_at: new Date().toISOString(), retry_reviewed_by: auth.currentUser.uid };
                    transaction.update(ref, patch); transaction.update(doc(db, 'communication_threads', threadId, 'messages', id), patch);
                });
                showToast('Email queued for another attempt.');
            } else if (button.dataset.saveHistory) {
                const message = local.messages.find(item => item.id === button.dataset.saveHistory);
                const thread = current();
                if (!thread.account_id || !message || !window.confirm('Save this message as an internal, admin-only support note?')) return;
                const eventId = `communication_${message.id}`;
                await runTransaction(db, async transaction => {
                    const ref = doc(db, 'strong8k_profiles', thread.account_id, 'support_events', eventId);
                    const exists = await transaction.get(ref);
                    if (exists.exists()) return;
                    transaction.set(ref, { kind: 'communication', visibility: 'internal', summary: thread.subject,
                        details: message.body, source_text: '', occurred_at: message.created_at, created_at: new Date().toISOString(), created_by: auth.currentUser.uid,
                        communication_thread_id: thread.id, communication_message_id: message.id });
                });
                showToast('Internal support note saved.');
            }
        } catch (error) { report(error); }
    }

    function report(error) {
        const text = error?.message || 'The change could not be saved. Please retry.';
        if (byId('communication-send-status')) byId('communication-send-status').textContent = text;
        showToast(text, 'error');
    }
    return { bind, start, stop, route, beforeRouteChange, items, composeProspect };
}
