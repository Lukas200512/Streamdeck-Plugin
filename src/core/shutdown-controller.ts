import streamDeck from "@elgato/streamdeck";
import type {
	KeyAction,
	KeyDownEvent,
	KeyUpEvent,
	WillAppearEvent,
	WillDisappearEvent,
	DidReceiveSettingsEvent,
} from "@elgato/streamdeck";

import { CountdownTimer } from "./countdown-timer";
import { DisplayRenderer } from "./display-renderer";
import type { RenderOptions } from "./display-renderer";
import { SystemPower } from "./system-commands";
import {
	DEFAULTS,
	POWER_LABELS,
	clampSeconds,
	normalizeColor,
	normalizePowerAction,
} from "./types";
import type { ShutdownSettings, NormalizedSettings, Role } from "./types";

export type { ShutdownSettings, Role };

// ── Internal types ───────────────────────────────────────────────────────────

type ControllerState = "idle" | "running" | "cancelling" | "completing";

type ActionContext = {
	id: string;
	action: KeyAction;
	role: Role;
	deviceId: string;
};

const LONG_PRESS_MS = 800;
const CANCEL_DISPLAY_MS = 800;
const COMPLETE_FLASH_MS = 800;

// ── Controller ───────────────────────────────────────────────────────────────

/**
 * State machine: idle → running → cancelling / completing → idle
 *
 * Key fix: cancel is synchronous (stops timer + sets state instantly). The
 * visual cancel animation runs in the background so handleKeyDown returns
 * immediately — no more multi-second latency on cancel presses.
 *
 * Tick renders are fire-and-forget with a render guard, keeping the Node.js
 * event loop free to process key events without delay.
 */
export class ShutdownController {
	private readonly renderer = new DisplayRenderer();
	private readonly timer = new CountdownTimer();
	private readonly power: SystemPower;
	private readonly activeKeys = new Map<string, ActionContext>();

	private state: ControllerState = "idle";
	private sharedSettings: NormalizedSettings = { ...DEFAULTS };
	private masterContextId: string | null = null;

	// Latest-value render queue — stores the most recent tick so no frame is silently dropped.
	private rendering = false;
	private pendingTick: { remainingSeconds: number; fraction: number } | null = null;

	// Long-press detection
	private keyDownTime = 0;
	private keyDownState: ControllerState = "idle";

	constructor() {
		this.power = new SystemPower((msg, err) => this.log(msg, err));
	}

	// ── Lifecycle hooks (called by actions) ──────────────────────────────

	register(ev: WillAppearEvent<ShutdownSettings>, role: Role): void {
		const key = this.toKeyAction(ev.action);
		if (!key) return;

		const settings = this.normalize(ev.payload.settings);
		this.trackKey(key, role);

		if (role === "master") {
			this.applyMaster(key.id, settings);
		} else {
			key.setSettings(this.sharedSettings).catch((e) => this.log("setSettings failed", e));
		}

		this.safeAsync(() => this.renderByState());
	}

	unregister(ev: WillDisappearEvent<ShutdownSettings>, role: Role): void {
		const key = this.toKeyAction(ev.action);
		if (!key) return;

		this.activeKeys.delete(key.id);

		if (this.activeKeys.size === 0 && this.state === "running") {
			this.timer.dispose();
			this.power.abortScheduled().catch((e) => this.log("abort failed", e));
			this.state = "idle";
		}

		if (role === "master" && this.masterContextId === key.id) {
			this.masterContextId = null;
		}

		if (this.activeKeys.size > 0) {
			this.safeAsync(() => this.renderByState());
		}
	}

	handleSettings(ev: DidReceiveSettingsEvent<ShutdownSettings>, role: Role): void {
		const key = this.toKeyAction(ev.action);
		if (!key) return;

		if (role === "master") {
			this.applyMaster(key.id, this.normalize(ev.payload.settings));
		} else {
			key.setSettings(this.sharedSettings).catch((e) => this.log("setSettings failed", e));
		}

		this.safeAsync(() => this.renderByState());
	}

