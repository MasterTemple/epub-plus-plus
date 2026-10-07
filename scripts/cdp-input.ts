/**
 * Send real mouse input through CDP (Input.dispatchMouseEvent), then print an expression's value.
 *   bun scripts/cdp-input.ts --port 9333 --dblclick x,y | --drag x1,y1,x2,y2 [--eval "js"]
 */
const args = process.argv.slice(2);
const opt = (k: string) => {
	const i = args.indexOf(k);
	return i === -1 ? undefined : args[i + 1];
};
const list = (await (await fetch(`http://127.0.0.1:${opt('--port') ?? '9333'}/json`)).json()) as any[];
const page = list.find((t) => t.type === 'page' && t.url.startsWith('app://')) ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg.result ?? msg.error);
};
const send = (method: string, params: object = {}) =>
	new Promise<any>((r) => {
		pending.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
const mouse = (type: string, x: number, y: number, clickCount = 1, button = 'left') =>
	send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mouseReleased' ? 0 : 1 });

const dbl = opt('--dblclick');
if (dbl) {
	const [x, y] = dbl.split(',').map(Number);
	await mouse('mousePressed', x, y, 1);
	await mouse('mouseReleased', x, y, 1);
	await mouse('mousePressed', x, y, 2);
	await mouse('mouseReleased', x, y, 2);
}
const drag = opt('--drag');
if (drag) {
	const [x1, y1, x2, y2] = drag.split(',').map(Number);
	await mouse('mousePressed', x1, y1);
	for (let i = 1; i <= 10; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 10, y: y1 + ((y2 - y1) * i) / 10, button: 'left', buttons: 1 });
	await mouse('mouseReleased', x2, y2);
}
const hover = opt('--hover'); // x,y[,modifiers]
if (hover) {
	const [x, y, mods] = hover.split(',').map(Number);
	for (let i = 0; i < 3; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + i, y, modifiers: mods || 0, buttons: 0 });
	await Bun.sleep(Number(opt('--hover-wait') ?? 1500));
}
const swipe = opt('--swipe'); // x1,y1,x2,y2 (touch)
if (swipe) {
	const [x1, y1, x2, y2] = swipe.split(',').map(Number);
	await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
	for (let i = 1; i <= 12; i++) {
		await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + ((x2 - x1) * i) / 12, y: y1 + ((y2 - y1) * i) / 12 }] });
		await Bun.sleep(16);
	}
	await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const tap = opt('--tap'); // x,y (touch)
if (tap) {
	const [x, y] = tap.split(',').map(Number);
	await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
	await Bun.sleep(60);
	await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const dbltap = opt('--dbltap'); // x,y (touch)
if (dbltap) {
	const [x, y] = dbltap.split(',').map(Number);
	await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	for (let i = 0; i < 2; i++) {
		await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
		await Bun.sleep(40);
		await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		if (i === 0) await Bun.sleep(120);
	}
}
const hold = opt('--hold'); // x,y (touch, ~700ms)
if (hold) {
	const [x, y] = hold.split(',').map(Number);
	await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
	await Bun.sleep(700);
	await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const rc = opt('--rightclick');
if (rc) {
	const [x, y] = rc.split(',').map(Number);
	await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
	await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
}
const key = opt('--key'); // e.g. ctrl+c
if (key) {
	const parts = key.toLowerCase().split('+');
	const k = parts.pop()!;
	const modifiers = (parts.includes('alt') ? 1 : 0) | (parts.includes('ctrl') ? 2 : 0) | (parts.includes('meta') ? 4 : 0) | (parts.includes('shift') ? 8 : 0);
	const base = { modifiers, key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) };
	const commands = modifiers === 2 && k === 'c' ? ['copy'] : [];
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
await Bun.sleep(400);
const ev = opt('--eval');
if (ev) {
	const res = await send('Runtime.evaluate', { expression: ev, awaitPromise: true, returnByValue: true });
	console.log(JSON.stringify(res.result?.value ?? res.exceptionDetails?.exception?.description, null, 1));
}
ws.close();
process.exit(0);
