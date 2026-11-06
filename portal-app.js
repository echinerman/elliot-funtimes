import { CONFIG } from './config.js?v=20261103-inbox-live';
import { bindPortalSupport } from './portal-support.js?v=20261102-inbox';
import {
    APP_DEFINITIONS,
    APP_IDS,
    defaultMembership,
    defaultSharedUser,
    deriveAccessibleApps,
    formatDate,
    getSetupNotesValue,
    normalizeStrong8kProfile
} from './app-model.js?v=20261027-user-workspace';
import {
    formatStrong8kDuration,
    isSelectableStrong8kRenewal,
    mergeStrong8kProducts
} from './strong8k-products.mjs?v=20261101-renewal-requests';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
    createUserWithEmailAndPassword,
    getAuth,
    onAuthStateChanged,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    orderBy,
    query,
    setDoc,
    updateDoc,
    where
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const firebaseApp = initializeApp(CONFIG.FIREBASE);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const VIEW_IDS = [
    'loading-view',
    'auth-view',
    'app-switcher-view',
    'no-access-view',
    'strong8k-view',
];

const state = {
    authUser: null,
    accountId: '',
    sharedUser: null,
    isPlatformAdmin: false,
    memberships: {},
    accessibleApps: {},
    activeAppId: null,
    strong8k: {
        profile: null,
        products: [],
        contentOptions: { live_list: [], vod_list: [] },
        supportEvents: [],
        renewalRequests: [],
        selectedProductId: '',
        selectedLicenseId: ''
    }
};

document.addEventListener('DOMContentLoaded', () => {
    renderPortalChrome();
    bindAuthForms();
    bindNoAccessEvents();
    bindStrong8kEvents();
    bindPortalSupport({ auth, state, config: CONFIG });
    bindSharedActions();
    setView('auth-view');
    onAuthStateChanged(auth, handleAuthStateChange);
    window.addEventListener('hashchange', () => {
        if (state.authUser) {
            routeAuthenticatedUser().catch(handlePortalLoadError);
        }
    });
});

function byId(id) {
    return document.getElementById(id);
}

