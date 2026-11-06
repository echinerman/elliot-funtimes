export const STRONG8K_RECONCILIATION_FIELDS = Object.freeze([
    { key: 'username_8k', label: 'Username', kind: 'exact' },
    { key: 'password_8k', label: 'License password', kind: 'exact' },
    { key: 'expiry_date', label: 'Expiry', kind: 'date' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'domain_8k', label: 'Primary domain', kind: 'url', scope: 'profile' },
    { key: 'm3u_url_8k', label: 'M3U URL', kind: 'exact', derived: true },
    { key: 'epg_url_8k', label: 'EPG URL', kind: 'exact', derived: true }
]);

const GENERATED_URL_SOURCES = new Set(['username_8k', 'password_8k', 'domain_8k']);

export function normalizeProviderBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\/[^/]/i.test(raw)) return '';
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return '';
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
}

export function buildProviderReconciliationSnapshot(baseline = {}, provider = {}) {
    const current = canonicalizeReconciliationSnapshot(baseline);
    const incoming = canonicalizeReconciliationSnapshot(provider);
    const providerDomain = normalizeProviderBaseUrl(provider.domain_8k);
    const domain = providerDomain || current.domain_8k;
    const generatedUrls = domain
        ? buildStrong8kUrls(domain, incoming.username_8k, incoming.password_8k)
        : {
            m3u_url_8k: current.m3u_url_8k,
            epg_url_8k: current.epg_url_8k
        };

    return canonicalizeReconciliationSnapshot({
        ...provider,
        domain_8k: domain,
        ...generatedUrls
    });
}

export function normalizeStrong8kDate(value) {
    const raw = String(value || '').trim();
    const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct) return direct[1];
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

export function normalizeStrong8kStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const statuses = {
        active: 'Active',
        disabled: 'Disabled',
        trial: 'Trial',
        expired: 'Expired',
        banned: 'Banned'
    };
    return statuses[normalized] || String(value || '').trim();
}

export function buildStrong8kUrls(baseUrl, username, password) {
    const normalizedBase = normalizeProviderBaseUrl(baseUrl);
    if (!normalizedBase) return { m3u_url_8k: '', epg_url_8k: '' };
    const encodedUsername = encodeURIComponent(String(username || ''));
    const encodedPassword = encodeURIComponent(String(password || ''));
    return {
        m3u_url_8k: `${normalizedBase}/get.php?username=${encodedUsername}&password=${encodedPassword}&type=m3u_plus&output=ts`,
        epg_url_8k: `${normalizedBase}/xmltv.php?username=${encodedUsername}&password=${encodedPassword}`
    };
}

export function canonicalReconciliationValue(field, value) {
    const definition = STRONG8K_RECONCILIATION_FIELDS.find(item => item.key === field);
    if (definition?.kind === 'date') return normalizeStrong8kDate(value);
    if (definition?.kind === 'status') return normalizeStrong8kStatus(value);
    if (definition?.kind === 'url') return normalizeProviderBaseUrl(value);
    return String(value ?? '');
}

export function canonicalizeReconciliationSnapshot(source = {}) {
    return Object.fromEntries(STRONG8K_RECONCILIATION_FIELDS.map(definition => [
        definition.key,
        canonicalReconciliationValue(definition.key, source[definition.key])
    ]));
}

export function buildReconciliationDifferences(baseline = {}, provider = {}) {
    const current = canonicalizeReconciliationSnapshot(baseline);
    const proposed = canonicalizeReconciliationSnapshot(provider);
    return STRONG8K_RECONCILIATION_FIELDS.flatMap(definition => {
        if (current[definition.key] === proposed[definition.key]) return [];
        return [{
            ...definition,
            current: current[definition.key],
            provider: proposed[definition.key]
        }];
    });
}

export function selectedFieldsWithDependencies(selectedFields = [], differences = []) {
    const selected = new Set(selectedFields);
    const available = new Set(differences.map(item => item.key));
    if ([...selected].some(field => GENERATED_URL_SOURCES.has(field))) {
        if (available.has('m3u_url_8k')) selected.add('m3u_url_8k');
        if (available.has('epg_url_8k')) selected.add('epg_url_8k');
    }
    return [...selected];
}

export function reconciliationBaselineMatches(expected = {}, current = {}) {
    const left = canonicalizeReconciliationSnapshot(expected);
    const right = canonicalizeReconciliationSnapshot(current);
    return STRONG8K_RECONCILIATION_FIELDS.every(definition => left[definition.key] === right[definition.key]);
}
