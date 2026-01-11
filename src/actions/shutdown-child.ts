import { action, SingletonAction } from "@elgato/streamdeck";
import type { KeyDownEvent, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";

import type { ShutdownSettings } from "../core/shutdown-controller";
import { shutdownController } from "../core/shutdown-controller";

@action({ UUID: "com.lukas.shutdown.child" })
export class ShutdownChildAction extends SingletonAction<ShutdownSettings> {
	override async onWillAppear(ev: WillAppearEvent<ShutdownSettings>): Promise<void> {
		shutdownController.register(ev, "child");
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ShutdownSettings>): Promise<void> {
		shutdownController.handleSettings(ev, "child");
	}

	override async onWillDisappear(ev: WillDisappearEvent<ShutdownSettings>): Promise<void> {
		shutdownController.unregister(ev, "child");
	}

	override async onKeyDown(ev: KeyDownEvent<ShutdownSettings>): Promise<void> {
		await shutdownController.handleKeyDown(ev, "child");
	}
}
