export type PowerAction = "shutdown" | "restart" | "sleep" | "hibernate" | "logoff";

export type ShutdownSettings = {
	countdownSeconds?: number;
	accentColor?: string;
	multiTileLayout?: boolean;
	armed?: boolean;
	powerAction?: PowerAction;
};

export type NormalizedSettings = Required<ShutdownSettings>;

export type Role = "master" | "child";

export const DEFAULTS: NormalizedSettings = {
	countdownSeconds: 10,
	accentColor: "#00d37f",
	multiTileLayout: true,
	armed: false,
	powerAction: "shutdown",
};

export const POWER_LABELS: Record<PowerAction, string> = {
	shutdown: "Shutdown",
	restart: "Restart",
	sleep: "Sleep",
	hibernate: "Hibernate",
	logoff: "Log Off",
};

export const MIN_SECONDS = 3;
export const MAX_SECONDS = 60;

export function clampSeconds(seconds: number): number {
	const safe = Number.isFinite(seconds) ? seconds : DEFAULTS.countdownSeconds;
	return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(safe)));
}

export function normalizeColor(color: string): string {
	if (!color) return DEFAULTS.accentColor;
	const hex = color.startsWith("#") ? color.slice(1) : color;
	return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}`.toLowerCase() : DEFAULTS.accentColor;
}

export function normalizePowerAction(action?: string): PowerAction {
	const valid: PowerAction[] = ["shutdown", "restart", "sleep", "hibernate", "logoff"];
	return valid.includes(action as PowerAction) ? (action as PowerAction) : DEFAULTS.powerAction;
}
