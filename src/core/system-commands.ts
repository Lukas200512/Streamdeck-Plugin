import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PowerAction } from "./types";

const execFileAsync = promisify(execFile);

type LogFn = (message: string, error?: unknown) => void;

/**
 * Cross-platform power commands (Windows + macOS).
 *
 * All commands are guarded by an armed flag — when disarmed, calls are logged
 * but nothing is executed.
 */
export class SystemPower {
	private readonly log: LogFn;
	private armed = false;

	constructor(log: LogFn) {
		this.log = log;
	}

	setArmed(value: boolean): void {
		this.armed = value;
		this.log(value ? "Power ARMED — live mode" : "Power disarmed — preview mode");
	}

	isArmed(): boolean {
		return this.armed;
	}

	async perform(action: PowerAction): Promise<void> {
		if (!this.armed) {
			this.log(`${action} skipped — not armed`);
			return;
		}

		const platform = process.platform;
		if (platform === "win32") {
			await this.performWindows(action);
		} else if (platform === "darwin") {
			await this.performMac(action);
		} else {
			this.log(`${action} skipped — unsupported platform: ${platform}`);
		}
	}

	async abortScheduled(): Promise<void> {
		if (!this.armed) return;

		if (process.platform === "win32") {
			await this.run("shutdown", ["/a"], "abort scheduled shutdown");
		}
		// macOS doesn't queue shutdowns in our usage pattern.
	}

	// ── Windows ──────────────────────────────────────────────────────────

	private async performWindows(action: PowerAction): Promise<void> {
		switch (action) {
			case "shutdown":
				await this.run("shutdown", ["/s", "/t", "0"], "shutdown");
				break;
			case "restart":
				await this.run("shutdown", ["/r", "/t", "0"], "restart");
				break;
			case "sleep":
				await this.run("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], "sleep");
				break;
			case "hibernate":
				await this.run("shutdown", ["/h"], "hibernate");
				break;
			case "logoff":
				await this.run("shutdown", ["/l"], "log off");
				break;
		}
	}

	// ── macOS ────────────────────────────────────────────────────────────

	private async performMac(action: PowerAction): Promise<void> {
		switch (action) {
			case "shutdown":
				await this.run("osascript", ["-e", 'tell application "System Events" to shut down'], "shutdown");
				break;
			case "restart":
				await this.run("osascript", ["-e", 'tell application "System Events" to restart'], "restart");
				break;
			case "sleep":
				await this.run("pmset", ["sleepnow"], "sleep");
				break;
			case "hibernate":
				await this.run("pmset", ["sleepnow"], "hibernate (via sleep)");
				break;
			case "logoff":
				await this.run("osascript", ["-e", 'tell application "System Events" to log out'], "log off");
				break;
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private async run(command: string, args: string[], label: string): Promise<void> {
		try {
			await execFileAsync(command, args);
			this.log(`${label} — executed`);
		} catch (error) {
			this.log(`${label} — failed`, error);
		}
	}
}
