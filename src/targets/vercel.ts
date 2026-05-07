import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ResolvedVar, SyncResult, VercelTarget } from "../types";

// ── Why we don't use `vercel env add` from the CLI ──────────────────────────
// Vercel CLI 51.x has an "agent mode" that activates when invoked from a
// non-TTY subprocess (which env-sync always is, via Bun.spawn). In that mode
// `vercel env add NAME preview --value V --yes` returns a structured JSON
// hint on stdout —
//   { "status": "action_required", "reason": "git_branch_required", ... }
// — but the process **exits 0**. So env-sync's previous exit-code check
// happily logged ✓ for every var while nothing actually persisted on
// Vercel. Confirmed via `vercel env ls` on a project where prod had been
// populated weeks earlier and a fresh `env-sync preview` reported 21/21
// success but added 0/21 vars.
//
// The CLI form that *should* work per `vercel env add --help` is
// `vercel env add NAME preview --value V --yes` (omit gitbranch → "all
// preview branches"), but agent mode rejects it anyway. Passing an
// explicit gitbranch like `*` errors with `branch_not_found`.
//
// Workaround: skip the CLI for write paths and call Vercel's REST API
// directly. Read paths (`vercel env pull`) work fine in agent mode and
// we keep using the CLI there for backups.

interface VercelEnvVar {
	id: string;
	key: string;
	target: string[];
	gitBranch?: string;
	value?: string;
	type?: string;
}

function getVercelAuthToken(): string {
	// Standard locations per OS — same paths the Vercel CLI uses to
	// store the token after `vercel login`.
	const candidates = [
		// macOS
		`${homedir()}/Library/Application Support/com.vercel.cli/auth.json`,
		// Linux (XDG default)
		`${homedir()}/.local/share/com.vercel.cli/auth.json`,
		// Linux (XDG_CONFIG_HOME)
		process.env.XDG_CONFIG_HOME
			? `${process.env.XDG_CONFIG_HOME}/com.vercel.cli/auth.json`
			: undefined,
		// Windows
		process.env.APPDATA ? `${process.env.APPDATA}/com.vercel.cli/auth.json` : undefined,
	].filter(Boolean) as string[];

	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
			if (raw.token) return raw.token;
		} catch {
			// fall through to next candidate
		}
	}

	throw new Error(
		"Vercel auth token not found in any of the standard CLI store paths. Run `vercel login` first.",
	);
}

function getProjectInfo(configDir: string, override?: string): { projectId: string; teamId: string } {
	const path = resolve(configDir, ".vercel/project.json");
	if (!existsSync(path)) {
		throw new Error(
			`.vercel/project.json not found at ${configDir}. Run \`vercel link\` first.`,
		);
	}
	const data = JSON.parse(readFileSync(path, "utf8")) as {
		projectId: string;
		orgId: string;
		projectName?: string;
	};
	if (override && data.projectName !== override) {
		// Sanity check — env-sync.yaml's `project:` should match if set.
		// We don't fail hard, just log: the user might have intentionally
		// scoped to a different linked project.
		console.warn(
			`  ⚠ Configured project '${override}' differs from .vercel/project.json '${data.projectName}'. Using linked project.`,
		);
	}
	return { projectId: data.projectId, teamId: data.orgId };
}

async function vercelApi(
	method: string,
	endpoint: string,
	teamId: string,
	token: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const url = `https://api.vercel.com${endpoint}${endpoint.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";

	const res = await fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		parsed = text;
	}
	return { ok: res.ok, status: res.status, body: parsed };
}

async function listExistingEnvVars(
	projectId: string,
	teamId: string,
	token: string,
): Promise<VercelEnvVar[]> {
	const res = await vercelApi("GET", `/v9/projects/${projectId}/env`, teamId, token);
	if (!res.ok) {
		throw new Error(`Failed to list env vars: ${res.status} ${JSON.stringify(res.body)}`);
	}
	const body = res.body as { envs?: VercelEnvVar[] };
	return body.envs ?? [];
}

async function deleteEnvVar(
	projectId: string,
	teamId: string,
	token: string,
	envId: string,
): Promise<void> {
	const res = await vercelApi(
		"DELETE",
		`/v9/projects/${projectId}/env/${envId}`,
		teamId,
		token,
	);
	if (!res.ok) {
		throw new Error(`Delete env var ${envId} failed: ${res.status} ${JSON.stringify(res.body)}`);
	}
}

async function createEnvVar(
	projectId: string,
	teamId: string,
	token: string,
	payload: { key: string; value: string; target: string[]; type?: string },
): Promise<void> {
	const res = await vercelApi(
		"POST",
		`/v10/projects/${projectId}/env`,
		teamId,
		token,
		{
			key: payload.key,
			value: payload.value,
			target: payload.target,
			type: payload.type ?? "encrypted",
		},
	);
	if (!res.ok) {
		throw new Error(`Create env var ${payload.key} failed: ${res.status} ${JSON.stringify(res.body)}`);
	}
}

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

	let token: string;
	let projectId: string;
	let teamId: string;
	try {
		token = getVercelAuthToken();
		const info = getProjectInfo(configDir, target.project);
		projectId = info.projectId;
		teamId = info.teamId;
	} catch (err) {
		errors.push(`  ✗ Vercel API setup: ${err instanceof Error ? err.message : err}`);
		return { target: name, type: "vercel", vars: vars.length, errors };
	}

	// Back up current env vars before overwriting. The pull command works
	// fine in agent mode (it's read-only) so we keep the CLI here.
	for (const env of target.environments) {
		await backupVercelEnv(env, target.project, configDir);
	}

	// One round-trip to find existing entries that match key+target so we
	// can delete-then-create (the Vercel API rejects POST when an exact
	// (key, target) overlap already exists).
	let existing: VercelEnvVar[];
	try {
		existing = await listExistingEnvVars(projectId, teamId, token);
	} catch (err) {
		errors.push(`  ✗ List env failed: ${err instanceof Error ? err.message : err}`);
		return { target: name, type: "vercel", vars: vars.length, errors };
	}

	for (const v of vars) {
		for (const env of target.environments) {
			try {
				// An entry "conflicts" if it's the same key AND its target
				// list overlaps with the env we're pushing to AND it's not
				// branch-scoped (gitBranch falsy = "all branches in env").
				// Branch-specific entries don't block all-branches pushes.
				const conflict = existing.find(
					(e) => e.key === v.key && e.target.includes(env) && !e.gitBranch,
				);
				if (conflict) {
					await deleteEnvVar(projectId, teamId, token, conflict.id);
					// Update local cache so the next loop iteration doesn't
					// see it again (relevant when the same key is being
					// pushed across multiple environments).
					existing = existing.filter((e) => e.id !== conflict.id);
				}
				await createEnvVar(projectId, teamId, token, {
					key: v.key,
					value: v.value,
					target: [env],
				});
				console.log(`  ✓ ${v.key} [${env}]`);
			} catch (err) {
				errors.push(
					`  ✗ ${v.key} [${env}]: ${err instanceof Error ? err.message : err}`,
				);
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

	// Redeploy if configured and no errors. CLI is fine here since it's
	// just a list-and-redeploy round-trip; no env writes.
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

	// Quiet the unused-import warning when this codepath is the only
	// consumer of writeFileSync (kept for future debug fallbacks).
	void writeFileSync;
}
