import { createUserEditor } from './user-editor.js?v=20261104-conversations';
import { deriveProspectState, hasCompleteLicense } from './prospect-model.mjs?v=20261104-prospects';
import {
    formatStrong8kDuration,
    getLegacyProductMigrationCandidates,
    mergeStrong8kProducts,
    strong8kProductPayload
} from './strong8k-products.mjs?v=20261101-renewal-requests';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    orderBy,
    query,
    setDoc,
    updateDoc
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const firebaseApp = initializeApp(CONFIG.FIREBASE);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
let userEditor = null;
let communications = null;

const state = {
    currentUser: null,
    users: [],
    membershipsByUser: {},
    strong8kProfiles: {},
    strong8kPrivate: {},
    peopleFilter: 'all',
    strong8kProducts: [],
    strong8kLegacyProducts: [],
    strong8kProductMigrationCandidates: [],
    renewalRequests: [],
    strong8kConfig: { live_list: [], vod_list: [] },
    currentLicenses: [],
    operationsFilter: 'all',
    editingProductId: ''
};

document.addEventListener('DOMContentLoaded', () => {
    bindAdminShell();
    bindNavigation();
    bindMergeModal();
    bindStrong8kForms();
    communications = createCommunicationsWorkspace({ db, auth, state, enabled: CONFIG.COMMUNICATIONS_ENABLED,
        showToast, refreshInbox: renderOperationsInbox });
    communications.bind();
    userEditor = createUserEditor({
        db,
        auth,
        state,
        showToast,
        copyTextToClipboard,
        reloadAdminData: loadAdminData,
        syncMembership,
        syncPoolMembers: async () => {},
        appIds: APP_IDS,
        deviceInfoWebhookUrl: CONFIG.STRONG8K_DEVICE_INFO_WEBHOOK,
        startProspectConversation: userId => communications.composeProspect(userId),
        beforeRouteChange: () => communications.beforeRouteChange(),
        onDashboardRoute: () => communications.route()
    });
    userEditor.bind();
    byId('admin-signout-btn').addEventListener('click', () => signOut(auth));
    onAuthStateChanged(auth, handleAdminAuth);
});

function byId(id) {
    return document.getElementById(id);
}

function bindAdminShell() {
    const rail = byId('admin-room-rail');
    const backdrop = byId('admin-rail-backdrop');
    const openButton = byId('admin-rail-open');
    const closeButton = byId('admin-rail-close');

    const setOpen = isOpen => {
        rail?.classList.toggle('is-open', isOpen);
        rail?.toggleAttribute('inert', !isOpen && window.innerWidth <= 1100);
        backdrop?.classList.toggle('is-open', isOpen);
        openButton?.setAttribute('aria-expanded', String(isOpen));
        document.body.classList.toggle('overflow-hidden', isOpen && window.innerWidth <= 1100);
    };

    const syncAccessibility = () => {
        const isMobile = window.innerWidth <= 1100;
        const isOpen = rail?.classList.contains('is-open') || false;
        rail?.toggleAttribute('inert', isMobile && !isOpen);
        openButton?.setAttribute('aria-expanded', String(isMobile && isOpen));
        if (!isMobile) backdrop?.classList.remove('is-open');
    };

    openButton?.addEventListener('click', () => setOpen(true));
    closeButton?.addEventListener('click', () => setOpen(false));
    backdrop?.addEventListener('click', () => setOpen(false));
    document.querySelectorAll('.admin-nav-item').forEach(item => {
        item.addEventListener('click', () => setOpen(false));
    });
    syncAccessibility();
    window.addEventListener('resize', syncAccessibility, { passive: true });
}

function showToast(message, tone = 'default') {
    const toast = byId('toast');
    const icon = byId('toast-icon');
    byId('toast-msg').textContent = message;
    icon.className = tone === 'error'
        ? 'fa-solid fa-circle-exclamation'
        : 'fa-solid fa-circle-check';
    toast.classList.remove('translate-x-full', 'opacity-0');
    setTimeout(() => toast.classList.add('translate-x-full', 'opacity-0'), 3000);
}

async function copyTextToClipboard(value) {
    const text = String(value ?? '');
    const clipboardAttempt = navigator.clipboard?.writeText && window.isSecureContext
        ? navigator.clipboard.writeText(text)
        : null;

    const activeElement = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.inset = '-1000px auto auto -1000px';
    document.body.appendChild(textarea);
    textarea.select();

    let copiedWithSelection = false;
    try {
        copiedWithSelection = document.execCommand('copy');
    } finally {
        textarea.remove();
        activeElement?.focus?.({ preventScroll: true });
    }

    if (copiedWithSelection) {
        clipboardAttempt?.catch(() => {});
        return;
    }
    if (clipboardAttempt) {
        await clipboardAttempt;
        return;
    }
    throw new Error('Copy command was rejected.');
}

