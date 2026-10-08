/**
 * A minimal read-only SQLite reader: table rows, nothing else (no indexes, no SQL). Works on desktop
 * and mobile alike (no native modules or WebAssembly). The write-ahead log (`<db>-wal`) can be given
 * too: its committed pages replace the database's, which is how SQLite itself reads them.
 *
 * File format: https://www.sqlite.org/fileformat2.html
 */

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface TableInfo {
	name: string;
	rootPage: number;
	sql: string;
	columns: string[];
	/** The `INTEGER PRIMARY KEY` column (an alias of the rowid), if any. */
	rowidColumn: string | null;
}

export class SqliteError extends Error {}

export class SqliteReader {
	private readonly pageSize: number;
	private readonly usable: number;
	private readonly decoder: TextDecoder;
	/** Pages from the write-ahead log, newest committed version of each. */
	private readonly walPages = new Map<number, Uint8Array>();
	private tableCache: TableInfo[] | null = null;

	constructor(
		private readonly db: Uint8Array,
		wal?: Uint8Array | null,
	) {
		if (db.length < 100 || new TextDecoder().decode(db.subarray(0, 15)) !== 'SQLite format 3') throw new SqliteError('Not an SQLite database');
		const raw = (db[16] << 8) | db[17];
		this.pageSize = raw === 1 ? 65536 : raw;
		this.usable = this.pageSize - db[20];
		const enc = u32(db, 56);
		this.decoder = new TextDecoder(enc === 2 ? 'utf-16le' : enc === 3 ? 'utf-16be' : 'utf-8');
		if (wal?.length) this.readWal(wal);
	}

