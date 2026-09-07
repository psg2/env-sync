import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config, FileTarget, GitHubTarget, Target, VarGroup, VercelTarget } from "./types";

const CONFIG_FILENAMES = ["env-sync.yaml", "env-sync.yml"];

/** Find the config file, searching up from cwd */
export function findConfigFile(startDir?: string): string {
	let dir = startDir ?? process.cwd();
	while (true) {
		for (const name of CONFIG_FILENAMES) {
			const candidate = resolve(dir, name);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`No env-sync.yaml found (searched from ${startDir ?? process.cwd()} upward)`);
}

/** Parse and validate the config file */
export function loadConfig(configPath: string): { config: Config; configDir: string } {
	const raw = readFileSync(configPath, "utf-8");
	const doc = parseYaml(raw);

	if (!doc || typeof doc !== "object") {
		throw new Error(`Invalid config: ${configPath} is empty or not an object`);
	}

	const config = validateConfig(doc, configPath);
	return { config, configDir: dirname(configPath) };
}

function validateConfig(doc: Record<string, unknown>, path: string): Config {
	if (!doc.groups || typeof doc.groups !== "object") {
		throw new Error(`${path}: missing or invalid 'groups' section`);
	}
	if (!doc.targets || typeof doc.targets !== "object") {
		throw new Error(`${path}: missing or invalid 'targets' section`);
	}

	const groups: Record<string, VarGroup> = {};
	for (const [name, raw] of Object.entries(doc.groups as Record<string, unknown>)) {
		groups[name] = validateGroup(name, raw, path);
	}

	const targets: Record<string, Target> = {};
	for (const [name, raw] of Object.entries(doc.targets as Record<string, unknown>)) {
		targets[name] = validateTarget(name, raw, path, groups);
	}

	return { groups, targets };
}

function validateGroup(name: string, raw: unknown, path: string): VarGroup {
	if (!raw || typeof raw !== "object") {
		throw new Error(`${path}: group '${name}' must be an object`);
	}

	const vars: VarGroup = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (v === null || v === undefined) continue; // skip commented-out vars
		vars[k] = String(v);
	}

	return vars;
}

function validateTarget(
	name: string,
	raw: unknown,
	path: string,
	groups: Record<string, VarGroup>,
): Target {
	if (!raw || typeof raw !== "object") {
		throw new Error(`${path}: target '${name}' must be an object`);
	}
	const obj = raw as Record<string, unknown>;

	const type = obj.type as string;
	if (!type) {
		throw new Error(`${path}: target '${name}' missing 'type'`);
	}

	const groupNames = validateGroupRefs(name, obj, path, groups);

	switch (type) {
		case "file":
			return validateFileTarget(name, obj, path, groupNames);
		case "vercel":
			return validateVercelTarget(name, obj, path, groupNames);
		case "github":
			return validateGitHubTarget(name, obj, path, groupNames);
		default:
			throw new Error(`${path}: target '${name}' has unknown type '${type}'`);
	}
}

function validateGroupRefs(
	name: string,
	obj: Record<string, unknown>,
	path: string,
	groups: Record<string, VarGroup>,
): string[] {
	if (!Array.isArray(obj.groups)) {
		throw new Error(`${path}: target '${name}' missing 'groups' array`);
	}
	const refs = obj.groups as string[];
	for (const ref of refs) {
		if (!(ref in groups)) {
			throw new Error(`${path}: target '${name}' references unknown group '${ref}'`);
		}
	}
	return refs;
}

function validateFileTarget(
	name: string,
	obj: Record<string, unknown>,
	path: string,
	groups: string[],
): FileTarget {
	if (!obj.path || typeof obj.path !== "string") {
		throw new Error(`${path}: file target '${name}' missing 'path'`);
	}
	return {
		type: "file",
		path: obj.path,
		groups,
		backup: obj.backup !== false,
	};
}

function validateVercelTarget(
	name: string,
	obj: Record<string, unknown>,
	path: string,
	groups: string[],
): VercelTarget {
	if (!Array.isArray(obj.environments) || obj.environments.length === 0) {
		throw new Error(`${path}: vercel target '${name}' missing 'environments' array`);
	}
	const valid = ["preview", "production", "development"];
	for (const env of obj.environments) {
		if (!valid.includes(env)) {
			throw new Error(
				`${path}: vercel target '${name}' has invalid environment '${env}' (expected: ${valid.join(", ")})`,
			);
		}
	}
	return {
		type: "vercel",
		environments: obj.environments as string[],
		groups,
		project: obj.project ? String(obj.project) : undefined,
		redeploy: obj.redeploy === true,
	};
}

function validateGitHubTarget(
	name: string,
	obj: Record<string, unknown>,
	path: string,
	groups: string[],
): GitHubTarget {
	// Only an omitted key means "default"; an explicit null is a config error.
	const secretType = obj.secretType === undefined ? "actions" : obj.secretType;
	if (secretType !== "actions" && secretType !== "dependabot") {
		throw new Error(`${path}: github target '${name}' has invalid secretType '${secretType}'`);
	}
	return {
		type: "github",
		secretType,
		groups,
		repo: obj.repo ? String(obj.repo) : undefined,
		environment: obj.environment ? String(obj.environment) : undefined,
	};
}