function setAdminPanelsHidden(hidden) {
    if (hidden) {
        document.querySelectorAll('main > section').forEach(section => {
            if (section.id !== 'admin-access-state') section.classList.add('hidden');
        });
        return;
    }

    const activeTab = document.querySelector('[data-tab].is-active')?.dataset.tab || 'platform';
    byId('user-workspace')?.classList.add('hidden');
    document.querySelectorAll('[data-admin-dashboard]').forEach(section => {
        if (section.matches('[data-panel]')) {
            section.classList.toggle('hidden', section.dataset.panel !== activeTab);
        } else {
            section.classList.remove('hidden');
        }
    });
}

function showAdminAccessState(title, message, detail = '') {
    const titleNode = byId('admin-access-title');
    const messageNode = byId('admin-access-message');
    const detailNode = byId('admin-access-detail');
    const container = byId('admin-access-state');
    if (!titleNode || !messageNode || !detailNode || !container) {
        return;
    }

    titleNode.textContent = title;
    messageNode.textContent = message;
    detailNode.textContent = detail;
    container.classList.remove('hidden');
    setAdminPanelsHidden(true);
}

function hideAdminAccessState() {
    const container = byId('admin-access-state');
    if (!container) {
        return;
    }
    container.classList.add('hidden');
    setAdminPanelsHidden(false);
}

function isConfiguredAdminEmail(email) {
    if (!email) {
        return false;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    return Array.isArray(CONFIG.ADMIN_EMAILS)
        && CONFIG.ADMIN_EMAILS.some(candidate => String(candidate).trim().toLowerCase() === normalizedEmail);
}

async function handleAdminAuth(user) {
    communications?.stop();
    state.currentUser = null;
    if (!user) {
        showAdminAccessState(
            'Sign-in Required',
            'This page could not find a saved signed-in admin session. Sign in on the portal first, then open the admin page again in the same browser.',
            'Detected session: none'
        );
        return;
    }

    let hasPlatformRole = false;
    try {
        const roleSnap = await getDoc(doc(db, 'roles', user.uid));
        hasPlatformRole = roleSnap.exists() && roleSnap.data().platform_admin === true;
    } catch (error) {
        console.warn('Unable to load admin role document, falling back to configured admin emails.', error);
    }

    if (!hasPlatformRole && !isConfiguredAdminEmail(user.email)) {
        showAdminAccessState(
            'Admin Access Not Granted',
            'This account is signed in successfully, but it is not recognized as a platform admin by the current site configuration.',
            `Signed in as: ${user.email || 'unknown'}`
        );
        return;
    }

    state.currentUser = user;
    byId('admin-email').textContent = user.email;
    byId('admin-email-rail').textContent = user.email;
    hideAdminAccessState();
    try {
        await loadAdminData();
        communications?.start();
    } catch (error) {
        console.error('Admin bootstrap failed', error);
        showAdminAccessState(
            'Admin Data Failed to Load',
            'The admin session was accepted, but the page could not load the Firestore data it needs. This usually means a rules mismatch or a Firestore permission error.',
            `Signed in as: ${user.email || 'unknown'}`
        );
        showToast('Admin data failed to load. Check the browser console for the Firestore error.', 'error');
    }
}

async function loadAdminData() {
    const userSnap = await getDocs(collection(db, 'users'));
    const users = [];
    userSnap.forEach(item => {
        const data = item.data();
        if (!data.deleted) {
            users.push({ id: item.id, ...defaultSharedUser(data.email || ''), ...data });
        }
    });
    state.users = users.sort((left, right) => (left.full_name || left.email).localeCompare(right.full_name || right.email));

    const membershipEntries = await Promise.all(state.users.map(async user => {
        const membershipsSnap = await getDocs(collection(db, 'users', user.id, 'memberships'));
        const memberships = {};
        membershipsSnap.forEach(item => {
            memberships[item.id] = normalizeMembership(item.id, item.data());
        });
        return [user.id, memberships];
    }));
    state.membershipsByUser = Object.fromEntries(membershipEntries);

    const strong8kSnap = await getDocs(collection(db, 'strong8k_profiles'));
    const profiles = {};
    strong8kSnap.forEach(item => {
        profiles[item.id] = normalizeStrong8kProfile(item.data(), state.users.find(user => user.id === item.id) || {});
    });
    state.strong8kProfiles = profiles;

    // Do not turn a failed private-history read into an empty prospect map.
    const privateSnap = await getDocs(collection(db, 'strong8k_private'));
    state.strong8kPrivate = Object.fromEntries(privateSnap.docs.map(item => [item.id, item.data()]));

    const configSnap = await getDoc(doc(db, 'strong8k_config', 'content_options'));
    if (configSnap.exists()) {
        state.strong8kConfig = configSnap.data();
    } else {
        const legacyConfigSnap = await getDoc(doc(db, 'app_config', 'content_options'));
        state.strong8kConfig = legacyConfigSnap.exists() ? legacyConfigSnap.data() : { live_list: [], vod_list: [] };
    }

    const [productSnap, legacyProductSnap, renewalRequestSnap] = await Promise.all([
        getDocs(collection(db, 'strong8k_products')),
        getDocs(collection(db, 'products')),
        getDocs(collection(db, 'strong8k_renewal_requests'))
    ]);
    const canonicalProducts = productSnap.docs.map(item => ({ id: item.id, ...item.data() }));
    const legacyProducts = legacyProductSnap.docs.map(item => ({ id: item.id, ...item.data() }));
    state.strong8kLegacyProducts = legacyProducts;
    state.strong8kProducts = mergeStrong8kProducts(canonicalProducts, legacyProducts);
    state.strong8kProductMigrationCandidates = getLegacyProductMigrationCandidates(canonicalProducts, legacyProducts);
    state.renewalRequests = renewalRequestSnap.docs.map(item => ({ id: item.id, ...item.data() }));


    renderAdmin();
    userEditor?.handleDataLoaded();
}

function renderAdmin() {
    renderOperationsInbox();
    renderUsers();
    renderStrong8kSection();
}

function bindNavigation() {
    byId('user-search')?.addEventListener('input', () => renderUsers());
    byId('people-filter')?.addEventListener('change', event => {
        state.peopleFilter = event.target.value;
        renderUsers();
    });
    document.querySelectorAll('[data-tab]').forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.dataset.tab;
            document.querySelectorAll('[data-tab]').forEach(item => {
                item.classList.toggle('is-active', item === button);
                item.setAttribute('aria-selected', String(item === button));
            });
            document.querySelectorAll('[data-panel]').forEach(panel => {
                panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
            });
        });
    });

    document.querySelectorAll('[data-ops-filter]').forEach(button => {
        button.addEventListener('click', () => {
            state.operationsFilter = button.dataset.opsFilter || 'all';
            renderOperationsInbox();
        });
    });


}

