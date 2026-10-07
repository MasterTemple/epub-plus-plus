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
	 * Mobile: sit at the top of the screen (CSS) and shrink to the area the on-screen keyboard leaves
	 * visible, so the buttons stay reachable.
	 */
	private fitAboveKeyboard(): void {
		this.containerEl.addClass('epp-comment-container');
		const vv = window.visualViewport;
		if (!vv) return;
		const fit = () => {
			this.modalEl.style.maxHeight = `${Math.max(200, vv.height - 24)}px`;
			this.containerEl.style.paddingTop = `${vv.offsetTop + 12}px`;
		};
		fit();
		vv.addEventListener('resize', fit);
		vv.addEventListener('scroll', fit);
		this.stopFit = () => {
			vv.removeEventListener('resize', fit);
			vv.removeEventListener('scroll', fit);
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
