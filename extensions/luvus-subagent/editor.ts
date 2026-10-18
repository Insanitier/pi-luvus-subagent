/**
 * The child's editor: a pasted task is text, never a paste marker.
 *
 * Installed only in a child, where every bracketed paste is a machine handing over a task.
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The markers a terminal wraps a bracketed paste in. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * An editor that takes a bracketed paste as typed text.
 *
 * Pi condenses a large paste into a marker in the editor, and a task delivered
 * through the child's pane arrives as exactly one bracketed paste — so the marker is
 * what the model ends up seeing. Feeding the paste back through `handleInput` one
 * character at a time leaves the text itself in the editor instead.
 *
 * The technique is raw-paste's (github.com/tmustier/pi-extensions). Unlike it there
 * is no arming command: this is installed only in a child, where every paste is a
 * machine handing over a task and the marker is never wanted. Newlines are fed as
 * `\n`, which is what that extension normalises to for the same reason.
 */
class RawPasteEditor extends CustomEditor {
	private buffering = false;
	private buffer = "";

	handleInput(data: string): void {
		if (this.buffering) {
			this.buffer += data;
			const end = this.buffer.indexOf(PASTE_END);
			if (end === -1) return;
			const pasted = this.buffer.slice(0, end);
			const rest = this.buffer.slice(end + PASTE_END.length);
			this.buffer = "";
			this.buffering = false;
			for (const char of pasted.replace(/\r\n?/g, "\n")) super.handleInput(char);
			if (rest.length > 0) this.handleInput(rest);
			return;
		}
		const start = data.indexOf(PASTE_START);
		if (start === -1) {
			super.handleInput(data);
			return;
		}
		super.handleInput(data.slice(0, start));
		this.buffering = true;
		this.handleInput(data.slice(start + PASTE_START.length));
	}
}

/**
 * Install that editor, in a child only.
 *
 * A human's editor wants the marker — it is how a big paste stays editable — so this
 * is never installed where someone is typing. A child has no UI worth the trade.
 */
export function installRawPaste(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new RawPasteEditor(tui, theme, keybindings));
	});
}