function renderOperationsInbox() {
    const container = byId('operations-inbox-list');
    if (!container) return;

    const items = buildOperationsInboxItems();
    const counts = items.reduce((result, item) => {
        result.all += 1;
        result[item.category] = (result[item.category] || 0) + 1;
        return result;
    }, { all: 0, renewal: 0, expiry: 0, review: 0, support: 0, payment: 0, automation: 0, message: 0 });

    document.querySelectorAll('[data-ops-count]').forEach(node => {
        node.textContent = String(counts[node.dataset.opsCount] || 0);
    });
    document.querySelectorAll('[data-ops-filter]').forEach(button => {
        const active = button.dataset.opsFilter === state.operationsFilter;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });

    const attentionCount = items.filter(item => item.category !== 'prospect').length;
    byId('operations-inbox-summary').textContent = counts.all
        ? `${attentionCount} ${attentionCount === 1 ? 'item needs' : 'items need'} attention${counts.prospect ? ` · ${counts.prospect} ${counts.prospect === 1 ? 'prospect' : 'prospects'}` : ''}`
        : 'Queue clear';

    const visibleItems = state.operationsFilter === 'all'
        ? items
        : items.filter(item => item.category === state.operationsFilter);

    if (!visibleItems.length) {
        const emptyStates = {
            all: {
                title: 'Nothing needs attention right now.',
                detail: 'The live queue is calculated from saved customer profiles, memberships, licenses, expiries, and requests.'
            },
            payment: {
                title: 'No customer-reported payments right now.',
                detail: 'New durable renewal requests will appear here after a customer reports sending payment.'
            },
            prospect: {
                title: 'No confirmed prospects match this queue.',
                detail: 'Review a person\'s license history in their profile before confirming a Prospect label.'
            },
            automation: {
                title: 'Automation queue not connected yet.',
                detail: 'n8n is not writing workflow review states to Firestore, so this portal deliberately shows no inferred failures.'
            }
        };
        const emptyState = emptyStates[state.operationsFilter] || {
            title: `No ${state.operationsFilter === 'review' ? 'manual review' : state.operationsFilter} items right now.`,
            detail: 'This filter is calculated from saved customer profiles and license records.'
        };
        container.innerHTML = `
            <div class="ops-empty">
                <strong>${escapeHtml(emptyState.title)}</strong>
                <p>${escapeHtml(emptyState.detail)}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = visibleItems.map((item, index) => `
        <article class="ops-row" style="--ops-accent: ${item.accent}" data-ops-row="${index}">
            <span class="ops-kind"><i class="fa-solid ${item.icon}" aria-hidden="true"></i>${escapeHtml(item.kind)}</span>
            <div>
                <div class="ops-title">${escapeHtml(item.title)}</div>
                <div class="ops-copy">${escapeHtml(item.summary)}</div>
            </div>
            <div class="ops-row-actions">${item.userId ? `<button type="button" class="ops-action" data-start-prospect="${escapeAttribute(item.userId)}">Start conversation</button>` : ''}<button type="button" class="ops-action" data-ops-expand="${index}" aria-expanded="false">Review</button></div>
            <div class="ops-detail">
                <p>${escapeHtml(item.detail)}</p>
                ${item.threadId
                    ? `<button type="button" data-ops-thread="${escapeAttribute(item.threadId)}">Open conversation</button>`
                    : `<button type="button" data-ops-user="${escapeAttribute(item.userId)}">Open full profile</button>`}
            </div>
        </article>
    `).join('');

    container.querySelectorAll('[data-ops-expand]').forEach(button => {
        button.addEventListener('click', () => {
            const row = button.closest('[data-ops-row]');
            const isOpen = !row.classList.contains('is-open');
            container.querySelectorAll('[data-ops-row]').forEach(candidate => {
                candidate.classList.remove('is-open');
                const candidateButton = candidate.querySelector('[data-ops-expand]');
                candidateButton?.setAttribute('aria-expanded', 'false');
                if (candidateButton) candidateButton.textContent = 'Review';
            });
            row.classList.toggle('is-open', isOpen);
            button.setAttribute('aria-expanded', String(isOpen));
            button.textContent = isOpen ? 'Close' : 'Review';
        });
    });
    container.querySelectorAll('[data-ops-user]').forEach(button => {
        button.addEventListener('click', () => userEditor?.open(button.dataset.opsUser));
    });
    container.querySelectorAll('[data-ops-thread]').forEach(button => {
        button.addEventListener('click', () => { window.location.hash = `#inbox/${button.dataset.opsThread}`; });
    });
    bindProspectConversationActions(container);
}

