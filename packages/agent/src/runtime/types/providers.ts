import type { ProcessId, ToolAttemptId, TurnId } from "@earendil-works/pi-protocol";
import { SandboxUnsupportedError } from "./errors.ts";
import type { ProcessOutcome } from "./state-machines.ts";

export interface WorkspaceFSProvider {
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: Uint8Array): Promise<void>;
	editFile(path: string, edits: readonly { oldText: string; newText: string }[]): Promise<void>;
	deleteFile(path: string): Promise<void>;
	renameFile(fromPath: string, toPath: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

export interface NetworkProvider {
	canAccess(host: string, port?: number): Promise<boolean>;
	fetch(url: string, init?: unknown): Promise<unknown>;
}

export type { ProcessOutcome } from "./state-machines.ts";

export interface ProcessSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly pty?: boolean;
	readonly timeoutMs?: number;
	readonly limits?: {
		readonly maxOutputBytes?: number;
	};
}

export interface ProcessHandle {
	readonly processId: ProcessId;
	read(options?: { afterSeq?: number; maxBytes?: number; waitMs?: number }): Promise<any>;
	write(data: Uint8Array): Promise<void>;
	resize(cols: number, rows: number): Promise<void>;
	interrupt(): Promise<void>;
	terminate(): Promise<ProcessOutcome>;
	wait(): Promise<ProcessOutcome>;
}

export interface ProcessSupervisor {
	spawn(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle>;
	get(processId: ProcessId): ProcessHandle | undefined;
	list(): readonly ProcessId[];
	read(processId: ProcessId, options?: { afterSeq?: number; maxBytes?: number; waitMs?: number }): Promise<any>;
	write(processId: ProcessId, data: Uint8Array): Promise<void>;
	resize(processId: ProcessId, cols: number, rows: number): Promise<void>;
	interrupt(processId: ProcessId): Promise<void>;
	terminate(processId: ProcessId): Promise<ProcessOutcome>;
}

export interface SandboxPolicy {
	readonly allowWorkspaceOnly: boolean;
	readonly allowNetwork: boolean;
	readonly allowedHosts?: readonly string[];
	readonly resourceLimits?: {
		readonly maxMemoryBytes?: number;
		readonly maxProcesses?: number;
		readonly timeoutMs?: number;
	};
}

export interface SandboxProvider {
	readonly platform: "windows" | "linux" | "macos" | "unsupported";
	readonly isSupported: boolean;
	evaluate(policy: SandboxPolicy): Promise<boolean>;
	wrapCommand(
		command: string,
		args: readonly string[],
		policy: SandboxPolicy,
	): Promise<{ command: string; args: string[] }>;
}

export class DefaultDenySandboxProvider implements SandboxProvider {
	readonly platform = "unsupported";
	readonly isSupported = false;

	async evaluate(_policy: SandboxPolicy): Promise<boolean> {
		throw new SandboxUnsupportedError("Platform sandbox enforcement is unsupported on this platform; failing closed");
	}

	async wrapCommand(
		_command: string,
		_args: readonly string[],
		_policy: SandboxPolicy,
	): Promise<{ command: string; args: string[] }> {
		throw new SandboxUnsupportedError("Cannot wrap command: sandbox is unsupported on this platform; failing closed");
	}
}

export interface ApprovalRequest {
	readonly requestId: string;
	readonly turnId: TurnId;
	readonly toolAttemptId: ToolAttemptId;
	readonly toolName: string;
	readonly fingerprint: string;
	readonly description: string;
	readonly expiresAt: number;
}

export interface ApprovalManager {
	requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<"approved" | "rejected" | "expired">;
	resolve(requestId: string, decision: "approved" | "rejected"): boolean;
	cancel(requestId: string, reason?: string): boolean;
}
