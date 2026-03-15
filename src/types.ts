// ── Config file schema (env-sync.yaml) ────────────────────────────────────────

/**
 * A group is a flat map of VAR_NAME → value.
 * Values are either plain strings or `op://vault/item/field` references.
 */
export type VarGroup = Record<string, string>;

/** A target defines where to push resolved env vars */
export interface FileTarget {
	type: "file";
	/** Output file path (relative to config file) */
	path: string;
	/** Which variable groups to include */
	groups: string[];
	/** Whether to backup existing file before overwriting (default: true) */
	backup?: boolean;
}

export interface VercelTarget {
	type: "vercel";
	/** Vercel environment(s): "preview", "production", or "development" */
	environments: string[];
	/** Which variable groups to include */
	groups: string[];
	/** Vercel project name (optional — uses linked project if omitted) */
	project?: string;
	/** Trigger a redeploy after pushing env vars (default: false) */
	redeploy?: boolean;
}

export interface GitHubTarget {
	type: "github";
	/** Secret type: "actions" (repository secrets) or "dependabot" */
	secretType?: "actions" | "dependabot";
	/** Which variable groups to include */
	groups: string[];
	/** GitHub repo (optional — uses current repo if omitted) */
	repo?: string;
	/** GitHub environment name (optional — uses repository secrets if omitted) */
	environment?: string;
}

export type Target = FileTarget | VercelTarget | GitHubTarget;

export interface Config {
	/** Named variable groups — each is a flat KEY: value map */
	groups: Record<string, VarGroup>;
	/** Named targets */
	targets: Record<string, Target>;
}

// ── Runtime types ─────────────────────────────────────────────────────────────

export interface ResolvedVar {
	key: string;
	value: string;
	/** Original value before resolution (e.g. the op:// reference) */
	source: string;
}

export interface SyncResult {
	target: string;
	type: Target["type"];
	vars: number;
	errors: string[];
}