function getProspectState(user) {
    const legacyId = user.legacy_account_id;
    return deriveProspectState(state.strong8kProfiles[user.id], state.strong8kPrivate[user.id],
        legacyId ? [state.strong8kProfiles[legacyId]] : [],
        legacyId ? [state.strong8kPrivate[legacyId]] : []);
}

function bindProspectConversationActions(container) {
    container.querySelectorAll('[data-start-prospect]').forEach(button => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            try { await userEditor?.startProspectConversation(button.dataset.startProspect); }
            finally { button.disabled = false; }
        });
    });
}

function buildOperationsInboxItems() {
    const items = communications?.items() || [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    state.users.forEach(user => {
        const displayName = user.full_name || user.email || 'Unnamed account';
        const memberships = state.membershipsByUser[user.id] || {};
        const strong8kMembership = memberships[APP_IDS.STRONG8K];
        const profile = state.strong8kProfiles[user.id];
        const prospect = getProspectState(user);
        if (prospect.status === 'prospect') {
            items.push({
                category: 'prospect', priority: 0, kind: 'Prospect', icon: 'fa-user', accent: '#94a3b8',
                title: displayName, summary: 'No license yet. Ready for a personal hello.',
                detail: 'Start a conversation manually. The Prospect label grants no access and does not purchase a license or send a message.',
                userId: user.id
            });
        }

        Object.values(memberships).forEach(membership => {
            if (membership?.status !== 'pending') return;
            items.push({
                category: 'review',
                priority: 2,
                kind: 'Access',
                icon: 'fa-user-clock',
                accent: '#d97706',
                title: `${displayName} is waiting for access`,
                summary: `${APP_DEFINITIONS[membership.app_id]?.label || membership.app_id} membership is pending.`,
                detail: 'Review the membership and activate it only after the account and requested room have been confirmed.',
                userId: user.id
            });
        });

        if (!strong8kMembership || !profile) return;

        const licenses = Array.isArray(profile.licenses) ? profile.licenses : [];
        if (!licenses.length && prospect.status !== 'prospect') {
            items.push({
                category: 'review',
                priority: 3,
                kind: 'Setup',
                icon: 'fa-key',
                accent: '#e11d48',
                title: `${displayName} has no Strong8K license`,
                summary: 'Strong8K access exists, but no license credentials are saved.',
                detail: prospect.canClassify
                    ? 'License history may be unknown. Review the full profile, then explicitly confirm a Prospect label only if appropriate. No access or license is granted by that label.'
                    : 'Prior license history is recorded. Review the missing license; do not treat this person as a new prospect.',
                userId: user.id
            });
        }

        licenses.forEach((license, licenseIndex) => {
            const licenseName = license.label || `License ${licenseIndex + 1}`;
            const missing = [
                !String(license.username_8k || '').trim() ? 'username' : '',
                !String(license.password_8k || '').trim() ? 'password' : '',
                !String(license.expiry_date || '').trim() ? 'expiry date' : ''
            ].filter(Boolean);
            if (!missing.length && !hasCompleteLicense(license)) missing.push('valid expiry date');

            if (missing.length) {
                items.push({
                    category: 'review',
                    priority: 3,
                    kind: 'Incomplete',
                    icon: 'fa-triangle-exclamation',
                    accent: '#e11d48',
                    title: `${displayName}'s ${licenseName} is incomplete`,
                    summary: `Missing ${missing.join(', ')}.`,
                    detail: 'Complete the saved credentials so the customer can use and renew this license without another message thread.',
                    userId: user.id
                });
            }

            const expiryValue = String(license.expiry_date || '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryValue)) return;
            const expiry = new Date(`${expiryValue}T00:00:00`);
            const daysRemaining = Math.ceil((expiry.getTime() - now.getTime()) / 86400000);
            if (daysRemaining < 0) {
                items.push({
                    category: 'renewal',
                    priority: 4,
                    kind: 'Renewal',
                    icon: 'fa-rotate',
                    accent: '#e11d48',
                    title: `${displayName}'s ${licenseName} has expired`,
                    summary: `Expired ${formatDate(expiryValue)} · ${Math.abs(daysRemaining)} days ago.`,
                    detail: 'Confirm payment or customer intent before renewing. Recheck the provider expiry before and after any renewal action.',
                    userId: user.id
                });
            } else if (daysRemaining <= 30) {
                items.push({
                    category: 'expiry',
                    priority: daysRemaining <= 7 ? 3 : 2,
                    kind: 'Expiry',
                    icon: 'fa-calendar-day',
                    accent: daysRemaining <= 7 ? '#d97706' : '#10b981',
                    title: `${displayName}'s ${licenseName} expires soon`,
                    summary: `${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'} left · ${formatDate(expiryValue)}.`,
                    detail: 'Confirm the authoritative provider expiry and make sure the customer receives the appropriate renewal reminder.',
                    userId: user.id
                });
            }
        });

        const customRequest = String(profile.custom_request || '').trim();
        if (customRequest) {
            items.push({
                category: 'support',
                priority: 1,
                kind: 'Support',
                icon: 'fa-life-ring',
                accent: '#10b981',
                title: `${displayName} left a viewing request`,
                summary: customRequest.length > 110 ? `${customRequest.slice(0, 107)}...` : customRequest,
                detail: `Customer request: ${customRequest}`,
                userId: user.id
            });
        }
    });

    state.renewalRequests
        .filter(request => ['payment_reported', 'manual_review', 'failed'].includes(String(request.status || '')))
        .forEach(request => {
            const user = state.users.find(item => item.id === request.account_id);
            const profile = state.strong8kProfiles[request.account_id];
            const license = (profile?.licenses || []).find(item => item.id === request.license_id);
            const displayName = user?.full_name || user?.email || request.customer_email || 'Customer';
            const licenseName = license?.label || 'selected license';
            const failed = request.status === 'failed';
            items.push({
                category: failed ? 'automation' : 'payment',
                priority: failed ? 4 : 3,
                kind: failed ? 'Automation' : 'Payment',
                icon: failed ? 'fa-triangle-exclamation' : 'fa-money-check-dollar',
                accent: failed ? '#e11d48' : '#d97706',
                title: failed ? `${displayName}'s renewal needs review` : `${displayName} reported payment`,
                summary: `${request.product_name || 'Renewal package'} · ${licenseName} · ${CONFIG.CURRENCY_SYMBOL}${Number(request.price || 0).toFixed(2)}`,
                detail: failed
                    ? String(request.failure_message || 'The renewal request could not continue automatically. Review it before retrying.')
                    : `Verify payment before approving the ${formatStrong8kDuration(request.duration_months)} renewal. The request reserves ${Number(request.credits || 0)} credits.`,
                userId: request.account_id
            });
        });

    return items.sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title));
}

