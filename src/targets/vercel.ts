import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedVar, SyncResult, VercelTarget } from "../types";

export async function syncVercel(
	name: string,
	target: VercelTarget,
	vars: ResolvedVar[],
	configDir: string,
	opts: { dryRun?: boolean },
): Promise<SyncResult> {
	const errors: string[] = [];
	const envLabel = target.environments.join(", ");

	if (opts.dryRun) {
		console.log(`  Would back up and push ${vars.length} vars to Vercel [${envLabel}]`);
		return { target: name, type: "vercel", vars: vars.length, errors };
	}

	// Back up current env vars before overwriting
	for (const env of target.environments) {
		await backupVercelEnv(env, target.project, configDir);
	}

	for (const v of vars) {
		for (const env of target.environments) {
			try {
				// Vercel CLI's "agent" / non-interactive mode (51.x+) refuses
				// the legacy stdin+--force form and instead prints a structured
				// `{status: "action_required"}` hint pointing at --value/--yes.
				// Using --value puts the secret on argv (visible to local
				// `ps aux` for the command's lifetime) which is the trade-off
				// Vercel's CLI explicitly recommends. --yes also covers the
				// "extend var to additional environments" prompt that fires
				// when the same key already exists in another env.
				const args = ["env", "add", v.key, env, "--value", v.value, "--yes"];
				if (target.project) args.push("--project", target.project);

				const proc = Bun.spawn(["vercel", ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});

				const stderr = await new Response(proc.stderr).text();
				const exitCode = await proc.exited;

				if (exitCode !== 0) {
					errors.push(`  ✗ ${v.key} [${env}]: ${stderr.trim()}`);
				} else {
					console.log(`  ✓ ${v.key} [${env}]`);
				}
			} catch (err) {
				errors.push(`  ✗ ${v.key} [${env}]: ${err}`);
			}
		}
	}

	if (errors.length > 0) {
		for (const e of errors) console.error(e);
	}

	const succeeded = vars.length * target.environments.length - errors.length;
	console.log(
		`  Done: ${succeeded}/${vars.length * target.environments.length} vars pushed to Vercel [${envLabel}]`,
	);

	// Redeploy if configured and no errors
	if (target.redeploy && errors.length === 0) {
		for (const env of target.environments) {
			await redeployVercel(env, target.project, errors);
		}
	}

	return { target: name, type: "vercel", vars: vars.length, errors };
}

async function redeployVercel(
	env: string,
	project: string | undefined,
	errors: string[],
): Promise<void> {
	console.log(`  Triggering redeploy [${env}]...`);

	// Get the latest deployment for this environment
	const listArgs = ["list", "--environment", env, "--format", "json", "--yes"];
	if (project) listArgs.push("--project", project);

	try {
		const listProc = Bun.spawn(["vercel", ...listArgs], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const listStdout = await new Response(listProc.stdout).text();
		const listExit = await listProc.exited;

		if (listExit !== 0) {
			const stderr = await new Response(listProc.stderr).text();
			errors.push(`  ✗ Could not list deployments [${env}]: ${stderr.trim()}`);
			return;
		}

		// Parse JSON — skip non-JSON lines (Vercel CLI prints status messages before JSON)
		const jsonStart = listStdout.indexOf("{");
		if (jsonStart === -1) {
			errors.push(`  ✗ No deployments found for [${env}]`);
			return;
		}

		const data = JSON.parse(listStdout.slice(jsonStart));
		const deployments = data.deployments as { url: string }[];
		if (!deployments || deployments.length === 0) {
			errors.push(`  ✗ No deployments found for [${env}]`);
			return;
		}

		const latestUrl = deployments[0].url;

		// Redeploy
		const redeployArgs = ["redeploy", latestUrl, "--no-wait", "--yes"];
		if (project) redeployArgs.push("--project", project);

		const redeployProc = Bun.spawn(["vercel", ...redeployArgs], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const redeployStderr = await new Response(redeployProc.stderr).text();
		const redeployExit = await redeployProc.exited;

		if (redeployExit !== 0) {
			errors.push(`  ✗ Redeploy failed [${env}]: ${redeployStderr.trim()}`);
		} else {
			console.log(`  ✓ Redeploy triggered [${env}]`);
		}
	} catch (err) {
		errors.push(`  ✗ Redeploy failed [${env}]: ${err}`);
	}
}

async function backupVercelEnv(
	env: string,
	project: string | undefined,
	configDir: string,
): Promise<void> {
	const backupDir = resolve(configDir, ".env-sync-backups");
	if (!existsSync(backupDir)) {
		mkdirSync(backupDir, { recursive: true });
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
	const backupFile = resolve(backupDir, `vercel-${env}.${timestamp}.env`);

	const args = ["env", "pull", backupFile, "--environment", env, "--yes"];
	if (project) args.push("--project", project);

	try {
		const proc = Bun.spawn(["vercel", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			console.log(`  Backed up Vercel [${env}] → .env-sync-backups/vercel-${env}.${timestamp}.env`);
		} else {
			const stderr = await new Response(proc.stderr).text();
			console.warn(`  ⚠ Could not back up Vercel [${env}]: ${stderr.trim()}`);
		}
	} catch {
		console.warn(`  ⚠ Could not back up Vercel [${env}]`);
	}
}
