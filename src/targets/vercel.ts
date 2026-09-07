import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ResolvedVar, SyncResult, VercelTarget } from "../types";

// ── Why we don't use the Vercel CLI at all ──────────────────────────────────
// Vercel CLI 51.x has an "agent mode" that activates when invoked from a
// non-TTY subprocess (which env-sync always is). In that mode
// `vercel env add NAME preview --value V --yes` returns a structured JSON
// hint on stdout —
//   { "status": "action_required", "reason": "git_branch_required", ... }
// — but the process **exits 0**. So env-sync's previous exit-code check
// happily logged ✓ for every var while nothing actually persisted on
// Vercel. Confirmed via `vercel env ls` on a project where prod had been
// populated weeks earlier and a fresh `env-sync preview` reported 21/21
// success but added 0/21 vars.
//
// Every operation (backup, write, redeploy) therefore goes through the REST
// API. The CLI is only used indirectly: `vercel login` populates the auth
// store we read the token from and `vercel link` writes .vercel/project.json.

interface VercelEnvVar {
	id: string;
	key: string;
	target: string[];
	gitBranch?: string;
	value?: string;
	type?: string;
}

interface VercelDeployment {
	uid: string;
	name: string;
	url: string;
}

function getVercelAuthToken(): string {
	const fromEnv = process.env.VERCEL_TOKEN;
	if (fromEnv) return fromEnv;

	// Standard locations per OS — same paths the Vercel CLI uses to
	// store the token after `vercel login`.
	const home = homedir();
	const candidates = [
		// macOS
		`${home}/Library/Application Support/com.vercel.cli/auth.json`,
		// Linux (XDG default)
		`${home}/.local/share/com.vercel.cli/auth.json`,
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
		"Vercel token not found. Set VERCEL_TOKEN, or run `vercel login` so the token is available in the CLI auth store.",
	);
}

