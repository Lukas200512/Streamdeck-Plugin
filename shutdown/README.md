# ShutDown Stream Deck Plugin

A Stream Deck plugin that shows a multi-key countdown and triggers a system power action (shutdown, restart, or sleep) when it finishes. Works on Windows with the Stream Deck app (SDK 3+, tested with Node.js 20).

## Install
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the plugin bundle:
   ```bash
   npm run build
   ```
3. Copy the folder `com.lukas.shutdown.sdPlugin` into your Stream Deck plugins directory (e.g. `%AppData%\Elgato\StreamDeck\Plugins` on Windows).
4. Restart Stream Deck.

## Usage
- Add one **Shutdown Master** action to a page and configure it in the property inspector:
  - Countdown duration (seconds)
  - Accent color
  - Armed (on = perform system action; off = preview only)
  - Power action: shutdown, restart, or sleep
  - Multi-key layout: renders the countdown and text across multiple keys if you place children around the master
- Add **Shutdown Child** actions on the surrounding keys. Children automatically mirror the master settings.
- Press the master (or any child) to start/cancel the countdown. When armed is on, the selected power action runs at the end.

### Multi-key text behavior
- When multiple keys are assigned, the plugin renders text once on a single virtual canvas spanning all involved keys, centers it, and applies a small left offset so leading glyphs stay visible. Each key shows its slice of that unified render.

## Development
- Build: `npm run build`
- Watch (auto-rebuild + Stream Deck restart): `npm run watch`
