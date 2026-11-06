import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function createFixtureServer({ signedOut = false } = {}) {
    return http.createServer(async (req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/__fixture/support') {
            let data = ''; for await (const chunk of req) data += chunk;
            res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, threadId: 'fixture-only', received: JSON.parse(data).clientRequestId })); return;
        }
        const file = pathname === '/__fixture/firebase.js' ? 'tests/fixtures/communications-firebase.js' : pathname.slice(1) || 'admin.html';
        if (!/^(?:[a-z0-9-]+\.(?:html|js|mjs|css)|assets\/[a-zA-Z0-9/_.-]+|tests\/fixtures\/communications-firebase\.js)$/.test(file)) { res.writeHead(404); res.end(); return; }
        try {
            const extension = path.extname(file);
            let content = await readFile(path.join(root, file));
            if (['.js', '.mjs', '.html'].includes(extension)) {
                content = content.toString().replace(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.7\.1\/firebase-[a-z-]+\.js/g, '/__fixture/firebase.js');
                if (file === 'config.js') content = content.replace('COMMUNICATIONS_ENABLED: false', 'COMMUNICATIONS_ENABLED: true').replace('https://automation.goelliot.vip/webhook/portal-support-message', '/__fixture/support');
                if (signedOut && extension === '.html') content = content.replace('<head>', '<head><script>window.authFixture = { calls: [], delay: 120, error: null };</script>');
                if (extension === '.html') content = content.replace('<body', '<body data-synthetic-fixture="true"').replace('</body>', '<div style="position:fixed;bottom:0;left:0;z-index:1000;background:#020617;color:white;padding:4px 12px;font:12px sans-serif">Synthetic test data. No live Firebase or sending.</div></body>');
            }
            res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2' }[extension] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(content);
        } catch { res.writeHead(404); res.end(); }
    });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const signedOut = process.argv.includes('--auth');
    const port = signedOut ? 4328 : 4326;
    createFixtureServer({ signedOut }).listen(port, '127.0.0.1', () => console.log(signedOut
        ? `Synthetic sign-in preview: http://127.0.0.1:${port}/index.html`
        : `Synthetic inbox preview: http://127.0.0.1:${port}/admin.html#inbox/comm_fixture_thread_0001`));
}