function activeAccountId() {
    return state.accountId || state.authUser?.uid || '';
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

function setView(viewId) {
    VIEW_IDS.forEach(id => byId(id).classList.toggle('hidden', id !== viewId));
    syncPortalChrome(viewId);
}

function renderPortalChrome() {
    const railMarkup = `
        <div class="room-rail-inner">
            <div class="room-brand">
                <span class="room-brand-mark">E</span>
                <div>
                    <div class="room-brand-name">Elliot's clubhouse</div>
                    <div class="room-brand-subtitle">Private access</div>
                </div>
                <button type="button" class="room-rail-close" data-rail-close aria-label="Close room menu">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
            <nav class="room-nav" aria-label="Portal rooms">
                <a class="room-nav-item" data-room-link="home" href="#/apps"><i class="fa-solid fa-house" aria-hidden="true"></i><span>Home</span></a>
                <a class="room-nav-item" data-room-link="strong8k" data-room-app="strong8k" href="#/app/strong8k"><i class="fa-solid fa-tv" aria-hidden="true"></i><span>Strong8K</span></a>
                <button type="button" class="room-nav-item" data-room-link="support" data-room-support><i class="fa-solid fa-life-ring" aria-hidden="true"></i><span>Support</span></button>
                <div class="room-nav-label">For Elliot</div>
                <a class="room-nav-item hidden" data-room-link="operations" data-room-operations href="./admin.html"><i class="fa-solid fa-list-check" aria-hidden="true"></i><span>Operations</span></a>
            </nav>
            <div class="room-account">
                <div class="room-account-name" data-portal-name>Member</div>
                <div class="room-account-email" data-portal-email></div>
                <button type="button" class="room-signout" data-action="signout"><i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>Sign out</button>
            </div>
        </div>
    `;

    document.querySelectorAll('[data-room-rail]').forEach(rail => {
        rail.innerHTML = railMarkup;
    });

    document.querySelectorAll('[data-rail-toggle]').forEach(button => {
        button.addEventListener('click', () => setRailOpen(button.closest('.portal-shell'), true));
    });
    document.querySelectorAll('[data-rail-close], [data-rail-backdrop]').forEach(control => {
        control.addEventListener('click', () => setRailOpen(control.closest('.portal-shell'), false));
    });
    document.querySelectorAll('.room-nav-item').forEach(item => {
        item.addEventListener('click', () => setRailOpen(item.closest('.portal-shell'), false));
    });
    document.querySelectorAll('[data-room-support]').forEach(button => {
        button.addEventListener('click', openSupportRoom);
    });

    syncRailAccessibility();
    window.addEventListener('resize', syncRailAccessibility, { passive: true });
}

function setRailOpen(shell, isOpen) {
    if (!shell) return;
    const rail = shell.querySelector('[data-room-rail]');
    rail?.classList.toggle('is-open', isOpen);
    rail?.toggleAttribute('inert', !isOpen && window.innerWidth <= 960);
    shell.querySelector('[data-rail-backdrop]')?.classList.toggle('is-open', isOpen);
    shell.querySelector('[data-rail-toggle]')?.setAttribute('aria-expanded', String(isOpen));
    document.body.classList.toggle('overflow-hidden', isOpen && window.innerWidth <= 960);
}

function syncRailAccessibility() {
    document.querySelectorAll('.portal-shell').forEach(shell => {
        const rail = shell.querySelector('[data-room-rail]');
        if (!rail) return;

        const isMobile = window.innerWidth <= 960;
        const isOpen = rail.classList.contains('is-open');
        rail.toggleAttribute('inert', isMobile && !isOpen);
        shell.querySelector('[data-rail-toggle]')?.setAttribute('aria-expanded', String(isMobile && isOpen));
        if (!isMobile) {
            shell.querySelector('[data-rail-backdrop]')?.classList.remove('is-open');
        }
    });
}

async function openSupportRoom() {
    if (!getActiveMemberships()[APP_IDS.STRONG8K]) return;

    window.location.hash = APP_DEFINITIONS[APP_IDS.STRONG8K].route;
    if (state.activeAppId !== APP_IDS.STRONG8K) {
        try {
            await openApp(APP_IDS.STRONG8K);
            setView('strong8k-view');
        } catch (error) {
            handlePortalLoadError(error);
            return;
        }
    }

    requestAnimationFrame(() => {
        byId('strong8k-support')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActivePortalRoom('support');
    });
}

function setActivePortalRoom(roomId) {
    document.querySelectorAll('[data-room-link]').forEach(item => {
        const active = item.dataset.roomLink === roomId;
        item.classList.toggle('is-active', active);
        if (active) {
            item.setAttribute('aria-current', 'page');
        } else {
            item.removeAttribute('aria-current');
        }
    });
}

function syncPortalChrome(viewId = '') {
    const activeMemberships = getActiveMemberships();
    document.querySelectorAll('[data-room-app]').forEach(item => {
        item.classList.toggle('hidden', !activeMemberships[item.dataset.roomApp]);
    });
    document.querySelectorAll('[data-room-support]').forEach(item => {
        item.classList.toggle('hidden', !activeMemberships[APP_IDS.STRONG8K]);
    });
    document.querySelectorAll('[data-room-operations]').forEach(item => {
        item.classList.toggle('hidden', !state.isPlatformAdmin);
    });
    document.querySelectorAll('[data-portal-name]').forEach(item => {
        item.textContent = state.sharedUser?.full_name || state.authUser?.email?.split('@')[0] || 'Member';
    });
    document.querySelectorAll('[data-portal-email]').forEach(item => {
        item.textContent = state.authUser?.email || '';
    });

    const activeRoom = viewId === 'app-switcher-view'
        ? 'home'
        : viewId === 'strong8k-view'
            ? APP_IDS.STRONG8K
                : '';
    setActivePortalRoom(activeRoom);
}

function currentHashApp() {
    const match = window.location.hash.match(/^#\/app\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function isAppsHomeRoute() {
    return window.location.hash === '#/apps';
}

function resolveInviteCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    return Object.entries(CONFIG.INVITE_CODES).find(([, inviteCode]) => inviteCode.toUpperCase() === normalized)?.[0] || null;
}


function resetSessionState() {
    state.accountId = '';
    state.sharedUser = null;
    state.isPlatformAdmin = false;
    state.memberships = {};
    state.accessibleApps = {};
    state.activeAppId = null;
    state.strong8k = {
        profile: null,
        products: [],
        contentOptions: { live_list: [], vod_list: [] },
        supportEvents: [],
        renewalRequests: [],
        selectedProductId: '',
        selectedLicenseId: ''
    };
}

async function handleAuthStateChange(user) {
    state.authUser = user;

    if (!user) {
        resetSessionState();
        setView('auth-view');
        return;
    }

    try {
        setView('loading-view');
        await hydrateSession(user);
        await routeAuthenticatedUser();
    } catch (error) {
        handlePortalLoadError(error);
    }
}

async function hydrateSession(user) {
    state.sharedUser = await loadSharedUser(user);
    state.memberships = await loadSessionMemberships(user.uid, state.accountId || user.uid);
    state.accessibleApps = deriveAccessibleApps(state.memberships, state.sharedUser);
    state.isPlatformAdmin = await resolvePlatformAdmin(user);
    byId('switcher-email').textContent = user.email;
    byId('no-access-email').textContent = user.email;
    syncPortalChrome();
}

function isConfiguredAdminEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return Boolean(normalizedEmail) && Array.isArray(CONFIG.ADMIN_EMAILS)
        && CONFIG.ADMIN_EMAILS.some(candidate => String(candidate || '').trim().toLowerCase() === normalizedEmail);
}

async function resolvePlatformAdmin(user) {
    if (isConfiguredAdminEmail(user?.email)) return true;
    try {
        const roleSnap = await getDoc(doc(db, 'roles', user.uid));
        return roleSnap.exists() && roleSnap.data().platform_admin === true;
    } catch (error) {
        console.warn('Unable to verify the optional platform role for portal navigation.', error);
        return false;
    }
}

function getActiveMemberships() {
    return Object.fromEntries(
        Object.entries(state.accessibleApps).filter(([, membership]) => membership.status === 'active')
    );
}

function getPendingMemberships() {
    return Object.fromEntries(
        Object.entries(state.accessibleApps).filter(([, membership]) => membership.status !== 'active')
    );
}

async function routeAuthenticatedUser() {
    const activeMemberships = getActiveMemberships();
    const requestedAppId = currentHashApp();
    const wantsAppSwitcher = isAppsHomeRoute();

    if (requestedAppId && activeMemberships[requestedAppId]) {
        await openApp(requestedAppId);
        return;
    }

    const appIds = Object.keys(activeMemberships);
    if (wantsAppSwitcher && appIds.length) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        return;
    }

    if (appIds.length === 1) {
        const appId = appIds[0];
        window.location.hash = APP_DEFINITIONS[appId].route;
        await openApp(appId);
        return;
    }

    if (appIds.length > 1) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        return;
    }

    renderInviteCodePrompt();
    setView('no-access-view');
}

