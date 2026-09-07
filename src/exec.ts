import { spawn } from "node:child_process";

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	input?: string;
	cwd?: string;
}

/**
 * Run a subprocess to completion, collecting stdout/stderr as UTF-8.
 * Rejects if the executable itself cannot be found.
 */
export async function exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts?.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") {
				reject(new Error(`Command not found: ${cmd}`));
			} else {
				reject(err);
			}
		});

		child.on("close", (code) => {
			resolvePromise({ exitCode: code ?? 0, stdout, stderr });
		});

		if (opts?.input !== undefined) {
			child.stdin.write(opts.input);
		}
		child.stdin.end();
	});
}
