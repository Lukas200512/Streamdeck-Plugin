import streamDeck from "@elgato/streamdeck";
import type {
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
	DidReceiveSettingsEvent
} from "@elgato/streamdeck";

import { CountdownTimer } from "./countdown-timer";
import { DisplayRenderer } from "./display-renderer";
import { SystemPower } from "./system-commands";

export type ShutdownSettings = {
	countdownSeconds?: number;
	accentColor?: string;
	multiTileLayout?: boolean;
	armed?: boolean;
	powerAction?: "shutdown" | "restart" | "sleep";
};

export type Role = "master" | "child";

type NormalizedSettings = Required<ShutdownSettings>;

const DEFAULTS: NormalizedSettings = {
	countdownSeconds: 10,
	accentColor: "#00d37f",
	multiTileLayout: true,
	armed: false,
	powerAction: "shutdown"
};

type ActionState = "idle" | "arming" | "armed" | "running" | "cancelled";

type ActionContext = {
	id: string;
	action: KeyAction;
	role: Role;
	deviceId: string;
};

/**
 * Centralizes shared state (settings, timer, rendering) across master/child actions.
 */
export class ShutdownController {
	private readonly renderer = new DisplayRenderer();
	private timer = new CountdownTimer(DEFAULTS.countdownSeconds);
	private readonly power = new SystemPower((message, error) => this.log(message, error));
	private readonly activeKeys = new Map<string, ActionContext>();

	private state: ActionState = "idle";
	private blinkToggle = false;

	private sharedSettings: NormalizedSettings = DEFAULTS;
	private masterContext: string | null = null;

	register(ev: WillAppearEvent<ShutdownSettings>, role: Role): NormalizedSettings {
		const keyAction = this.getKeyAction(ev.action);
		if (!keyAction) return this.sharedSettings;

		const settings = this.normalizeSettings(ev.payload.settings);
		this.trackKey(keyAction, role);

		if (role === "master") {
			this.setMaster(keyAction.id, settings);
		} else {
			// Child just consumes current shared settings.
			void keyAction.setSettings(this.sharedSettings);
		}

		void this.renderByState();
		return this.sharedSettings;
	}

	unregister(ev: WillDisappearEvent<ShutdownSettings>, role: Role): void {
		const keyAction = this.getKeyAction(ev.action);
		if (!keyAction) return;

		this.untrackKey(keyAction);

		if (this.totalKeyCount() === 0 && this.state === "running") {
			void this.timer.cancel(async () => {
				await this.power.abortScheduled();
			});
			this.state = "idle";
			void this.renderMessageAcrossDevices("Cancelled", this.sharedSettings);
			void this.clearTitlesAcrossDevices();
		}

		if (role === "master" && this.masterContext === keyAction.id) {
			this.masterContext = null;
		}
	}

	handleSettings(ev: DidReceiveSettingsEvent<ShutdownSettings>, role: Role): void {
		const keyAction = this.getKeyAction(ev.action);
		if (!keyAction) return;

		const settings = this.normalizeSettings(ev.payload.settings);
		if (role === "master") {
			this.setMaster(keyAction.id, settings);
		} else {
			// child uses shared settings; ignore its own values
			void keyAction.setSettings(this.sharedSettings);
		}

		void this.renderByState();
	}

	async handleKeyDown(ev: KeyDownEvent<ShutdownSettings>, role: Role): Promise<void> {
		const keyAction = this.getKeyAction(ev.action);
		if (!keyAction) return;

		if (role === "master") {
			const settings = this.normalizeSettings(ev.payload.settings);
			this.setMaster(keyAction.id, settings);
		}

		if (this.state === "running") {
			await this.cancelCountdown();
			return;
		}

		// Armed toggle controls whether power actions execute. No double-arm flow.
		this.power.setArmed(this.sharedSettings.armed);
		await this.startCountdown();
	}

	private async startCountdown(): Promise<void> {
		if (this.totalKeyCount() === 0) {
			this.log("No keys available to render the countdown.");
			return;
		}

		if (this.state !== "running") {
			this.timer = new CountdownTimer(this.sharedSettings.countdownSeconds);
		}

		// Armed setting controls live power actions.
		this.power.setArmed(this.sharedSettings.armed);

		const started = this.timer.start(
			async (remaining) => {
				await this.renderCountdownAcrossDevices(remaining, this.sharedSettings);
				await this.clearTitlesAcrossDevices();
			},
			async () => {
				await this.renderCountdownAcrossDevices(0, this.sharedSettings);
				await this.clearTitlesAcrossDevices();
				await this.power.perform(this.sharedSettings.powerAction);
				this.state = "idle";
				this.power.setArmed(false);
			}
		);

		if (started) {
			this.state = "running";
		}
	}

	private async cancelCountdown(): Promise<void> {
		const cancelled = await this.timer.cancel(async () => {
			await this.power.abortScheduled();
		});

		if (cancelled) {
			this.state = "cancelled";
			this.power.setArmed(false);
			await this.renderMessageAcrossDevices("Cancelled", this.sharedSettings, true);
			await this.clearTitlesAcrossDevices();
			this.state = "idle";
			await this.renderMessageAcrossDevices("Shutdown", this.sharedSettings);
			await this.clearTitlesAcrossDevices();
		}
	}