function handlePortalLoadError(error) {
    console.error('Portal load failed', error);
    if (state.authUser?.email) {
        byId('no-access-email').textContent = state.authUser.email;
    }

    const activeMemberships = getActiveMemberships();
    if (state.authUser && Object.keys(activeMemberships).length) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        showToast(error?.message || 'Portal load failed', 'error');
        return;
    }

    renderInviteCodePrompt();
    setView('no-access-view');
    showToast(error?.message || 'Portal load failed', 'error');
}

async function openApp(appId) {
    state.activeAppId = appId;

    if (appId === APP_IDS.STRONG8K) {
        await loadStrong8kApp();
        setView('strong8k-view');
        return;
    }

}

async function loadSharedUser(user) {
    const linkRef = doc(db, 'account_links', user.uid);
    const linkSnap = await getDoc(linkRef);
    let accountId = linkSnap.exists() ? String(linkSnap.data().account_id || '') : '';

    if (!accountId) {
        const directUserRef = doc(db, 'users', user.uid);
        const directUserSnap = await getDoc(directUserRef);
        if (directUserSnap.exists()) {
            accountId = user.uid;
        } else {
            const claimableAccount = await findClaimableAccount(user.email, user.uid);
            accountId = claimableAccount?.id || user.uid;
            if (claimableAccount) {
                await setDoc(linkRef, {
                    account_id: accountId,
                    email: user.email,
                    created_at: new Date().toISOString()
                });
                await updateDoc(doc(db, 'users', accountId), {
                    auth_uid: user.uid,
                    claimed_at: new Date().toISOString()
                });
            }
        }
    }

    state.accountId = accountId;
    const accountRef = doc(db, 'users', accountId);
    const accountSnap = await getDoc(accountRef);
    if (!accountSnap.exists()) {
        const newUser = {
            ...defaultSharedUser(user.email),
            email: user.email,
            auth_uid: user.uid
        };
        await setDoc(accountRef, newUser, { merge: true });
        return { id: accountId, ...newUser };
    }

    return {
        id: accountId,
        ...defaultSharedUser(user.email),
        ...accountSnap.data(),
        email: user.email
    };
}

async function findClaimableAccount(email, uid) {
    if (!email) return null;
    try {
        const accountQuery = query(collection(db, 'users'), where('email', '==', email));
        const results = await getDocs(accountQuery);
        const match = results.docs.find(item => {
            if (item.id === uid) return false;
            const data = item.data();
            return data.deleted !== true && (!data.auth_uid || data.auth_uid === uid);
        });
        return match ? { id: match.id, ...match.data() } : null;
    } catch (error) {
        console.warn('Pre-created profile lookup was skipped.', error);
        return null;
    }
}

async function loadMemberships(uid) {
    const membershipSnap = await getDocs(collection(db, 'users', uid, 'memberships'));
    const memberships = {};
    membershipSnap.forEach(item => {
        memberships[item.id] = {
            ...defaultMembership(item.id),
            ...item.data(),
            app_id: item.id
        };
    });
    return memberships;
}

async function loadSessionMemberships(authUid, accountId) {
    const directMemberships = await loadMemberships(authUid);
    if (!accountId || accountId === authUid) return directMemberships;
    const linkedMemberships = await loadMemberships(accountId);
    return {
        ...directMemberships,
        ...(linkedMemberships[APP_IDS.STRONG8K]
            ? { [APP_IDS.STRONG8K]: linkedMemberships[APP_IDS.STRONG8K] }
            : {})
    };
}

function bindAuthForms() {
    let pending = false;
    const feedback = (message = '', tone = 'error') => {
        const status = byId('auth-status');
        status.textContent = message;
        status.dataset.tone = tone;
        status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
        status.classList.toggle('hidden', !message);
    };
    const switchForm = registering => {
        if (pending) return;
        byId('login-form').classList.toggle('hidden', registering);
        byId('register-form').classList.toggle('hidden', !registering);
        byId('auth-form-title').textContent = registering ? 'Make yourself at home' : 'Come on in';
        byId('auth-helper-text').textContent = registering ? 'Create your account with an email and password.' : 'Sign in with your email and password.';
        feedback();
        byId(registering ? 'reg-email' : 'login-email').focus();
    };
    const friendlyError = error => {
        const messages = {
            'auth/invalid-credential': "That email and password didn't match. Check your details or reset your password.",
            'auth/wrong-password': "That email and password didn't match. Check your details or reset your password.",
            'auth/user-not-found': "That email and password didn't match. Check your details or reset your password.",
            'auth/network-request-failed': "We couldn't connect. Check your internet connection and try again.",
            'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
            'auth/email-already-in-use': 'This email already has an account. Sign in instead, or reset your password.',
            'auth/weak-password': 'Choose a stronger password, then try again.',
            'auth/invalid-email': 'Enter a valid email address.',
            'auth/user-disabled': 'This account is unavailable. Please contact Elliot for help.'
        };
        return messages[error.code] || "We couldn't complete that request. Please try again, or contact Elliot for help.";
    };
    const submit = async (form, label, action) => {
        if (pending) return;
        pending = true;
        feedback();
        const button = form.querySelector('button[type="submit"]');
        const originalLabel = button.textContent;
        form.setAttribute('aria-busy', 'true');
        button.disabled = true;
        button.textContent = label;
        try {
            await action();
        } catch (error) {
            feedback(friendlyError(error));
        } finally {
            pending = false;
            form.removeAttribute('aria-busy');
            button.disabled = false;
            button.textContent = originalLabel;
        }
    };
    byId('show-register-link').addEventListener('click', event => {
        event.preventDefault();
        switchForm(true);
    });

    byId('show-login-link').addEventListener('click', event => {
        event.preventDefault();
        switchForm(false);
    });

    byId('login-form').addEventListener('submit', async event => {
        event.preventDefault();
        await submit(event.currentTarget, 'Signing in...', () => signInWithEmailAndPassword(auth, byId('login-email').value.trim(), byId('login-pass').value));
    });

    byId('register-form').addEventListener('submit', async event => {
        event.preventDefault();
        const email = byId('reg-email').value.trim();
        const password = byId('reg-pass').value;
        await submit(event.currentTarget, 'Creating account...', () => createUserWithEmailAndPassword(auth, email, password));
    });

    byId('forgot-password-link').addEventListener('click', async event => {
        event.preventDefault();
        if (pending) return;
        const email = byId('login-email').value.trim();
        if (!email) {
            feedback('Enter your email address above first, then choose Forgot password.');
            byId('login-email').focus();
            return;
        }
        if (!byId('login-email').reportValidity()) return;
        await submit(byId('login-form'), 'Requesting reset...', async () => {
            try {
                await sendPasswordResetEmail(auth, email);
            } catch (error) {
                if (error.code !== 'auth/user-not-found') throw error;
            }
            feedback('If this email has an account, a reset link is on its way. Check your inbox.', 'success');
        });
    });
}

