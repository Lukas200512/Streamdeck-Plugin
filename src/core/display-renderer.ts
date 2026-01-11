import type { KeyAction } from "@elgato/streamdeck";

type Tile = {
	action: KeyAction;
	col: number;
	row: number;
};

type Layout = {
	tileSize: number;
	minCol: number;
	minRow: number;
	columns: number;
	rows: number;
	widthPx: number;
	heightPx: number;
};

type DisplayStyle = {
	accent: string;
	text: string;
	background: string;
	grid: string;
	progressBg: string;
	progressFg: string;
	blink: boolean;
};

type RenderOptions = {
	accentColor?: string;
	textColor?: string;
	backgroundColor?: string;
	gridColor?: string;
	progressColor?: string;
	progressBackground?: string;
	blink?: boolean;
	multiTileLayout?: boolean;
};

/**
 * Renders multi-key images for numbers and messages by composing a single SVG
 * across all keys and cropping it per key via the viewBox.
 */
export class DisplayRenderer {
	private readonly tileSize = 200;

	async renderCountdown(remaining: number, totalSeconds: number, actions: KeyAction[], options?: RenderOptions): Promise<void> {
		const tiles = this.prepareTiles(actions);
		if (tiles.length === 0) {
			return;
		}

		const useMultiTile = options?.multiTileLayout === true && tiles.length > 1;
		const style = this.buildStyle(remaining, totalSeconds, options);
		const progress = totalSeconds > 0 ? 1 - Math.max(0, Math.min(1, remaining / totalSeconds)) : 1;

		if (useMultiTile) {
			const layout = this.buildLayout(tiles);
			const content = this.buildCountdownGraphic(remaining, layout, style, progress);
			await this.renderAcrossTiles(tiles, layout, content, style);
			return;
		}

		// Render independently per key when not using multi-tile layout.
		await Promise.all(
			tiles.map(async (tile) => {
				const layout = this.buildLayout([tile]);
				const content = this.buildCountdownGraphic(remaining, layout, style, progress);
				await this.renderAcrossTiles([tile], layout, content, style);
			})
		);
	}

	async renderMessage(message: string, actions: KeyAction[], options?: RenderOptions): Promise<void> {
		const tiles = this.prepareTiles(actions);
		if (tiles.length === 0) {
			return;
		}

		// Always render messages on a single virtual canvas; when multiple keys are present,
		// treat the full layout as one surface and slice it for the keys.
		const useMultiTile = tiles.length > 1;
		const style = this.buildStyle(1, 1, options);

		if (useMultiTile) {
			const layout = this.buildLayout(tiles);
			const content = this.buildMessageGraphic(message, layout, style);
			await this.renderAcrossTiles(tiles, layout, content, style);
			return;
		}

		await Promise.all(
			tiles.map(async (tile) => {
				const layout = this.buildLayout([tile]);
				const content = this.buildMessageGraphic(message, layout, style);
				await this.renderAcrossTiles([tile], layout, content, style);
			})
		);
	}

