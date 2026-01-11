import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type LogFn = (message: string, error?: unknown) => void;

export type PowerAction = "shutdown" | "restart" | "sleep";

/**
 * Wraps platform-specific power commands.
 */
export class SystemPower {
	private readonly log?: LogFn;
	private armed = false;

	constructor(log?: LogFn) {
		this.log = log;
	}

	setArmed(value: boolean): void {
		this.armed = value;
		this.log?.(value ? "power armed (live mode)" : "power disarmed (preview mode)");
	}

	isArmed(): boolean {
		return this.armed;
	}

	async perform(action: PowerAction): Promise<void> {
		if (!this.armed) {
			this.log?.(`${action} skipped (not armed)`);
			return;
		}

		if (process.platform !== "win32") {
			this.log?.(`${action} skipped (non-Windows)`);
			return;
		}

		switch (action) {
			case "shutdown":
				await this.runCommand("shutdown", ["/s", "/t", "0"], "trigger shutdown");
				break;
			case "restart":
				await this.runCommand("shutdown", ["/r", "/t", "0"], "trigger restart");
				break;
			case "sleep":
				await this.runCommand("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], "trigger sleep");
				break;
			default:
				this.log?.(`unknown power action: ${action}`);
		}
	}

	async abortScheduled(): Promise<void> {
		if (!this.armed) {
			this.log?.("abort skipped (not armed)");
			return;
		}

		if (process.platform !== "win32") {
			this.log?.("abort skipped (non-Windows)");
			return;
		}

		await this.runCommand("shutdown", ["/a"], "abort shutdown");
	}

	private async runCommand(command: string, args: string[], label: string): Promise<void> {
		try {
			await execFileAsync(command, args);
			this.log?.(`${label} executed`);
		} catch (error) {
			this.log?.(`${label} failed`, error);
		}
	}
}
