export type CountdownState = "idle" | "running" | "cancelled";

/**
 * Drives a simple second-based countdown without leaking timers.
 */
export class CountdownTimer {
	private readonly durationSeconds: number;
	private state: CountdownState = "idle";
	private remainingSeconds = 0;
	private timeout?: NodeJS.Timeout;

	constructor(durationSeconds: number) {
		this.durationSeconds = durationSeconds;
	}

	getState(): CountdownState {
		return this.state;
	}

	getDurationSeconds(): number {
		return this.durationSeconds;
	}

	getRemainingSeconds(): number {
		return this.remainingSeconds;
	}

	/**
	 * Starts the countdown; returns `false` when a countdown is already running.
	 */
	start(onTick: (remainingSeconds: number) => Promise<void> | void, onComplete: () => Promise<void> | void): boolean {
		if (this.state === "running") {
			return false;
		}

		this.state = "running";
		this.remainingSeconds = this.durationSeconds;
		this.scheduleTick(onTick, onComplete);
		return true;
	}

	/**
	 * Cancels the countdown; resolves `false` if no countdown is running.
	 */
	async cancel(onCancel?: () => Promise<void> | void): Promise<boolean> {
		if (this.state !== "running") {
			return false;
		}

		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}

		this.state = "cancelled";
		this.remainingSeconds = 0;

		if (onCancel) {
			await onCancel();
		}

		this.state = "idle";
		return true;
	}

	/**
	 * Ensures timers are cleaned up when the action disappears.
	 */
	dispose(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
		this.remainingSeconds = 0;
		this.state = "idle";
	}

	private scheduleTick(onTick: (remainingSeconds: number) => Promise<void> | void, onComplete: () => Promise<void> | void): void {
		void this.runTick(onTick, onComplete);
	}

	private async runTick(onTick: (remainingSeconds: number) => Promise<void> | void, onComplete: () => Promise<void> | void): Promise<void> {
		await onTick(this.remainingSeconds);

		if (this.state !== "running") {
			return;
		}

		if (this.remainingSeconds === 0) {
			this.timeout = undefined;
			this.state = "idle";
			await onComplete();
			return;
		}

		this.timeout = setTimeout(() => {
			if (this.state !== "running") {
				return;
			}

			this.remainingSeconds -= 1;
			this.scheduleTick(onTick, onComplete);
		}, 1000);
	}
}