	async handleKeyDown(ev: KeyDownEvent<ShutdownSettings>, role: Role): Promise<void> {
		const key = this.toKeyAction(ev.action);
		if (!key) return;

		if (role === "master") {
			this.applyMaster(key.id, this.normalize(ev.payload.settings));
		}

		this.keyDownTime = Date.now();
		this.keyDownState = this.state;

		// Immediate synchronous cancel — stops timer, flips state, returns fast.
		if (this.state === "running" || this.state === "completing") {
			this.timer.cancel();
			this.state = "cancelling";
			this.rendering = false; // unblock so cancel render gets through
			this.pendingTick = null; // discard any queued tick
			this.safeAsync(() => this.runCancelSequence());
		}
	}

	async handleKeyUp(ev: KeyUpEvent<ShutdownSettings>, role: Role): Promise<void> {
		if (this.keyDownState !== "idle" || this.state !== "idle") return;

		const elapsed = Date.now() - this.keyDownTime;

		if (role === "master" && elapsed >= LONG_PRESS_MS) {
			await this.toggleArmed();
		} else {
			await this.startCountdown();
		}
	}

	// ── State transitions ────────────────────────────────────────────────

	private async startCountdown(): Promise<void> {
		if (this.activeKeys.size === 0) {
			this.log("No keys registered — cannot start countdown.");
			return;
		}

		this.power.setArmed(this.sharedSettings.armed);
		// Set state before start() so the immediate first tick isn't dropped by the guard.
		this.state = "running";

		const started = this.timer.start(
			this.sharedSettings.countdownSeconds,
			// Latest-value pattern: store the newest tick and flush when free.
			// Never drops a frame — always renders the most recent data.
			(tick) => {
				if (this.state !== "running") return;
				this.pendingTick = tick;
				if (!this.rendering) this.flushPendingTick();
			},
			async () => {
				await this.completeCountdown();
			},
		);

		if (!started) {
			this.state = "idle";
		}
	}

	private flushPendingTick(): void {
		if (!this.pendingTick || this.state !== "running") return;
		const tick = this.pendingTick;
		this.pendingTick = null;
		this.rendering = true;
		this.renderCountdownTick(tick)
			.catch((e) => this.log("Tick render failed", e))
			.finally(() => {
				this.rendering = false;
				this.flushPendingTick(); // immediately render next pending tick if queued
			});
	}

	private async runCancelSequence(): Promise<void> {
		try {
			await this.power.abortScheduled();
		} catch (e) {
			this.log("abortScheduled failed", e);
		}

		await this.renderMessageToAll("Cancelled", "#ffb02e");
		await this.delay(CANCEL_DISPLAY_MS);

		if (this.state === "cancelling") {
			this.state = "idle";
			await this.renderIdle();
		}
	}

	private async completeCountdown(): Promise<void> {
		// Render "0" explicitly before transitioning so the user sees the
		// countdown reach zero. Clear any queued tick first to avoid a race.
		this.pendingTick = null;
		this.rendering = false;
		await this.renderCountdownTick({ remainingSeconds: 0, fraction: 0 });

		this.state = "completing";
		await this.delay(300); // hold "0" visible briefly before the flash

		if (this.state !== "completing") return;

		const label = POWER_LABELS[this.sharedSettings.powerAction];
		await this.renderMessageToAll(label, "#ff3b30", true);

		await this.delay(COMPLETE_FLASH_MS);

		if (this.state !== "completing") return;

		await this.power.perform(this.sharedSettings.powerAction);
		this.state = "idle";
		await this.renderIdle();
	}

	private async toggleArmed(): Promise<void> {
		this.sharedSettings = { ...this.sharedSettings, armed: !this.sharedSettings.armed };
		this.power.setArmed(this.sharedSettings.armed);
		await this.persistAndPropagate();
		await this.renderIdle();
	}

	// ── Rendering helpers ────────────────────────────────────────────────

	private async renderIdle(): Promise<void> {
		const { armed, powerAction, accentColor, multiTileLayout } = this.sharedSettings;
		const label = POWER_LABELS[powerAction];

		const options: RenderOptions = {
			accentColor,
			multiTileLayout,
			textColor: armed ? "#ff3b30" : "#3fa3ff",
			subtitle: armed ? "ARMED" : "PREVIEW",
			subtitleColor: armed ? "#ff3b30" : undefined,
			borderColor: armed ? "rgba(255,59,48,0.4)" : undefined,
		};

		await Promise.all(
			this.deviceGroups().map((keys) => this.renderer.renderMessage(label, keys, options)),
		);
		await this.clearTitles();
	}