function renderInviteCodePrompt() {
    const codeInput = byId('activate-code');
    if (codeInput) codeInput.value = '';
}

async function selfActivateApp(appId, inviteCode) {
    const membershipOwnerId = appId === APP_IDS.STRONG8K ? activeAccountId() : state.authUser.uid;
    const membershipRef = doc(db, 'users', membershipOwnerId, 'memberships', appId);
    const membership = {
        ...defaultMembership(appId, inviteCode),
        app_id: appId
    };
    await setDoc(membershipRef, {
        ...membership
    }, { merge: true });
    if (appId === APP_IDS.STRONG8K) {
        const profileRef = doc(db, 'strong8k_profiles', membershipOwnerId);
        const profileSnap = await getDoc(profileRef);
        if (!profileSnap.exists()) {
            await setDoc(profileRef, customerStrong8kProfileDefaults());
        }
    }
}

function customerStrong8kProfileDefaults() {
    const defaults = normalizeStrong8kProfile({}, {});
    return {
        live_preferences: defaults.live_preferences,
        vod_preferences: defaults.vod_preferences,
        custom_request: '',
        setup_notes: '',
        devices: [],
        updated_at: new Date().toISOString()
    };
}

function bindNoAccessEvents() {
    const form = byId('activate-form');
    if (!form) return;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const code = byId('activate-code').value.trim();
        const appId = resolveInviteCode(code);
        if (!appId) {
            showToast('Invalid invite code', 'error');
            return;
        }
        const submitBtn = byId('activate-submit-btn');
        try {
            submitBtn.disabled = true;
            await selfActivateApp(appId, code.toUpperCase());
            await hydrateSession(state.authUser);
            await routeAuthenticatedUser();
            showToast(`${APP_DEFINITIONS[appId].shortLabel} access activated!`);
        } catch (error) {
            showToast(error.message, 'error');
        } finally {
            submitBtn.disabled = false;
        }
    });
}


function bindSharedActions() {
    byId('switcher-signout-btn').addEventListener('click', () => signOut(auth));
    byId('no-access-signout-btn').addEventListener('click', () => signOut(auth));

    document.querySelectorAll('[data-action="app-home"]').forEach(button => {
        button.addEventListener('click', async () => {
            window.location.hash = '#/apps';
            try {
                await routeAuthenticatedUser();
            } catch (error) {
                handlePortalLoadError(error);
            }
        });
    });

    document.querySelectorAll('[data-action="signout"]').forEach(button => {
        button.addEventListener('click', () => signOut(auth));
    });
}

function renderAppSwitcher(activeMemberships) {
    const container = byId('app-switcher-cards');
    container.innerHTML = '';

    Object.keys(activeMemberships).forEach(appId => {
        const app = APP_DEFINITIONS[appId];
        const button = document.createElement('button');
        const icon = 'fa-tv';
        button.type = 'button';
        button.className = 'room-ledger-row group';
        button.innerHTML = `
            <span class="room-ledger-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
            <span>
                <span class="room-ledger-title">${escapeHtml(app.authTitle)}</span>
                <span class="room-ledger-copy block">${escapeHtml(app.authDescription)}</span>
            </span>
            <span class="room-ledger-action">Open room <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span>
        `;
        button.addEventListener('click', async () => {
            window.location.hash = app.route;
            try {
                await openApp(appId);
                syncPortalChrome('strong8k-view');
            } catch (error) {
                handlePortalLoadError(error);
            }
        });
        container.appendChild(button);
    });

    if (state.isPlatformAdmin) {
        const operationsLink = document.createElement('a');
        operationsLink.className = 'room-ledger-row group';
        operationsLink.href = './admin.html';
        operationsLink.innerHTML = `
            <span class="room-ledger-icon bg-emerald-600"><i class="fa-solid fa-list-check" aria-hidden="true"></i></span>
            <span>
                <span class="room-ledger-title">Operations</span>
                <span class="room-ledger-copy block">Review people, expiring licenses, renewal work, and configuration.</span>
            </span>
            <span class="room-ledger-action">Open workspace <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span>
        `;
        container.appendChild(operationsLink);
    }

    if (!container.children.length) {
        container.innerHTML = `
            <div class="py-10 text-center">
                <p class="font-black text-slate-950">No rooms are active yet.</p>
                <p class="mt-2 text-sm text-slate-500">Use your invite code or contact Elliot for access.</p>
            </div>
        `;
    }
}

