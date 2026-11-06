import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// Never fall back to production when the emulator is missing or misconfigured.
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) throw new Error('A loopback FIRESTORE_EMULATOR_HOST is required.');
const require = createRequire(import.meta.url);
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, getDocs, collection, setLogLevel } = require('firebase/firestore');
setLogLevel('silent');
const projectId = 'demo-goelliot-inbox';
const environment = await initializeTestEnvironment({ projectId, firestore: {
    host: '127.0.0.1', port: Number(host.split(':')[1]), rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8')
} });
const protectedPaths = ['communication_threads/thread-fixture', 'communication_threads/thread-fixture/messages/message-fixture',
    'communication_outbox/message-fixture', 'communication_ingest/message-fixture', 'communication_notifications/message-fixture',
    'communication_mail_references/reference-fixture', 'communication_rate_limits/bucket-fixture', 'communication_config/runtime'];
try {
    await environment.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await setDoc(doc(db, 'roles/operator-fixture'), { platform_admin: true });
        await setDoc(doc(db, 'users/customer-fixture'), { email: 'customer@example.com', full_name: 'Synthetic customer' });
        await setDoc(doc(db, 'users/customer-fixture/memberships/strong8k'), { app_id: 'strong8k', role: 'member', status: 'active' });
        await setDoc(doc(db, 'strong8k_profiles/customer-fixture'), { licenses: [{ id: 'fixture', expiry_date: '2027-01-01' }], setup_notes: 'Synthetic setup' });
        await setDoc(doc(db, 'strong8k_private/customer-fixture'), { internal_notes: 'Internal synthetic note' });
        await setDoc(doc(db, 'strong8k_profiles/customer-fixture/support_events/internal'), { visibility: 'internal', summary: 'Private email' });
        await setDoc(doc(db, 'strong8k_profiles/customer-fixture/support_events/shared'), { visibility: 'shared', summary: 'Shared setup' });
        for (const path of protectedPaths) await setDoc(doc(db, path), { body: 'Synthetic private message', account_id: 'customer-fixture' });
    });
    const admin = environment.authenticatedContext('operator-fixture', { email: 'operator@example.com' }).firestore();
    const customer = environment.authenticatedContext('customer-fixture', { email: 'customer@example.com' }).firestore();
    const stranger = environment.authenticatedContext('stranger-fixture', { email: 'stranger@example.com' }).firestore();
    const anonymous = environment.unauthenticatedContext().firestore();
    for (const path of protectedPaths) {
        await assertSucceeds(getDoc(doc(admin, path)));
        await assertSucceeds(updateDoc(doc(admin, path), { checked: true }));
        for (const db of [customer, stranger, anonymous]) {
            await assertFails(getDoc(doc(db, path)));
            await assertFails(setDoc(doc(db, path), { body: 'unauthorized overwrite' }));
        }
    }
    await assertFails(getDocs(collection(customer, 'communication_threads')));
    await assertFails(setDoc(doc(customer, 'roles/customer-fixture'), { platform_admin: true }));
    await assertFails(getDoc(doc(customer, 'strong8k_private/customer-fixture')));
    await assertSucceeds(getDoc(doc(admin, 'strong8k_private/customer-fixture')));
    await assertFails(getDoc(doc(customer, 'strong8k_profiles/customer-fixture/support_events/internal')));
    await assertSucceeds(getDoc(doc(customer, 'strong8k_profiles/customer-fixture/support_events/shared')));
    await assertFails(setDoc(doc(customer, 'strong8k_profiles/customer-fixture/support_events/forged'), { visibility: 'shared', summary: 'Forged note' }));
    await assertSucceeds(updateDoc(doc(customer, 'strong8k_profiles/customer-fixture'), { setup_notes: 'Updated setup' }));
    await assertFails(updateDoc(doc(customer, 'strong8k_profiles/customer-fixture'), { licenses: [] }));
    assert.equal((await getDoc(doc(admin, 'communication_outbox/message-fixture'))).data().body, 'Synthetic private message');
    console.log('PASS: actual Firestore rules deny customer/stranger/anonymous reads and writes across all messaging collections; admin access, internal notes, shared history, role protection, and profile field limits verified.');
} finally {
    await environment.clearFirestore();
    await environment.cleanup();
}