	private async renderCountdownTick(tick: { remainingSeconds: number; fraction: number }): Promise<void> {
		const { accentColor, multiTileLayout, armed } = this.sharedSettings;

		const options: RenderOptions = {
			accentColor,
			multiTileLayout: multiTileLayout || this.activeKeys.size > 1,
			blink: tick.remainingSeconds <= 3,
			subtitle: armed ? "ARMED" : undefined,
			subtitleColor: armed ? "rgba(255,59,48,0.5)" : undefined,
		};

		await Promise.all(
			this.deviceGroups().map((keys) =>
				this.renderer.renderCountdown(tick.remainingSeconds, tick.fraction, keys, options),
			),
		);
	}

	private async renderMessageToAll(text: string, color: string, blink = false): Promise<void> {
		const { accentColor, multiTileLayout } = this.sharedSettings;

		const options: RenderOptions = {
			accentColor,
			multiTileLayout,
			textColor: color,
			blink,
		};

		await Promise.all(
			this.deviceGroups().map((keys) => this.renderer.renderMessage(text, keys, options)),
		);
		await this.clearTitles();
	}

	private async renderByState(): Promise<void> {
		if (this.state === "running") {
			const tick = this.timer.snapshot();
			await this.renderCountdownTick(tick);
			await this.clearTitles(); // clear for newly appeared keys
			return;
		}
		await this.renderIdle();
	}

	// ── Key tracking ─────────────────────────────────────────────────────

	private trackKey(action: KeyAction, role: Role): void {
		const deviceId = action.device?.id ?? "unknown";
		this.activeKeys.set(action.id, { id: action.id, action, role, deviceId });
	}

	private deviceGroups(): KeyAction[][] {
		const buckets = new Map<string, KeyAction[]>();
		for (const ctx of this.activeKeys.values()) {
			let arr = buckets.get(ctx.deviceId);
			if (!arr) {
				arr = [];
				buckets.set(ctx.deviceId, arr);
			}
			arr.push(ctx.action);
		}
		return Array.from(buckets.values());
	}

	private async clearTitles(): Promise<void> {
		await Promise.all(
			this.deviceGroups().flatMap((keys) => keys.map((k) => k.setTitle(""))),
		);
	}

	// ── Settings management ──────────────────────────────────────────────

	private applyMaster(contextId: string, settings: NormalizedSettings): void {
		this.masterContextId = contextId;
		this.sharedSettings = settings;
		this.safeAsync(() => this.persistAndPropagate());
	}

	private async persistAndPropagate(): Promise<void> {
		if (this.masterContextId) {
			const master = this.activeKeys.get(this.masterContextId);
			if (master) {
				await master.action.setSettings(this.sharedSettings);
			}
		}
		await Promise.all(
			Array.from(this.activeKeys.values())
				.filter((ctx) => ctx.role === "child")
				.map((ctx) => ctx.action.setSettings(this.sharedSettings)),
		);
	}

	private normalize(raw?: ShutdownSettings): NormalizedSettings {
		return {
			countdownSeconds: clampSeconds(raw?.countdownSeconds ?? DEFAULTS.countdownSeconds),
			accentColor: normalizeColor(raw?.accentColor ?? DEFAULTS.accentColor),
			multiTileLayout: raw?.multiTileLayout !== undefined ? !!raw.multiTileLayout : DEFAULTS.multiTileLayout,
			armed: raw?.armed !== undefined ? !!raw.armed : DEFAULTS.armed,
			powerAction: normalizePowerAction(raw?.powerAction),
		};
	}

	// ── Utilities ────────────────────────────────────────────────────────

	private toKeyAction(action: unknown): KeyAction | null {
		if (!action || typeof action !== "object") return null;
		const candidate = action as KeyAction & { setImage?: unknown };
		return typeof candidate.setImage === "function" ? (candidate as KeyAction) : null;
	}

	private safeAsync(fn: () => Promise<void>): void {
		fn().catch((e) => this.log("Async operation failed", e));
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private log(message: string, error?: unknown): void {
		if (error instanceof Error) {
			streamDeck.logger.warn(message, { error: error.message, stack: error.stack });
		} else {
			streamDeck.logger.info(message);
		}
	}
}

export const shutdownController = new ShutdownController();
