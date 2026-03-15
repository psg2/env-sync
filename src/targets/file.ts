import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FileTarget, ResolvedVar, SyncResult } from "../types";

export async function syncFile(
	name: string,
	target: FileTarget,
	vars: ResolvedVar[],
	configDir: string,
	opts: { dryRun?: boolean },
): Promise<SyncResult> {
	const outPath = resolve(configDir, target.path);
	const errors: string[] = [];

	// Build file content
	const content = `${vars.map((v) => `${v.key}=${v.value}`).join("\n")}\n`;

	if (opts.dryRun) {
		console.log(`  Would write ${vars.length} vars to ${outPath}`);
		return { target: name, type: "file", vars: vars.length, errors };
	}

	// Backup existing file
	if (target.backup !== false && existsSync(outPath)) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
		const backupPath = `${outPath}.bkp.${timestamp}`;
		copyFileSync(outPath, backupPath);
		console.log(`  Backed up ${target.path} → ${target.path}.bkp.${timestamp}`);
	}

	// Ensure directory exists
	const dir = dirname(outPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(outPath, content, "utf-8");
	console.log(`  ✓ Wrote ${vars.length} vars to ${target.path}`);

	return { target: name, type: "file", vars: vars.length, errors };
}
