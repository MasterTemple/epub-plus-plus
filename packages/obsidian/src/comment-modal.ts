import { Modal, Platform, Setting, type App } from 'obsidian';

export interface CommentPromptOptions {
	title?: string;
	initial?: string;
	submit?: string;
}

/** Ask for a comment to put under a quote. Resolves to null when cancelled. */
export function askForComment(app: App, quote: string, opts: CommentPromptOptions = {}): Promise<string | null> {
	return new Promise((resolve) => new CommentModal(app, quote, resolve, opts).open());
}

class CommentModal extends Modal {
	private done = false;
	private value = '';

	constructor(
		app: App,
		private quote: string,
		private resolve: (v: string | null) => void,
		private opts: CommentPromptOptions,
	) {
		super(app);
		this.value = opts.initial ?? '';
	}

	override onOpen(): void {
		this.modalEl.addClass('epp-comment-modal');
		if (Platform.isMobile) this.fitAboveKeyboard();
		this.titleEl.setText(this.opts.title ?? 'Add a comment');
		const { contentEl } = this;
		contentEl.createEl('blockquote', {
			cls: 'epp-comment-quote',
			text: this.quote.length > 400 ? `${this.quote.slice(0, 400)}…` : this.quote,
		});
		const area = contentEl.createEl('textarea', { cls: 'epp-comment-input', attr: { rows: Platform.isMobile ? '3' : '5', placeholder: 'Your comment…' } });
		area.value = this.value;
		area.addEventListener('input', () => (this.value = area.value));
		area.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit();
			}
		});
		new Setting(contentEl)
			.setDesc(Platform.isMobile ? '' : 'Ctrl/Cmd+Enter to confirm')
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.opts.submit ?? 'Copy').setCta().onClick(() => this.submit()));
		window.setTimeout(() => area.focus(), 50);
	}

	/**
	 * Mobile: keep the dialog directly above the on-screen keyboard (the bottom of the visual
	 * viewport), shrinking it if the visible area is too small, so its buttons stay reachable.
	 */
	private fitAboveKeyboard(): void {
		this.containerEl.addClass('epp-comment-container');
		const vv = window.visualViewport;
		const gap = 8;
		const fit = () => {
			const top = vv ? vv.offsetTop : 0;
			const height = vv ? vv.height : window.innerHeight;
			this.modalEl.style.maxHeight = `${Math.max(160, height - 2 * gap)}px`;
			const h = this.modalEl.offsetHeight;
			this.containerEl.style.paddingTop = `${Math.max(top + gap, top + height - h - gap)}px`;
		};
		fit();
		const ro = new ResizeObserver(fit); // content height changes (typing grows the text box)
		ro.observe(this.modalEl);
		vv?.addEventListener('resize', fit);
		vv?.addEventListener('scroll', fit);
		window.addEventListener('resize', fit);
		this.stopFit = () => {
			ro.disconnect();
			vv?.removeEventListener('resize', fit);
			vv?.removeEventListener('scroll', fit);
			window.removeEventListener('resize', fit);
		};
	}

	private stopFit: (() => void) | null = null;

	private submit(): void {
		this.done = true;
		this.resolve(this.value.trim());
		this.close();
	}

	override onClose(): void {
		this.stopFit?.();
		if (!this.done) this.resolve(null);
		this.contentEl.empty();
	}
}

/** Ask before deleting a highlight that has a comment. Resolves to true to delete. */
export function confirmDeleteHighlight(app: App, comment: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmDeleteModal(app, comment, resolve).open());
}

class ConfirmDeleteModal extends Modal {
	private result = false;

	constructor(
		app: App,
		private comment: string,
		private resolve: (v: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText('Delete highlight?');
		const { contentEl } = this;
		contentEl.createEl('p', { text: 'Its comment will be deleted too:' });
		contentEl.createEl('blockquote', {
			cls: 'epp-comment-quote',
			text: this.comment.length > 400 ? `${this.comment.slice(0, 400)}…` : this.comment,
		});
		if (!Platform.isMobile) contentEl.createEl('p', { cls: 'setting-item-description', text: 'Tip: Shift-click "Delete highlight" to skip this question.' });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Delete')
					.setWarning()
					.onClick(() => {
						this.result = true;
						this.close();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve(this.result);
	}
}
