/** Small hover tooltip for other plugins' annotations (desktop only). */
export class AnnotationTip {
	private readonly el: HTMLElement;
	private timer = 0;
	private shownFor = '';

	constructor(private container: HTMLElement) {
		this.el = container.createDiv('epp-annotation-tip');
	}

	/** `key` identifies what's under the pointer; `text` is computed only when the tip is shown. */
	hover(e: MouseEvent, key: string, text: () => string): void {
		window.clearTimeout(this.timer);
		if (!key) return this.hide();
		if (key === this.shownFor) return;
		this.timer = window.setTimeout(() => {
			const t = text();
			if (!t) return this.hide();
			this.shownFor = key;
			this.el.setText(t);
			this.el.addClass('is-visible');
			const box = this.container.getBoundingClientRect();
			const w = this.el.offsetWidth;
			const h = this.el.offsetHeight;
			const left = Math.max(8, Math.min(e.clientX - box.left + 12, box.width - w - 8));
			let top = e.clientY - box.top + 18;
			if (top + h > box.height - 8) top = Math.max(8, e.clientY - box.top - h - 12);
			this.el.style.left = `${left}px`;
			this.el.style.top = `${top}px`;
		}, 200);
	}

	hide(): void {
		window.clearTimeout(this.timer);
		this.shownFor = '';
		this.el.removeClass('is-visible');
	}

	destroy(): void {
		this.hide();
		this.el.remove();
	}
}
