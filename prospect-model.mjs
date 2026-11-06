// Prospect metadata belongs only in admin-only strong8k_private documents.
export function hasCompleteLicense(license = {}) {
    if (!['username_8k', 'password_8k'].every(field => String(license?.[field] || '').trim())) return false;
    const expiry = String(license?.expiry_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(expiry) || Number.isNaN(Date.parse(expiry))) return false;
    const day = expiry.slice(0, 10);
    return new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day;
}

export function deriveProspectState(profile = {}, metadata = {}, legacyProfiles = [], legacyMetadata = []) {
    const licenses = [profile, ...legacyProfiles].flatMap(item => Array.isArray(item?.licenses) ? item.licenses : []);
    const records = [metadata, ...legacyMetadata];
    const customer = licenses.some(hasCompleteLicense) || records.some(item => item?.prospect_status === 'customer');
    const historySeen = customer || licenses.length > 0 || records.some(item => item?.license_history_seen === true);
    const confirmed = metadata.prospect_status === 'prospect' && metadata.license_history_seen === false;
    const canClassify = !historySeen && licenses.length === 0;
    return {
        status: customer ? 'customer' : licenses.length ? 'setup' : canClassify && confirmed ? 'prospect' : 'unclassified',
        historySeen,
        historyKnown: historySeen || metadata.license_history_seen === false,
        canClassify,
        suggested: canClassify && metadata.license_history_seen === false && !confirmed
    };
}

export function prospectClassificationPatch(profile, metadata, {
    confirmedUnknown = false, at, by, legacyProfiles = [], legacyMetadata = []
} = {}) {
    const state = deriveProspectState(profile, metadata, legacyProfiles, legacyMetadata);
    if (!state.canClassify) throw new Error('Saved license history prevents prospect classification. Review the profile instead.');
    if (!state.historyKnown && !confirmedUnknown) throw new Error('Legacy license history is unknown. Informed manual confirmation is required.');
    return { prospect_status: 'prospect', license_history_seen: false, prospect_classified_at: at, prospect_classified_by: by };
}

export function licenseHistoryPatch(before = [], after = [], metadata = {}, { at, by } = {}) {
    const customer = [...before, ...after].some(hasCompleteLicense) || metadata.prospect_status === 'customer';
    if (!before.length && !after.length && !customer && metadata.license_history_seen !== true) return {};
    const patch = { license_history_seen: true };
    if (customer) {
        patch.prospect_status = 'customer';
        if (metadata.prospect_status !== 'customer') {
            patch.prospect_classified_at = at;
            patch.prospect_classified_by = by;
        }
    }
    return patch;
}