function renderUsers(filter = byId('user-search')?.value || '') {
    const tbody = byId('users-table-body');
    tbody.innerHTML = '';
    const queryValue = filter.trim().toLowerCase();
    const users = state.users.filter(user => {
        if (state.peopleFilter === 'prospects' && getProspectState(user).status !== 'prospect') return false;
        if (!queryValue) return true;
        return [user.full_name, user.email].some(value => String(value || '').toLowerCase().includes(queryValue));
    });

    users.forEach(user => {
        const memberships = state.membershipsByUser[user.id] || {};
        const prospect = getProspectState(user);
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4">
                <div class="font-semibold text-slate-950">${escapeHtml(user.full_name || 'No Name')}</div>
                <div class="text-xs text-slate-500">${escapeHtml(user.email || '')}</div>
            </td>
            <td class="px-4 py-4">
                <div class="flex flex-wrap gap-2">
                    ${renderMembershipBadge(memberships[APP_IDS.STRONG8K], APP_DEFINITIONS[APP_IDS.STRONG8K].shortLabel)}
                    ${['prospect', 'customer'].includes(prospect.status) ? `<span class="user-membership-chip">${prospect.status === 'prospect' ? 'Prospect' : 'Customer'}</span>` : ''}
                </div>
            </td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(user.default_app_id || 'Auto')}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="user-profile-button" data-start-prospect="${escapeAttribute(user.id)}">Start conversation</button>
                <button type="button" class="rounded-full border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-edit-user="${user.id}">
                    Edit
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-edit-user]').forEach(button => {
        button.addEventListener('click', () => userEditor?.open(button.dataset.editUser));
    });
    if (!users.length) tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-4 text-sm text-slate-600">No people match this filter.</td></tr>';
    bindProspectConversationActions(tbody);
}

function renderMembershipBadge(membership, label) {
    if (!membership) {
        return `<span class="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">${label}: none</span>`;
    }

    const statusClass = membership.status === 'active'
        ? 'bg-emerald-100 text-emerald-700'
        : membership.status === 'pending'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-rose-100 text-rose-700';
    return `<span class="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] ${statusClass}">${label}: ${membership.status}</span>`;
}

