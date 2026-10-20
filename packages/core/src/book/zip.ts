import { inflateSync, unzipSync } from 'fflate';

interface Entry {
	/** 0 stored, 8 deflate. */
	method: number;
	/** Offset of the local file header. */
	header: number;
	compressed: number;
	size: number;
}

/**
 * A zip archive read on demand: opening parses only the central directory, and each file is inflated
 * when it's first asked for. A book's images and fonts (most of its bytes) are never inflated up front,
 * and images can be inflated off the main thread (`blob`).
 */
export class LazyZip {
	private readonly entries = new Map<string, Entry>();
	/** Archives the central directory reader doesn't handle (zip64, damaged directories): inflated whole. */
	private readonly eager: Record<string, Uint8Array> | null = null;

	constructor(private readonly data: Uint8Array) {
		if (!this.readDirectory()) {
			this.entries.clear();
			this.eager = unzipSync(data);
		}
	}

	has(path: string): boolean {
		return this.eager ? path in this.eager : this.entries.has(path);
	}

	/** The file's bytes, inflated now (not cached), or null. Stored files are views into the archive. */
	read(path: string): Uint8Array | null {
		if (this.eager) return this.eager[path] ?? null;
		const e = this.entries.get(path);
		if (!e) return null;
		const raw = this.raw(e);
		if (!raw) return null;
		if (e.method === 0) return raw;
		return inflateSync(raw, { out: new Uint8Array(e.size) });
	}

	/** The file's bytes, inflated natively and off the main thread where the browser can. */
	async readAsync(path: string): Promise<Uint8Array | null> {
		const e = this.eager ? null : this.entries.get(path);
		// Streams cost more to set up than small files take to inflate here.
		if (e?.method !== 8 || e.compressed < ASYNC_MIN) return this.read(path);
		const blob = await this.blob(path, 'application/octet-stream');
		return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
	}

	/**
	 * The file as a Blob of `type`, inflated by the browser's DecompressionStream when it has one
	 * (natively and off the main thread), or null.
	 */
	async blob(path: string, type: string): Promise<Blob | null> {
		const e = this.eager ? null : this.entries.get(path);
		const raw = e && this.raw(e);
		if (e && raw && e.method === 8 && typeof DecompressionStream !== 'undefined') {
			try {
				const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
				return await new Response(stream, { headers: { 'content-type': type } }).blob();
			} catch {
				/* inflate it here instead */
			}
		}
		const bytes = this.read(path);
		return bytes ? new Blob([bytes as BlobPart], { type }) : null;
	}

	private raw(e: Entry): Uint8Array | null {
		const d = this.data;
		if (e.header + 30 > d.length || u32(d, e.header) !== 0x04034b50) return null;
		const start = e.header + 30 + u16(d, e.header + 26) + u16(d, e.header + 28);
		if (start + e.compressed > d.length) return null;
		return d.subarray(start, start + e.compressed);
	}

	/** Index the central directory; false when this archive needs the eager reader. */
	private readDirectory(): boolean {
		const d = this.data;
		// End of central directory: 22 bytes plus a comment of up to 64 KiB, at the end.
		let eocd = -1;
		for (let i = d.length - 22; i >= Math.max(0, d.length - 22 - 0xffff); i--) {
			if (u32(d, i) === 0x06054b50) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) return false;
		const count = u16(d, eocd + 10);
		let p = u32(d, eocd + 16);
		if (count === 0xffff || p === 0xffffffff) return false; // zip64
		const utf8 = new TextDecoder('utf-8');
		const latin1 = new TextDecoder('latin1');
		for (let i = 0; i < count; i++) {
			if (p + 46 > d.length || u32(d, p) !== 0x02014b50) return false;
			const flags = u16(d, p + 8);
			const method = u16(d, p + 10);
			const compressed = u32(d, p + 20);
			const size = u32(d, p + 24);
			const nameLen = u16(d, p + 28);
			const next = p + 46 + nameLen + u16(d, p + 30) + u16(d, p + 32);
			if (method !== 0 && method !== 8) return false;
			if (compressed === 0xffffffff || size === 0xffffffff || u32(d, p + 42) === 0xffffffff) return false;
			const name = (flags & 0x800 ? utf8 : latin1).decode(d.subarray(p + 46, p + 46 + nameLen));
			if (!name.endsWith('/')) this.entries.set(name, { method, header: u32(d, p + 42), compressed, size });
			p = next;
		}
		return true;
	}
}

/** Smallest compressed size worth inflating through a DecompressionStream for `readAsync`. */
const ASYNC_MIN = 64 * 1024;

const u16 = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8);
const u32 = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;
