import type { KeyAction } from "@elgato/streamdeck";

// ── Color utilities ──────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.startsWith("#") ? hex.slice(1) : hex;
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ── Constants ────────────────────────────────────────────────────────────────

const AMBER = "#e8943a";
const RED = "#ff3b30";

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
	const r = Math.round(a[0] + (b[0] - a[0]) * t);
	const g = Math.round(a[1] + (b[1] - a[1]) * t);
	const b2 = Math.round(a[2] + (b[2] - a[2]) * t);
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b2.toString(16).padStart(2, "0")}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

type Tile = { action: KeyAction; col: number; row: number };
type Layout = { tileSize: number; minCol: number; minRow: number; columns: number; rows: number; widthPx: number; heightPx: number };

export type RenderOptions = {
	accentColor: string;
	multiTileLayout: boolean;
	textColor?: string;
	blink?: boolean;
	subtitle?: string;
	subtitleColor?: string;
	borderColor?: string;
};

// ── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Instrument-gauge themed SVG renderer for Stream Deck keys.
 *
 * Dual-color progress ring (green remaining + amber elapsed), 60 tick marks
 * with amber cardinal markers, seven-segment digits with glow, no grid lines.
 */
export class DisplayRenderer {
	private readonly ts = 144;

	// ── Public API ───────────────────────────────────────────────────────

	async renderCountdown(remainingSeconds: number, fraction: number, keys: KeyAction[], options: RenderOptions): Promise<void> {
		const tiles = this.prepareTiles(keys);
		if (tiles.length === 0) return;

		const useMulti = options.multiTileLayout && tiles.length > 1;
		const blink = options.blink === true && Math.floor(Date.now() / 500) % 2 === 0;
		const arcColor = this.computeArcColor(fraction, options.accentColor);

		if (useMulti) {
			const layout = this.buildLayout(tiles);
			const content = [
				this.buildTickMarks(layout),
				this.buildDualRing(layout, arcColor, fraction),
				this.buildCountdownDigits(remainingSeconds, layout, arcColor),
			].join("");
			await this.renderTiles(tiles, layout, content, options, blink);
		} else {
			await Promise.all(tiles.map(async (tile) => {
				const layout = this.buildLayout([tile]);
				const content = [
					this.buildTickMarks(layout),
					this.buildDualRing(layout, arcColor, fraction),
					this.buildCountdownDigits(remainingSeconds, layout, arcColor),
				].join("");
				await this.renderTiles([tile], layout, content, options, blink);
			}));
		}
	}

	async renderMessage(message: string, keys: KeyAction[], options: RenderOptions): Promise<void> {
		const tiles = this.prepareTiles(keys);
		if (tiles.length === 0) return;

		const useMulti = tiles.length > 1;
		const blink = options.blink === true && Math.floor(Date.now() / 500) % 2 === 0;
		const textColor = options.textColor ?? "#e7f0ff";

		if (useMulti) {
			const layout = this.buildLayout(tiles);
			const content = [
				this.buildDecoRing(layout, textColor),
				this.buildTickMarks(layout),
				this.buildMessageText(message, layout, textColor),
			].join("");
			await this.renderTiles(tiles, layout, content, options, blink);
		} else {
			await Promise.all(tiles.map(async (tile) => {
				const layout = this.buildLayout([tile]);
				const content = [
					this.buildDecoRing(layout, textColor),
					this.buildTickMarks(layout),
					this.buildMessageText(message, layout, textColor),
				].join("");
				await this.renderTiles([tile], layout, content, options, blink);
			}));
		}
	}

	// ── Core tile rendering ──────────────────────────────────────────────