function renderStrong8kSection() {
    byId('strong8k-live-list').value = (state.strong8kConfig.live_list || []).join('\n');
    byId('strong8k-vod-list').value = (state.strong8kConfig.vod_list || []).join('\n');

    const migrationCount = state.strong8kProductMigrationCandidates.length;
    byId('product-migration-notice')?.toggleAttribute('hidden', migrationCount === 0);
    if (byId('product-migration-copy')) {
        byId('product-migration-copy').textContent = migrationCount
            ? `${migrationCount} legacy ${migrationCount === 1 ? 'package is' : 'packages are'} visible but not yet copied into the canonical catalog.`
            : 'The package catalog is canonical.';
    }

    const tbody = byId('product-table-body');
    tbody.innerHTML = state.strong8kProducts.length
        ? state.strong8kProducts.map(product => {
            const isRenewal = product.kind === 'renewal' && product.duration_months;
            const availability = isRenewal && product.active ? 'Available' : 'Not offered';
            const source = product.source === 'legacy' ? 'Legacy source' : 'Canonical';
            return `
                <article class="catalog-row ${product.active ? '' : 'is-inactive'}">
                    <div>
                        <div class="catalog-title">${escapeHtml(product.name)}</div>
                        <div class="catalog-meta">${isRenewal ? `${escapeHtml(formatStrong8kDuration(product.duration_months))} · ${escapeHtml(String(product.credits))} credits` : 'Manual product · no automated renewal'} · ${escapeHtml(source)}</div>
                    </div>
                    <div class="catalog-price">${CONFIG.CURRENCY_SYMBOL}${Number(product.price || 0).toFixed(2)}</div>
                    <span class="catalog-status ${product.active ? 'is-active' : ''}">${availability}</span>
                    <button type="button" class="catalog-edit" data-edit-product="${escapeAttribute(product.id)}">Edit</button>
                </article>`;
        }).join('')
        : '<div class="catalog-empty"><strong>No packages yet.</strong><p>Add the first renewal duration and customer price.</p></div>';

    tbody.querySelectorAll('[data-edit-product]').forEach(button => {
        button.addEventListener('click', () => loadProductIntoForm(button.dataset.editProduct));
    });
}

const mergeState = { sourceId: '', targetId: '', conflicts: [], conflictChoices: {} };

function bindMergeModal() {
    byId('merge-profiles-btn').addEventListener('click', openMergeModal);
    byId('merge-modal-close').addEventListener('click', closeMergeModal);
    byId('merge-preview-btn').addEventListener('click', renderMergePreview);
    byId('merge-execute-btn').addEventListener('click', executeMerge);
    byId('merge-reset-btn').addEventListener('click', resetMergeModal);
}

function openMergeModal() {
    const options = state.users
        .map(user => `<option value="${escapeAttribute(user.id)}">${escapeHtml(user.full_name || user.email || user.id)} — ${escapeHtml(user.email || '')}</option>`)
        .join('');
    byId('merge-source-select').innerHTML = '<option value="">Select source user…</option>' + options;
    byId('merge-target-select').innerHTML = '<option value="">Select target user…</option>' + options;
    resetMergeModal();
    byId('merge-modal').classList.remove('hidden');
}

function closeMergeModal() {
    byId('merge-modal').classList.add('hidden');
}

function resetMergeModal() {
    mergeState.sourceId = '';
    mergeState.targetId = '';
    mergeState.conflicts = [];
    mergeState.conflictChoices = {};
    byId('merge-preview-area').classList.add('hidden');
    byId('merge-conflict-area').classList.add('hidden');
    byId('merge-action-row').classList.add('hidden');
    byId('merge-preview-content').innerHTML = '';
    byId('merge-conflict-area').innerHTML = '';
    byId('merge-source-select').value = '';
    byId('merge-target-select').value = '';
}

