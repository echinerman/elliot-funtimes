import assert from 'node:assert/strict';
import test from 'node:test';
import { prospectStarter, validateProspectDraft } from '../communications-model.mjs';

test('starter is personal and asks about needs and device without credentials or payment claims', () => {
    const draft = prospectStarter({ full_name: 'Example Friend' });
    assert.match(draft.body, /^Hi Example,/);
    assert.match(draft.body, /which device/);
    assert.doesNotMatch(draft.body, /paid|purchased|password|renewed/i);
    assert.match(prospectStarter({}).body, /^Hi there,/);
});
test('outreach validates subject, body, and personal recipient with existing mail safeguards', () => {
    const draft = { ...prospectStarter({}), email: ' Friend@Example.com ' };
    assert.equal(validateProspectDraft(draft).email, 'friend@example.com');
    for (const email of ['', 'invalid', 'info@goelliot.vip', 'info+thread123456789012@goelliot.vip', 'a@example.com\r\nBcc: a@evil.com']) {
        assert.throws(() => validateProspectDraft({ ...draft, email }));
    }
    assert.throws(() => validateProspectDraft({ ...draft, subject: 'Bad\nsubject' }));
    assert.throws(() => validateProspectDraft({ ...draft, body: ' ' }));
    assert.throws(() => validateProspectDraft({ ...draft, body: 'x'.repeat(12001) }));
});
