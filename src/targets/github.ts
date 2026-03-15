import type { GitHubTarget, ResolvedVar, SyncResult } from "../types";

export async function syncGitHub(
	name: string,
	target: GitHubTarget,
	vars: ResolvedVar[],
	_configDir: string,
	opts: { dryRun?: boolean },
): Promise<SyncResult> {
	const errors: string[] = [];
	const label = target.environment
		? `${target.secretType}/${target.environment}`
		: (target.secretType ?? "actions");

	if (opts.dryRun) {
		console.log(`  Would push ${vars.length} secrets to GitHub [${label}]`);
		return { target: name, type: "github", vars: vars.length, errors };
	}

	for (const v of vars) {
		try {
			const args = ["secret", "set", v.key, "--body", v.value];

			if (target.repo) args.push("--repo", target.repo);
			if (target.environment) args.push("--env", target.environment);
			if (target.secretType === "dependabot") args.push("--app", "dependabot");

			const proc = Bun.spawn(["gh", ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				errors.push(`  ✗ ${v.key}: ${stderr.trim()}`);
			} else {
				console.log(`  ✓ ${v.key}`);
			}
		} catch (err) {
			errors.push(`  ✗ ${v.key}: ${err}`);
		}
	}

	if (errors.length > 0) {
		for (const e of errors) console.error(e);
	}

	const succeeded = vars.length - errors.length;
	console.log(`  Done: ${succeeded}/${vars.length} secrets pushed to GitHub [${label}]`);

	return { target: name, type: "github", vars: vars.length, errors };
}
