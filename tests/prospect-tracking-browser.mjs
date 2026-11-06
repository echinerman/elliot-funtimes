import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createFixtureServer } from './communications-browser-server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = createFixtureServer();
await new Promise(resolve => server.listen(4330, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const confirmations = [];
let acceptConfirmation = false;
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', async dialog => {
    confirmations.push(dialog.message());
    await (acceptConfirmation ? dialog.accept() : dialog.dismiss());
});
await mkdir('.impeccable/review', { recursive: true });
const root = 'http://127.0.0.1:4330/admin.html';
const waitLabel = text => page.waitForFunction(value => document.getElementById('user-prospect-label').textContent === value, text);
const openProfile = async id => {
    await page.evaluate(value => { location.hash = `#people/${value}`; }, id);
    await page.waitForFunction(value => document.getElementById('user-id').value === value, id);
    await page.locator('#user-workspace').waitFor({ state: 'visible' });
};
const screenshot = name => page.screenshot({ path: `.impeccable/review/prospect-${name}.png`, fullPage: true });
try {
    await page.goto(root);
    await page.locator('[data-edit-user="prospect-fixture-01"]').waitFor();
    assert.equal(await page.locator('#users-table-body [data-start-prospect]').count(), 4, 'every person has Start conversation');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('[data-ops-filter="prospect"]').click();
    assert.match(await page.locator('#operations-inbox-list').innerText(), /Alex Example/);
    assert.doesNotMatch(await page.locator('#operations-inbox-list').innerText(), /Jamie Example|Morgan Example/);
    await screenshot('queue-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.getElementById('admin-room-rail').getBoundingClientRect().right <= 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('#users-table-body td:nth-child(2) span').evaluateAll(nodes => nodes.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth;
    })), 'every membership and Prospect/Customer chip must stay visible on mobile');
    await screenshot('queue-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.locator('#people-filter').selectOption('prospects');
    assert.equal(await page.locator('#users-table-body tr').count(), 1);
    assert.match(await page.locator('#users-table-body').innerText(), /Alex Example.*Prospect/s);
    await page.locator('#user-search').fill('Jamie');
    assert.match(await page.locator('#users-table-body').innerText(), /No people match/);
    await page.locator('#user-search').fill('');
    await screenshot('people-desktop');

    await page.locator('[data-edit-user="prospect-fixture-01"]').click();
    await waitLabel('Prospect');
    assert.equal(await page.locator('#user-prospect-start').isVisible(), true);
    assert.equal(await page.locator('#user-prospect-classify').isVisible(), false);
    await screenshot('profile-desktop');
    await page.locator('#user-prospect-start').click();
    await page.locator('#prospect-body').waitFor();
    assert.match(page.url(), /#inbox\/compose\/prospect-fixture-01$/);
    assert.equal(await page.evaluate(() => [...window.fixtureData.keys()].filter(key => key.startsWith('communication_outbox/')).length), 0);
    acceptConfirmation = true;
    await page.locator('#prospect-compose-back').click();
    await page.locator('#user-workspace').waitFor({ state: 'visible' });
    await waitLabel('Prospect');

    await openProfile('prospect-fixture-02');
    await waitLabel('License history unknown');
    assert.equal(await page.locator('#user-prospect-start').isVisible(), true, 'unclassified profile can start a conversation');
    acceptConfirmation = false;
    await page.locator('#user-prospect-classify').click();
    assert.match(confirmations.at(-1), /unknown.*does not prove/s);
    assert.equal(await page.evaluate(() => window.fixtureData.has('strong8k_private/prospect-fixture-02')), false);
    acceptConfirmation = true;
    await page.locator('#user-prospect-classify').click();
    await waitLabel('Prospect');
    const classified = await page.evaluate(() => window.fixtureData.get('strong8k_private/prospect-fixture-02'));
    assert.equal(classified.prospect_status, 'prospect');
    assert.equal(classified.license_history_seen, false);
    assert.equal(classified.prospect_classified_by, 'fixture-admin');
    assert.ok(classified.prospect_classified_at);
    assert.equal(await page.evaluate(() => window.fixtureData.get('strong8k_profiles/prospect-fixture-02').prospect_status), undefined);

    await page.locator('#add-license-btn').click();
    await page.locator('#new-license-label').fill('Synthetic first license');
    await page.locator('#new-license-expiry').fill('2027-12-01');
    await page.locator('#new-license-username').fill('synthetic-person');
    await page.locator('#new-license-password').fill('synthetic-password');
    await page.locator('#new-license-form button[type="submit"]').click();
    await waitLabel('Customer');
    const converted = await page.evaluate(() => window.fixtureData.get('strong8k_private/prospect-fixture-02'));
    assert.equal(converted.prospect_status, 'customer');
    assert.equal(converted.license_history_seen, true);
    assert.equal(await page.locator('#user-prospect-start').isVisible(), true);
    await page.locator('[data-license-remove]').click();
    await page.waitForFunction(() => window.fixtureData.get('strong8k_profiles/prospect-fixture-02').licenses.length === 0);
    await waitLabel('Customer');
    assert.equal(await page.locator('#user-prospect-classify').isVisible(), false);

    await openProfile('customer-fixture-old');
    await waitLabel('Customer');
    assert.equal(await page.locator('#user-prospect-classify').isVisible(), false);
    await page.locator('#user-workspace-back').click();
    await page.locator('#people-filter').waitFor({ state: 'visible' });
    await page.locator('#people-filter').selectOption('prospects');
    assert.equal(await page.locator('#users-table-body tr').count(), 1);
    assert.match(await page.locator('#users-table-body').innerText(), /Alex Example/);
    assert.doesNotMatch(await page.locator('#users-table-body').innerText(), /Jamie Example|Morgan Example/);
    assert.equal(await page.evaluate(() => [...window.fixtureData.keys()].filter(key => key.startsWith('communication_outbox/')).length), 0);
    assert.deepEqual(errors, []);

    // Inject a read failure in transit, never into the fixture source or live data.
    const failedReadPage = await browser.newPage();
    await failedReadPage.route('**/__fixture/firebase.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
            'export const getDocs = async ref => snapshot(ref);',
            'export const getDocs = async ref => { if (ref.path === "strong8k_private") throw new Error("Synthetic private read failure"); return snapshot(ref); };'
        );
        await route.fulfill({ response, body });
    });
    await failedReadPage.goto(root);
    await failedReadPage.waitForFunction(() => document.getElementById('admin-access-title').textContent === 'Admin Data Failed to Load');
    assert.equal(await failedReadPage.locator('[data-start-prospect]:visible').count(), 0);
    await failedReadPage.close();
    console.log('PASS: confirmed-only queue/filter, unknown-history consent, private-only classification, manual compose, first-license conversion, deletion sentinel, private read failure, desktop/mobile. Synthetic only.');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
