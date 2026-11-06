import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createFixtureServer } from './communications-browser-server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = createFixtureServer({ signedOut: true });
const port = Number(process.env.AUTH_TEST_PORT || 4331);
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('.impeccable/review', { recursive: true });
const open = async () => {
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.locator('#login-email').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMedia({ reducedMotion: 'reduce' });
};
try {
    await open();
    assert.match(await page.locator('#auth-view').innerText(), /A familiar face\./);
    assert.doesNotMatch(await page.locator('#auth-view').innerText(), /strong8k|playoff/i);
    assert.equal(await page.locator('#login-pass').getAttribute('type'), 'password');
    assert.equal(await page.locator('#login-pass').getAttribute('autocomplete'), 'current-password');
    await page.screenshot({ path: '.impeccable/review/sign-in-desktop.png', fullPage: true });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'login-email');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'login-pass');
    await page.locator('#forgot-password-link').click();
    assert.match(await page.locator('#auth-status').innerText(), /Enter your email/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'login-email');
    await page.locator('#login-email').fill('friend@example.com');
    await page.locator('#forgot-password-link').click();
    await page.waitForFunction(() => document.getElementById('auth-status').dataset.tone === 'success');
    assert.match(await page.locator('#auth-status').innerText(), /If this email has an account/);
    assert.equal(await page.evaluate(() => window.authFixture.calls[0].kind), 'reset');

    await page.evaluate(() => { window.authFixture.error = 'auth/invalid-credential'; window.authFixture.delay = 350; });
    await page.locator('#login-pass').fill('synthetic-password');
    await page.locator('#login-form button').click();
    assert.equal(await page.locator('#login-form').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#login-form button').isDisabled(), true);
    await page.evaluate(() => document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true })));
    await page.waitForFunction(() => document.getElementById('auth-status').textContent.includes("didn't match"));
    assert.equal(await page.evaluate(() => window.authFixture.calls.filter(c => c.kind === 'login').length), 1);
    assert.equal(await page.locator('#login-form button').isEnabled(), true);
    await page.screenshot({ path: '.impeccable/review/sign-in-error.png', fullPage: true });

    await page.locator('#show-register-link').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'reg-email');
    assert.equal(await page.locator('#auth-form-title').innerText(), 'Make yourself at home');
    assert.equal(await page.locator('#reg-pass').getAttribute('autocomplete'), 'new-password');
    await page.screenshot({ path: '.impeccable/review/sign-in-register.png', fullPage: true });
    await page.locator('#reg-email').fill('friend@example.com');
    await page.locator('#reg-pass').fill('synthetic-password');
    await page.evaluate(() => { window.authFixture.error = 'auth/email-already-in-use'; });
    await page.locator('#register-form button').click();
    await page.waitForFunction(() => document.getElementById('auth-status').textContent.includes('already has an account'));
    await page.evaluate(() => { window.authFixture.error = null; });
    await page.locator('#register-form button').click();
    await page.locator('#auth-view').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#auth-view').isVisible(), false, 'signed-in routing hides the entrance');

    await open();
    await page.locator('#login-email').fill('friend@example.com');
    await page.locator('#login-pass').fill('synthetic-password');
    await page.locator('#login-form button').click();
    await page.locator('#auth-view').waitFor({ state: 'hidden' });

    await open();
    for (const [width, height] of [[768, 1024], [390, 844], [320, 740]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px has no horizontal overflow`);
        const button = await page.locator('#login-form button').boundingBox();
        assert.ok(button.width >= 44 && button.height >= 44);
        if (width === 390) {
            await page.screenshot({ path: '.impeccable/review/sign-in-mobile.png', fullPage: true });
            assert.ok(button.y + button.height <= 844, `mobile sign-in is reachable in the first viewport (${button.y + button.height})`);
        } else await page.screenshot({ path: `.impeccable/review/sign-in-${width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: signed-out copy, keyboard, recovery, failures, duplicate protection, registration, login, signed-in routing, and 3 responsive widths. Synthetic Firebase only.');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
