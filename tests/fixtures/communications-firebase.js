const threadId = 'comm_fixture_thread_0001';
const user = { uid: 'fixture-admin', email: 'e.chinerman@gmail.com', getIdToken: async () => 'synthetic-test-token' };
const data = new Map(Object.entries({
    'roles/fixture-admin': { platform_admin: true },
    'users/fixture-admin': { full_name: 'Demo operator', email: 'e.chinerman@gmail.com', default_app_id: 'strong8k' },
    'users/fixture-admin/memberships/strong8k': { app_id: 'strong8k', role: 'member', status: 'active' },
    'strong8k_profiles/fixture-admin': { domain_8k: 'https://example.com', setup_notes: 'Synthetic setup notes. Google TV, TiviMate Premium.', licenses: [{ id: 'fixture-license', label: 'Living room', username_8k: 'demo-user', password_8k: 'synthetic-password', expiry_date: '2027-01-10' }] },
    'communication_config/runtime': { enabled: true, sending_enabled: true },
    [`communication_threads/${threadId}`]: { subject: 'The guide is not loading on the living room TV', participant_email: 'friend@example.com', account_id: 'fixture-admin', license_id: 'fixture-license', source: 'email', category: 'support', status: 'open', preview: 'The channels work, but the guide is empty after the update.', created_at: '2026-11-02T14:00:00Z', updated_at: '2026-11-02T14:00:00Z', last_message_at: '2026-11-02T14:00:00Z', last_inbound_id: 'inbound-1', last_read_inbound_id: '' },
    [`communication_threads/${threadId}/messages/inbound-1`]: { body: 'Hi Elliot, the channels work, but the guide is empty after the update.\n\nI attached a picture of what I see. Should I refresh the EPG or change a setting?\n\nThanks!', direction: 'inbound', source: 'email', sender_email: 'friend@example.com', created_at: '2026-11-02T14:00:00Z', status: 'received', gmail_message_id: '18abcde01234', attachments: [{ filename: 'guide-screen.jpg', size: 5400 }] },
    'strong8k_renewal_requests/fixture-renewal': { account_id: 'fixture-admin', license_id: 'fixture-license', product_name: '1 Year', price: 70, status: 'payment_reported' }
}));
data.set('users/prospect-fixture-01', { full_name: 'Alex Example', email: 'alex@example.com' });
data.set('users/prospect-fixture-01/memberships/strong8k', { app_id: 'strong8k', role: 'member', status: 'active' });
data.set('strong8k_profiles/prospect-fixture-01', { licenses: [] });
data.set('strong8k_private/prospect-fixture-01', { prospect_status: 'prospect', license_history_seen: false });
data.set('users/prospect-fixture-02', { full_name: 'Jamie Example', email: 'jamie@example.com' });
data.set('users/prospect-fixture-02/memberships/strong8k', { app_id: 'strong8k', role: 'member', status: 'active' });
data.set('strong8k_profiles/prospect-fixture-02', { licenses: [] });
data.set('users/customer-fixture-old', { full_name: 'Morgan Example', email: 'morgan@example.com' });
data.set('users/customer-fixture-old/memberships/strong8k', { app_id: 'strong8k', role: 'member', status: 'active' });
data.set('strong8k_profiles/customer-fixture-old', { licenses: [] });
data.set('strong8k_private/customer-fixture-old', { license_history_seen: true, prospect_status: 'customer' });
const listeners = new Set();
const snap = ref => ({ id: ref.path.split('/').at(-1), exists: () => data.has(ref.path), data: () => structuredClone(data.get(ref.path)) });
function snapshot(ref) {
    if (ref.kind === 'doc') return snap(ref);
    let rows = [...data].filter(([path]) => path.startsWith(ref.path + '/') && path.split('/').length === ref.path.split('/').length + 1);
    for (const filter of ref.filters || []) {
        if (filter.type === 'where') rows = rows.filter(([, value]) => value[filter.key] === filter.value);
        if (filter.type === 'order') rows.sort(([, a], [, b]) => String(a[filter.key] || '').localeCompare(String(b[filter.key] || '')) * (filter.direction === 'desc' ? -1 : 1));
        if (filter.type === 'limit') rows = rows.slice(0, filter.count);
    }
    const docs = rows.map(([path]) => snap({ path })); return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
}
const notify = () => queueMicrotask(() => { for (const listener of listeners) listener.fn(snapshot(listener.ref)); });
export const initializeApp = () => ({});
export const getFirestore = () => ({});
const authListeners = new Set();
const auth = { currentUser: window.authFixture ? null : user, onAuthStateChanged: fn => onAuthStateChanged(auth, fn) };
export const getAuth = () => auth;
export const onAuthStateChanged = (_, fn) => { authListeners.add(fn); queueMicrotask(() => fn(auth.currentUser)); return () => authListeners.delete(fn); };
export const signOut = async () => { auth.currentUser = null; location.reload(); };
async function authAction(kind, email) {
    if (window.authFixture) {
        window.authFixture.calls.push({ kind, email });
        await new Promise(resolve => setTimeout(resolve, window.authFixture.delay));
        if (window.authFixture.error) throw { code: window.authFixture.error };
        if (kind !== 'reset') {
            auth.currentUser = user;
            for (const fn of authListeners) fn(user);
        }
    }
    return { user };
}
export const sendPasswordResetEmail = async (_, email) => authAction('reset', email);
export const signInWithEmailAndPassword = async (_, email) => authAction('login', email);
export const createUserWithEmailAndPassword = async (_, email) => authAction('register', email);
export const doc = (_, ...parts) => ({ path: parts.join('/'), kind: 'doc' });
export const collection = (_, ...parts) => ({ path: parts.join('/'), kind: 'collection' });
export const orderBy = (key, direction = 'asc') => ({ type: 'order', key, direction });
export const where = (key, operator, value) => ({ type: 'where', key, value });
export const limit = count => ({ type: 'limit', count });
export const query = (ref, ...filters) => ({ ...ref, filters });
export const getDoc = async ref => snap(ref);
export const getDocs = async ref => snapshot(ref);
export const onSnapshot = (ref, fn) => { const listener = { ref, fn }; listeners.add(listener); queueMicrotask(() => { if (listeners.has(listener)) fn(snapshot(ref)); }); return () => listeners.delete(listener); };
export const setDoc = async (ref, value, options = {}) => { data.set(ref.path, options.merge ? { ...data.get(ref.path), ...value } : value); notify(); };
export const updateDoc = async (ref, value) => { if (!data.has(ref.path)) throw new Error('Document not found'); data.set(ref.path, { ...data.get(ref.path), ...value }); notify(); };
export const addDoc = async (ref, value) => { const id = crypto.randomUUID(); data.set(ref.path + '/' + id, value); notify(); return { id }; };
export const deleteDoc = async ref => { data.delete(ref.path); notify(); };
export const deleteField = () => null;
export async function runTransaction(_, callback) {
    if (window.fixtureFailWrite) throw new Error('Synthetic network failure. Retry.');
    const writes = [];
    const result = await callback({ get: async ref => snap(ref), set: (ref, value, options) => writes.push(() => data.set(ref.path, options?.merge ? { ...data.get(ref.path), ...value } : value)), update: (ref, value) => writes.push(() => data.set(ref.path, { ...data.get(ref.path), ...value })), delete: ref => writes.push(() => data.delete(ref.path)) });
    writes.forEach(write => write()); notify();
    if (window.fixtureLoseCommitResponse) { window.fixtureLoseCommitResponse = false; throw new Error('Synthetic lost commit response. Retry.'); }
    return result;
}
window.fixtureData = data;
window.fixtureNotify = notify;
