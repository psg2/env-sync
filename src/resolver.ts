import type { Config, ResolvedVar } from "./types";

/**
 * Collect all variables for a set of groups.
 * Values starting with `op://` are 1Password references.
 * Everything else is a plain value.
 * First group wins on key conflicts.
 */
export function collectVars(config: Config, groupNames: string[]): ResolvedVar[] {
	const vars: ResolvedVar[] = [];
	const seen = new Set<string>();

	for (const name of groupNames) {
		const group = config.groups[name];
		if (!group) continue;

		for (const [key, value] of Object.entries(group)) {
			if (seen.has(key)) continue;
			seen.add(key);
			vars.push({ key, value, source: value });
		}
	}

	return vars;
}

/**
 * Resolve 1Password references in a list of vars.
 * Plain values pass through unchanged.
 */
export async function resolveSecrets(
	vars: ResolvedVar[],
	opts: { dryRun?: boolean },
): Promise<{ resolved: ResolvedVar[]; errors: string[] }> {
	if (opts.dryRun) {
		return {
			resolved: vars.map((v) => ({
				...v,
				value: v.value.startsWith("op://") ? `<secret:${v.key}>` : v.value,
			})),
			errors: [],
		};
	}

	const resolved: ResolvedVar[] = [];
	const errors: string[] = [];

	const opVars = vars.filter((v) => v.value.startsWith("op://"));
	const plainVars = vars.filter((v) => !v.value.startsWith("op://"));

	for (const v of plainVars) {
		resolved.push(v);
	}

	if (opVars.length > 0) {
		const results = await resolveOpReferences(opVars);
		for (const r of results) {
			if (r.error) {
				errors.push(r.error);
			} else {
				resolved.push(r.var);
			}
		}
	}

	return { resolved, errors };
}

interface OpResult {
	var: ResolvedVar;
	error?: string;
}

async function resolveOpReferences(vars: ResolvedVar[]): Promise<OpResult[]> {
	// Use `op inject` for batch resolution (more efficient than individual `op read`)
	const template = vars.map((v) => `${v.key}=${v.value}`).join("\n");

	try {
		const proc = Bun.spawn(["op", "inject"], {
			stdin: new TextEncoder().encode(template),
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			return resolveOpReferencesIndividually(vars, stderr);
		}

		const lines = stdout.trim().split("\n");
		const results: OpResult[] = [];
		const resolvedMap = new Map<string, string>();

		for (const line of lines) {
			const eqIdx = line.indexOf("=");
			if (eqIdx === -1) continue;
			const key = line.substring(0, eqIdx);
			const value = line.substring(eqIdx + 1);
			resolvedMap.set(key, value);
		}

		for (const v of vars) {
			const resolvedValue = resolvedMap.get(v.key);
			if (resolvedValue !== undefined) {
				results.push({ var: { ...v, value: resolvedValue } });
			} else {
				results.push({
					var: v,
					error: `Failed to resolve ${v.key} (${v.value})`,
				});
			}
		}

		return results;
	} catch {
		return resolveOpReferencesIndividually(vars);
	}
}

async function resolveOpReferencesIndividually(
	vars: ResolvedVar[],
	_batchError?: string,
): Promise<OpResult[]> {
	const results: OpResult[] = [];

	for (const v of vars) {
		try {
			const proc = Bun.spawn(["op", "read", v.value], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				results.push({
					var: v,
					error: `Failed to resolve ${v.key} from 1Password: ${stderr.trim()}`,
				});
			} else {
				results.push({
					var: { ...v, value: stdout.trim() },
				});
			}
		} catch (err) {
			results.push({
				var: v,
				error: `Failed to resolve ${v.key}: ${err}`,
			});
		}
	}

	return results;
}