async function loadStrong8kApp() {
    const user = state.authUser;
    const accountId = state.accountId || user.uid;
    const sharedUser = state.sharedUser || {};
    const profileSnap = await getDoc(doc(db, 'strong8k_profiles', accountId));
    const profile = normalizeStrong8kProfile(profileSnap.exists() ? profileSnap.data() : {}, sharedUser);
    const supportEvents = await loadSharedSupportEvents(accountId);

    let contentOptions = { live_list: [], vod_list: [] };
    const configSnap = await getDoc(doc(db, 'strong8k_config', 'content_options'));
    if (configSnap.exists()) {
        contentOptions = configSnap.data();
    } else {
        const legacyConfigSnap = await getDoc(doc(db, 'app_config', 'content_options'));
        if (legacyConfigSnap.exists()) {
            contentOptions = legacyConfigSnap.data();
        }
    }

    const [productsSnap, legacyProductsSnap, renewalRequestsSnap] = await Promise.all([
        getDocs(collection(db, 'strong8k_products')),
        getDocs(collection(db, 'products')),
        getDocs(query(
            collection(db, 'strong8k_renewal_requests'),
            where('account_id', '==', accountId)
        ))
    ]);
    const products = mergeStrong8kProducts(
        productsSnap.docs.map(item => ({ id: item.id, ...item.data() })),
        legacyProductsSnap.docs.map(item => ({ id: item.id, ...item.data() }))
    ).filter(isSelectableStrong8kRenewal);

    const hasEPGenius = profile.licenses.some(license => license.epgenius_url && String(license.epgenius_url).trim() !== '');
    const resolvedProducts = [...products];
    if (hasEPGenius) {
        resolvedProducts.push({ id: 'donation_epgenius', name: 'Donate to EPGenius Curator', price: 20, kind: 'donation' });
    }

    state.strong8k.profile = profile;
    state.strong8k.products = resolvedProducts;
    state.strong8k.contentOptions = contentOptions;
    state.strong8k.supportEvents = supportEvents;
    state.strong8k.renewalRequests = renewalRequestsSnap.docs.map(item => ({ id: item.id, ...item.data() }));
    renderStrong8k();
}

async function loadSharedSupportEvents(userId, legacyAccountId = '') {
    const profileIds = [...new Set([userId, legacyAccountId].filter(Boolean))];
    const events = [];
    for (const profileId of profileIds) {
        try {
            const eventQuery = query(
                collection(db, 'strong8k_profiles', profileId, 'support_events'),
                where('visibility', '==', 'shared')
            );
            const snapshot = await getDocs(eventQuery);
            snapshot.forEach(item => events.push({ id: item.id, profile_id: profileId, ...item.data() }));
        } catch (error) {
            console.warn(`Shared support history could not be loaded for ${profileId}.`, error);
        }
    }
    return events.sort((left, right) => String(right.occurred_at || right.created_at || '').localeCompare(String(left.occurred_at || left.created_at || '')));
}

function renderStrong8k() {
    const { profile, products, contentOptions } = state.strong8k;
    if (!profile) return;

    byId('strong8k-user-name').textContent = state.sharedUser.full_name || 'Client';
    byId('strong8k-user-email').textContent = state.authUser.email;
    byId('contact-link').href = CONFIG.CONTACT_LINK;
    const licenseCount = profile.licenses?.length || 0;
    byId('strong8k-license-summary').textContent = `${licenseCount} ${licenseCount === 1 ? 'license' : 'licenses'}`;

    renderStrong8kLicenses(profile);
    renderStrong8kProducts(products);
    renderStrong8kPreferenceTags('live', profile.live_preferences || [], contentOptions.live_list || []);
    renderStrong8kPreferenceTags('vod', profile.vod_preferences || [], contentOptions.vod_list || []);
    byId('custom-req').value = profile.custom_request || '';
    byId('setup-notes').value = getSetupNotesValue(profile);
    renderSharedSupportHistory(state.strong8k.supportEvents || []);
}

function renderSharedSupportHistory(events) {
    const container = byId('shared-support-history');
    if (!container) return;
    if (!events.length) {
        container.innerHTML = `
            <div class="customer-support-empty">
                <strong>No shared support history yet.</strong>
                <p>When Elliot records a setup or troubleshooting update for you, it will appear here.</p>
            </div>`;
        return;
    }
    container.innerHTML = events.map(event => `
        <article class="customer-support-event">
            <time datetime="${escapeAttribute(event.occurred_at || '')}">${escapeHtml(formatSupportEventDate(event.occurred_at || event.created_at))}</time>
            <div>
                <h3>${escapeHtml(event.summary || 'Support update')}</h3>
                ${event.details ? `<p>${escapeHtml(event.details)}</p>` : ''}
                <span>${escapeHtml(formatSupportKind(event.kind))}</span>
            </div>
        </article>`).join('');
}

function formatSupportKind(value) {
    return {
        setup: 'Setup',
        troubleshooting: 'Troubleshooting',
        renewal: 'Renewal',
        communication: 'Communication',
        other: 'Other'
    }[value] || 'Support';
}

function formatSupportEventDate(value) {
    const parsed = new Date(value || '');
    if (Number.isNaN(parsed.getTime())) return 'Date not recorded';
    return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(parsed);
}

