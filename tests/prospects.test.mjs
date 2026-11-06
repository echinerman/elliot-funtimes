import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProspectState, hasCompleteLicense, licenseHistoryPatch, prospectClassificationPatch } from '../prospect-model.mjs';

const license = { id: 'synthetic', username_8k: 'example', password_8k: 'synthetic', expiry_date: '2027-01-01' };
const confirmed = { prospect_status: 'prospect', license_history_seen: false };
const audit = { at: '2026-11-04T12:00:00.000Z', by: 'synthetic-admin' };

test('missing licenses do not establish no prior license history', () => {
    for (const profile of [{}, { licenses: [] }, { licenses: null }]) {
        const state = deriveProspectState(profile);
        assert.equal(state.status, 'unclassified');
        assert.equal(state.historyKnown, false);
        assert.equal(state.suggested, false);
        assert.equal(state.canClassify, true);
        assert.throws(() => prospectClassificationPatch(profile, {}, audit), /unknown/);
    }
});

test('unknown legacy history requires informed explicit confirmation', () => {
    const patch = prospectClassificationPatch({}, {}, { ...audit, confirmedUnknown: true });
    assert.deepEqual(patch, { ...confirmed, prospect_classified_at: audit.at, prospect_classified_by: audit.by });
    assert.equal(deriveProspectState({}, patch).status, 'prospect');
});

test('evidence of no prior license permits suggestion, not automatic classification', () => {
    const metadata = { license_history_seen: false };
    assert.equal(deriveProspectState({}, metadata).suggested, true);
    assert.equal(deriveProspectState({}, metadata).status, 'unclassified');
    assert.equal(prospectClassificationPatch({}, metadata, audit).prospect_status, 'prospect');
});

test('prospect requires confirmed admin metadata, not just a saved label', () => {
    assert.equal(deriveProspectState({}, { prospect_status: 'prospect' }).status, 'unclassified');
    assert.equal(deriveProspectState({}, confirmed).status, 'prospect');
});

test('first complete license converts stale prospect metadata to customer', () => {
    const profile = { licenses: [license] };
    assert.equal(deriveProspectState(profile, confirmed).status, 'customer');
    assert.deepEqual(licenseHistoryPatch([], [license], confirmed, audit), {
        license_history_seen: true, prospect_status: 'customer',
        prospect_classified_at: audit.at, prospect_classified_by: audit.by
    });
    assert.throws(() => prospectClassificationPatch(profile, confirmed, { ...audit, confirmedUnknown: true }));
});

test('partial licenses remain setup failures and block prospect classification', () => {
    for (const field of ['username_8k', 'password_8k', 'expiry_date']) {
        const partial = { ...license, [field]: '   ' };
        assert.equal(hasCompleteLicense(partial), false);
        assert.equal(deriveProspectState({ licenses: [partial] }, confirmed).status, 'setup');
        assert.equal(deriveProspectState({ licenses: [partial] }, confirmed).canClassify, false);
        assert.throws(() => prospectClassificationPatch({ licenses: [partial] }, confirmed, { ...audit, confirmedUnknown: true }));
    }
});

test('invalid legacy expiry dates cannot convert a prospect to customer', () => {
    for (const expiry_date of ['tomorrow', '2027-02-30', '2027-13-01', '2027-00-01', '2027-01-01Tbroken']) {
        const invalid = { ...license, expiry_date };
        assert.equal(hasCompleteLicense(invalid), false);
        assert.equal(deriveProspectState({ licenses: [invalid] }, confirmed).status, 'setup');
        assert.deepEqual(licenseHistoryPatch([], [invalid], confirmed, audit), { license_history_seen: true });
    }
    assert.equal(hasCompleteLicense({ ...license, expiry_date: '2024-02-29' }), true);
    assert.equal(hasCompleteLicense({ ...license, expiry_date: '2027-01-01T12:00:00Z' }), true);
});

test('removing credentials or deleting the last license preserves customer history', () => {
    for (const next of [[], [{ ...license, password_8k: '' }]]) {
        const patch = licenseHistoryPatch([license], next, confirmed, audit);
        assert.equal(patch.prospect_status, 'customer');
        assert.equal(patch.license_history_seen, true);
        assert.equal(deriveProspectState({ licenses: next }, { ...confirmed, ...patch }).status, 'customer');
        assert.equal(deriveProspectState({ licenses: next }, patch).canClassify, false);
    }
});

test('deleted partial licenses retain evidence without claiming a complete customer license', () => {
    const patch = licenseHistoryPatch([{ username_8k: 'partial' }], [], confirmed, audit);
    assert.deepEqual(patch, { license_history_seen: true });
    const state = deriveProspectState({}, { ...confirmed, ...patch });
    assert.equal(state.status, 'unclassified');
    assert.equal(state.canClassify, false);
});

test('empty writes do not fabricate known history and customer sentinel is monotonic', () => {
    assert.deepEqual(licenseHistoryPatch([], [], {}, audit), {});
    assert.deepEqual(licenseHistoryPatch([], [], { prospect_status: 'customer' }, audit), {
        license_history_seen: true, prospect_status: 'customer'
    });
    assert.deepEqual(licenseHistoryPatch([], [], { license_history_seen: true }, audit), { license_history_seen: true });
});

test('linked legacy licenses and private customer history prevent false prospects', () => {
    for (const [profiles, records] of [[[{ licenses: [license] }], []], [[], [{ prospect_status: 'customer' }]], [[], [{ license_history_seen: true }]]]) {
        assert.equal(deriveProspectState({}, confirmed, profiles, records).canClassify, false);
        assert.throws(() => prospectClassificationPatch({}, confirmed, {
            ...audit, confirmedUnknown: true, legacyProfiles: profiles, legacyMetadata: records
        }));
    }
});

test('customer-readable fields cannot classify a person and pure functions never mutate input', () => {
    const profile = Object.freeze({ prospect_status: 'prospect', license_history_seen: false, licenses: Object.freeze([]) });
    const metadata = Object.freeze({ ...confirmed, internal_notes: 'Private' });
    assert.equal(deriveProspectState(profile).status, 'unclassified');
    const patch = licenseHistoryPatch(profile.licenses, [Object.freeze(license)], metadata, audit);
    assert.deepEqual(Object.keys(patch).sort(), ['license_history_seen', 'prospect_classified_at', 'prospect_classified_by', 'prospect_status']);
    assert.equal(metadata.prospect_status, 'prospect');
    assert.equal(profile.licenses.length, 0);
    assert.equal(deriveProspectState({}, { ...confirmed, membership: { status: 'active' } }).status, 'prospect');
});