	private async renderAcrossTiles(tiles: Tile[], layout: Layout, content: string, style: DisplayStyle): Promise<void> {
		const defs = this.buildDefs(style);
		const background = this.baseBackground(layout, style);
		const grid = this.gridLines(layout, style);
		const fullGraphic = `${defs}${background}${grid}${content}`;

		await Promise.all(
			tiles.map(async (tile) => {
				const viewX = (tile.col - layout.minCol) * layout.tileSize;
				const viewY = (tile.row - layout.minRow) * layout.tileSize;
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewX} ${viewY} ${layout.tileSize} ${layout.tileSize}" width="200" height="200">${fullGraphic}</svg>`;
				const dataUri = this.toDataUri(svg);
				await tile.action.setImage(dataUri);
			})
		);
	}

	private buildCountdownGraphic(remaining: number, layout: Layout, style: DisplayStyle, progress: number): string {
		const digits = remaining.toString().split("");
		const baseDigitWidth = 80;
		const baseDigitHeight = 140;
		const gap = 20;
		const padding = layout.tileSize * 0.08;

		const contentWidth = digits.length * baseDigitWidth + Math.max(0, digits.length - 1) * gap;
		const contentHeight = baseDigitHeight;
		const scale = Math.min(
			(layout.widthPx - padding * 2) / contentWidth,
			(layout.heightPx - padding * 2) / contentHeight
		);

		const digitWidth = baseDigitWidth * scale;
		const digitHeight = baseDigitHeight * scale;
		const digitGap = gap * scale;
		const totalWidth = digits.length * digitWidth + Math.max(0, digits.length - 1) * digitGap;
		const startX = (layout.widthPx - totalWidth) / 2;
		const startY = (layout.heightPx - digitHeight) / 2;

		let segments = "";
		for (const [index, char] of digits.entries()) {
			const digit = Number.parseInt(char, 10);
			const flags = this.segmentsForDigit(Number.isNaN(digit) ? 0 : digit);
			const x = startX + index * (digitWidth + digitGap);
			segments += this.renderDigit(flags, x, startY, digitWidth, digitHeight, style);
		}

		const progressRing = this.progressSweep(layout, style, progress);
		return `${progressRing}${segments}`;
	}

	private buildMessageGraphic(message: string, layout: Layout, style: DisplayStyle): string {
		const safeMessage = this.escapeXml(message);
		const isMulti = layout.columns > 1 || layout.rows > 1;

		// Extra padding to prevent clipping across multi-key viewBox crops.
		const padding = isMulti ? Math.max(layout.tileSize * 0.16, layout.widthPx * 0.05) : layout.tileSize * 0.12;
		const maxFontByWidth = (layout.widthPx - padding * 2) / Math.max(3, safeMessage.length * 0.62);
		const maxFontByHeight = layout.heightPx * 0.38;
		const fontSize = Math.min(maxFontByWidth, maxFontByHeight);

		// Center text across the full canvas; small global left-safe inset to avoid clipping leading glyphs.
		const leftInset = isMulti ? Math.max(layout.tileSize * 0.08, layout.widthPx * 0.032) : 0;
		const centerX = layout.widthPx / 2 - leftInset;
		const centerY = layout.heightPx / 2 + fontSize / 3;

		if (!safeMessage) {
			return "";
		}

		return `<g filter="url(#digit-glow)">
			<text x="${centerX}" y="${centerY}" fill="${style.text}" font-family="Segoe UI Semibold,Segoe UI,Arial" font-size="${fontSize}" text-anchor="middle" letter-spacing="${fontSize * 0.038}" dominant-baseline="middle">${safeMessage}</text>
		</g>`;
	}

	private renderDigit(flags: boolean[], x: number, y: number, width: number, height: number, style: DisplayStyle): string {
		const thickness = Math.min(width, height) * 0.18;
		const horizontalLength = width - thickness * 2;
		const verticalLength = (height - thickness * 3) / 2;
		const radius = thickness * 0.35;

		const coreSegments = this.segmentSet(flags, x, y, horizontalLength, verticalLength, thickness, radius, style.accent);
		return `<g filter="url(#digit-glow)">${coreSegments}</g>`;
	}

	private segmentSet(
		flags: boolean[],
		x: number,
		y: number,
		horizontalLength: number,
		verticalLength: number,
		thickness: number,
		radius: number,
		fill: string
	): string {
		const segments: Array<string> = [];
		if (flags[0]) segments.push(this.segmentRect(x + thickness, y, horizontalLength, thickness, radius, fill));
		if (flags[1]) segments.push(this.segmentRect(x + thickness + horizontalLength, y + thickness, thickness, verticalLength, radius, fill));
		if (flags[2]) segments.push(this.segmentRect(x + thickness + horizontalLength, y + thickness * 2 + verticalLength, thickness, verticalLength, radius, fill));
		if (flags[3]) segments.push(this.segmentRect(x + thickness, y + thickness * 2 + verticalLength * 2, horizontalLength, thickness, radius, fill));
		if (flags[4]) segments.push(this.segmentRect(x, y + thickness * 2 + verticalLength, thickness, verticalLength, radius, fill));
		if (flags[5]) segments.push(this.segmentRect(x, y + thickness, thickness, verticalLength, radius, fill));
		if (flags[6]) segments.push(this.segmentRect(x + thickness, y + thickness + verticalLength, horizontalLength, thickness, radius, fill));
		return segments.join("");
	}

	private segmentRect(x: number, y: number, width: number, height: number, radius: number, fill: string): string {
		return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}" />`;
	}

	private progressSweep(layout: Layout, style: DisplayStyle, progress: number): string {
		const clamped = Math.max(0, Math.min(1, progress));
		const cx = layout.widthPx / 2;
		const cy = layout.heightPx / 2;
		const radius = Math.min(layout.widthPx, layout.heightPx) / 2 - layout.tileSize * 0.12;
		const circumference = 2 * Math.PI * radius;
		const dashLength = circumference * clamped;
		const strokeWidth = Math.max(8, layout.tileSize * 0.05);

		return `
			<g>
				<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${style.progressBg}" stroke-width="${strokeWidth}" />
				<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${style.progressFg}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${dashLength} ${circumference}" transform="rotate(-90 ${cx} ${cy})" />
			</g>
		`;
	}

	private baseBackground(layout: Layout, style: DisplayStyle): string {
		const vignette = style.blink ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.14)";
		return `<rect x="0" y="0" width="${layout.widthPx}" height="${layout.heightPx}" fill="${style.background}" />
		<rect x="0" y="0" width="${layout.widthPx}" height="${layout.heightPx}" fill="${vignette}" />`;
	}

	private gridLines(layout: Layout, style: DisplayStyle): string {
		const parts: string[] = [];
		for (let c = 1; c < layout.columns; c += 1) {
			const x = c * layout.tileSize;
			parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${layout.heightPx}" stroke="${style.grid}" stroke-width="4" />`);
		}
		for (let r = 1; r < layout.rows; r += 1) {
			const y = r * layout.tileSize;
			parts.push(`<line x1="0" y1="${y}" x2="${layout.widthPx}" y2="${y}" stroke="${style.grid}" stroke-width="4" />`);
		}
		return parts.join("");
	}

	private buildStyle(remaining: number, total: number, options?: RenderOptions): DisplayStyle {
		const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
		const accent = options?.accentColor ?? this.colorForRatio(ratio);
		const background = options?.backgroundColor ?? "#050910";
		const text = options?.textColor ?? "#e7f0ff";

		const blink = options?.blink ?? false;
		const grid = options?.gridColor ?? (blink ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.12)");

		return {
			accent,
			text,
			background,
			grid,
			progressBg: options?.progressBackground ?? "rgba(255,255,255,0.12)",
			progressFg: options?.progressColor ?? this.colorForRatio(ratio),
			blink
		};
	}

	private buildDefs(style: DisplayStyle): string {
		return `<defs>
			<filter id="digit-glow" x="-30%" y="-30%" width="160%" height="160%">
				<feGaussianBlur stdDeviation="6" result="blur" />
				<feMerge>
					<feMergeNode in="blur" />
					<feMergeNode in="SourceGraphic" />
				</feMerge>
			</filter>
		</defs>`;
	}

	private buildLayout(tiles: Tile[]): Layout {
		const minCol = Math.min(...tiles.map((tile) => tile.col));
		const maxCol = Math.max(...tiles.map((tile) => tile.col));
		const minRow = Math.min(...tiles.map((tile) => tile.row));
		const maxRow = Math.max(...tiles.map((tile) => tile.row));

		const columns = maxCol - minCol + 1;
		const rows = maxRow - minRow + 1;
		const widthPx = columns * this.tileSize;
		const heightPx = rows * this.tileSize;

		return { tileSize: this.tileSize, minCol, minRow, columns, rows, widthPx, heightPx };
	}

	private prepareTiles(actions: KeyAction[]): Tile[] {
		const tiles: Tile[] = [];
		for (const action of actions) {
			const coords = action.coordinates;
			if (!coords) continue;
			tiles.push({ action, col: coords.column, row: coords.row });
		}

		if (tiles.length === 0 && actions.length > 0) {
			// Fallback: no coordinates available (e.g. multi-action), still render onto the first action.
			tiles.push({ action: actions[0] as KeyAction, col: 0, row: 0 });
		}

		return tiles;
	}

	private segmentsForDigit(digit: number): boolean[] {
		// a, b, c, d, e, f, g
		const mapping: Record<number, boolean[]> = {
			0: [true, true, true, true, true, true, false],
			1: [false, true, true, false, false, false, false],
			2: [true, true, false, true, true, false, true],
			3: [true, true, true, true, false, false, true],
			4: [false, true, true, false, false, true, true],
			5: [true, false, true, true, false, true, true],
			6: [true, false, true, true, true, true, true],
			7: [true, true, true, false, false, false, false],
			8: [true, true, true, true, true, true, true],
			9: [true, true, true, true, false, true, true]
		};

		return mapping[digit] ?? mapping[0];
	}

	private colorForRatio(ratio: number): string {
		if (ratio > 0.66) {
			return "#00d37f"; // green
		}
		if (ratio > 0.33) {
			return "#ffb02e"; // amber
		}
		return "#ff3b30"; // red
	}

	private escapeXml(value: string): string {
		return value.replace(/[<>&"]/g, (char) => {
			switch (char) {
				case "<":
					return "&lt;";
				case ">":
					return "&gt;";
				case "&":
					return "&amp;";
				case '"':
					return "&quot;";
				default:
					return char;
			}
		});
	}

	private toDataUri(svg: string): string {
		return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
	}
}