function renderStrong8kLicenses(profile) {
    const container = byId('licenses-container');
    container.innerHTML = '';

    const licenses = profile.licenses || [];
    if (!licenses.length) {
        container.innerHTML = `
            <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
                <p class="font-black text-slate-950">No licenses have been added yet.</p>
                <p class="mt-2 text-sm text-slate-500">If you recently paid, Elliot may still be preparing your access.</p>
            </div>
        `;
        return;
    }

    licenses.forEach(license => {
        const card = document.createElement('article');
        const presentation = getLicensePresentation(license);
        const domain = profile.domain_8k || 'Contact Admin';
        const backup = profile.domain_8k_backup || '';
        card.className = 'license-ledger-card';
        card.style.setProperty('--license-accent', presentation.accent);
        card.innerHTML = `
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h3 class="text-xl font-black tracking-[-0.02em] text-slate-950">${escapeHtml(license.label || 'License')}</h3>
                    <p class="mt-1 text-sm text-slate-500">Expires <time datetime="${escapeAttribute(license.expiry_date || '')}">${escapeHtml(formatDate(license.expiry_date))}</time></p>
                </div>
                <span class="self-start rounded-full px-3 py-1.5 text-xs font-black ${presentation.className}">${escapeHtml(presentation.label)}</span>
            </div>
            <div class="license-fields">
                <div class="grid gap-3 md:grid-cols-2">
                    ${copyField('Primary Domain', domain)}
                    ${backup ? copyField('Backup Domain', backup) : ''}
                </div>
                <div class="grid gap-3 md:grid-cols-2">
                    ${copyField('Username', license.username_8k)}
                    ${copyField('License Password', license.password_8k)}
                </div>
                ${license.m3u_url_8k ? copyBlock('8K M3U URL', license.m3u_url_8k) : ''}
                ${license.epg_url_8k ? copyBlock('8K EPG URL', license.epg_url_8k) : ''}
                ${license.epgenius_url ? copyBlock('EPGenius Playlist URL', license.epgenius_url, 'border-blue-100') : ''}
            </div>
        `;
        container.appendChild(card);
    });

    container.querySelectorAll('[data-copy]').forEach(button => {
        button.addEventListener('click', async () => {
            try {
                await copyTextToClipboard(button.dataset.copy || '');
                showToast('Copied to clipboard');
            } catch (error) {
                console.error('Unable to copy credential', error);
                showToast('Copy failed. Select the text and copy it manually.', 'error');
            }
        });
    });
}

function getLicensePresentation(license = {}) {
    const status = String(license.status || '').trim().toLowerCase();
    const expiryValue = String(license.expiry_date || '').slice(0, 10);
    const expiry = /^\d{4}-\d{2}-\d{2}$/.test(expiryValue) ? new Date(`${expiryValue}T00:00:00`) : null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysRemaining = expiry ? Math.ceil((expiry.getTime() - today.getTime()) / 86400000) : null;

    if (status === 'expired' || (daysRemaining !== null && daysRemaining < 0)) {
        return { label: 'Expired', className: 'bg-rose-100 text-rose-800', accent: '#e11d48' };
    }
    if (status === 'disabled' || status === 'banned') {
        return { label: status === 'banned' ? 'Banned' : 'Disabled', className: 'bg-rose-100 text-rose-800', accent: '#e11d48' };
    }
    if (daysRemaining !== null && daysRemaining <= 30) {
        return { label: `${Math.max(daysRemaining, 0)} days left`, className: 'bg-amber-100 text-amber-900', accent: '#d97706' };
    }
    if (status === 'active') {
        return { label: 'Active', className: 'bg-emerald-100 text-emerald-800', accent: '#10b981' };
    }
    return { label: license.status || 'Status unknown', className: 'bg-slate-100 text-slate-700', accent: '#94a3b8' };
}

function copyField(label, value) {
    return `
        <div>
            <span class="mb-1.5 block text-xs font-black text-slate-500">${escapeHtml(label)}</span>
            <button type="button" class="credential-button flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-left text-sm font-mono text-slate-800" data-copy="${escapeAttribute(value || '')}" aria-label="Copy ${escapeAttribute(label)}">
                <span class="credential-value">${escapeHtml(value || 'N/A')}</span>
                <i class="fa-regular fa-copy shrink-0 text-xs text-slate-400" aria-hidden="true"></i>
            </button>
        </div>
    `;
}

function copyBlock(label, value, extraBorderClass = '') {
    return `
        <div>
            <span class="mb-1.5 block text-xs font-black text-slate-500">${escapeHtml(label)}</span>
            <button type="button" class="credential-button flex w-full items-start justify-between gap-3 rounded-xl border ${extraBorderClass || 'border-slate-200'} bg-slate-50 px-3 py-2.5 text-left text-xs font-mono text-slate-700" data-copy="${escapeAttribute(value || '')}" aria-label="Copy ${escapeAttribute(label)}">
                <span class="credential-value">${escapeHtml(value)}</span>
                <i class="fa-regular fa-copy mt-0.5 shrink-0 text-xs text-slate-400" aria-hidden="true"></i>
            </button>
        </div>
    `;
}

