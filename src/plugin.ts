import streamDeck from "@elgato/streamdeck";

import { ShutdownChildAction } from "./actions/shutdown-child";
import { ShutdownMasterAction } from "./actions/shutdown-master";

// Capture detailed logging during development; tone down to "info" for production.
streamDeck.logger.setLevel("info");

// Register master and child actions.
streamDeck.actions.registerAction(new ShutdownMasterAction());
streamDeck.actions.registerAction(new ShutdownChildAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
