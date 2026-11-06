export const STRONG8K_RENEWAL_DURATIONS = Object.freeze([1, 3, 6, 12]);

function allowedDuration(value) {
    const duration = Number(value || 0);
    return STRONG8K_RENEWAL_DURATIONS.includes(duration) ? duration : 0;
}

export function inferStrong8kDuration(product = {}) {
    const explicit = allowedDuration(product.duration_months ?? product.subscription_months);
    if (explicit) return explicit;

    const idAndName = `${product.id || ''} ${product.name || ''}`.toLowerCase();
    if (/\b1\s*year\b/.test(idAndName) || /\b12[\s_-]*months?\b/.test(idAndName)) return 12;
    const monthMatch = idAndName.match(/\b(1|3|6)[\s_-]*months?\b/);
    if (monthMatch) return Number(monthMatch[1]);

    return allowedDuration(product.credits);
}

export function normalizeStrong8kProduct(product = {}, source = 'canonical') {
    const duration = inferStrong8kDuration(product);
    const kind = product.kind || (duration ? 'renewal' : 'manual');
    const isRenewal = kind === 'renewal' && Boolean(duration);

    return {
        ...product,
        id: String(product.id || '').trim(),
        name: String(product.name || '').trim() || (duration ? `${duration} Month Renewal` : 'Untitled package'),
        price: Number(product.price || 0),
        duration_months: duration,
        credits: duration || Number(product.credits || 0),
        kind: isRenewal ? 'renewal' : kind,
        active: isRenewal ? product.active !== false : false,
        sort_order: Number(product.sort_order ?? duration ?? 999),
        source
    };
}

export function mergeStrong8kProducts(canonicalProducts = [], legacyProducts = []) {
    const productsByKey = new Map();
    const keyFor = product => product.kind === 'renewal' && product.duration_months
        ? `renewal:${product.duration_months}`
        : `id:${product.id}`;

    legacyProducts
        .map(product => normalizeStrong8kProduct(product, 'legacy'))
        .forEach(product => productsByKey.set(keyFor(product), product));

    canonicalProducts
        .map(product => normalizeStrong8kProduct(product, 'canonical'))
        .forEach(product => productsByKey.set(keyFor(product), product));

    return [...productsByKey.values()].sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'renewal' ? -1 : 1;
        return left.sort_order - right.sort_order || left.price - right.price || left.name.localeCompare(right.name);
    });
}

export function getLegacyProductMigrationCandidates(canonicalProducts = [], legacyProducts = []) {
    const canonicalDurations = new Set(canonicalProducts
        .map(product => normalizeStrong8kProduct(product, 'canonical'))
        .filter(product => product.kind === 'renewal')
        .map(product => product.duration_months));

    return legacyProducts
        .map(product => normalizeStrong8kProduct(product, 'legacy'))
        .filter(product => product.kind === 'renewal' && !canonicalDurations.has(product.duration_months));
}

export function strong8kProductPayload(product = {}) {
    const normalized = normalizeStrong8kProduct(product);
    if (normalized.kind !== 'renewal' || !normalized.duration_months) {
        throw new Error('Renewal packages must use a supported duration.');
    }

    return {
        name: normalized.name,
        price: normalized.price,
        duration_months: normalized.duration_months,
        credits: normalized.duration_months,
        kind: 'renewal',
        active: normalized.active,
        sort_order: normalized.duration_months
    };
}

export function isSelectableStrong8kRenewal(product = {}) {
    const normalized = normalizeStrong8kProduct(product);
    return normalized.kind === 'renewal' && normalized.active && Boolean(normalized.duration_months);
}

export function formatStrong8kDuration(value) {
    const duration = Number(value || 0);
    return `${duration} ${duration === 1 ? 'month' : 'months'}`;
}