function renderStrong8kProducts(products) {
    const list = byId('product-list');
    list.innerHTML = '';

    if (!products.length) {
        list.innerHTML = `
            <div class="py-8 text-center">
                <p class="font-black text-slate-950">No renewal packages are available right now.</p>
                <p class="mt-2 text-sm text-slate-500">Contact Elliot if your license is close to expiring.</p>
            </div>
        `;
        return;
    }

    products.forEach(product => {
        const isDonation = product.kind === 'donation';
        const pendingCount = isDonation ? 0 : state.strong8k.renewalRequests.filter(request => (
            request.product_id === product.id && isOpenRenewalRequest(request)
        )).length;
        const row = document.createElement('div');
        row.className = 'room-ledger-row';
        row.innerHTML = `
            <span class="room-ledger-icon"><i class="fa-solid ${isDonation ? 'fa-heart' : 'fa-rotate'}" aria-hidden="true"></i></span>
            <span>
                <span class="room-ledger-title">${escapeHtml(product.name)}</span>
                <span class="room-ledger-copy block">${CONFIG.CURRENCY_SYMBOL}${Number(product.price || 0).toFixed(2)}${isDonation ? ' · Manual donation' : ` · Adds ${escapeHtml(formatStrong8kDuration(product.duration_months))}`}${pendingCount ? ` · ${pendingCount} pending` : ''}</span>
            </span>
            <button type="button" class="portal-secondary room-ledger-action" data-choose-product="${escapeAttribute(product.id)}">${isDonation ? 'Donation details' : 'Choose package'}</button>
        `;
        list.appendChild(row);
    });

    list.querySelectorAll('[data-choose-product]').forEach(button => {
        button.addEventListener('click', () => {
            openPurchaseModal(button.dataset.chooseProduct);
        });
    });
}

function isOpenRenewalRequest(request = {}) {
    return ['payment_reported', 'approved', 'processing', 'manual_review'].includes(String(request.status || ''));
}

function renderStrong8kPreferenceTags(type, selectedValues, allOptions) {
    const container = byId(type === 'live' ? 'live-tags' : 'vod-tags');
    const select = byId(type === 'live' ? 'live-pref-select' : 'vod-pref-select');
    container.innerHTML = '';

    selectedValues.forEach(value => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'rounded-full bg-slate-900 px-3 py-1 text-[11px] font-bold text-white transition hover:bg-rose-600';
        chip.textContent = value;
        chip.addEventListener('click', () => toggleStrong8kPreference(type, value));
        container.appendChild(chip);
    });

    select.innerHTML = '<option value="">+ Add...</option>';
    allOptions.forEach(option => {
        if (selectedValues.includes(option)) return;
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        select.appendChild(opt);
    });
}

function bindStrong8kEvents() {
    byId('live-pref-select').addEventListener('change', event => {
        if (event.target.value) toggleStrong8kPreference('live', event.target.value);
        event.target.value = '';
    });
    byId('vod-pref-select').addEventListener('change', event => {
        if (event.target.value) toggleStrong8kPreference('vod', event.target.value);
        event.target.value = '';
    });
    byId('save-config-btn').addEventListener('click', saveStrong8kProfile);
    byId('purchase-close-btn').addEventListener('click', closePurchaseModal);
    byId('purchase-cancel-btn').addEventListener('click', closePurchaseModal);
    byId('donation-cancel-btn').addEventListener('click', closePurchaseModal);
    byId('purchase-success-close-btn').addEventListener('click', closePurchaseModal);
    byId('purchase-form').addEventListener('submit', submitRenewalRequest);
    byId('purchase-license-list').addEventListener('change', event => {
        if (event.target.matches('[name="renewal-license"]')) {
            state.strong8k.selectedLicenseId = event.target.value;
            syncRenewalRequestSummary();
        }
    });
    byId('purchase-modal').addEventListener('click', event => {
        if (event.target === byId('purchase-modal')) closePurchaseModal();
    });
}

function toggleStrong8kPreference(type, value) {
    const field = type === 'live' ? 'live_preferences' : 'vod_preferences';
    const current = state.strong8k.profile[field] || [];
    state.strong8k.profile[field] = current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value];
    renderStrong8k();
}

async function saveStrong8kProfile() {
    const profileRef = doc(db, 'strong8k_profiles', state.accountId || state.authUser.uid);
    state.strong8k.profile.custom_request = byId('custom-req').value;
    state.strong8k.profile.setup_notes = byId('setup-notes').value;

    await setDoc(profileRef, {
        custom_request: state.strong8k.profile.custom_request,
        setup_notes: state.strong8k.profile.setup_notes,
        live_preferences: state.strong8k.profile.live_preferences || [],
        vod_preferences: state.strong8k.profile.vod_preferences || [],
        updated_at: new Date().toISOString()
    }, { merge: true });

    showToast('Strong8K preferences saved');
}

function openPurchaseModal(productId) {
    const product = state.strong8k.products.find(item => item.id === productId);
    if (!product) {
        showToast('That package is no longer available. Refresh and try again.', 'error');
        return;
    }

    const dialog = byId('purchase-modal');
    const isDonation = product.kind === 'donation';
    state.strong8k.selectedProductId = product.id;
    state.strong8k.selectedLicenseId = '';
    byId('modal-product-name').textContent = product.name;
    byId('modal-product-price').textContent = `${CONFIG.CURRENCY_SYMBOL}${Number(product.price || 0).toFixed(2)}`;
    byId('modal-product-duration').textContent = isDonation
        ? 'Handled separately from Strong8K renewals'
        : `Adds ${formatStrong8kDuration(product.duration_months)} to one license`;
    byId('renewal-form-content').hidden = isDonation;
    byId('donation-form-content').hidden = !isDonation;
    byId('purchase-success').hidden = true;
    byId('purchase-form').hidden = false;
    setPurchaseStatus('');

    if (isDonation) {
        const subject = encodeURIComponent(`EPGenius donation (${state.authUser.email})`);
        const body = encodeURIComponent(`Hi Elliot,\n\nI would like to send a ${CONFIG.CURRENCY_SYMBOL}${Number(product.price || 0).toFixed(2)} donation to the EPGenius curator.\n\nAccount Email: ${state.authUser.email}\n\nThanks!`);
        byId('donation-notify-link').href = `mailto:${CONFIG.PAYMENT_EMAIL}?subject=${subject}&body=${body}`;
    } else {
        renderRenewalLicenseChoices();
    }

    if (!dialog.open) dialog.showModal();
}