	private async renderTiles(
		tiles: Tile[], layout: Layout, content: string, options: RenderOptions, blink = false,
	): Promise<void> {
		const parts = [
			this.buildDefs(),
			this.buildBackground(layout, blink),
			content,
		];

		if (options.subtitle) {
			parts.push(this.buildSubtitle(options.subtitle, layout, options.subtitleColor ?? "rgba(255,255,255,0.3)"));
		}
		if (options.borderColor) {
			parts.push(this.buildBorder(layout, options.borderColor));
		}

		const full = parts.join("");
		const s = this.ts;

		await Promise.all(tiles.map(async (tile) => {
			const vx = (tile.col - layout.minCol) * s;
			const vy = (tile.row - layout.minRow) * s;
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${s} ${s}" width="144" height="144">${full}</svg>`;
			await tile.action.setImage(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
		}));
	}

	// ── Defs ─────────────────────────────────────────────────────────────

	private buildDefs(): string {
		return `<defs><radialGradient id="bg" cx="50%" cy="50%" r="70%"><stop offset="0%" stop-color="#0a0e18"/><stop offset="100%" stop-color="#030508"/></radialGradient><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
	}

	// ── Background ───────────────────────────────────────────────────────

	private buildBackground(layout: Layout, blink: boolean): string {
		let bg = `<rect width="${layout.widthPx}" height="${layout.heightPx}" fill="url(#bg)"/>`;
		if (blink) {
			bg += `<rect width="${layout.widthPx}" height="${layout.heightPx}" fill="rgba(255,40,40,0.08)"/>`;
		}
		return bg;
	}

	// ── 60 tick marks with amber cardinal markers ────────────────────────

	private buildTickMarks(layout: Layout): string {
		const cx = layout.widthPx / 2;
		const cy = layout.heightPx / 2;
		const outerR = Math.min(layout.widthPx, layout.heightPx) / 2 - this.ts * 0.03;
		const marks: string[] = [];

		for (let i = 0; i < 60; i++) {
			const angle = i * 6;
			const isMajor = i % 5 === 0;
			const isCardinal = i === 0 || i === 15 || i === 30 || i === 45;

			const len = isMajor ? this.ts * 0.055 : this.ts * 0.025;
			const w = isMajor ? 2 : 1;
			const color = isCardinal ? AMBER : isMajor ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)";

			marks.push(`<line x1="${this.n(cx)}" y1="${this.n(cy - outerR)}" x2="${this.n(cx)}" y2="${this.n(cy - outerR + len)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" transform="rotate(${angle} ${this.n(cx)} ${this.n(cy)})"/>`);
		}
		return marks.join("");
	}

	// ── Dual-color progress ring (green remaining + amber elapsed) ───────

	private buildDualRing(layout: Layout, accentColor: string, fraction: number): string {
		const cx = layout.widthPx / 2;
		const cy = layout.heightPx / 2;
		const r = Math.min(layout.widthPx, layout.heightPx) / 2 - this.ts * 0.10;
		const circ = 2 * Math.PI * r;
		const sw = Math.max(7, this.ts * 0.065);
		const glowSw = sw * 3.5;
		const f = Math.max(0, Math.min(1, fraction));

		const greenLen = f * circ;
		const amberLen = (1 - f) * circ;
		const [gr, gg, gb] = hexToRgb(accentColor);
		const [ar, ag, ab] = hexToRgb(AMBER);

		const parts: string[] = [];

		// Track (dim full circle)
		parts.push(`<circle cx="${this.n(cx)}" cy="${this.n(cy)}" r="${this.n(r)}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="${sw}"/>`);

		// Amber glow (elapsed)
		if (amberLen > 1) {
			const rot = -90 + f * 360;
			parts.push(`<circle cx="${this.n(cx)}" cy="${this.n(cy)}" r="${this.n(r)}" fill="none" stroke="rgba(${ar},${ag},${ab},0.12)" stroke-width="${this.n(glowSw)}" stroke-dasharray="${this.n(amberLen)} ${this.n(circ)}" transform="rotate(${this.n(rot)} ${this.n(cx)} ${this.n(cy)})"/>`);
		}

		// Amber arc (elapsed)
		if (amberLen > 1) {
			const rot = -90 + f * 360;
			parts.push(`<circle cx="${this.n(cx)}" cy="${this.n(cy)}" r="${this.n(r)}" fill="none" stroke="${AMBER}" stroke-width="${sw}" stroke-dasharray="${this.n(amberLen)} ${this.n(circ)}" transform="rotate(${this.n(rot)} ${this.n(cx)} ${this.n(cy)})"/>`);
		}

		// Green glow (remaining)
		if (greenLen > 1) {
			parts.push(`<circle cx="${this.n(cx)}" cy="${this.n(cy)}" r="${this.n(r)}" fill="none" stroke="rgba(${gr},${gg},${gb},0.18)" stroke-width="${this.n(glowSw)}" stroke-dasharray="${this.n(greenLen)} ${this.n(circ)}" transform="rotate(-90 ${this.n(cx)} ${this.n(cy)})"/>`);
		}

		// Green arc (remaining) — drawn last so it's on top
		if (greenLen > 1) {
			parts.push(`<circle cx="${this.n(cx)}" cy="${this.n(cy)}" r="${this.n(r)}" fill="none" stroke="${accentColor}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${this.n(greenLen)} ${this.n(circ)}" transform="rotate(-90 ${this.n(cx)} ${this.n(cy)})"/>`);
		}

		return parts.join("");
	}

	// ── Decorative ring (idle/message state) ─────────────────────────────

	private buildDecoRing(layout: Layout, color: string): string {
		const cx = layout.widthPx / 2;
		const cy = layout.heightPx / 2;
		const r = Math.min(layout.widthPx, layout.heightPx) / 2 - this.ts * 0.10;
		const [cr, cg, cb] = hexToRgb(color);
		return `<circle cx="${this.n(cx)}" cy="${this.n(cy)}" r="${this.n(r)}" fill="none" stroke="rgba(${cr},${cg},${cb},0.10)" stroke-width="1.5"/>`;
	}

	// ── Countdown digits (seven-segment in accent color) ─────────────────

	private buildCountdownDigits(remaining: number, layout: Layout, accentColor: string): string {
		const digits = remaining.toString().split("");
		const baseW = 80, baseH = 140, gap = 20;
		const padding = this.ts * 0.08;

		const contentW = digits.length * baseW + Math.max(0, digits.length - 1) * gap;
		const scale = Math.min(
			(layout.widthPx - padding * 2) / contentW,
			(layout.heightPx - padding * 2) / baseH,
		);

		const dw = baseW * scale, dh = baseH * scale, dg = gap * scale;
		const totalW = digits.length * dw + Math.max(0, digits.length - 1) * dg;
		const startX = (layout.widthPx - totalW) / 2;
		const startY = (layout.heightPx - dh) / 2;

		let segs = "";
		for (const [i, ch] of digits.entries()) {
			const d = Number.parseInt(ch, 10);
			const flags = this.segmentsForDigit(Number.isNaN(d) ? 0 : d);
			segs += this.renderDigit(flags, startX + i * (dw + dg), startY, dw, dh, accentColor);
		}
		return segs;
	}

	// ── Message text ─────────────────────────────────────────────────────

	private buildMessageText(message: string, layout: Layout, color: string): string {
		const safe = this.escapeXml(message);
		if (!safe) return "";

		const isMulti = layout.columns > 1 || layout.rows > 1;
		const padding = isMulti ? Math.max(this.ts * 0.16, layout.widthPx * 0.05) : this.ts * 0.12;
		const maxFontW = (layout.widthPx - padding * 2) / Math.max(3, safe.length * 0.62);
		const maxFontH = layout.heightPx * 0.38;
		const fontSize = Math.min(maxFontW, maxFontH);

		const cx = layout.widthPx / 2;
		const cy = layout.heightPx / 2 + fontSize / 3;

		return `<g filter="url(#glow)"><text x="${this.n(cx)}" y="${this.n(cy)}" fill="${color}" font-family="Segoe UI Semibold,Segoe UI,Arial" font-size="${this.n(fontSize)}" text-anchor="middle" letter-spacing="${this.n(fontSize * 0.04)}" dominant-baseline="middle">${safe}</text></g>`;
	}

	// ── Subtitle ─────────────────────────────────────────────────────────

	private buildSubtitle(text: string, layout: Layout, color: string): string {
		const fontSize = this.ts * 0.10;
		const x = layout.widthPx / 2;
		const y = layout.heightPx - this.ts * 0.10;
		return `<text x="${this.n(x)}" y="${this.n(y)}" fill="${color}" font-family="Segoe UI,Arial" font-size="${this.n(fontSize)}" font-weight="600" text-anchor="middle" letter-spacing="3" opacity="0.85">${this.escapeXml(text.toUpperCase())}</text>`;
	}

	// ── Armed border ─────────────────────────────────────────────────────

	private buildBorder(layout: Layout, color: string): string {
		return `<rect x="3" y="3" width="${layout.widthPx - 6}" height="${layout.heightPx - 6}" fill="none" stroke="${color}" stroke-width="2.5" rx="5"/>`;
	}

	// ── Seven-segment rendering ──────────────────────────────────────────

	private renderDigit(flags: boolean[], x: number, y: number, w: number, h: number, fill: string): string {
		const t = Math.min(w, h) * 0.18;
		const hLen = w - t * 2;
		const vLen = (h - t * 3) / 2;
		const r = t * 0.35;
		const s: string[] = [];

		if (flags[0]) s.push(this.rect(x + t, y, hLen, t, r, fill));
		if (flags[1]) s.push(this.rect(x + t + hLen, y + t, t, vLen, r, fill));
		if (flags[2]) s.push(this.rect(x + t + hLen, y + t * 2 + vLen, t, vLen, r, fill));
		if (flags[3]) s.push(this.rect(x + t, y + t * 2 + vLen * 2, hLen, t, r, fill));
		if (flags[4]) s.push(this.rect(x, y + t * 2 + vLen, t, vLen, r, fill));
		if (flags[5]) s.push(this.rect(x, y + t, t, vLen, r, fill));
		if (flags[6]) s.push(this.rect(x + t, y + t + vLen, hLen, t, r, fill));

		return `<g filter="url(#glow)">${s.join("")}</g>`;
	}

	private rect(x: number, y: number, w: number, h: number, r: number, fill: string): string {
		return `<rect x="${this.n(x)}" y="${this.n(y)}" width="${this.n(w)}" height="${this.n(h)}" rx="${this.n(r)}" ry="${this.n(r)}" fill="${fill}"/>`;
	}

	private segmentsForDigit(d: number): boolean[] {
		const m: Record<number, boolean[]> = {
			0: [true, true, true, true, true, true, false],
			1: [false, true, true, false, false, false, false],
			2: [true, true, false, true, true, false, true],
			3: [true, true, true, true, false, false, true],
			4: [false, true, true, false, false, true, true],
			5: [true, false, true, true, false, true, true],
			6: [true, false, true, true, true, true, true],
			7: [true, true, true, false, false, false, false],
			8: [true, true, true, true, true, true, true],
			9: [true, true, true, true, false, true, true],
		};
		return m[d] ?? m[0]!;
	}

	// ── Layout helpers ───────────────────────────────────────────────────

	private buildLayout(tiles: Tile[]): Layout {
		const minCol = Math.min(...tiles.map((t) => t.col));
		const maxCol = Math.max(...tiles.map((t) => t.col));
		const minRow = Math.min(...tiles.map((t) => t.row));
		const maxRow = Math.max(...tiles.map((t) => t.row));
		const columns = maxCol - minCol + 1;
		const rows = maxRow - minRow + 1;
		return { tileSize: this.ts, minCol, minRow, columns, rows, widthPx: columns * this.ts, heightPx: rows * this.ts };
	}

	private prepareTiles(actions: KeyAction[]): Tile[] {
		const tiles: Tile[] = [];
		for (const a of actions) {
			const c = a.coordinates;
			if (c) tiles.push({ action: a, col: c.column, row: c.row });
		}
		if (tiles.length === 0 && actions.length > 0) {
			tiles.push({ action: actions[0]!, col: 0, row: 0 });
		}
		return tiles;
	}

	// ── Arc color interpolation ──────────────────────────────────────────

	private computeArcColor(fraction: number, accentColor: string): string {
		const f = Math.max(0, Math.min(1, fraction));
		if (f >= 0.5) {
			// accentColor (full) → amber (half)
			return lerpColor(hexToRgb(accentColor), hexToRgb(AMBER), (1 - f) * 2);
		} else {
			// amber (half) → red (zero)
			return lerpColor(hexToRgb(AMBER), hexToRgb(RED), (0.5 - f) * 2);
		}
	}

	// ── Utility ──────────────────────────────────────────────────────────

	private n(v: number): number { return Math.round(v * 10) / 10; }

	private escapeXml(v: string): string {
		return v.replace(/[<>&"]/g, (c) => {
			switch (c) { case "<": return "&lt;"; case ">": return "&gt;"; case "&": return "&amp;"; case '"': return "&quot;"; default: return c; }
		});
	}
}
