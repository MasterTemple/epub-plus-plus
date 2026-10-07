/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown[]>> {
	private listeners = new Map<keyof Events, Set<(...args: any[]) => void>>();

	on<K extends keyof Events>(event: K, cb: (...args: Events[K]) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) this.listeners.set(event, (set = new Set()));
		set.add(cb);
		return () => this.off(event, cb);
	}

	off<K extends keyof Events>(event: K, cb: (...args: Events[K]) => void): void {
		this.listeners.get(event)?.delete(cb);
	}

	protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
		for (const cb of [...(this.listeners.get(event) ?? [])]) {
			try {
				cb(...args);
			} catch (e) {
				console.error(`[epub-pp] error in "${String(event)}" listener`, e);
			}
		}
	}

	protected removeAllListeners(): void {
		this.listeners.clear();
	}
}