	/** Committed frames of the WAL whose salts and checksums are valid (as SQLite recovers them). */
	private readWal(wal: Uint8Array): void {
		if (wal.length < 32) return;
		const magic = u32(wal, 0);
		if (magic !== 0x377f0682 && magic !== 0x377f0683) return;
		const bigEndian = magic === 0x377f0683;
		const pageSize = u32(wal, 8);
		if (pageSize !== this.pageSize) return;
		const salt1 = u32(wal, 16);
		const salt2 = u32(wal, 20);
		let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, bigEndian);
		if (s0 !== u32(wal, 24) || s1 !== u32(wal, 28)) return;
		const frameSize = 24 + pageSize;
		let pending = new Map<number, Uint8Array>();
		for (let off = 32; off + frameSize <= wal.length; off += frameSize) {
			if (u32(wal, off + 8) !== salt1 || u32(wal, off + 12) !== salt2) break;
			[s0, s1] = walChecksum(wal.subarray(off, off + 8), s0, s1, bigEndian);
			[s0, s1] = walChecksum(wal.subarray(off + 24, off + frameSize), s0, s1, bigEndian);
			if (s0 !== u32(wal, off + 16) || s1 !== u32(wal, off + 20)) break;
			pending.set(u32(wal, off), wal.subarray(off + 24, off + frameSize));
			// A commit frame (database size set) makes the transaction's pages visible.
			if (u32(wal, off + 4)) {
				for (const [n, p] of pending) this.walPages.set(n, p);
				pending = new Map();
			}
		}
	}

	private page(n: number): Uint8Array {
		const fromWal = this.walPages.get(n);
		if (fromWal) return fromWal;
		const start = (n - 1) * this.pageSize;
		if (n < 1 || start + this.pageSize > this.db.length) throw new SqliteError(`Page ${n} is out of range`);
		return this.db.subarray(start, start + this.pageSize);
	}

	/** The tables (from `sqlite_master`), with their column names. */
	tables(): TableInfo[] {
		if (this.tableCache) return this.tableCache;
		const out: TableInfo[] = [];
		for (const { values } of this.scan(1)) {
			const [type, name, , rootPage, sql] = values;
			if (type !== 'table' || typeof name !== 'string' || typeof sql !== 'string') continue;
			const { columns, rowidColumn } = parseColumns(sql);
			out.push({ name, rootPage: Number(rootPage), sql, columns, rowidColumn });
		}
		return (this.tableCache = out);
	}

	table(name: string): TableInfo | null {
		return this.tables().find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
	}

	/** All rows of a table, as objects keyed by column name. */
	*rows(tableName: string): Generator<Row> {
		const t = this.table(tableName);
		if (!t) throw new SqliteError(`No table ${tableName}`);
		for (const { rowid, values } of this.scan(t.rootPage)) {
			const row: Row = {};
			t.columns.forEach((c, i) => (row[c] = c === t.rowidColumn ? (values[i] ?? rowid) : (values[i] ?? null)));
			yield row;
		}
	}

	/** The records of a table b-tree, in rowid order. */
	private *scan(root: number): Generator<{ rowid: number | bigint; values: SqlValue[] }> {
		const stack = [root];
		const seen = new Set<number>();
		while (stack.length) {
			const n = stack.pop()!;
			if (seen.has(n)) throw new SqliteError('Corrupt database (page cycle)');
			seen.add(n);
			const page = this.page(n);
			const h = n === 1 ? 100 : 0;
			const type = page[h];
			const cells = (page[h + 3] << 8) | page[h + 4];
			if (type === 0x05) {
				// Interior table page: children in order, then the rightmost; pushed reversed for a stack.
				const children = [];
				for (let i = 0; i < cells; i++) children.push(u32(page, (page[h + 12 + 2 * i] << 8) | page[h + 13 + 2 * i]));
				children.push(u32(page, h + 8));
				for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
			} else if (type === 0x0d) {
				for (let i = 0; i < cells; i++) {
					let p = (page[h + 8 + 2 * i] << 8) | page[h + 9 + 2 * i];
					const [size, a] = varint(page, p);
					p += a;
					const [rowid, b] = varint(page, p);
					p += b;
					yield { rowid, values: this.record(this.payload(page, p, Number(size))) };
				}
			} else throw new SqliteError(`Unexpected page type ${type} in a table`);
		}
	}

	/** A cell's payload, following overflow pages when it doesn't fit. */
	private payload(page: Uint8Array, at: number, size: number): Uint8Array {
		const u = this.usable;
		const x = u - 35;
		if (size <= x) return page.subarray(at, at + size);
		const m = Math.floor(((u - 12) * 32) / 255) - 23;
		const k = m + ((size - m) % (u - 4));
		const local = k <= x ? k : m;
		const out = new Uint8Array(size);
		out.set(page.subarray(at, at + local));
		let filled = local;
		let next = u32(page, at + local);
		while (filled < size && next) {
			const o = this.page(next);
			const take = Math.min(size - filled, u - 4);
			out.set(o.subarray(4, 4 + take), filled);
			filled += take;
			next = u32(o, 0);
		}
		return out;
	}

	private record(rec: Uint8Array): SqlValue[] {
		const [headerSize, hs] = varint(rec, 0);
		const types: number[] = [];
		for (let p = hs; p < Number(headerSize); ) {
			const [t, n] = varint(rec, p);
			types.push(Number(t));
			p += n;
		}
		const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
		const values: SqlValue[] = [];
		let p = Number(headerSize);
		for (const t of types) {
			if (t === 0) values.push(null);
			else if (t >= 1 && t <= 6) {
				const len = [0, 1, 2, 3, 4, 6, 8][t];
				let v = BigInt(rec[p] & 0x80 ? -1 : 0);
				for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(rec[p + i]);
				v = BigInt.asIntN(len * 8, v);
				values.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
				p += len;
			} else if (t === 7) {
				values.push(view.getFloat64(p));
				p += 8;
			} else if (t === 8 || t === 9) values.push(t - 8);
			else if (t >= 12) {
				const len = (t - (t % 2 ? 13 : 12)) / 2;
				const bytes = rec.subarray(p, p + len);
				values.push(t % 2 ? this.decoder.decode(bytes) : bytes);
				p += len;
			} else values.push(null);
		}
		return values;
	}
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** SQLite varint: 1–9 bytes, big-endian, 7 bits per byte (8 in the 9th). */
function varint(b: Uint8Array, o: number): [number | bigint, number] {
	let v = 0n;
	for (let i = 0; i < 9; i++) {
		const byte = b[o + i];
		if (i === 8) {
			v = (v << 8n) | BigInt(byte);
			return [small(v), 9];
		}
		v = (v << 7n) | BigInt(byte & 0x7f);
		if (!(byte & 0x80)) return [small(v), i + 1];
	}
	return [small(v), 9];
}

const small = (v: bigint): number | bigint => {
	const s = BigInt.asIntN(64, v);
	return s >= BigInt(Number.MIN_SAFE_INTEGER) && s <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s;
};

/** The WAL's running checksum over 32-bit words, two at a time. */
function walChecksum(data: Uint8Array, s0: number, s1: number, bigEndian: boolean): [number, number] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	for (let i = 0; i + 8 <= data.length; i += 8) {
		s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0;
		s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0;
	}
	return [s0, s1];
}

/** Column names of a `CREATE TABLE` statement, and its rowid alias (`x INTEGER PRIMARY KEY`). */
export function parseColumns(sql: string): { columns: string[]; rowidColumn: string | null } {
	const open = sql.indexOf('(');
	const close = sql.lastIndexOf(')');
	const body = sql.slice(open + 1, close);
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	let quote: string | null = null;
	for (const ch of body) {
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'" || ch === '`' || ch === '[') quote = ch === '[' ? ']' : ch;
		else if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			parts.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) parts.push(cur);
	const columns: string[] = [];
	let rowidColumn: string | null = null;
	for (const part of parts) {
		const def = part.trim();
		if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(def)) continue;
		const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\S+))\s*(.*)$/s.exec(def);
		if (!m) continue;
		const name = m[1] ?? m[2] ?? m[3] ?? m[4];
		columns.push(name);
		if (/^integer\s+primary\s+key\b/i.test(m[5].trim())) rowidColumn = name;
	}
	return { columns, rowidColumn };
}