function renderRenewalLicenseChoices() {
    const container = byId('purchase-license-list');
    const licenses = (state.strong8k.profile?.licenses || []).filter(license => String(license.id || '').trim());
    container.innerHTML = '';

    if (!licenses.length) {
        container.innerHTML = `
            <div class="renewal-blocked">
                <strong>No selectable license found.</strong>
                <p>Ask Elliot to finish the license record before submitting a renewal.</p>
            </div>`;
        byId('renewal-submit-btn').disabled = true;
        setPurchaseStatus('Your saved license needs an ID before it can be renewed.', 'error');
        return;
    }

    const autoSelect = licenses.length === 1;
    state.strong8k.selectedLicenseId = autoSelect ? licenses[0].id : '';
    container.innerHTML = licenses.map((license, index) => `
        <label class="renewal-license-option">
            <input type="radio" name="renewal-license" value="${escapeAttribute(license.id)}" ${autoSelect && index === 0 ? 'checked' : ''} required>
            <span>
                <strong>${escapeHtml(license.label || `License ${index + 1}`)}</strong>
                <small>${escapeHtml(license.username_8k || 'Username not saved')} · Expires ${escapeHtml(formatDate(license.expiry_date))}</small>
            </span>
        </label>
    `).join('');
    syncRenewalRequestSummary();
}

function syncRenewalRequestSummary() {
    const product = state.strong8k.products.find(item => item.id === state.strong8k.selectedProductId);
    const licenseId = state.strong8k.selectedLicenseId;
    const submitButton = byId('renewal-submit-btn');
    const summary = byId('purchase-summary');
    const existing = state.strong8k.renewalRequests.find(request => (
        request.license_id === licenseId && isOpenRenewalRequest(request)
    ));

    if (!licenseId) {
        summary.textContent = 'Choose the license that should receive the added time.';
        submitButton.disabled = true;
        setPurchaseStatus('');
        return;
    }
    if (existing) {
        summary.textContent = `${existing.product_name || 'A renewal'} is already waiting for Elliot’s review for this license.`;
        submitButton.disabled = true;
        setPurchaseStatus('You do not need to submit this payment again.', 'attention');
        return;
    }

    summary.textContent = `${product.name} will add ${formatStrong8kDuration(product.duration_months)} after Elliot verifies payment.`;
    submitButton.disabled = false;
    setPurchaseStatus('');
}

async function submitRenewalRequest(event) {
    event.preventDefault();
    const product = state.strong8k.products.find(item => item.id === state.strong8k.selectedProductId);
    const licenseId = state.strong8k.selectedLicenseId;
    if (!product || product.kind !== 'renewal' || !licenseId) {
        setPurchaseStatus('Choose a package and license before submitting.', 'error');
        return;
    }

    const submitButton = byId('renewal-submit-btn');
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';
    setPurchaseStatus('Securely recording your request…');
    try {
        const idToken = await state.authUser.getIdToken();
        const response = await fetch(CONFIG.STRONG8K_RENEWAL_REQUEST_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, productId: product.id, licenseId })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok && payload.code !== 'DUPLICATE_REQUEST') {
            throw new Error(payload.message || 'The request could not be recorded.');
        }
        if (payload.code === 'DUPLICATE_REQUEST') {
            setPurchaseStatus('A renewal request is already waiting for this license.', 'attention');
            submitButton.textContent = 'Already submitted';
            return;
        }

        state.strong8k.renewalRequests.push(payload.request);
        byId('purchase-form').hidden = true;
        byId('purchase-success').hidden = false;
        byId('purchase-success-title').textContent = 'Request received';
        byId('purchase-success-copy').textContent = 'Elliot will verify the payment before processing the renewal. You’ll receive a final confirmation after the provider expiry has been checked again.';
        renderStrong8kProducts(state.strong8k.products);
    } catch (error) {
        console.error('Renewal request could not be submitted', error);
        setPurchaseStatus(error.message || 'The request could not be recorded.', 'error');
        submitButton.disabled = false;
        submitButton.textContent = 'I’ve sent payment · Submit request';
    }
}

function setPurchaseStatus(message, tone = '') {
    const status = byId('purchase-status');
    status.textContent = message;
    status.dataset.tone = tone;
}

function closePurchaseModal() {
    const dialog = byId('purchase-modal');
    if (dialog.open) dialog.close();
    state.strong8k.selectedProductId = '';
    state.strong8k.selectedLicenseId = '';
    byId('renewal-submit-btn').disabled = false;
    byId('renewal-submit-btn').textContent = 'I’ve sent payment · Submit request';
}


function prettifyStatus(value) {
    return String(value || '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function formatCurrency(value) {
    return `${CONFIG.CURRENCY_SYMBOL}${Number(value || 0).toFixed(2)}`;
}

function formatDateTime(value) {
    if (!value) {
        return 'TBD';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return formatDate(value);
    }

    return new Intl.DateTimeFormat('en-CA', {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(parsed);
}

function ordinal(value) {
    const safeValue = Number(value || 0);
    const remainder100 = safeValue % 100;
    if (remainder100 >= 11 && remainder100 <= 13) {
        return `${safeValue}th`;
    }

    switch (safeValue % 10) {
    case 1:
        return `${safeValue}st`;
    case 2:
        return `${safeValue}nd`;
    case 3:
        return `${safeValue}rd`;
    default:
        return `${safeValue}th`;
    }
}

function escapeAttribute(value) {
    return String(value || '').replace(/"/g, '&quot;');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
