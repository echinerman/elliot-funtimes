import {
    defaultSharedUser,
    escapeHtml,
    formatDate,
    normalizeStrong8kProfile,
    parseDelimitedList
} from './app-model.js?v=20261027-user-workspace';
import {
    buildProviderReconciliationSnapshot,
    buildReconciliationDifferences,
    buildStrong8kUrls,
    canonicalizeReconciliationSnapshot,
    normalizeProviderBaseUrl,
    reconciliationBaselineMatches,
    selectedFieldsWithDependencies
} from './strong8k-reconciliation.mjs?v=20261030-provider-reconciliation';
import {
    addDoc,
    collection,
    deleteField,
    doc,
    getDoc,
    getDocs,
    query,
    runTransaction,
    setDoc,
    updateDoc,
    where
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { deriveProspectState, hasCompleteLicense, licenseHistoryPatch, prospectClassificationPatch } from './prospect-model.mjs?v=20261104-prospects';

const PROFILE_ROUTE = /^#people\/([^/]+)$/;
const SUPPORT_KINDS = {
    setup: 'Setup',
    troubleshooting: 'Troubleshooting',
    renewal: 'Renewal',
    communication: 'Communication',
    other: 'Other'
};

export function createUserEditor({
    db,
    auth,
    state,
    showToast,
    copyTextToClipboard,
    reloadAdminData,
    syncMembership,
    syncPoolMembers,
    appIds,
    deviceInfoWebhookUrl,
    startProspectConversation = async () => { throw new Error('Conversation composer is not available.'); },
    beforeRouteChange = async () => true,
    onDashboardRoute = () => {}
}) {
    const local = {
        activeUserId: '',
        expandedLicenseId: '',
        supportEvents: [],
        privateNotes: '',
        accessBaseline: '',
        pendingLicensePatches: {},
        providerChecks: {},
        profileDomainProposal: null,
        checkAll: null,
        reconciliationController: null,
        autosave: {
            queue: Promise.resolve(),
            timers: new Map(),
            scheduled: new Map(),
            pending: 0,
            failed: null
        }
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function bind() {
        byId('new-user-btn')?.addEventListener('click', openNewUserModal);
        byId('new-user-close')?.addEventListener('click', closeNewUserModal);
        byId('new-user-cancel')?.addEventListener('click', closeNewUserModal);
        byId('new-user-form')?.addEventListener('submit', createUserShell);
        byId('new-user-modal')?.addEventListener('click', event => {
            if (event.target === byId('new-user-modal')) closeNewUserModal();
        });
        byId('new-user-modal')?.addEventListener('keydown', trapModalFocus);

        byId('user-workspace-back')?.addEventListener('click', navigateToPeople);
        byId('user-autosave-retry')?.addEventListener('click', retryFailedSave);
        byId('archive-user-btn')?.addEventListener('click', archiveActiveUser);
        byId('user-prospect-classify')?.addEventListener('click', () => classifyProspect(local.activeUserId));
        byId('user-prospect-start')?.addEventListener('click', () => startConversation(local.activeUserId));
        byId('add-license-btn')?.addEventListener('click', openNewLicenseForm);
        byId('check-all-licenses-btn')?.addEventListener('click', () => checkAllLicenses());
        byId('strong8k-check-all-status')?.addEventListener('click', handleProfileCheckClick);
        byId('new-license-cancel')?.addEventListener('click', closeNewLicenseForm);
        byId('new-license-form')?.addEventListener('submit', createLicense);
        byId('user-license-list')?.addEventListener('click', handleLicenseClick);
        byId('user-license-list')?.addEventListener('input', handleLicenseInput);
        byId('user-license-list')?.addEventListener('change', handleLicenseInput);

        byId('support-event-add-btn')?.addEventListener('click', openSupportEventForm);
        byId('support-event-cancel')?.addEventListener('click', closeSupportEventForm);
        byId('support-event-form')?.addEventListener('submit', createSupportEvent);

        document.querySelectorAll('[data-user-field]').forEach(field => {
            field.addEventListener('input', scheduleUserSave);
            field.addEventListener('change', scheduleUserSave);
        });
        document.querySelectorAll('[data-profile-field]').forEach(field => {
            field.addEventListener('input', scheduleProfileSave);
            field.addEventListener('change', scheduleProfileSave);
        });
        document.querySelectorAll('[data-private-field]').forEach(field => {
            field.addEventListener('input', schedulePrivateSave);
        });

        const accessControls = [
            'member-strong8k-enabled',
            'member-strong8k-role',
            'member-strong8k-status',
        ];
        accessControls.forEach(id => byId(id)?.addEventListener('change', updateAccessDraft));
        byId('user-access-apply')?.addEventListener('click', applyAccessChanges);
        byId('private-notes-migration-btn')?.addEventListener('click', migrateAllPrivateNotes);

        window.addEventListener('hashchange', runRouteChange);
        window.addEventListener('beforeunload', event => {
            if (!hasUnsettledSaves()) return;
            event.preventDefault();
            event.returnValue = '';
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !byId('new-user-modal')?.hasAttribute('hidden')) {
                closeNewUserModal();
            }
        });
    }

    function handleDataLoaded() {
        runRouteChange();
    }

    function open(userId) {
        if (!userId) return;
        const nextHash = `#people/${encodeURIComponent(userId)}`;
        if (window.location.hash === nextHash) {
            showUserWorkspace(userId).catch(reportWorkspaceError);
            return;
        }
        window.location.hash = nextHash;
    }

    function runRouteChange() {
        handleRouteChange().catch(reportWorkspaceError);
    }

    function reportWorkspaceError(error) {
        console.error('Unable to open the customer workspace', error);
        showToast(error?.message || 'The customer workspace could not be opened.', 'error');
    }

    async function handleRouteChange() {
        if (!await beforeRouteChange()) return;
        const match = window.location.hash.match(PROFILE_ROUTE);
        if (!match) {
            if (local.activeUserId) {
                await flushAutosaves();
                if (local.autosave.failed && !window.confirm('A profile change could not be saved. Leave the profile anyway?')) {
                    window.location.hash = `#people/${encodeURIComponent(local.activeUserId)}`;
                    return;
                }
            }
            showDashboard();
            return;
        }

        const userId = decodeURIComponent(match[1]);
        if (!state.users.length) return;
        await showUserWorkspace(userId);
    }

    function showDashboard() {
        local.reconciliationController?.abort();
        local.reconciliationController = null;
        local.activeUserId = '';
        local.expandedLicenseId = '';
        resetReconciliationState();
        byId('user-workspace')?.classList.add('hidden');
        byId('admin-page-header')?.classList.remove('hidden');
        const activeTab = document.querySelector('[data-tab].is-active')?.dataset.tab || 'platform';
        document.querySelectorAll('[data-admin-dashboard]').forEach(section => {
            if (section.matches('[data-panel]')) {
                section.classList.toggle('hidden', section.dataset.panel !== activeTab);
            } else {
                section.classList.remove('hidden');
            }
        });
        document.title = "Operations | Elliot's Private Clubhouse";
        onDashboardRoute();
    }

    async function showUserWorkspace(userId) {
        const user = state.users.find(item => item.id === userId);
        if (!user) {
            showToast('That customer profile could not be found.', 'error');
            window.location.hash = '#people';
            return;
        }

        if (local.activeUserId && local.activeUserId !== userId) {
            await flushAutosaves();
            if (local.autosave.failed && !window.confirm('A profile change could not be saved. Open another profile anyway?')) {
                window.location.hash = `#people/${encodeURIComponent(local.activeUserId)}`;
                return;
            }
        }

        local.activeUserId = userId;
        local.expandedLicenseId = '';
        local.pendingLicensePatches = {};
        local.reconciliationController?.abort();
        local.reconciliationController = null;
        resetReconciliationState();
        resetAutosaveState();

        document.querySelectorAll('[data-admin-dashboard]').forEach(section => section.classList.add('hidden'));
        byId('communications-workspace')?.classList.add('hidden');
        byId('admin-page-header')?.classList.add('hidden');
        byId('user-workspace')?.classList.remove('hidden');
        document.title = `${user.full_name || user.email || 'Customer'} | Operations`;
        window.scrollTo({ top: 0, behavior: 'auto' });

        const profile = normalizeStrong8kProfile(state.strong8kProfiles[userId] || {}, user);
        try {
            state.currentLicenses = await ensureStableLicenseIds(userId, profile);
        } catch (error) {
            console.error('Unable to verify stable license IDs', error);
            state.currentLicenses = profile.licenses.map(license => ({
                ...license,
                id: license.id || crypto.randomUUID()
            }));
            showToast('Licenses are visible, but edits may fail until the connection recovers.', 'error');
        }
        profile.licenses = state.currentLicenses;
        state.strong8kProfiles[userId] = profile;
        const supportContext = await loadSupportContext(user);
        local.privateNotes = supportContext.privateNotes;
        local.supportEvents = supportContext.events;

        populateWorkspace(user, profile);
        renderLicenses();
        renderSupportTimeline();
        renderAccessEditor(user);
        closeNewLicenseForm();
        closeSupportEventForm();
    }

    function populateWorkspace(user, profile) {
        byId('user-id').value = user.id;
        byId('user-workspace-title').textContent = user.full_name || user.email || 'Customer profile';
        byId('user-workspace-email').textContent = user.email || 'No email saved';
        byId('user-full-name').value = user.full_name || '';
        byId('user-email').value = user.email || '';
        byId('user-default-app').value = user.default_app_id || '';
        byId('strong8k-domain').value = profile.domain_8k || '';
        byId('strong8k-backup-domain').value = profile.domain_8k_backup || '';
        byId('strong8k-credits').value = Number(profile.credits_allocated || 0);
        byId('strong8k-live').value = (profile.live_preferences || []).join(', ');
        byId('strong8k-vod').value = (profile.vod_preferences || []).join(', ');
        byId('strong8k-custom-request').value = profile.custom_request || '';
        byId('strong8k-setup-notes').value = profile.setup_notes || '';
        byId('strong8k-internal-notes').value = local.privateNotes || '';
        renderMembershipStrip(user.id);
        renderProspectLabel();
    }

    function prospectState(userId) {
        const user = state.users.find(item => item.id === userId);
        const legacyId = user?.legacy_account_id;
        return deriveProspectState(state.strong8kProfiles[userId], state.strong8kPrivate?.[userId],
            legacyId ? [state.strong8kProfiles[legacyId]] : [],
            legacyId ? [state.strong8kPrivate?.[legacyId]] : []);
    }

    function renderProspectLabel() {
        const node = byId('user-prospect-label');
        if (!node || !local.activeUserId) return;
        const classification = prospectState(local.activeUserId);
        node.textContent = classification.status === 'prospect' ? 'Prospect'
            : classification.status === 'customer' ? 'Customer'
                : classification.status === 'setup' ? 'License setup incomplete'
                    : classification.historySeen ? 'Prior license history recorded'
                        : classification.suggested ? 'Prospect suggested · confirm before labelling' : 'License history unknown';
        byId('user-prospect-classify').hidden = !classification.canClassify || classification.status === 'prospect';
        byId('user-prospect-start').hidden = false;
    }

    let prospectActionPending = false;

    async function runProspectAction(userId, action) {
        if (!userId || prospectActionPending) return;
        prospectActionPending = true;
        const buttons = [byId('user-prospect-classify'), byId('user-prospect-start')];
        buttons.forEach(button => { if (button) button.disabled = true; });
        try {
            await flushAutosaves();
            if (local.autosave.failed) throw new Error('Retry the unsaved profile changes before continuing.');
            await action();
        } catch (error) {
            showToast(error.message || 'The prospect action could not be completed. Please retry.', 'error');
        } finally {
            prospectActionPending = false;
            buttons.forEach(button => { if (button) button.disabled = false; });
        }
    }

    async function classifyProspect(userId) {
        return runProspectAction(userId, async () => {
            const classification = prospectState(userId);
            if (!classification.canClassify) throw new Error('Saved license history prevents prospect classification.');
            const explanation = classification.historyKnown
                ? 'The admin record says no prior license has been recorded.'
                : 'Legacy license history is unknown. An empty license list does not prove this person never had a license. Confirm only after reviewing their history and deciding they are a prospect, not a former customer.';
            if (!window.confirm(`${explanation}\n\nLabel this person as a Prospect? This changes admin-only metadata. It grants no access, buys nothing, and sends no message.`)) return;
            const user = state.users.find(item => item.id === userId);
            await enqueueSave(`prospect:${userId}`, () => runTransaction(db, async transaction => {
                const ids = [...new Set([userId, user?.legacy_account_id].filter(Boolean))];
                const profiles = [];
                const records = [];
                for (const id of ids) {
                    const profile = await transaction.get(doc(db, 'strong8k_profiles', id));
                    const record = await transaction.get(doc(db, 'strong8k_private', id));
                    profiles.push(profile.exists() ? profile.data() : {});
                    records.push(record.exists() ? record.data() : {});
                }
                const patch = prospectClassificationPatch(profiles[0], records[0], {
                    confirmedUnknown: !classification.historyKnown, at: new Date().toISOString(), by: auth.currentUser?.uid || '',
                    legacyProfiles: profiles.slice(1), legacyMetadata: records.slice(1)
                });
                transaction.set(doc(db, 'strong8k_private', userId), patch, { merge: true });
            }));
            await reloadAdminData();
            renderProspectLabel();
            showToast('Prospect label saved. No message sent.');
        });
    }

    async function startConversation(userId) {
        return runProspectAction(userId, async () => {
            await reloadAdminData();
            if (!state.users.some(user => user.id === userId && !user.deleted)) throw new Error('This profile is no longer available.');
            await startProspectConversation(userId);
        });
    }

    // Read private history before any writes; commit the sentinel with the license.
    async function runLicenseTransaction(userId, writer) {
        let committedMetadata;
        const result = await runTransaction(db, async transaction => {
            committedMetadata = undefined;
            const privateRef = doc(db, 'strong8k_private', userId);
            const privateSnapshot = await transaction.get(privateRef);
            const metadata = privateSnapshot.exists() ? privateSnapshot.data() : {};
            return writer(transaction, (profileSnapshot, licenses) => {
                const before = profileSnapshot.exists() && Array.isArray(profileSnapshot.data().licenses)
                    ? profileSnapshot.data().licenses : [];
                const patch = licenseHistoryPatch(before, licenses, metadata, {
                    at: new Date().toISOString(), by: auth.currentUser?.uid || ''
                });
                if (Object.keys(patch).length) transaction.set(privateRef, patch, { merge: true });
                committedMetadata = { ...metadata, ...patch };
            });
        });
        if (committedMetadata) {
            state.strong8kPrivate ||= {};
            state.strong8kPrivate[userId] = committedMetadata;
            renderProspectLabel();
        }
        return result;
    }

    function renderMembershipStrip(userId) {
        const memberships = state.membershipsByUser[userId] || {};
        const definitions = [
            { id: appIds.STRONG8K, label: 'Strong8K' }
        ];
        byId('user-membership-strip').innerHTML = definitions.map(item => {
            const membership = memberships[item.id];
            const status = membership?.status || 'none';
            const statusClass = status === 'active'
                ? 'is-active'
                : status === 'pending'
                    ? 'is-pending'
                    : status === 'disabled'
                        ? 'is-disabled'
                        : '';
            return `<span class="user-membership-chip ${statusClass}">${escapeHtml(item.label)}: ${escapeHtml(status)}</span>`;
        }).join('');
    }

    async function ensureStableLicenseIds(userId, profile) {
        let resolvedLicenses = profile.licenses.map(license => ({ ...license }));
        await runLicenseTransaction(userId, async (transaction, saveHistory) => {
            const profileRef = doc(db, 'strong8k_profiles', userId);
            const snapshot = await transaction.get(profileRef);
            const savedLicenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                ? snapshot.data().licenses
                : profile.licenses;
            resolvedLicenses = savedLicenses.map(license => ({ ...license, id: license.id || crypto.randomUUID() }));
            const needsWrite = !snapshot.exists() || savedLicenses.some(license => !license.id);
            if (needsWrite && resolvedLicenses.length) {
                saveHistory(snapshot, resolvedLicenses);
                transaction.set(profileRef, {
                    licenses: resolvedLicenses,
                    updated_at: new Date().toISOString()
                }, { merge: true });
            }
        });
        return resolvedLicenses;
    }

    function profileIdsForUser(user) {
        return [...new Set([user.id, user.legacy_account_id].filter(Boolean))];
    }

    async function loadSupportContext(user) {
        const profileIds = profileIdsForUser(user);
        const legacyNotes = [];
        let incomplete = false;
        for (const profileId of profileIds) {
            const profile = state.strong8kProfiles[profileId];
            if (profile?.internal_notes) {
                legacyNotes.push(String(profile.internal_notes).trim());
                try {
                    await migrateLegacyPrivateNote(profileId, profile.internal_notes);
                    delete profile.internal_notes;
                } catch (error) {
                    incomplete = true;
                    console.error(`Private note migration deferred for ${profileId}`, error);
                }
            }
        }

        const privateSnapshots = await Promise.all(profileIds.map(async profileId => {
            try {
                return await getDoc(doc(db, 'strong8k_private', profileId));
            } catch (error) {
                incomplete = true;
                console.error(`Unable to load private notes for ${profileId}`, error);
                return null;
            }
        }));
        const privateValues = privateSnapshots
            .filter(Boolean)
            .filter(snapshot => snapshot.exists() && String(snapshot.data().internal_notes || '').trim())
            .map(snapshot => String(snapshot.data().internal_notes).trim())
            .filter((value, index, values) => values.indexOf(value) === index);
        legacyNotes.forEach(note => {
            if (note && !privateValues.some(value => value.includes(note))) privateValues.push(note);
        });
        const privateNotes = privateValues.join('\n\n');

        const eventSnapshots = await Promise.all(profileIds.map(async profileId => {
            try {
                return await getDocs(collection(db, 'strong8k_profiles', profileId, 'support_events'));
            } catch (error) {
                incomplete = true;
                console.error(`Unable to load support history for ${profileId}`, error);
                return null;
            }
        }));
        const events = [];
        eventSnapshots.forEach((snapshot, index) => {
            if (!snapshot) return;
            snapshot.forEach(item => events.push({
                id: item.id,
                profile_id: profileIds[index],
                ...item.data()
            }));
        });
        events.sort((left, right) => String(right.occurred_at || right.created_at || '').localeCompare(String(left.occurred_at || left.created_at || '')));
        if (incomplete) {
            showToast('Some private notes or support history could not be loaded. You can keep working and retry later.', 'error');
        }
        return { privateNotes, events };
    }

    function scheduleUserSave() {
        const userId = local.activeUserId;
        if (!userId) return;
        const emailInput = byId('user-email');
        if (!emailInput.checkValidity()) {
            setAutosaveStatus('error', 'Check email', false);
            return;
        }

        const user = state.users.find(item => item.id === userId);
        if (user) {
            user.full_name = byId('user-full-name').value.trim();
            user.email = emailInput.value.trim().toLowerCase();
            user.default_app_id = byId('user-default-app').value;
            byId('user-workspace-title').textContent = user.full_name || user.email || 'Customer profile';
            byId('user-workspace-email').textContent = user.email || 'No email saved';
        }

        scheduleAutosave(`user:${userId}`, async () => {
            await setDoc(doc(db, 'users', userId), {
                full_name: byId('user-full-name').value.trim(),
                email: byId('user-email').value.trim().toLowerCase(),
                default_app_id: byId('user-default-app').value,
                updated_at: new Date().toISOString()
            }, { merge: true });
        });
    }

    function scheduleProfileSave() {
        const userId = local.activeUserId;
        if (!userId) return;
        const profile = state.strong8kProfiles[userId] || normalizeStrong8kProfile({}, {});
        Object.assign(profile, collectProfileFields());
        state.strong8kProfiles[userId] = profile;

        scheduleAutosave(`profile:${userId}`, async () => {
            await setDoc(doc(db, 'strong8k_profiles', userId), {
                ...collectProfileFields(),
                updated_at: new Date().toISOString()
            }, { merge: true });
        });
    }

    function collectProfileFields() {
        return {
            domain_8k: byId('strong8k-domain').value.trim(),
            domain_8k_backup: byId('strong8k-backup-domain').value.trim(),
            credits_allocated: Number(byId('strong8k-credits').value || 0),
            live_preferences: parseDelimitedList(byId('strong8k-live').value),
            vod_preferences: parseDelimitedList(byId('strong8k-vod').value),
            custom_request: byId('strong8k-custom-request').value,
            setup_notes: byId('strong8k-setup-notes').value
        };
    }

    function schedulePrivateSave() {
        const userId = local.activeUserId;
        if (!userId) return;
        local.privateNotes = byId('strong8k-internal-notes').value;
        scheduleAutosave(`private:${userId}`, async () => {
            await setDoc(doc(db, 'strong8k_private', userId), {
                internal_notes: byId('strong8k-internal-notes').value,
                updated_at: new Date().toISOString(),
                updated_by: auth.currentUser?.uid || ''
            }, { merge: true });
        });
    }

    function scheduleAutosave(key, writer) {
        const existingTimer = local.autosave.timers.get(key);
        if (existingTimer) window.clearTimeout(existingTimer);
        local.autosave.scheduled.set(key, writer);
        setAutosaveStatus('saving', 'Waiting to save');
        const timer = window.setTimeout(() => {
            local.autosave.timers.delete(key);
            local.autosave.scheduled.delete(key);
            enqueueSave(key, writer);
        }, 700);
        local.autosave.timers.set(key, timer);
    }

    function enqueueSave(key, writer) {
        local.autosave.pending += 1;
        local.autosave.failed = null;
        setAutosaveStatus('saving', 'Saving');
        const operation = local.autosave.queue.then(writer);
        local.autosave.queue = operation.catch(() => {});
        operation
            .then(() => {
                local.autosave.pending -= 1;
                refreshAutosaveStatus();
            })
            .catch(error => {
                console.error(`Autosave failed for ${key}`, error);
                local.autosave.pending -= 1;
                local.autosave.failed = { key, writer };
                setAutosaveStatus('error', 'Could not save', true);
            });
        return operation;
    }

    function refreshAutosaveStatus() {
        if (local.autosave.failed) {
            setAutosaveStatus('error', 'Could not save', true);
            return;
        }
        if (local.autosave.pending || local.autosave.scheduled.size) {
            setAutosaveStatus('saving', 'Saving');
            return;
        }
        setAutosaveStatus('saved', 'Saved');
    }

    function setAutosaveStatus(status, label, canRetry = false) {
        const container = byId('user-autosave-status');
        if (!container) return;
        container.dataset.state = status;
        byId('user-autosave-label').textContent = label;
        byId('user-autosave-icon').className = status === 'error'
            ? 'fa-solid fa-circle-exclamation'
            : status === 'saving'
                ? 'fa-solid fa-rotate fa-spin'
                : 'fa-solid fa-circle-check';
        byId('user-autosave-retry').classList.toggle('hidden', !canRetry);
    }

    function resetAutosaveState() {
        local.autosave.timers.forEach(timer => window.clearTimeout(timer));
        local.autosave.timers.clear();
        local.autosave.scheduled.clear();
        local.autosave.pending = 0;
        local.autosave.failed = null;
        local.autosave.queue = Promise.resolve();
        setAutosaveStatus('saved', 'Saved');
    }

    async function retryFailedSave() {
        const failed = local.autosave.failed;
        if (!failed) return;
        local.autosave.failed = null;
        try {
            await enqueueSave(failed.key, failed.writer);
        } catch (error) {
            showToast('The profile change still could not be saved.', 'error');
        }
    }

    async function flushAutosaves() {
        const scheduled = [...local.autosave.scheduled.entries()];
        local.autosave.timers.forEach(timer => window.clearTimeout(timer));
        local.autosave.timers.clear();
        local.autosave.scheduled.clear();
        scheduled.forEach(([key, writer]) => enqueueSave(key, writer));
        await local.autosave.queue;
    }

    function hasUnsettledSaves() {
        return Boolean(local.autosave.pending || local.autosave.scheduled.size || local.autosave.failed);
    }

    function renderLicenses() {
        renderProspectLabel();
        const container = byId('user-license-list');
        const licenses = state.currentLicenses || [];
        renderProfileCheckSummary();
        if (!licenses.length) {
            container.innerHTML = `
                <div class="user-license-empty">
                    <strong>No Strong8K license is saved yet.</strong>
                    <p>Add the purchased line after payment and provider details have been confirmed.</p>
                </div>`;
            return;
        }

        container.innerHTML = licenses.map(license => {
            const presentation = licensePresentation(license);
            const isEditing = local.expandedLicenseId === license.id;
            const check = local.providerChecks[license.id] || null;
            const isChecking = ['checking', 'applying'].includes(check?.status);
            const paidSummary = [license.package_name, license.price_paid ? `Paid ${license.price_paid}` : '', license.date_paid ? formatDate(license.date_paid) : ''].filter(Boolean).join(' / ') || 'No package or payment details';
            return `
                <article class="user-license ${isEditing ? 'is-editing' : ''}" data-license-id="${escapeAttribute(license.id)}" style="--license-accent:${presentation.accent}">
                    <div class="user-license-summary">
                        <div>
                            <div class="user-license-name">${escapeHtml(license.label || 'Strong8K license')}</div>
                            <div class="user-license-meta mt-1">${escapeHtml(paidSummary)} / ${escapeHtml(String(Number(license.credits || 0)))} credits</div>
                            <span class="user-license-status mt-2 ${presentation.className}">${escapeHtml(presentation.label)}</span>
                        </div>
                        <div><div class="user-license-meta">Username</div><div class="user-license-value">${escapeHtml(license.username_8k || 'Missing')}</div></div>
                        <div><div class="user-license-meta">License password</div><div class="user-license-value">${escapeHtml(license.password_8k || 'Missing')}</div></div>
                        <div><div class="user-license-meta">Expiry</div><div class="user-license-value">${escapeHtml(formatDate(license.expiry_date))}</div></div>
                        <div class="user-license-actions">
                            <button type="button" class="user-license-check" data-license-check="${escapeAttribute(license.id)}" ${isChecking ? 'disabled' : ''}><i class="fa-solid ${isChecking ? 'fa-rotate fa-spin' : 'fa-arrows-rotate'}" aria-hidden="true"></i><span>${isChecking ? 'Checking' : 'Check Strong8K'}</span></button>
                            <button type="button" data-license-copy-all="${escapeAttribute(license.id)}" aria-label="Copy all credentials"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
                            <button type="button" data-license-edit="${escapeAttribute(license.id)}" aria-label="${isEditing ? 'Close' : 'Edit'} license"><i class="fa-solid ${isEditing ? 'fa-chevron-up' : 'fa-pen'}" aria-hidden="true"></i></button>
                            <button type="button" data-license-remove="${escapeAttribute(license.id)}" aria-label="Remove license"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
                        </div>
                    </div>
                    <div class="grid gap-2 px-3 pt-4 md:grid-cols-2">
                        ${licenseCopyRow('M3U URL', license.m3u_url_8k)}
                        ${licenseCopyRow('EPG URL', license.epg_url_8k)}
                        ${licenseCopyRow('EPGenius URL', license.epgenius_url)}
                        ${licenseCopyRow('EPGenius key', license.epgenius_key)}
                    </div>
                    ${renderProviderCheck(license, check)}
                    <div class="user-license-editor">
                        <div class="user-license-grid">
                            ${licenseInput('Label', 'label', license.label)}
                            ${licenseSelect('Status', 'status', license.status || 'Active', ['Active', 'Disabled', 'Trial', 'Expired', 'Banned'])}
                            ${licenseInput('Expiry', 'expiry_date', license.expiry_date, 'date')}
                            ${licenseInput('Username', 'username_8k', license.username_8k)}
                            ${licenseInput('License password', 'password_8k', license.password_8k)}
                            ${licenseInput('Credits', 'credits', Number(license.credits || 0), 'number')}
                            ${licenseInput('Package', 'package_name', license.package_name)}
                            ${licenseInput('Price paid', 'price_paid', license.price_paid)}
                            ${licenseInput('Date paid', 'date_paid', license.date_paid, 'date')}
                            ${licenseInput('M3U URL', 'm3u_url_8k', license.m3u_url_8k, 'url', 'is-wide')}
                            ${licenseInput('EPG URL', 'epg_url_8k', license.epg_url_8k, 'url')}
                            ${licenseInput('EPGenius key', 'epgenius_key', license.epgenius_key)}
                            ${licenseInput('EPGenius URL', 'epgenius_url', license.epgenius_url, 'url', 'is-wide')}
                        </div>
                        <p class="user-license-validation" data-license-validation="${escapeAttribute(license.id)}"></p>
                    </div>
                </article>`;
        }).join('');
    }

    function renderProviderCheck(license, check) {
        if (!check) return '';
        const checkedAt = check.checkedAt ? `<time class="user-provider-time" datetime="${escapeAttribute(check.checkedAt)}">${escapeHtml(formatDateTime(check.checkedAt))}</time>` : '';
        if (check.status === 'checking') {
            return `
                <div class="user-provider-check" aria-live="polite">
                    <div class="user-provider-head">
                        <div><div class="user-provider-title"><i class="fa-solid fa-rotate fa-spin" aria-hidden="true"></i>Checking Strong8K</div><p class="user-provider-copy">Reading the saved license securely and asking the provider for its current details.</p></div>
                    </div>
                </div>`;
        }
        if (check.status === 'applying') {
            return `
                <div class="user-provider-check" aria-live="polite">
                    <div class="user-provider-head">
                        <div><div class="user-provider-title"><i class="fa-solid fa-rotate fa-spin" aria-hidden="true"></i>Applying selected changes</div><p class="user-provider-copy">Saving the reviewed fields, then checking Strong8K a second time.</p></div>
                        ${checkedAt}
                    </div>
                </div>`;
        }
        if (check.status === 'error') {
            const credentialHelp = check.code === 'INVALID_CREDENTIALS'
                ? 'The saved username or license password was not accepted. The editor is open below so you can correct them and retry.'
                : check.message;
            return `
                <div class="user-provider-check" aria-live="polite">
                    <div class="user-provider-head">
                        <div><div class="user-provider-title is-error"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>Strong8K check failed</div><p class="user-provider-copy">${escapeHtml(credentialHelp || 'The provider could not be checked. Retry in a moment.')}</p></div>
                        ${checkedAt}
                    </div>
                    <div class="user-provider-actions">
                        <button type="button" class="user-profile-button" data-license-check="${escapeAttribute(license.id)}"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>Retry check</button>
                        <button type="button" class="user-profile-button" data-license-check-dismiss="${escapeAttribute(license.id)}">Dismiss</button>
                    </div>
                </div>`;
        }
        if (['clean', 'verified'].includes(check.status)) {
            const title = check.status === 'verified' ? 'Update verified' : 'Profile matches Strong8K';
            const copy = check.status === 'verified'
                ? 'The selected fields were saved and a second provider check found no remaining differences.'
                : 'The saved username, password, expiry, status, domain, and generated URLs are current.';
            return `
                <div class="user-provider-check" aria-live="polite">
                    <div class="user-provider-head">
                        <div><div class="user-provider-title is-positive"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>${title}</div><p class="user-provider-copy">${copy}</p></div>
                        ${checkedAt}
                    </div>
                    ${renderProviderMetadata(check.metadata)}
                    <div class="user-provider-actions"><button type="button" class="user-profile-button" data-license-check="${escapeAttribute(license.id)}">Check again</button><button type="button" class="user-profile-button" data-license-check-dismiss="${escapeAttribute(license.id)}">Dismiss</button></div>
                </div>`;
        }
        if (check.status === 'warning') {
            return `
                <div class="user-provider-check" aria-live="polite">
                    <div class="user-provider-head">
                        <div><div class="user-provider-title is-attention"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>Saved, verification pending</div><p class="user-provider-copy">${escapeHtml(check.message || 'The changes were saved, but the follow-up provider check was unavailable.')}</p></div>
                        ${checkedAt}
                    </div>
                    <div class="user-provider-actions"><button type="button" class="user-profile-button" data-license-check="${escapeAttribute(license.id)}">Retry verification</button><button type="button" class="user-profile-button" data-license-check-dismiss="${escapeAttribute(license.id)}">Dismiss</button></div>
                </div>`;
        }

        const selectedFields = new Set(check.selectedFields || []);
        const sourceSelected = ['username_8k', 'password_8k', 'domain_8k'].some(field => selectedFields.has(field));
        const selectableDifferences = check.differences.filter(difference => !difference.blocked);
        const hasSelection = selectableDifferences.some(difference => selectedFields.has(difference.key));
        return `
            <div class="user-provider-check" aria-live="polite">
                <div class="user-provider-head">
                    <div><div class="user-provider-title is-attention"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${check.differences.length} difference${check.differences.length === 1 ? '' : 's'} found</div><p class="user-provider-copy">Review the current and provider values. Checked fields are the only ones that will be applied.</p></div>
                    ${checkedAt}
                </div>
                <div class="user-provider-diffs">
                    ${check.differences.map(difference => {
                        const locked = difference.derived && sourceSelected;
                        const disabled = difference.blocked || locked;
                        const note = difference.blocked
                            ? 'Run Check all licenses before changing a shared domain.'
                            : locked
                                ? 'Included with the selected credential or domain change.'
                                : '';
                        return `
                            <label class="user-provider-diff">
                                <input type="checkbox" data-check-field="${escapeAttribute(difference.key)}" data-check-license="${escapeAttribute(license.id)}" ${selectedFields.has(difference.key) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                                <span class="user-provider-diff-label">${escapeHtml(difference.label)}${note ? `<span class="user-provider-diff-note">${escapeHtml(note)}</span>` : ''}</span>
                                <span><span class="user-provider-value-label">Saved now</span><span class="user-provider-value">${escapeHtml(displayProviderValue(difference.current))}</span></span>
                                <span><span class="user-provider-value-label">Strong8K reports</span><span class="user-provider-value">${escapeHtml(displayProviderValue(difference.provider))}</span></span>
                            </label>`;
                    }).join('')}
                </div>
                ${renderProviderMetadata(check.metadata)}
                <div class="user-provider-actions">
                    <button type="button" class="user-profile-button is-primary" data-license-check-apply="${escapeAttribute(license.id)}" ${hasSelection ? '' : 'disabled'}>Apply selected changes</button>
                    <button type="button" class="user-profile-button" data-license-check="${escapeAttribute(license.id)}">Check again</button>
                    <button type="button" class="user-profile-button" data-license-check-dismiss="${escapeAttribute(license.id)}">Cancel</button>
                </div>
            </div>`;
    }

    function renderProviderMetadata(metadata = {}) {
        const entries = [
            ['Provider user ID', metadata.provider_user_id],
            ['Country', metadata.country],
            ['Provider note', metadata.note],
            ['Raw base URL', metadata.url]
        ].filter(([, value]) => String(value || '').trim());
        if (!entries.length) return '';
        return `<div class="user-provider-metadata">${entries.map(([label, value]) => `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`).join('')}</div>`;
    }

    function displayProviderValue(value) {
        return String(value ?? '').trim() || 'Not saved';
    }

    function renderProfileCheckSummary() {
        const container = byId('strong8k-check-all-status');
        const button = byId('check-all-licenses-btn');
        if (!container || !button) return;
        button.disabled = Boolean(local.checkAll?.running);
        button.innerHTML = local.checkAll?.running
            ? '<i class="fa-solid fa-rotate fa-spin" aria-hidden="true"></i>Checking licenses'
            : '<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>Check all licenses';
        if (!local.checkAll && !local.profileDomainProposal) {
            container.hidden = true;
            container.innerHTML = '';
            return;
        }

        container.hidden = false;
        if (local.checkAll?.running) {
            const activeNumber = Math.min(local.checkAll.completed + 1, local.checkAll.total);
            container.innerHTML = `<div class="user-check-all-head"><div><div class="user-check-all-title"><i class="fa-solid fa-rotate fa-spin" aria-hidden="true"></i>Checking ${activeNumber} of ${local.checkAll.total}</div><p class="user-check-all-copy">Checks run one at a time so the provider is not flooded with requests.</p></div></div>`;
            return;
        }

        const summary = local.checkAll || { clean: 0, changed: 0, failed: 0, total: 0 };
        const proposal = local.profileDomainProposal;
        const resultCopy = `${summary.clean} current, ${summary.changed} with differences, ${summary.failed} failed.`;
        const proposalCopy = proposal?.status === 'ready'
            ? `Every license reports ${proposal.domain}. Apply it as the shared primary domain and rebuild each saved M3U and EPG URL.`
            : proposal?.reason || 'Shared domain changes stay locked unless every license completes and reports the same provider domain.';
        container.innerHTML = `
            <div class="user-check-all-head">
                <div>
                    <div class="user-check-all-title"><i class="fa-solid ${summary.failed ? 'fa-triangle-exclamation' : 'fa-circle-check'}" aria-hidden="true"></i>Profile check complete</div>
                    <p class="user-check-all-copy">${escapeHtml(resultCopy)} ${escapeHtml(proposalCopy)}</p>
                    ${proposal?.status === 'ready' ? `<div class="user-provider-value mt-2">${escapeHtml(proposal.domain)}</div>` : ''}
                </div>
                <div class="user-check-all-actions">
                    ${proposal?.status === 'ready' ? '<button type="button" class="user-profile-button is-primary" data-profile-domain-apply>Apply shared domain</button>' : ''}
                    <button type="button" class="user-profile-button" data-profile-check-dismiss>Dismiss summary</button>
                </div>
            </div>`;
    }

    function licenseCopyRow(label, value) {
        if (!String(value || '').trim()) return '';
        return `
            <button type="button" class="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left" data-license-copy-value="${escapeAttribute(value)}">
                <span class="min-w-0"><span class="block text-[11px] font-bold text-slate-500">${escapeHtml(label)}</span><span class="block break-all font-mono text-xs text-slate-800">${escapeHtml(value)}</span></span>
                <i class="fa-regular fa-copy shrink-0 text-xs text-slate-400" aria-hidden="true"></i>
            </button>`;
    }

    function licenseInput(label, field, value, type = 'text', extraClass = '') {
        return `<label class="${extraClass}"><span class="user-profile-field-label">${escapeHtml(label)}</span><input type="${escapeAttribute(type)}" class="user-profile-field" value="${escapeAttribute(value ?? '')}" data-license-field="${escapeAttribute(field)}"></label>`;
    }

    function licenseSelect(label, field, value, options) {
        return `<label><span class="user-profile-field-label">${escapeHtml(label)}</span><select class="user-profile-field" data-license-field="${escapeAttribute(field)}">${options.map(option => `<option value="${escapeAttribute(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
    }

    function licensePresentation(license = {}) {
        if (!hasCompleteLicense(license)) {
            return { label: 'Setup incomplete', className: 'bg-rose-100 text-rose-800', accent: '#e11d48' };
        }
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

    async function handleLicenseClick(event) {
        const selection = event.target.closest('[data-check-field]');
        if (selection) {
            updateProviderSelection(selection.dataset.checkLicense, selection.dataset.checkField, selection.checked);
            return;
        }

        const checkButton = event.target.closest('[data-license-check]');
        if (checkButton) {
            await checkLicense(checkButton.dataset.licenseCheck);
            return;
        }

        const applyButton = event.target.closest('[data-license-check-apply]');
        if (applyButton) {
            await applyProviderChanges(applyButton.dataset.licenseCheckApply);
            return;
        }

        const dismissButton = event.target.closest('[data-license-check-dismiss]');
        if (dismissButton) {
            delete local.providerChecks[dismissButton.dataset.licenseCheckDismiss];
            renderLicenses();
            return;
        }

        const copyButton = event.target.closest('[data-license-copy-value]');
        if (copyButton) {
            await copyValue(copyButton.dataset.licenseCopyValue);
            return;
        }

        const copyAllButton = event.target.closest('[data-license-copy-all]');
        if (copyAllButton) {
            const license = state.currentLicenses.find(item => item.id === copyAllButton.dataset.licenseCopyAll);
            if (!license) return;
            const lines = [
                license.label ? `Label: ${license.label}` : '',
                license.username_8k ? `Username: ${license.username_8k}` : '',
                license.password_8k ? `Password: ${license.password_8k}` : '',
                license.m3u_url_8k ? `M3U: ${license.m3u_url_8k}` : '',
                license.epg_url_8k ? `EPG: ${license.epg_url_8k}` : '',
                license.epgenius_url ? `EPGenius: ${license.epgenius_url}` : '',
                license.expiry_date ? `Expiry: ${license.expiry_date}` : ''
            ].filter(Boolean);
            await copyValue(lines.join('\n'));
            return;
        }

        const editButton = event.target.closest('[data-license-edit]');
        if (editButton) {
            local.expandedLicenseId = local.expandedLicenseId === editButton.dataset.licenseEdit ? '' : editButton.dataset.licenseEdit;
            renderLicenses();
            return;
        }

        const removeButton = event.target.closest('[data-license-remove]');
        if (removeButton) await removeLicense(removeButton.dataset.licenseRemove);
    }

    function resetReconciliationState() {
        local.providerChecks = {};
        local.profileDomainProposal = null;
        local.checkAll = null;
        const summary = byId('strong8k-check-all-status');
        if (summary) {
            summary.hidden = true;
            summary.innerHTML = '';
        }
    }

    async function checkLicense(licenseId, options = {}) {
        const license = state.currentLicenses.find(item => item.id === licenseId);
        if (!license) return null;
        if (!deviceInfoWebhookUrl) {
            local.providerChecks[licenseId] = {
                status: 'error',
                code: 'SERVICE_NOT_CONFIGURED',
                message: 'The Strong8K verification service is not configured yet.'
            };
            renderLicenses();
            return local.providerChecks[licenseId];
        }

        if (!options.skipFlush) await flushAutosaves();
        if (!options.batch) {
            local.reconciliationController?.abort();
            local.reconciliationController = new AbortController();
            local.profileDomainProposal = null;
            local.checkAll = null;
        }
        const signal = options.signal || local.reconciliationController?.signal;
        local.providerChecks[licenseId] = { status: 'checking' };
        renderLicenses();

        try {
            const payload = await requestDeviceInfo(licenseId, signal);
            const baseline = {
                id: licenseId,
                ...canonicalizeReconciliationSnapshot(payload.baseline || {})
            };
            const provider = buildProviderReconciliationSnapshot(baseline, payload.provider || {});
            if (!provider.username_8k || !provider.password_8k || !provider.expiry_date || !provider.status) {
                throw providerError('INVALID_PROVIDER_RESPONSE', 'Strong8K returned an incomplete license response.');
            }

            const differences = buildReconciliationDifferences(baseline, provider).map(difference => ({
                ...difference,
                blocked: difference.key === 'domain_8k' && state.currentLicenses.length > 1
            }));
            const selected = differences.filter(difference => !difference.blocked).map(difference => difference.key);
            const selectedFields = selectedFieldsWithDependencies(selected, differences)
                .filter(field => !differences.find(difference => difference.key === field)?.blocked);
            const check = {
                status: differences.length ? 'differences' : (options.postApply ? 'verified' : 'clean'),
                checkedAt: payload.checkedAt || new Date().toISOString(),
                baseline,
                provider,
                metadata: payload.metadata || {},
                differences,
                selectedFields
            };
            local.providerChecks[licenseId] = check;
            renderLicenses();
            return check;
        } catch (error) {
            if (error.name === 'AbortError') return null;
            const check = {
                status: options.postApply ? 'warning' : 'error',
                code: error.code || 'PROVIDER_UNAVAILABLE',
                message: options.postApply
                    ? 'The changes were saved, but the final Strong8K verification was unavailable. Retry the check when the provider is reachable.'
                    : error.message || 'The provider could not be checked. Retry in a moment.',
                checkedAt: new Date().toISOString()
            };
            local.providerChecks[licenseId] = check;
            if (check.code === 'INVALID_CREDENTIALS' && !options.postApply) {
                local.expandedLicenseId = licenseId;
            }
            renderLicenses();
            if (check.code === 'INVALID_CREDENTIALS' && !options.postApply) focusCredentialCorrection(licenseId);
            return check;
        }
    }

    async function requestDeviceInfo(licenseId, signal, forceRefresh = false) {
        const currentUser = auth.currentUser;
        if (!currentUser) throw providerError('UNAUTHORIZED', 'Sign in again before checking Strong8K.');
        let response;
        try {
            response = await fetch(deviceInfoWebhookUrl, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'text/plain;charset=UTF-8'
                },
                body: JSON.stringify({
                    idToken: await currentUser.getIdToken(forceRefresh),
                    profileId: local.activeUserId,
                    licenseId
                }),
                cache: 'no-store',
                credentials: 'omit',
                signal
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw providerError('PROVIDER_UNAVAILABLE', 'The Strong8K verification service could not be reached.');
        }

        let payload = {};
        try {
            payload = await response.json();
        } catch {
            throw providerError('INVALID_PROVIDER_RESPONSE', 'The verification service returned an unreadable response.');
        }
        if (response.status === 401 && !forceRefresh) {
            return requestDeviceInfo(licenseId, signal, true);
        }
        if (!response.ok || payload.ok === false) {
            throw providerError(payload.code || 'PROVIDER_UNAVAILABLE', payload.message || 'Strong8K could not be checked.');
        }
        if (payload.ok !== true || !payload.baseline || !payload.provider) {
            throw providerError('INVALID_PROVIDER_RESPONSE', 'The verification service returned an incomplete response.');
        }
        return payload;
    }

    function providerError(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function focusCredentialCorrection(licenseId) {
        window.requestAnimationFrame(() => {
            const card = document.querySelector(`[data-license-id="${CSS.escape(licenseId)}"]`);
            const username = card?.querySelector('[data-license-field="username_8k"]');
            username?.focus({ preventScroll: true });
            card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    function updateProviderSelection(licenseId, field, checked) {
        const check = local.providerChecks[licenseId];
        if (!check || check.status !== 'differences') return;
        const selected = new Set(check.selectedFields || []);
        if (checked) selected.add(field);
        else selected.delete(field);
        check.selectedFields = selectedFieldsWithDependencies([...selected], check.differences)
            .filter(key => !check.differences.find(difference => difference.key === key)?.blocked);
        renderLicenses();
    }

    async function checkAllLicenses({ skipFlush = false } = {}) {
        const licenses = state.currentLicenses || [];
        if (!licenses.length) {
            showToast('Add a Strong8K license before running a provider check.', 'error');
            return;
        }
        if (!skipFlush) await flushAutosaves();
        local.reconciliationController?.abort();
        const controller = new AbortController();
        local.reconciliationController = controller;
        local.profileDomainProposal = null;
        local.checkAll = { running: true, total: licenses.length, completed: 0, clean: 0, changed: 0, failed: 0 };
        renderLicenses();

        const completedChecks = [];
        for (const license of licenses) {
            const check = await checkLicense(license.id, {
                skipFlush: true,
                batch: true,
                signal: controller.signal
            });
            if (controller.signal.aborted) return;
            local.checkAll.completed += 1;
            if (!check || ['error', 'warning'].includes(check.status)) local.checkAll.failed += 1;
            else if (check.status === 'differences') local.checkAll.changed += 1;
            else local.checkAll.clean += 1;
            if (check && !['error', 'warning'].includes(check.status)) completedChecks.push(check);
            renderProfileCheckSummary();
        }

        local.checkAll.running = false;
        buildProfileDomainProposal(completedChecks);
        renderLicenses();
    }

    function buildProfileDomainProposal(completedChecks) {
        if (state.currentLicenses.length < 2) {
            local.profileDomainProposal = {
                status: 'none',
                reason: 'This profile has one license, so any domain difference can be reviewed on that license.'
            };
            return;
        }
        if (completedChecks.length !== state.currentLicenses.length) {
            local.profileDomainProposal = {
                status: 'blocked',
                reason: 'The shared domain was not offered because every license must complete successfully first.'
            };
            return;
        }
        const domains = [...new Set(completedChecks.map(check => normalizeProviderBaseUrl(check.provider.domain_8k)).filter(Boolean))];
        if (domains.length !== 1) {
            local.profileDomainProposal = {
                status: 'blocked',
                reason: 'The shared domain was not offered because the licenses report different provider domains.'
            };
            return;
        }
        const profile = state.strong8kProfiles[local.activeUserId] || {};
        const currentDomain = normalizeProviderBaseUrl(profile.domain_8k);
        if (currentDomain === domains[0]) {
            local.profileDomainProposal = {
                status: 'none',
                reason: 'Every license agrees with the saved primary domain.'
            };
            return;
        }
        local.profileDomainProposal = {
            status: 'ready',
            domain: domains[0],
            currentDomain,
            checkedAt: new Date().toISOString(),
            baselines: completedChecks.map(check => check.baseline)
        };
    }

    async function handleProfileCheckClick(event) {
        if (event.target.closest('[data-profile-check-dismiss]')) {
            local.checkAll = null;
            local.profileDomainProposal = null;
            renderLicenses();
            return;
        }
        if (event.target.closest('[data-profile-domain-apply]')) await applySharedProviderDomain();
    }

    async function applyProviderChanges(licenseId) {
        const check = local.providerChecks[licenseId];
        if (!check || check.status !== 'differences') return;
        await flushAutosaves();
        const selected = new Set(selectedFieldsWithDependencies(check.selectedFields || [], check.differences));
        check.differences.filter(difference => difference.blocked).forEach(difference => selected.delete(difference.key));
        if (!selected.size) return;
        check.status = 'applying';
        renderLicenses();

        try {
            const result = await runLicenseTransaction(local.activeUserId, async (transaction, saveHistory) => {
                const profileRef = doc(db, 'strong8k_profiles', local.activeUserId);
                const snapshot = await transaction.get(profileRef);
                if (!snapshot.exists()) throw new Error('The Strong8K profile no longer exists.');
                const profile = snapshot.data();
                const licenses = Array.isArray(profile.licenses) ? [...profile.licenses] : [];
                const index = licenses.findIndex(item => item.id === licenseId);
                if (index < 0) throw new Error('The license no longer exists. Reload the profile and try again.');
                const current = { ...licenses[index], domain_8k: profile.domain_8k };
                if (!reconciliationBaselineMatches(check.baseline, current)) {
                    throw providerError('STALE_DATA', 'This profile changed after the provider check. Run Check Strong8K again before applying.');
                }

                const nextLicense = { ...licenses[index] };
                ['username_8k', 'password_8k', 'expiry_date', 'status'].forEach(field => {
                    if (selected.has(field)) nextLicense[field] = check.provider[field];
                });
                const nextDomain = selected.has('domain_8k') ? check.provider.domain_8k : profile.domain_8k;
                const sourceChanged = ['username_8k', 'password_8k', 'domain_8k'].some(field => selected.has(field));
                const generated = buildStrong8kUrls(nextDomain, nextLicense.username_8k, nextLicense.password_8k);
                if (selected.has('m3u_url_8k') || sourceChanged) {
                    nextLicense.m3u_url_8k = sourceChanged ? generated.m3u_url_8k : check.provider.m3u_url_8k;
                }
                if (selected.has('epg_url_8k') || sourceChanged) {
                    nextLicense.epg_url_8k = sourceChanged ? generated.epg_url_8k : check.provider.epg_url_8k;
                }
                licenses[index] = nextLicense;
                const update = { licenses, updated_at: new Date().toISOString() };
                if (selected.has('domain_8k')) update.domain_8k = check.provider.domain_8k;
                saveHistory(snapshot, licenses);
                transaction.set(profileRef, update, { merge: true });
                return { licenses, nextLicense, domain: update.domain_8k || profile.domain_8k };
            });

            state.currentLicenses = result.licenses.map(item => ({ ...item }));
            state.strong8kProfiles[local.activeUserId] = {
                ...(state.strong8kProfiles[local.activeUserId] || {}),
                licenses: state.currentLicenses,
                domain_8k: result.domain
            };
            byId('strong8k-domain').value = result.domain || '';
            const changedLabels = check.differences
                .filter(difference => selected.has(difference.key))
                .map(difference => difference.label);
            if (['username_8k', 'password_8k', 'domain_8k'].some(field => selected.has(field))) {
                changedLabels.push('M3U URL', 'EPG URL');
            }
            await createReconciliationAudit(changedLabels, check.checkedAt, licenseId);
            showToast('Selected Strong8K fields updated');
            await checkLicense(licenseId, { skipFlush: true, postApply: true });
        } catch (error) {
            console.error('Unable to apply Strong8K reconciliation', error);
            local.providerChecks[licenseId] = {
                status: 'error',
                code: error.code || 'SAVE_FAILED',
                message: error.message || 'The selected changes could not be saved.',
                checkedAt: check.checkedAt
            };
            renderLicenses();
        }
    }

    async function applySharedProviderDomain() {
        const proposal = local.profileDomainProposal;
        if (!proposal || proposal.status !== 'ready') return;
        if (!window.confirm(`Use ${proposal.domain} as the shared domain and rebuild URLs for every license on this profile?`)) return;
        await flushAutosaves();
        try {
            const result = await runLicenseTransaction(local.activeUserId, async (transaction, saveHistory) => {
                const profileRef = doc(db, 'strong8k_profiles', local.activeUserId);
                const snapshot = await transaction.get(profileRef);
                if (!snapshot.exists()) throw new Error('The Strong8K profile no longer exists.');
                const profile = snapshot.data();
                if (normalizeProviderBaseUrl(profile.domain_8k) !== proposal.currentDomain) {
                    throw providerError('STALE_DATA', 'The primary domain changed after the profile check. Run Check all licenses again.');
                }
                const licenses = Array.isArray(profile.licenses) ? profile.licenses.map(item => ({ ...item })) : [];
                if (licenses.length !== proposal.baselines.length) {
                    throw providerError('STALE_DATA', 'The license list changed after the profile check. Run Check all licenses again.');
                }
                proposal.baselines.forEach(baseline => {
                    const current = licenses.find(item => item.id === baseline.id || item.username_8k === baseline.username_8k);
                    if (!current || !reconciliationBaselineMatches(baseline, { ...current, domain_8k: profile.domain_8k })) {
                        throw providerError('STALE_DATA', 'A license changed after the profile check. Run Check all licenses again.');
                    }
                });
                licenses.forEach(license => Object.assign(license, buildStrong8kUrls(proposal.domain, license.username_8k, license.password_8k)));
                saveHistory(snapshot, licenses);
                transaction.set(profileRef, {
                    domain_8k: proposal.domain,
                    licenses,
                    updated_at: new Date().toISOString()
                }, { merge: true });
                return licenses;
            });
            state.currentLicenses = result.map(item => ({ ...item }));
            state.strong8kProfiles[local.activeUserId] = {
                ...(state.strong8kProfiles[local.activeUserId] || {}),
                domain_8k: proposal.domain,
                licenses: state.currentLicenses
            };
            byId('strong8k-domain').value = proposal.domain;
            await createReconciliationAudit(['Primary domain', 'M3U URL', 'EPG URL'], proposal.checkedAt);
            showToast('Shared Strong8K domain updated');
            await checkAllLicenses({ skipFlush: true });
        } catch (error) {
            console.error('Unable to apply shared Strong8K domain', error);
            showToast(error.message || 'The shared domain could not be applied.', 'error');
            local.profileDomainProposal = {
                status: 'blocked',
                reason: error.message || 'The shared domain could not be applied.'
            };
            renderLicenses();
        }
    }

    async function createReconciliationAudit(changedLabels, providerCheckedAt, licenseId = '') {
        const uniqueLabels = [...new Set(changedLabels)];
        if (!uniqueLabels.length) return;
        const license = state.currentLicenses.find(item => item.id === licenseId);
        const occurredAt = new Date().toISOString();
        const record = {
            occurred_at: occurredAt,
            created_at: occurredAt,
            created_by: auth.currentUser?.uid || '',
            kind: 'other',
            visibility: 'internal',
            summary: license
                ? `Strong8K profile reconciled for ${license.label || license.username_8k || 'license'}`
                : 'Strong8K shared domain reconciled',
            details: `Updated fields: ${uniqueLabels.join(', ')}. Provider checked: ${providerCheckedAt || occurredAt}.`,
            source_text: ''
        };
        try {
            const reference = await addDoc(collection(db, 'strong8k_profiles', local.activeUserId, 'support_events'), record);
            local.supportEvents.unshift({ id: reference.id, profile_id: local.activeUserId, ...record });
            renderSupportTimeline();
        } catch (error) {
            console.error('Unable to save Strong8K reconciliation audit event', error);
            showToast('Profile updated, but its audit note could not be saved.', 'error');
        }
    }

    async function copyValue(value) {
        try {
            await copyTextToClipboard(value || '');
            showToast('Copied to clipboard');
        } catch (error) {
            console.error('Unable to copy license value', error);
            showToast('Copy failed. Select the value and copy it manually.', 'error');
        }
    }

    function handleLicenseInput(event) {
        const input = event.target.closest('[data-license-field]');
        if (!input) return;
        const card = input.closest('[data-license-id]');
        const licenseId = card?.dataset.licenseId;
        const license = state.currentLicenses.find(item => item.id === licenseId);
        if (!license) return;
        const field = input.dataset.licenseField;
        const value = field === 'credits' ? Number(input.value || 0) : input.value;
        license[field] = value;
        local.pendingLicensePatches[licenseId] = {
            ...(local.pendingLicensePatches[licenseId] || {}),
            [field]: value
        };

        const validation = validateLicense(license);
        const validationNode = card.querySelector('[data-license-validation]');
        if (validationNode) validationNode.textContent = validation;
        if (validation) {
            setAutosaveStatus('error', 'Fix license fields', false);
            return;
        }

        let retryPatch = null;
        scheduleAutosave(`license:${licenseId}`, async () => {
            if (!retryPatch) {
                retryPatch = { ...(local.pendingLicensePatches[licenseId] || {}) };
                delete local.pendingLicensePatches[licenseId];
            }
            await patchLicense(local.activeUserId, licenseId, retryPatch);
            retryPatch = null;
        });
    }

    function validateLicense(license) {
        const missing = [
            !String(license.username_8k || '').trim() ? 'username' : '',
            !String(license.password_8k || '').trim() ? 'license password' : '',
            !String(license.expiry_date || '').trim() ? 'expiry' : ''
        ].filter(Boolean);
        return missing.length ? `Required: ${missing.join(', ')}.`
            : hasCompleteLicense(license) ? '' : 'Use a valid expiry date.';
    }

    async function patchLicense(userId, licenseId, patch) {
        if (!Object.keys(patch).length) return;
        await runLicenseTransaction(userId, async (transaction, saveHistory) => {
            const profileRef = doc(db, 'strong8k_profiles', userId);
            const snapshot = await transaction.get(profileRef);
            const licenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                ? snapshot.data().licenses.map(license => ({ ...license }))
                : [];
            const index = licenses.findIndex(license => license.id === licenseId);
            if (index < 0) throw new Error('The license no longer exists. Reload the profile and try again.');
            licenses[index] = { ...licenses[index], ...patch };
            saveHistory(snapshot, licenses);
            transaction.set(profileRef, { licenses, updated_at: new Date().toISOString() }, { merge: true });
        });
    }

    function openNewLicenseForm() {
        const form = byId('new-license-form');
        form.hidden = false;
        form.reset();
        byId('new-license-status').value = 'Active';
        byId('new-license-credits').value = '0';
        byId('new-license-error').textContent = '';
        byId('new-license-label').focus({ preventScroll: true });
        window.requestAnimationFrame(() => scrollEditorFormIntoView(form));
    }

    function closeNewLicenseForm() {
        const form = byId('new-license-form');
        if (!form) return;
        form.hidden = true;
        form.reset();
        byId('new-license-error').textContent = '';
    }

    async function createLicense(event) {
        event.preventDefault();
        const license = {
            id: crypto.randomUUID(),
            label: byId('new-license-label').value.trim(),
            status: byId('new-license-status').value,
            expiry_date: byId('new-license-expiry').value,
            username_8k: byId('new-license-username').value.trim(),
            password_8k: byId('new-license-password').value,
            credits: Number(byId('new-license-credits').value || 0),
            package_name: byId('new-license-package').value.trim(),
            price_paid: byId('new-license-price').value.trim(),
            date_paid: byId('new-license-date-paid').value,
            m3u_url_8k: byId('new-license-m3u').value.trim(),
            epg_url_8k: byId('new-license-epg').value.trim(),
            epgenius_key: byId('new-license-epgenius-key').value.trim(),
            epgenius_url: byId('new-license-epgenius-url').value.trim(),
            history: [],
            created_at: new Date().toISOString()
        };
        const validation = validateLicense(license);
        if (validation) {
            byId('new-license-error').textContent = validation;
            return;
        }
        if (!window.confirm(`Create ${license.label || license.username_8k} as a new Strong8K license?`)) return;

        const userId = local.activeUserId;
        try {
            await runLicenseTransaction(userId, async (transaction, saveHistory) => {
                const profileRef = doc(db, 'strong8k_profiles', userId);
                const snapshot = await transaction.get(profileRef);
                const licenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                    ? [...snapshot.data().licenses]
                    : [];
                licenses.push(license);
                saveHistory(snapshot, licenses);
                transaction.set(profileRef, { licenses, updated_at: new Date().toISOString() }, { merge: true });
            });
            state.currentLicenses.push(license);
            state.strong8kProfiles[userId] = {
                ...(state.strong8kProfiles[userId] || normalizeStrong8kProfile({}, {})),
                licenses: state.currentLicenses
            };
            closeNewLicenseForm();
            renderLicenses();
            showToast('License created');
        } catch (error) {
            console.error('Unable to create license', error);
            byId('new-license-error').textContent = error.message || 'The license could not be created.';
        }
    }

    async function removeLicense(licenseId) {
        const license = state.currentLicenses.find(item => item.id === licenseId);
        if (!license) return;
        if (!window.confirm(`Remove ${license.label || license.username_8k || 'this license'} from the customer profile? This does not cancel it with Strong8K.`)) return;
        const userId = local.activeUserId;
        try {
            await runLicenseTransaction(userId, async (transaction, saveHistory) => {
                const profileRef = doc(db, 'strong8k_profiles', userId);
                const snapshot = await transaction.get(profileRef);
                const licenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                    ? snapshot.data().licenses.filter(item => item.id !== licenseId)
                    : [];
                saveHistory(snapshot, licenses);
                transaction.set(profileRef, { licenses, updated_at: new Date().toISOString() }, { merge: true });
            });
            state.currentLicenses = state.currentLicenses.filter(item => item.id !== licenseId);
            state.strong8kProfiles[userId].licenses = state.currentLicenses;
            renderLicenses();
            showToast('License removed');
        } catch (error) {
            console.error('Unable to remove license', error);
            showToast(error.message || 'The license could not be removed.', 'error');
        }
    }

    function openSupportEventForm() {
        const form = byId('support-event-form');
        form.hidden = false;
        form.reset();
        byId('support-event-occurred').value = toLocalDateTimeValue(new Date());
        byId('support-event-kind').value = 'setup';
        byId('support-event-visibility').value = 'internal';
        byId('support-event-error').textContent = '';
        byId('support-event-summary').focus({ preventScroll: true });
        window.requestAnimationFrame(() => scrollEditorFormIntoView(form));
    }

    function closeSupportEventForm() {
        const form = byId('support-event-form');
        if (!form) return;
        form.hidden = true;
        form.reset();
        byId('support-event-error').textContent = '';
    }

    function scrollEditorFormIntoView(form) {
        const stickyOffset = window.matchMedia('(max-width: 720px)').matches ? 220 : 112;
        const top = form.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
    }

    async function createSupportEvent(event) {
        event.preventDefault();
        const occurredValue = byId('support-event-occurred').value;
        const summary = byId('support-event-summary').value.trim();
        if (!occurredValue || !summary) {
            byId('support-event-error').textContent = 'Date and summary are required.';
            return;
        }
        const record = {
            occurred_at: new Date(occurredValue).toISOString(),
            created_at: new Date().toISOString(),
            created_by: auth.currentUser?.uid || '',
            kind: byId('support-event-kind').value,
            visibility: byId('support-event-visibility').value,
            summary,
            details: byId('support-event-details').value.trim(),
            source_text: byId('support-event-source').value.trim()
        };
        try {
            const reference = await addDoc(collection(db, 'strong8k_profiles', local.activeUserId, 'support_events'), record);
            local.supportEvents.unshift({ id: reference.id, profile_id: local.activeUserId, ...record });
            local.supportEvents.sort((left, right) => String(right.occurred_at || '').localeCompare(String(left.occurred_at || '')));
            closeSupportEventForm();
            renderSupportTimeline();
            showToast('Support interaction added');
        } catch (error) {
            console.error('Unable to add support event', error);
            byId('support-event-error').textContent = error.message || 'The interaction could not be saved.';
        }
    }

    function renderSupportTimeline() {
        const container = byId('user-support-timeline');
        if (!local.supportEvents.length) {
            container.innerHTML = '<div class="user-timeline-empty">No dated interactions yet. Add the first setup, troubleshooting, renewal, or communication note above.</div>';
            return;
        }
        container.innerHTML = local.supportEvents.map(event => {
            const source = String(event.source_text || '').trim();
            return `
                <article class="user-timeline-item">
                    <time class="user-timeline-date" datetime="${escapeAttribute(event.occurred_at || '')}">${escapeHtml(formatDateTime(event.occurred_at))}</time>
                    <div>
                        <div class="user-timeline-title">${escapeHtml(event.summary || 'Support interaction')}</div>
                        ${event.details ? `<div class="user-timeline-copy">${escapeHtml(event.details)}</div>` : ''}
                        <div class="user-timeline-tags">
                            <span class="user-timeline-tag">${escapeHtml(SUPPORT_KINDS[event.kind] || 'Other')}</span>
                            <span class="user-timeline-tag ${event.visibility === 'shared' ? 'is-shared' : ''}">${event.visibility === 'shared' ? 'Shared with customer' : 'Internal'}</span>
                        </div>
                        ${source ? `<details class="mt-3"><summary class="cursor-pointer text-xs font-bold text-slate-600">View source text</summary><pre class="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">${escapeHtml(source)}</pre></details>` : ''}
                    </div>
                </article>`;
        }).join('');
    }

    function renderAccessEditor(user) {
        const memberships = state.membershipsByUser[user.id] || {};
        const strong = memberships[appIds.STRONG8K];
        byId('member-strong8k-enabled').checked = Boolean(strong);
        byId('member-strong8k-role').value = strong?.role || 'member';
        byId('member-strong8k-status').value = strong?.status || 'active';
        toggleAccessPanels();
        local.accessBaseline = JSON.stringify(collectAccessDraft());
        updateAccessDraft();
    }

    function collectAccessDraft() {
        return {
            strong8k: {
                enabled: byId('member-strong8k-enabled').checked,
                role: byId('member-strong8k-role').value,
                status: byId('member-strong8k-status').value
            }
        };
    }

    function toggleAccessPanels() {
        byId('strong8k-membership-panel').classList.toggle('hidden', !byId('member-strong8k-enabled').checked);
    }

    function updateAccessDraft() {
        toggleAccessPanels();
        const draft = JSON.stringify(collectAccessDraft());
        const changed = Boolean(local.accessBaseline && draft !== local.accessBaseline);
        byId('user-access-apply').disabled = !changed;
        byId('user-access-summary').textContent = changed
            ? 'Access changes are waiting for review. Nothing has been applied yet.'
            : 'No access changes waiting.';
    }

    async function applyAccessChanges() {
        const user = state.users.find(item => item.id === local.activeUserId);
        if (!user) return;
        const draft = collectAccessDraft();
        const previousMemberships = state.membershipsByUser[user.id] || {};
        const summary = [
            `Strong8K: ${draft.strong8k.enabled ? `${draft.strong8k.status}, ${draft.strong8k.role}` : 'disabled'}`
        ].join('\n');
        if (!window.confirm(`Apply these access changes for ${user.full_name || user.email}?\n\n${summary}`)) return;

        const button = byId('user-access-apply');
        button.disabled = true;
        button.textContent = 'Applying...';
        try {
            await flushAutosaves();
            await syncMembership(user.id, appIds.STRONG8K, draft.strong8k.enabled, {
                app_id: appIds.STRONG8K,
                role: draft.strong8k.role,
                status: draft.strong8k.status,
                pool_ids: [],
                invite_code_used: previousMemberships[appIds.STRONG8K]?.invite_code_used || '',
                created_at: previousMemberships[appIds.STRONG8K]?.created_at || new Date().toISOString()
            });

            if (draft.strong8k.enabled) {
                await setDoc(doc(db, 'strong8k_profiles', user.id), {
                    status: draft.strong8k.status,
                    updated_at: new Date().toISOString()
                }, { merge: true });
            }
            showToast('Access changes applied');
            await reloadAdminData();
        } catch (error) {
            console.error('Unable to apply access changes', error);
            showToast(error.message || 'Access changes could not be applied.', 'error');
            button.disabled = false;
        } finally {
            button.textContent = 'Review and apply';
        }
    }

    async function migrateLegacyPrivateNote(profileId, legacyValue) {
        const legacyNotes = String(legacyValue || '').trim();
        if (!legacyNotes) return false;
        const privateRef = doc(db, 'strong8k_private', profileId);
        const privateSnapshot = await getDoc(privateRef);
        const existingNotes = privateSnapshot.exists() ? String(privateSnapshot.data().internal_notes || '').trim() : '';
        const nextNotes = existingNotes.includes(legacyNotes)
            ? existingNotes
            : [existingNotes, existingNotes ? `Legacy profile note:\n${legacyNotes}` : legacyNotes].filter(Boolean).join('\n\n');

        await setDoc(privateRef, {
            internal_notes: nextNotes,
            migrated_at: new Date().toISOString(),
            updated_by: auth.currentUser?.uid || ''
        }, { merge: true });
        const verification = await getDoc(privateRef);
        if (!verification.exists() || !String(verification.data().internal_notes || '').includes(legacyNotes)) {
            throw new Error(`Private note verification failed for ${profileId}.`);
        }
        await updateDoc(doc(db, 'strong8k_profiles', profileId), { internal_notes: deleteField() });
        if (state.strong8kProfiles[profileId]) delete state.strong8kProfiles[profileId].internal_notes;
        return true;
    }

    async function migrateAllPrivateNotes() {
        const button = byId('private-notes-migration-btn');
        const result = byId('private-notes-migration-result');
        const candidates = Object.entries(state.strong8kProfiles)
            .filter(([, profile]) => String(profile.internal_notes || '').trim());
        if (!candidates.length) {
            result.textContent = 'No legacy private notes need migration.';
            return;
        }
        if (!window.confirm(`Move ${candidates.length} legacy private note${candidates.length === 1 ? '' : 's'} into admin-only storage?`)) return;
        button.disabled = true;
        result.textContent = 'Migration in progress...';
        let migrated = 0;
        const failures = [];
        for (const [profileId, profile] of candidates) {
            try {
                if (await migrateLegacyPrivateNote(profileId, profile.internal_notes)) migrated += 1;
            } catch (error) {
                console.error(`Private note migration failed for ${profileId}`, error);
                failures.push(profileId);
            }
        }
        result.textContent = failures.length
            ? `${migrated} migrated. ${failures.length} failed and were left in place for retry.`
            : `${migrated} private note${migrated === 1 ? '' : 's'} migrated and verified.`;
        button.disabled = false;
    }

    function openNewUserModal() {
        const modal = byId('new-user-modal');
        modal.hidden = false;
        byId('new-user-form').reset();
        byId('new-user-error').textContent = '';
        document.body.classList.add('overflow-hidden');
        window.setTimeout(() => byId('new-user-name').focus(), 0);
    }

    function closeNewUserModal() {
        byId('new-user-modal').hidden = true;
        document.body.classList.remove('overflow-hidden');
    }

    async function createUserShell(event) {
        event.preventDefault();
        const name = byId('new-user-name').value.trim();
        const email = byId('new-user-email').value.trim().toLowerCase();
        const errorNode = byId('new-user-error');
        const submit = byId('new-user-submit');
        if (!name || !email || !byId('new-user-email').checkValidity()) {
            errorNode.textContent = 'A name and valid email address are required.';
            return;
        }

        submit.disabled = true;
        submit.textContent = 'Creating...';
        try {
            let existing = state.users.find(user => String(user.email || '').trim().toLowerCase() === email) || null;
            if (!existing) {
                const snapshot = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
                const existingDoc = snapshot.docs[0];
                if (existingDoc) existing = { id: existingDoc.id, ...existingDoc.data() };
            }
            if (existing) {
                if (existing.deleted) {
                    if (!window.confirm('A profile with this email is archived. Restore and open it?')) return;
                    await updateDoc(doc(db, 'users', existing.id), {
                        deleted: false,
                        full_name: name || existing.full_name || '',
                        email,
                        restored_at: new Date().toISOString()
                    });
                    await reloadAdminData();
                }
                closeNewUserModal();
                showToast('Existing profile opened');
                open(existing.id);
                return;
            }

            const reference = await addDoc(collection(db, 'users'), {
                ...defaultSharedUser(email),
                full_name: name,
                email,
                created_by_admin: true
            });
            closeNewUserModal();
            await reloadAdminData();
            open(reference.id);
            showToast('Customer profile created');
        } catch (error) {
            console.error('Unable to create user profile', error);
            errorNode.textContent = error.message || 'The profile could not be created.';
        } finally {
            submit.disabled = false;
            submit.textContent = 'Create profile';
        }
    }

    async function archiveActiveUser() {
        const user = state.users.find(item => item.id === local.activeUserId);
        if (!user) return;
        if (!window.confirm(`Archive ${user.full_name || user.email}? This hides the profile but does not delete their Firebase Auth account or cancel any Strong8K license.`)) return;
        try {
            await flushAutosaves();
            await updateDoc(doc(db, 'users', user.id), {
                deleted: true,
                archived_at: new Date().toISOString()
            });
            window.location.hash = '#people';
            await reloadAdminData();
            showToast('Customer profile archived');
        } catch (error) {
            console.error('Unable to archive user', error);
            showToast(error.message || 'The profile could not be archived.', 'error');
        }
    }

    async function navigateToPeople() {
        await flushAutosaves();
        if (local.autosave.failed && !window.confirm('A profile change could not be saved. Leave the profile anyway?')) return;
        window.location.hash = '#people';
    }

    function trapModalFocus(event) {
        if (event.key !== 'Tab') return;
        const modal = byId('new-user-modal');
        const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function toLocalDateTimeValue(date) {
        const offset = date.getTimezoneOffset();
        return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
    }

    function formatDateTime(value) {
        if (!value) return 'Date not recorded';
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return value;
        return new Intl.DateTimeFormat('en-CA', {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(parsed);
    }

    function escapeAttribute(value) {
        return escapeHtml(String(value ?? '')).replace(/`/g, '&#96;');
    }

    return {
        bind,
        handleDataLoaded,
        open,
        classifyProspect,
        startProspectConversation: startConversation
    };
}
