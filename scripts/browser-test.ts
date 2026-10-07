/**
 * Drives headless Chromium over CDP: opens a demo URL, waits for document.title === 'done',
 * prints console output and the #results JSON. Optional screenshot.
 *
 *   bun scripts/browser-test.ts "http://localhost:3737/test?book=moby-dick.epub" [--shot out.png] [--eval "js"] [--wait ms]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const url = args[0];
const opt = (k: string) => {
	const i = args.indexOf(k);
	return i === -1 ? undefined : args[i + 1];
};
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'epp-chrome-'));
const chrome = spawn('chromium', [
	'--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
	`--window-size=${opt('--size') ?? '1200,900'}`, 'about:blank',
], { stdio: 'ignore' });

let wsUrl = '';
for (let i = 0; i < 50 && !wsUrl; i++) {
	await Bun.sleep(100);
	try {
		const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
		wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
	} catch {}
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg.result ?? msg.error);
	else if (msg.method === 'Runtime.consoleAPICalled') {
		const text = msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ');
		if (!text.includes('[Bun]')) console.log(`[console.${msg.params.type}]`, text);
	} else if (msg.method === 'Runtime.exceptionThrown') console.log('[exception]', msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
};
const send = (method: string, params: object = {}) =>
	new Promise<any>((r) => {
		pending.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expr: string) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
const deadline = Date.now() + Number(opt('--timeout') ?? 180000);
const waitTitle = opt('--wait') ? null : 'done';
if (waitTitle) while (Date.now() < deadline && (await evaluate('document.title')) !== waitTitle) await Bun.sleep(250);
else await Bun.sleep(Number(opt('--wait')));
const ev = opt('--eval');
if (ev) console.log(JSON.stringify(await evaluate(ev), null, 1));
const results = await evaluate("document.getElementById('results')?.textContent");
if (results) console.log(results);
const shot = opt('--shot');
if (shot) {
	const { data } = await send('Page.captureScreenshot', { format: 'png' });
	await Bun.write(shot, Buffer.from(data, 'base64'));
	console.log('screenshot →', shot);
}
ws.close();
chrome.kill();
process.exit(0);