function renderMergePreview() {
    const sourceId = byId('merge-source-select').value;
    const targetId = byId('merge-target-select').value;

    if (!sourceId || !targetId) {
        showToast('Select both a source and a target user', 'error');
        return;
    }
    if (sourceId === targetId) {
        showToast('Source and target must be different users', 'error');
        return;
    }

    const sourceUser = state.users.find(user => user.id === sourceId);
    const targetUser = state.users.find(user => user.id === targetId);
    const sourceProfile = state.strong8kProfiles[sourceId] || normalizeStrong8kProfile({}, sourceUser || {});
    const sourceMembership = state.membershipsByUser[sourceId]?.[APP_IDS.STRONG8K];

    mergeState.sourceId = sourceId;
    mergeState.targetId = targetId;

    const licenseCount = (sourceProfile.licenses || []).length;
    const previewLines = [
        sourceMembership ? `<li>Strong8K membership (role: ${escapeHtml(sourceMembership.role || 'member')}, status: ${escapeHtml(sourceMembership.status || 'active')})</li>` : '<li class="text-slate-400">No Strong8K membership on source</li>',
        `<li>${licenseCount} license${licenseCount !== 1 ? 's' : ''}</li>`,
        sourceProfile.domain_8k ? `<li>Primary domain: ${escapeHtml(sourceProfile.domain_8k)}</li>` : '',
        sourceProfile.domain_8k_backup ? `<li>Backup domain: ${escapeHtml(sourceProfile.domain_8k_backup)}</li>` : '',
        sourceProfile.credits_allocated ? `<li>Credits allocated: ${escapeHtml(String(sourceProfile.credits_allocated))}</li>` : '',
        sourceProfile.setup_notes ? `<li>Setup notes: ${escapeHtml(sourceProfile.setup_notes.slice(0, 80))}${sourceProfile.setup_notes.length > 80 ? '…' : ''}</li>` : '',
    ].filter(Boolean);

    byId('merge-preview-content').innerHTML = `<ul class="list-disc pl-5 space-y-1">${previewLines.join('')}</ul>`;
    byId('merge-preview-area').classList.remove('hidden');

    const conflictFields = [
        { key: 'full_name', label: 'Full name' },
        { key: 'default_app_id', label: 'Default app' },
    ];
    mergeState.conflicts = conflictFields.filter(field => {
        const src = String((sourceUser || {})[field.key] || '').trim();
        const tgt = String((targetUser || {})[field.key] || '').trim();
        return src && tgt && src !== tgt;
    });

    const conflictArea = byId('merge-conflict-area');
    if (mergeState.conflicts.length) {
        conflictArea.innerHTML = `
            <p class="text-xs font-bold uppercase tracking-[0.22em] text-amber-500">Conflicts — choose which value to keep</p>
            ${mergeState.conflicts.map(field => `
                <div class="rounded-[1.25rem] border border-amber-100 bg-amber-50 p-4 space-y-3">
                    <p class="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">${escapeHtml(field.label)}</p>
                    <label class="flex items-center gap-3 text-sm cursor-pointer">
                        <input type="radio" name="conflict-${escapeAttribute(field.key)}" value="source" class="accent-slate-900">
                        <span>Source: <strong>${escapeHtml(String((sourceUser || {})[field.key] || ''))}</strong></span>
                    </label>
                    <label class="flex items-center gap-3 text-sm cursor-pointer">
                        <input type="radio" name="conflict-${escapeAttribute(field.key)}" value="target" class="accent-slate-900" checked>
                        <span>Target (keep): <strong>${escapeHtml(String((targetUser || {})[field.key] || ''))}</strong></span>
                    </label>
                </div>
            `).join('')}
        `;
        conflictArea.classList.remove('hidden');
    } else {
        conflictArea.classList.add('hidden');
        conflictArea.innerHTML = '';
    }

    byId('merge-action-row').classList.remove('hidden');
}

async function executeMerge() {
    const { sourceId, targetId, conflicts } = mergeState;
    if (!sourceId || !targetId) return;

    for (const field of conflicts) {
        const chosen = document.querySelector(`input[name="conflict-${field.key}"]:checked`);
        mergeState.conflictChoices[field.key] = chosen?.value || 'target';
    }

    try {
        const sourceProfileSnap = await getDoc(doc(db, 'strong8k_profiles', sourceId));
        if (sourceProfileSnap.exists()) {
            await setDoc(doc(db, 'strong8k_profiles', targetId), sourceProfileSnap.data(), { merge: true });
        }

        const sourceMembershipSnap = await getDoc(doc(db, 'users', sourceId, 'memberships', APP_IDS.STRONG8K));
        if (sourceMembershipSnap.exists()) {
            await setDoc(doc(db, 'users', targetId, 'memberships', APP_IDS.STRONG8K), sourceMembershipSnap.data(), { merge: true });
        }

        if (Object.keys(mergeState.conflictChoices).length) {
            const sourceUser = state.users.find(user => user.id === sourceId) || {};
            const targetUpdates = {};
            for (const [key, choice] of Object.entries(mergeState.conflictChoices)) {
                if (choice === 'source') targetUpdates[key] = sourceUser[key];
            }
            if (Object.keys(targetUpdates).length) {
                await updateDoc(doc(db, 'users', targetId), targetUpdates);
            }
        }

        await updateDoc(doc(db, 'users', sourceId), { deleted: true });

        closeMergeModal();
        showToast('Profiles merged — source archived');
        await loadAdminData();
    } catch (error) {
        showToast('Merge failed: ' + error.message, 'error');
    }
}

function bindStrong8kForms() {
    byId('strong8k-config-form').addEventListener('submit', saveStrong8kConfig);
    byId('product-form').addEventListener('submit', saveStrong8kProduct);
    byId('new-product-btn').addEventListener('click', openNewProductForm);
    byId('product-cancel-btn').addEventListener('click', clearProductForm);
    byId('product-duration').addEventListener('change', syncProductCredits);
    byId('product-migration-btn').addEventListener('click', migrateLegacyProducts);
    byId('seed-strong8k-btn').addEventListener('click', seedStrong8kDefaults);
}

