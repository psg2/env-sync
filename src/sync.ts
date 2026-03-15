import { collectVars, resolveSecrets } from "./resolver";
import { syncFile } from "./targets/file";
import { syncGitHub } from "./targets/github";
import { syncVercel } from "./targets/vercel";
import type { Config, SyncResult, Target } from "./types";

export interface SyncOptions {
	/** Only sync these targets (undefined = all) */
	targets?: string[];
	/** Print what would happen without doing it */
	dryRun?: boolean;
	/** Directory the config file lives in (for resolving relative paths) */
	configDir: string;
}

export async function sync(config: Config, opts: SyncOptions): Promise<SyncResult[]> {
	const targetNames = opts.targets ?? Object.keys(config.targets);
	const results: SyncResult[] = [];

	// Validate requested targets exist
	for (const name of targetNames) {
		if (!(name in config.targets)) {
			const available = Object.keys(config.targets).join(", ");
			throw new Error(`Unknown target '${name}'. Available: ${available}`);
		}
	}

	for (const name of targetNames) {
		const target = config.targets[name];
		console.log(`\n→ ${name} (${describeTarget(target)})`);

		// 1. Collect vars from referenced groups
		const vars = collectVars(config, target.groups);
		if (vars.length === 0) {
			console.log("  No variables to sync");
			results.push({ target: name, type: target.type, vars: 0, errors: [] });
			continue;
		}

		// 2. Resolve secrets (op:// → actual values)
		const { resolved, errors: resolveErrors } = await resolveSecrets(vars, {
			dryRun: opts.dryRun,
		});

		if (resolveErrors.length > 0) {
			console.error(`  ⚠ ${resolveErrors.length} resolution error(s):`);
			for (const e of resolveErrors) console.error(`    ${e}`);
		}

		// 3. Push to target
		const result = await dispatch(name, target, resolved, opts);
		result.errors.push(...resolveErrors);
		results.push(result);
	}

	return results;
}

async function dispatch(
	name: string,
	target: Target,
	vars: { key: string; value: string; source: string }[],
	opts: SyncOptions,
): Promise<SyncResult> {
	switch (target.type) {
		case "file":
			return syncFile(name, target, vars, opts.configDir, opts);
		case "vercel":
			return syncVercel(name, target, vars, opts.configDir, opts);
		case "github":
			return syncGitHub(name, target, vars, opts.configDir, opts);
		default:
			throw new Error(`Unknown target type: ${(target as Target).type}`);
	}
}

function describeTarget(target: Target): string {
	switch (target.type) {
		case "file":
			return `file → ${target.path}`;
		case "vercel":
			return `vercel → ${target.environments.join(", ")}`;
		case "github":
			return `github → ${target.secretType ?? "actions"}${target.environment ? `/${target.environment}` : ""}`;
	}
}
