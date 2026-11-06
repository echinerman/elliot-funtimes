export const APP_IDS = {
    STRONG8K: 'strong8k'
};

export const APP_ORDER = [APP_IDS.STRONG8K];

export const APP_DEFINITIONS = {
    [APP_IDS.STRONG8K]: {
        id: APP_IDS.STRONG8K,
        label: 'Strong8K',
        shortLabel: 'Strong8K',
        authTitle: 'Strong8K Portal',
        authDescription: 'Client access for licenses, support notes, and package purchases.',
        adminLabel: 'Strong8K',
        accent: 'stone',
        heroClass: 'from-stone-900 via-stone-800 to-amber-950',
        surfaceClass: 'bg-white',
        route: '#/app/strong8k'
    }
};

export function defaultSharedUser(email = '') {
    return {
        email,
        full_name: '',
        created_at: new Date().toISOString(),
        default_app_id: ''
    };
}

export function defaultMembership(appId, inviteCode = '') {
    return {
        app_id: appId,
        role: 'member',
        status: 'active',
        created_at: new Date().toISOString(),
        invite_code_used: inviteCode,
        pool_ids: []
    };
}

export function defaultStrong8kProfile() {
    return {
        status: 'Pending',
        domain_8k: '',
        domain_8k_backup: '',
        credits_allocated: 0,
        licenses: [],
        live_preferences: ["Elliot's Default (QC + Sports + English)"],
        vod_preferences: ["Elliot's Default (Movies & Series)"],
        custom_request: '',
        setup_notes: '',
        devices: []
    };
}

export function buildLegacySetupNotes(devices = []) {
    if (!Array.isArray(devices) || devices.length === 0) return '';
    const lines = devices
        .map(device => String(device || '').replace(/^[^A-Za-z0-9]+/, '').trim())
        .filter(Boolean)
        .map(device => `- ${device}`);

    if (lines.length === 0) return '';
    return ['Legacy device inventory:', ...lines].join('\n');
}

export function getSetupNotesValue(userData = {}) {
    const savedNotes = typeof userData.setup_notes === 'string' ? userData.setup_notes : '';
    if (savedNotes.trim()) return savedNotes;
    return buildLegacySetupNotes(userData.devices || []);
}

export function normalizeStrong8kProfile(profileData = {}, legacyUserData = {}) {
    const profile = {
        ...defaultStrong8kProfile(),
        ...legacyStrong8kProfile(legacyUserData),
        ...profileData
    };

    profile.setup_notes = getSetupNotesValue({
        ...legacyUserData,
        ...profileData
    });

    if (!Array.isArray(profile.licenses)) {
        profile.licenses = [];
    }

    if (profile.licenses.length === 0 && legacyUserData.username_8k) {
        profile.licenses = [{
            id: crypto.randomUUID(),
            label: 'Primary (Legacy)',
            status: legacyUserData.status || 'Active',
            username_8k: legacyUserData.username_8k || '',
            password_8k: legacyUserData.password_8k || '',
            expiry_date: legacyUserData.expiry_date || '',
            credits: 0,
            package_name: '',
            price_paid: '',
            date_paid: '',
            m3u_url_8k: legacyUserData.m3u_url_8k || '',
            epg_url_8k: legacyUserData.epg_url_8k || '',
            epgenius_key: legacyUserData.epgenius_key || '',
            epgenius_url: legacyUserData.epgenius_url || '',
            history: []
        }];
    }

    return profile;
}

export function normalizeStrong8kPortalUser(record = {}) {
    const username = String(record.username || '').trim();
    const expiryDate = String(record.exp_date_flag || '').trim().slice(0, 10);
    if (!username || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return null;

    return {
        id: record.id || '',
        username,
        expiry_date: expiryDate,
        status: String(record.status || '').trim().toLowerCase() || 'active'
    };
}

export function normalizeStrong8kUsername(value = '') {
    return String(value || '').trim().toLowerCase();
}

export function legacyStrong8kProfile(userData = {}) {
    return {
        status: userData.status || 'Pending',
        domain_8k: userData.domain_8k || '',
        domain_8k_backup: userData.domain_8k_backup || '',
        credits_allocated: Number(userData.credits_allocated) || 0,
        licenses: Array.isArray(userData.licenses) ? userData.licenses : [],
        live_preferences: Array.isArray(userData.live_preferences) ? userData.live_preferences : ["Elliot's Default (QC + Sports + English)"],
        vod_preferences: Array.isArray(userData.vod_preferences) ? userData.vod_preferences : ["Elliot's Default (Movies & Series)"],
        custom_request: userData.custom_request || '',
        setup_notes: getSetupNotesValue(userData),
        internal_notes: userData.internal_notes || '',
        devices: Array.isArray(userData.devices) ? userData.devices : []
    };
}

export function hasLegacyStrong8kAccess(userData = {}) {
    return Boolean(
        userData.username_8k ||
        (Array.isArray(userData.licenses) && userData.licenses.length > 0) ||
        userData.domain_8k ||
        userData.domain_8k_backup ||
        (Array.isArray(userData.live_preferences) && userData.live_preferences.length > 0) ||
        (Array.isArray(userData.vod_preferences) && userData.vod_preferences.length > 0) ||
        userData.custom_request ||
        userData.setup_notes
    );
}

export function normalizeMembership(appId, membershipData = {}) {
    return {
        ...defaultMembership(appId),
        ...membershipData,
        app_id: appId,
        role: membershipData.role || 'member',
        status: membershipData.status || 'active',
        pool_ids: Array.isArray(membershipData.pool_ids) ? membershipData.pool_ids.filter(Boolean) : []
    };
}

export function deriveAccessibleApps(membershipMap = {}, userData = {}) {
    const resolved = {};

    APP_ORDER.forEach(appId => {
        const membership = membershipMap[appId];
        if (membership) {
            resolved[appId] = normalizeMembership(appId, membership);
            return;
        }

        if (appId === APP_IDS.STRONG8K && hasLegacyStrong8kAccess(userData)) {
            resolved[appId] = normalizeMembership(appId, {
                app_id: appId,
                role: 'member',
                status: 'active',
                created_at: userData.created_at || new Date().toISOString(),
                invite_code_used: 'legacy-import',
                pool_ids: []
            });
        }
    });

    return resolved;
}

export function pickPrimaryApp(accessibleApps = {}, userData = {}) {
    if (userData.default_app_id && accessibleApps[userData.default_app_id]) {
        return userData.default_app_id;
    }

    return APP_ORDER.find(appId => accessibleApps[appId]) || null;
}

export function sortByPrice(items = []) {
    return [...items].sort((left, right) => Number(left.price || 0) - Number(right.price || 0));
}

export function parseDelimitedList(rawValue = '') {
    return String(rawValue || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
}

export function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

export function slugify(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

export function formatDate(value) {
    if (!value) return 'N/A';
    return String(value).slice(0, 10);
}