	private getKeysPerDevice(): KeyAction[][] {
		const buckets = new Map<string, KeyAction[]>();
		for (const ctx of this.activeKeys.values()) {
			const arr = buckets.get(ctx.deviceId) ?? [];
			arr.push(ctx.action);
			buckets.set(ctx.deviceId, arr);
		}
		return Array.from(buckets.values());
	}

	private trackKey(action: KeyAction, role: Role): void {
		const deviceId = action.device?.id ?? "unknown-device";
		this.activeKeys.set(action.id, { id: action.id, action, role, deviceId });
	}

	private untrackKey(action: KeyAction): void {
		this.activeKeys.delete(action.id);
	}

	private totalKeyCount(): number {
		return this.activeKeys.size;
	}

	private async renderCountdownAcrossDevices(remaining: number, settings: NormalizedSettings): Promise<void> {
		const total = this.timer.getDurationSeconds();
		this.blinkToggle = !this.blinkToggle;

		await Promise.all(
			this.getKeysPerDevice().map(async (keys) => {
				await this.renderer.renderCountdown(remaining, total, keys, {
					accentColor: settings.accentColor,
					blink: remaining <= 3 ? this.blinkToggle : false,
					multiTileLayout: settings.multiTileLayout || keys.length > 1
				});
			})
		);
	}

	private async renderMessageAcrossDevices(message: string, settings: NormalizedSettings, blink = false): Promise<void> {
		await Promise.all(
			this.getKeysPerDevice().map(async (keys) => {
				await this.renderer.renderMessage(message, keys, {
					accentColor: settings.accentColor,
					progressColor: settings.accentColor,
					blink,
					multiTileLayout: settings.multiTileLayout || keys.length > 1
				});
			})
		);
	}

	private async clearTitlesAcrossDevices(): Promise<void> {
		await Promise.all(
			this.getKeysPerDevice().flatMap((keys) => keys.map((key) => key.setTitle("")))
		);
	}

	private async renderByState(): Promise<void> {
		if (this.state === "running") {
			await this.renderCountdownAcrossDevices(this.timer.getRemainingSeconds(), this.sharedSettings);
			await this.clearTitlesAcrossDevices();
			return;
		}

		const armed = this.sharedSettings.armed;
		const message = armed ? "Live mode - press to start" : "Preview mode - press to start";
		await this.renderMessageAcrossDevices(message, this.sharedSettings);
		await this.clearTitlesAcrossDevices();
	}

	private normalizeSettings(settings?: ShutdownSettings): NormalizedSettings {
		const accent = this.normalizeColor(settings?.accentColor ?? DEFAULTS.accentColor);
		const seconds = this.clampSeconds(settings?.countdownSeconds ?? DEFAULTS.countdownSeconds);
		return {
			accentColor: accent,
			countdownSeconds: seconds,
			multiTileLayout: settings?.multiTileLayout !== undefined ? !!settings.multiTileLayout : DEFAULTS.multiTileLayout,
			armed: settings?.armed !== undefined ? !!settings.armed : DEFAULTS.armed,
			powerAction: this.normalizePowerAction(settings?.powerAction)
		};
	}

	private normalizePowerAction(action?: string): NormalizedSettings["powerAction"] {
		if (action === "restart" || action === "sleep" || action === "shutdown") {
			return action;
		}
		return DEFAULTS.powerAction;
	}

	private setMaster(contextId: string, settings: NormalizedSettings): void {
		this.masterContext = contextId;
		this.sharedSettings = settings;
		void this.persistMasterSettings(contextId, settings);
		void this.propagateSettings();
	}

	private async persistMasterSettings(contextId: string, settings: NormalizedSettings): Promise<void> {
		const ctx = this.activeKeys.get(contextId);
		if (ctx) {
			await ctx.action.setSettings(settings);
		}
	}

	private async propagateSettings(): Promise<void> {
		const childPayload = this.sharedSettings;
		await Promise.all(
			Array.from(this.activeKeys.values())
				.filter((ctx) => ctx.role === "child")
				.map((ctx) => ctx.action.setSettings(childPayload))
		);
	}

	private clampSeconds(seconds: number): number {
		const safe = Number.isFinite(seconds) ? seconds : DEFAULTS.countdownSeconds;
		return Math.min(30, Math.max(5, Math.round(safe)));
	}

	private normalizeColor(color: string): string {
		if (!color) return DEFAULTS.accentColor;
		const hex = color.startsWith("#") ? color.slice(1) : color;
		const isValid = /^[0-9a-fA-F]{6}$/.test(hex);
		return isValid ? `#${hex}`.toLowerCase() : DEFAULTS.accentColor;
	}

	private getKeyAction(action: unknown): KeyAction | null {
		if (!action || typeof action !== "object") {
			return null;
		}

		const candidate = action as KeyAction & { setImage?: unknown };
		return typeof candidate.setImage === "function" ? (candidate as KeyAction) : null;
	}

	private log(message: string, error?: unknown): void {
		if (error instanceof Error) {
			streamDeck.logger.warn(message, { error: error.message, stack: error.stack });
			return;
		}

		streamDeck.logger.info(message);
	}
}

export const shutdownController = new ShutdownController();
