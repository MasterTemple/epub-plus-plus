/**
 * Attach to a running Chromium/Electron (e.g. a headless Obsidian started with --remote-debugging-port)
 * and evaluate JS and/or take a screenshot.
 *
 *   bun scripts/cdp.ts --port 9333 [--eval "js" | --file script.js] [--shot out.png] [--logs ms]
 */
const args = process.argv.slice(2);
const opt = (k: string) => {
	const i = args.indexOf(k);
	return i === -1 ? undefined : args[i + 1];
};
const port = opt('--port') ?? '9333';
const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
const title = opt('--title');
const page = title
	? list.find((t) => t.type === 'page' && t.title.includes(title))
	: (list.find((t) => t.type === 'page' && t.url.startsWith('app://')) ?? list.find((t) => t.type === 'page'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
const logs: string[] = [];
ws.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg.result ?? msg.error);
	else if (msg.method === 'Runtime.consoleAPICalled') logs.push(`[console.${msg.params.type}] ${msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`);
	else if (msg.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
};
const send = (method: string, params: object = {}) =>
	new Promise<any>((r) => {
		pending.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
if (opt('--logs')) await send('Runtime.enable');
if (opt('--throttle')) await send('Emulation.setCPUThrottlingRate', { rate: Number(opt('--throttle')) });
let expr = opt('--eval');
const file = opt('--file');
if (file) expr = await Bun.file(file).text();
if (expr) {
	const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
	if (res.exceptionDetails) console.log('EXCEPTION', res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
	else console.log(typeof res.result?.value === 'string' ? res.result.value : JSON.stringify(res.result?.value, null, 1));
}
if (opt('--logs')) {
	await Bun.sleep(Number(opt('--logs')));
	console.log(logs.join('\n'));
}
const shot = opt('--shot');
if (shot) {
	const { data } = await send('Page.captureScreenshot', { format: 'png' });
	await Bun.write(shot, Buffer.from(data, 'base64'));
	console.log('screenshot →', shot);
}
ws.close();
process.exit(0);
