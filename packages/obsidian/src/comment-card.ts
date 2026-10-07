import { Component, MarkdownRenderer, type App } from 'obsidian';
import type { HighlightEntry } from './highlight-index';

/** Floating card that renders the comments of highlights (hover on desktop, tap on mobile). */
export class CommentCard extends Component {
	private readonly el: HTMLElement;
	private timer = 0;
	private shownFor = '';
	private renderChild: Component | null = null;

	constructor(
		private app: App,
		private container: HTMLElement,
	) {
		super();
		this.el = container.createDiv('epp-comment-card');
	}

	/** Pointer moved over these highlights (empty: left them). */
	hover(e: MouseEvent, entries: HighlightEntry[]): void {
		window.clearTimeout(this.timer);
		const withComments = entries.filter((x) => x.comment);
		if (!withComments.length) return this.hide();
		const key = withComments.map((x) => x.id).join('|');
		if (key === this.shownFor) return;
		this.timer = window.setTimeout(() => this.show(withComments, { x: e.clientX, y: e.clientY }), 250);
	}

	/** Show the comments near a point, or pinned to the top of the container. */
	async show(entries: HighlightEntry[], at: { x: number; y: number } | 'top'): Promise<void> {
		const withComments = entries.filter((x) => x.comment);
		if (!withComments.length) return this.hide();
		this.shownFor = withComments.map((x) => x.id).join('|');
		this.renderChild?.unload();
		this.renderChild = this.addChild(new Component());
		this.el.empty();
		for (const entry of withComments) {
			const block = this.el.createDiv('epp-comment-card-item');
			await MarkdownRenderer.render(this.app, entry.comment!, block.createDiv('markdown-rendered'), entry.sourcePath, this.renderChild);
			const note = entry.sourcePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
			block.createDiv({ cls: 'epp-comment-card-source', text: note });
		}
		this.el.addClass('is-visible');
		const box = this.container.getBoundingClientRect();
		if (at === 'top') {
			this.el.addClass('is-pinned');
			this.el.style.left = this.el.style.top = '';
			return;
		}
		this.el.removeClass('is-pinned');
		const w = this.el.offsetWidth;
		const h = this.el.offsetHeight;
		const left = Math.max(8, Math.min(at.x - box.left + 12, box.width - w - 8));
		let top = at.y - box.top + 18;
		if (top + h > box.height - 8) top = Math.max(8, at.y - box.top - h - 12);
		this.el.style.left = `${left}px`;
		this.el.style.top = `${top}px`;
	}

	hide(): void {
		window.clearTimeout(this.timer);
		this.shownFor = '';
		this.el.removeClass('is-visible');
	}

	override onunload(): void {
		window.clearTimeout(this.timer);
		this.el.remove();
	}
}
