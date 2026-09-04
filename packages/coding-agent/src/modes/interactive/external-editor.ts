import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import spawn from "cross-spawn";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

/**
 * Split an editor setting into executable and argv without invoking a shell.
 * Backslashes remain literal so Windows paths survive, while single/double
 * quotes and escaped whitespace allow paths and arguments containing spaces.
 */
function parseEditorCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let tokenStarted = false;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (quote) {
			if (character === quote) {
				quote = undefined;
				tokenStarted = true;
				continue;
			}
			if (character === "\\" && quote === '"' && (command[index + 1] === '"' || command[index + 1] === "\\")) {
				current += command[index + 1];
				index += 1;
				continue;
			}
			current += character;
			tokenStarted = true;
			continue;
		}

		if (character === "'" || character === '"') {
			quote = character;
			tokenStarted = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}
		if (character === "\\" && /[\s'"\\]/.test(command[index + 1] ?? "")) {
			current += command[index + 1];
			index += 1;
			tokenStarted = true;
			continue;
		}
		current += character;
		tokenStarted = true;
	}

	if (quote) throw new Error("External editor command contains an unterminated quote");
	if (tokenStarted) args.push(current);
	if (args.length === 0 || !args[0]) throw new Error("External editor command must not be empty");
	return args;
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		let parsedCommand: string[];
		try {
			parsedCommand = parseEditorCommand(options.command);
		} catch {
			return { status: "failed" };
		}
		const [editor, ...editorArgs] = parsedCommand;
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: false,
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
