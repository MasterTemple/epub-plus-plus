import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteReader, parseColumns } from '../src/apple-books/sqlite';

/** A WAL-mode database with interior pages, overflow pages, every value type, and uncheckpointed changes. */
function makeDb(dir: string) {
	const path = join(dir, 'test.sqlite');
	const db = new Database(path, { create: true });
	db.run('PRAGMA journal_mode=WAL');
	db.run('PRAGMA wal_autocheckpoint=0');
	db.run('CREATE TABLE ZITEM ( Z_PK INTEGER PRIMARY KEY, ZNAME VARCHAR, ZNUM INTEGER, ZREAL TIMESTAMP, ZBLOB BLOB, "ZQUOTED name" TEXT, CONSTRAINT x UNIQUE (ZNAME) )');
	const insert = db.prepare('INSERT INTO ZITEM (ZNAME, ZNUM, ZREAL, ZBLOB, "ZQUOTED name") VALUES (?, ?, ?, ?, ?)');
	for (let i = 0; i < 1500; i++) insert.run(`name ${i} ${'é'.repeat(i % 7)}`, i * 1_000_003 - 700_000, i / 7, new Uint8Array([i & 255, 1, 2]), i % 50 === 0 ? 'long '.repeat(2000) : null);
	db.run('PRAGMA wal_checkpoint(TRUNCATE)');
	// Changes after the checkpoint live only in the WAL.
	db.run("UPDATE ZITEM SET ZNAME = 'changed in the wal' WHERE Z_PK = 7");
	db.run('DELETE FROM ZITEM WHERE Z_PK = 8');
	insert.run('added in the wal', 9_007_199_254_740_993n, -1.5, null, 'x');
	const read = () => ({ db: readFileSync(path), wal: existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : null });
	return { db, read };
}

test('reads tables like SQLite does, including uncheckpointed WAL changes', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sqlite-test-'));
	try {
		const { db, read } = makeDb(dir);
		const files = read();
		expect(files.wal?.length).toBeGreaterThan(0);
		const expected = db.query('SELECT * FROM ZITEM ORDER BY Z_PK').all() as Record<string, unknown>[];
		const rows = [...new SqliteReader(files.db, files.wal).rows('ZITEM')];
		expect(rows.length).toBe(expected.length);
		for (let i = 0; i < expected.length; i++) {
			for (const [k, v] of Object.entries(expected[i])) {
				const got = rows[i][k];
				if (v instanceof Uint8Array) expect(Buffer.from(got as Uint8Array).equals(Buffer.from(v))).toBe(true);
				// bun:sqlite rounds 64-bit integers to numbers; the reader keeps them exact (bigint).
				else expect(typeof got === 'bigint' ? Number(got) : got).toEqual(v as never);
			}
		}
		expect(rows.find((r) => r.Z_PK === 7)?.ZNAME).toBe('changed in the wal');
		expect(rows.some((r) => r.Z_PK === 8)).toBe(false);
		expect(rows.at(-1)?.ZNUM).toBe(9_007_199_254_740_993n);
		// Without the WAL: the checkpointed state.
		const old = [...new SqliteReader(files.db).rows('ZITEM')];
		expect(old.find((r) => r.Z_PK === 7)?.ZNAME).toBe(`name 6 ${'é'.repeat(6)}`);
		expect(old.some((r) => r.Z_PK === 8)).toBe(true);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('rejects non-SQLite data', () => {
	expect(() => new SqliteReader(new Uint8Array(200))).toThrow('Not an SQLite database');
});

test('parseColumns', () => {
	expect(parseColumns('CREATE TABLE t ( Z_PK INTEGER PRIMARY KEY, "a b" TEXT, [c] INT DEFAULT (1, 2), d, PRIMARY KEY (d) )')).toEqual({ columns: ['Z_PK', 'a b', 'c', 'd'], rowidColumn: 'Z_PK' });
});
