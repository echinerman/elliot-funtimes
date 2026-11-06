import { validateSupportInput } from './communications-model.mjs?v=20261102-inbox';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

export function bindPortalSupport({ auth, state, config }) {
    const form = document.getElementById('portal-support-form');
    const link = document.getElementById('contact-link');
    const status = document.getElementById('portal-support-status');
    const button = document.getElementById('portal-support-send');
    let requestId = '', previousPayload = '', pending = false;
    link.setAttribute('aria-controls', 'portal-support-form');
    link.setAttribute('aria-expanded', 'false');
    link.addEventListener('click', event => {
        if (!config.COMMUNICATIONS_ENABLED) return;
        if (pending) { event.preventDefault(); return; }
        event.preventDefault(); form.hidden = !form.hidden;
        link.setAttribute('aria-expanded', String(!form.hidden));
        if (!form.hidden) {
            const select = document.getElementById('portal-support-license'); select.replaceChildren(new Option('Not about a particular license', ''));
            for (const license of state.strong8k.profile?.licenses || []) if (license.id) select.add(new Option(license.label || license.username_8k || 'License', license.id));
            document.getElementById('portal-support-subject').focus();
        }
    });
    document.getElementById('portal-support-cancel').addEventListener('click', () => {
        if (pending) return;
        form.hidden = true; link.setAttribute('aria-expanded', 'false'); link.focus();
    });
    form.addEventListener('submit', async event => {
        event.preventDefault(); if (pending || !config.COMMUNICATIONS_ENABLED || !auth.currentUser) return;
        const values = { category: form.elements.category.value, licenseId: form.elements.licenseId.value,
            subject: form.elements.subject.value, body: form.elements.body.value };
        const fingerprint = JSON.stringify(values);
        if (fingerprint !== previousPayload) { requestId = crypto.randomUUID(); previousPayload = fingerprint; }
        try {
            const payload = validateSupportInput({ ...values, clientRequestId: requestId });
            pending = true; button.disabled = true; status.textContent = 'Sending your message...';
            [...form.elements].forEach(element => { element.disabled = true; });
            const response = await fetch(config.PORTAL_SUPPORT_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, idToken: await auth.currentUser.getIdToken() }), signal: AbortSignal.timeout(45000) });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.message || 'Your message could not be saved. Please retry.');
            status.textContent = 'Message received. Elliot will reply by email from info@goelliot.vip.';
            form.reset(); requestId = ''; previousPayload = '';
        } catch (error) {
            status.textContent = error.name === 'TimeoutError' ? 'We could not confirm receipt. Retry with the same message; it will not create a duplicate.' : error.message || 'Could not send. Retry or email info@goelliot.vip.';
        } finally { pending = false; [...form.elements].forEach(element => { element.disabled = false; }); }
    });
    onAuthStateChanged(auth, () => { form.reset(); form.hidden = true; requestId = ''; previousPayload = ''; status.textContent = ''; link.setAttribute('aria-expanded', 'false'); });
}