async function saveStrong8kConfig(event) {
    event.preventDefault();
    await setDoc(doc(db, 'strong8k_config', 'content_options'), {
        live_list: parseLineList(byId('strong8k-live-list').value),
        vod_list: parseLineList(byId('strong8k-vod-list').value)
    }, { merge: true });
    showToast('Strong8K config saved');
    await loadAdminData();
}

function parseLineList(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean);
}

function loadProductIntoForm(productId) {
    const product = state.strong8kProducts.find(item => item.id === productId);
    if (!product) return;
    state.editingProductId = product.id;
    byId('product-id').value = product.id;
    byId('product-name').value = product.name || '';
    byId('product-price').value = product.price || 0;
    byId('product-duration').value = product.duration_months || '';
    byId('product-credits').value = product.duration_months || 0;
    byId('product-active').checked = product.active !== false;
    byId('product-form-title').textContent = `Edit ${product.name || 'package'}`;
    byId('product-form').hidden = false;
    byId('product-name').focus();
}

function clearProductForm() {
    state.editingProductId = '';
    byId('product-id').value = '';
    byId('product-name').value = '';
    byId('product-price').value = '0';
    byId('product-duration').value = '';
    byId('product-credits').value = '0';
    byId('product-active').checked = true;
    byId('product-form-title').textContent = 'New renewal package';
    byId('product-form').hidden = true;
}

function openNewProductForm() {
    clearProductForm();
    byId('product-form').hidden = false;
    byId('product-name').focus();
}

function syncProductCredits() {
    byId('product-credits').value = String(Number(byId('product-duration').value || 0));
}

async function saveStrong8kProduct(event) {
    event.preventDefault();
    const duration = Number(byId('product-duration').value || 0);
    const currentId = byId('product-id').value;
    const duplicate = state.strong8kProducts.find(product => product.kind === 'renewal' && product.duration_months === duration && product.id !== currentId);
    if (duplicate) {
        showToast(`${formatStrong8kDuration(duration)} already uses ${duplicate.name}. Edit that row instead.`, 'error');
        return;
    }

    const productId = currentId || `${duration}_month`;
    let payload;
    try {
        payload = strong8kProductPayload({
            id: productId,
            name: byId('product-name').value,
            price: Number(byId('product-price').value || 0),
            duration_months: duration,
            active: byId('product-active').checked
        });
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }

    const saveButton = byId('product-save-btn');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving';
    try {
        await setDoc(doc(db, 'strong8k_products', productId), {
            ...payload,
            updated_at: new Date().toISOString()
        }, { merge: true });
        clearProductForm();
        showToast('Renewal package saved');
        await loadAdminData();
    } catch (error) {
        showToast(`Package could not be saved: ${error.message}`, 'error');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save package';
    }
}

async function migrateLegacyProducts() {
    const candidates = state.strong8kProductMigrationCandidates;
    if (!candidates.length) {
        showToast('The package catalog is already canonical');
        return;
    }

    const button = byId('product-migration-btn');
    button.disabled = true;
    button.textContent = 'Importing';
    try {
        for (const product of candidates) {
            await setDoc(doc(db, 'strong8k_products', product.id || `${product.duration_months}_month`), {
                ...strong8kProductPayload(product),
                migrated_from: 'products',
                migrated_at: new Date().toISOString()
            }, { merge: true });
        }
        showToast(`${candidates.length} legacy ${candidates.length === 1 ? 'package' : 'packages'} imported`);
        await loadAdminData();
    } catch (error) {
        showToast(`Legacy packages could not be imported: ${error.message}`, 'error');
    } finally {
        button.disabled = false;
        button.textContent = 'Import missing packages';
    }
}

async function seedStrong8kDefaults() {
    await setDoc(doc(db, 'strong8k_config', 'content_options'), {
        live_list: [
            "Elliot's Default (QC + Sports + English)",
            'Quebec Premium (French)',
            'Canada & USA (English)',
            'International (Europe/Latino)',
            'Adult 18+',
            'Other / Custom Request'
        ],
        vod_list: [
            "Elliot's Default (Movies & Series)",
            'French Content Only',
            'English Content Only',
            'International',
            'Adult',
            'None',
            'Other / Custom Request'
        ]
    }, { merge: true });

    const defaults = [
        { id: '1_month', name: '1 Month Access', price: 10, duration_months: 1, active: true },
        { id: '3_month', name: '3 Months Bundle', price: 25, duration_months: 3, active: true },
        { id: '6_month', name: '6 Months Deal', price: 40, duration_months: 6, active: true },
        { id: '12_month', name: '1 Year VIP', price: 60, duration_months: 12, active: true }
    ];

    for (const product of defaults) {
        await setDoc(doc(db, 'strong8k_products', product.id), {
            ...strong8kProductPayload(product),
            updated_at: new Date().toISOString()
        }, { merge: true });
    }

    showToast('Strong8K defaults seeded');
    await loadAdminData();
}

function escapeAttribute(value) {
    return String(value || '').replace(/"/g, '&quot;');
}

function toDateTimeLocal(value) {
    if (!value) return '';
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}