function getProjectInfo(
	configDir: string,
	override?: string,
): { projectId: string; teamId: string } {
	const path = resolve(configDir, ".vercel/project.json");
	if (!existsSync(path)) {
		throw new Error(`.vercel/project.json not found at ${configDir}. Run \`vercel link\` first.`);
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

interface VercelClient {
	projectId: string;
	teamId: string;
	token: string;
}

async function vercelApi(
	client: VercelClient,
	method: string,
	endpoint: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const url = `https://api.vercel.com${endpoint}${endpoint.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(client.teamId)}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${client.token}`,
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

async function listExistingEnvVars(client: VercelClient): Promise<VercelEnvVar[]> {
	// decrypt=true returns readable values so the same listing serves both
	// the backup and conflict detection. Sensitive variables come back
	// without a value regardless.
	const res = await vercelApi(client, "GET", `/v9/projects/${client.projectId}/env?decrypt=true`);
	if (!res.ok) {
		throw new Error(`Failed to list env vars: ${res.status} ${JSON.stringify(res.body)}`);
	}
	const body = res.body as { envs?: VercelEnvVar[] };
	return body.envs ?? [];
}

async function deleteEnvVar(client: VercelClient, envId: string): Promise<void> {
	const res = await vercelApi(client, "DELETE", `/v9/projects/${client.projectId}/env/${envId}`);
	if (!res.ok) {
		throw new Error(`Delete env var ${envId} failed: ${res.status} ${JSON.stringify(res.body)}`);
	}
}

type VercelEnvType = "sensitive" | "encrypted";

/**
 * A value that came from a 1Password reference is a secret by definition, so
 * it is stored as a Vercel "sensitive" variable: the value can never be read
 * back through the dashboard, CLI or API. Literal values in env-sync.yaml
 * (URLs, feature flags) stay "encrypted", Vercel's default readable type,
 * so they remain inspectable and diffable.
 */
export function vercelEnvType(v: ResolvedVar): VercelEnvType {
	return v.source.startsWith("op://") ? "sensitive" : "encrypted";
}

async function createEnvVar(
	client: VercelClient,
	payload: { key: string; value: string; target: string[]; type: VercelEnvType },
): Promise<void> {
	const res = await vercelApi(client, "POST", `/v10/projects/${client.projectId}/env`, {
		key: payload.key,
		value: payload.value,
		target: payload.target,
		type: payload.type,
	});
	if (!res.ok) {
		throw new Error(
			`Create env var ${payload.key} failed: ${res.status} ${JSON.stringify(res.body)}`,
		);
	}
	// The endpoint accepts batches, so per-variable errors arrive inside a
	// 201 response rather than as a non-2xx status.
	const { failed } = res.body as { failed?: { error: { code?: string; message?: string } }[] };
	if (failed && failed.length > 0) {
		const reason = failed[0].error.message ?? failed[0].error.code ?? JSON.stringify(failed[0]);
		throw new Error(`Create env var ${payload.key} failed: ${reason}`);
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

	let client: VercelClient;
	try {
		const token = getVercelAuthToken();
		const info = getProjectInfo(configDir, target.project);
		client = { token, projectId: info.projectId, teamId: info.teamId };
	} catch (err) {
		errors.push(`  ✗ Vercel API setup: ${err instanceof Error ? err.message : err}`);
		return { target: name, type: "vercel", vars: vars.length, errors };
	}

	// One round-trip to find existing entries that match key+target so we
	// can delete-then-create (the Vercel API rejects POST when an exact
	// (key, target) overlap already exists).
	let existing: VercelEnvVar[];
	try {
		existing = await listExistingEnvVars(client);
	} catch (err) {
		errors.push(`  ✗ List env failed: ${err instanceof Error ? err.message : err}`);
		return { target: name, type: "vercel", vars: vars.length, errors };
	}

	// Back up current env vars before overwriting.
	for (const env of target.environments) {
		backupVercelEnv(env, existing, configDir);
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
					await deleteEnvVar(client, conflict.id);
					// Update local cache so the next loop iteration doesn't
					// see it again (relevant when the same key is being
					// pushed across multiple environments).
					existing = existing.filter((e) => e.id !== conflict.id);
				}
				await createEnvVar(client, {
					key: v.key,
					value: v.value,
					target: [env],
					type: vercelEnvType(v),
				});
				console.log(`  ✓ ${v.key} [${env}]`);
			} catch (err) {
				errors.push(`  ✗ ${v.key} [${env}]: ${err instanceof Error ? err.message : err}`);
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

	if (target.redeploy && errors.length === 0) {
		for (const env of target.environments) {
			await redeployVercel(client, env, errors);
		}
	}

	return { target: name, type: "vercel", vars: vars.length, errors };
}

/**
 * Redeploy the latest ready deployment of an environment, the same way
 * `vercel redeploy` does: POST /v13/deployments with the source deployment id
 * and `meta.action = "redeploy"`. Preview deployments have no `target`.
 */
async function redeployVercel(client: VercelClient, env: string, errors: string[]): Promise<void> {
	if (env === "development") {
		console.log("  Skipping redeploy [development]: environment has no deployments");
		return;
	}

	console.log(`  Triggering redeploy [${env}]...`);

	try {
		const query = new URLSearchParams({
			projectId: client.projectId,
			target: env,
			state: "READY",
			limit: "1",
		});
		const listRes = await vercelApi(client, "GET", `/v6/deployments?${query}`);
		if (!listRes.ok) {
			errors.push(
				`  ✗ Could not list deployments [${env}]: ${listRes.status} ${JSON.stringify(listRes.body)}`,
			);
			return;
		}

		const { deployments } = listRes.body as { deployments?: VercelDeployment[] };
		const latest = deployments?.[0];
		if (!latest) {
			errors.push(`  ✗ No deployments found for [${env}]`);
			return;
		}

		const redeployRes = await vercelApi(client, "POST", "/v13/deployments?forceNew=1", {
			deploymentId: latest.uid,
			name: latest.name,
			target: env === "production" ? "production" : undefined,
			meta: { action: "redeploy" },
		});
		if (!redeployRes.ok) {
			errors.push(
				`  ✗ Redeploy failed [${env}]: ${redeployRes.status} ${JSON.stringify(redeployRes.body)}`,
			);
			return;
		}

		const created = redeployRes.body as { url?: string };
		console.log(`  ✓ Redeploy triggered [${env}]${created.url ? ` → https://${created.url}` : ""}`);
	} catch (err) {
		errors.push(`  ✗ Redeploy failed [${env}]: ${err instanceof Error ? err.message : err}`);
	}
}

/** Same line format as `vercel env pull` (KEY="value", newlines escaped) */
function escapeEnvValue(value: string): string {
	return value.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/**
 * Write a `.env`-style snapshot of the environment's current variables.
 * Sensitive variables are write-only on Vercel, so only their key and type
 * are recorded; the file is a record of what was there, not a restore point
 * for secrets.
 */
function backupVercelEnv(env: string, existing: VercelEnvVar[], configDir: string): void {
	const backupDir = resolve(configDir, ".env-sync-backups");
	if (!existsSync(backupDir)) {
		mkdirSync(backupDir, { recursive: true });
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
	const backupFile = resolve(backupDir, `vercel-${env}.${timestamp}.env`);

	const entries = existing
		.filter((e) => e.target.includes(env) && !e.gitBranch)
		.sort((a, b) => a.key.localeCompare(b.key));

	const lines = [`# Created by env-sync — Vercel [${env}] backup`];
	for (const e of entries) {
		if (e.value === undefined || e.type === "sensitive") {
			lines.push(`# ${e.key} (${e.type ?? "unknown"}: value not readable via API)`);
		} else {
			lines.push(`${e.key}="${escapeEnvValue(e.value)}"`);
		}
	}

	try {
		writeFileSync(backupFile, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
		console.log(`  Backed up Vercel [${env}] → .env-sync-backups/vercel-${env}.${timestamp}.env`);
	} catch (err) {
		console.warn(
			`  ⚠ Could not back up Vercel [${env}]: ${err instanceof Error ? err.message : err}`,
		);
	}
}
