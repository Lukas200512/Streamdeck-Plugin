/**
 * Data emitted on every tick of the countdown.
 */
export type TickData = {
	/** Whole seconds remaining (ceiling). */
	remainingSeconds: number;
	/** Fraction of total duration remaining (1 = full, 0 = done). */
	fraction: number;
	/** Original duration in seconds. */
	totalSeconds: number;
};

type TickCallback = (data: TickData) => Promise<void> | void;
type CompleteCallback = () => Promise<void> | void;

/** Tick interval in milliseconds — 100ms gives smooth ~10 FPS animation. */
const TICK_MS = 100;

/**
 * Drift-corrected countdown timer.
 *
 * Uses Date.now() as the time reference so the displayed remaining time never
 * drifts away from wall-clock time, regardless of how long each tick callback
 * takes to execute.
 */
export class CountdownTimer {
	private state: "idle" | "running" = "idle";
	private startTime = 0;
	private durationMs = 0;
	private totalSeconds = 0;
	private interval?: NodeJS.Timeout;

	isRunning(): boolean {
		return this.state === "running";
	}

	/** Returns the current countdown snapshot without side-effects. */
	snapshot(): TickData {
		if (this.state !== "running") {
			return { remainingSeconds: 0, fraction: 0, totalSeconds: this.totalSeconds };
		}
		return this.compute();
	}

	/**
	 * Starts the countdown. Returns false if already running.
	 */
	start(seconds: number, onTick: TickCallback, onComplete: CompleteCallback): boolean {
		if (this.state === "running") return false;

		this.totalSeconds = seconds;
		this.durationMs = seconds * 1000;
		this.startTime = Date.now();
		this.state = "running";

		const tick = async (): Promise<void> => {
			if (this.state !== "running") return;

			const data = this.compute();
			await onTick(data);

			if (data.fraction <= 0 && this.state === "running") {
				this.stop();
				await onComplete();
			}
		};

		// Immediate first tick so the display updates instantly on press.
		void tick();
		this.interval = setInterval(() => void tick(), TICK_MS);

		return true;
	}

	/** Cancels the running countdown. Returns false if not running. */
	cancel(): boolean {
		if (this.state !== "running") return false;
		this.stop();
		return true;
	}

	/** Emergency cleanup — call when keys disappear. */
	dispose(): void {
		this.stop();
	}

	private stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		this.state = "idle";
	}

	private compute(): TickData {
		const elapsed = Date.now() - this.startTime;
		const remainingMs = Math.max(0, this.durationMs - elapsed);
		return {
			remainingSeconds: Math.ceil(remainingMs / 1000),
			fraction: this.durationMs > 0 ? remainingMs / this.durationMs : 0,
			totalSeconds: this.totalSeconds,
		};
	}
}
