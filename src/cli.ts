#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findConfigFile, loadConfig } from "./config";
import { sync } from "./sync";

const HELP = `env-sync — Declarative env var management

Resolves secrets from 1Password and pushes them to local files,
Vercel environments, or GitHub secrets. All driven by env-sync.yaml.

Usage:
  env-sync                       Sync all targets
  env-sync <target> [target...]  Sync specific targets
  env-sync --dry-run             Preview without making changes
  env-sync --list                List all targets from config

Options:
  -c, --config <path>  Path to config file (default: search upward for env-sync.yaml)
  -n, --dry-run        Preview what would happen without making changes
  -l, --list           List configured targets and groups
  -h, --help           Show this help
  -v, --version        Show version

Examples:
  env-sync                       # Sync everything
  env-sync local                 # Only the "local" target
  env-sync preview production    # Multiple specific targets
  env-sync --dry-run vercel-prod # Preview vercel production sync
`;

interface CliOptions {
	configPath?: string;
	targets: string[];
	dryRun: boolean;
	list: boolean;
}

function parseArgs(args: string[]): CliOptions {
	const opts: CliOptions = {
		targets: [],
		dryRun: false,
		list: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "-c":
			case "--config":
				opts.configPath = args[++i];
				break;
			case "-n":
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "-l":
			case "--list":
				opts.list = true;
				break;
			case "-h":
			case "--help":
				console.log(HELP);
				process.exit(0);
				break;
			case "-v":
			case "--version": {
				const pkgPath = resolve(import.meta.dirname ?? ".", "..", "package.json");
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				console.log(`env-sync v${pkg.version}`);
				process.exit(0);
				break;
			}
			default:
				if (arg.startsWith("-")) {
					console.error(`Unknown option: ${arg}\nRun 'env-sync --help' for usage.`);
					process.exit(1);
				}
				opts.targets.push(arg);
		}
	}

	return opts;
}

function listConfig(config: ReturnType<typeof loadConfig>["config"]): void {
	console.log("Groups:");
	for (const [name, group] of Object.entries(config.groups)) {
		const varCount = Object.keys(group).length;
		console.log(`  ${name} — ${varCount} vars`);
		for (const key of Object.keys(group)) {
			console.log(`    ${key}`);
		}
	}

	console.log("\nTargets:");
	for (const [name, target] of Object.entries(config.targets)) {
		const groups = target.groups.join(", ");
		switch (target.type) {
			case "file":
				console.log(`  ${name} (file → ${target.path}) — groups: [${groups}]`);
				break;
			case "vercel":
				console.log(`  ${name} (vercel → ${target.environments.join(", ")}) — groups: [${groups}]`);
				break;
			case "github":
				console.log(`  ${name} (github → ${target.secretType ?? "actions"}) — groups: [${groups}]`);
				break;
		}
	}
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));

	// Find and load config
	const configPath = opts.configPath ? resolve(opts.configPath) : findConfigFile();

	console.log(`Config: ${configPath}`);

	const { config, configDir } = loadConfig(configPath);

	if (opts.list) {
		listConfig(config);
		return;
	}

	// Check prerequisites
	await checkPrerequisites(config, opts.targets);

	// Sync
	const label = opts.dryRun ? " (dry run)" : "";
	const targetLabel = opts.targets.length > 0 ? opts.targets.join(", ") : "all targets";
	console.log(`Syncing ${targetLabel}${label}...`);

	const results = await sync(config, {
		targets: opts.targets.length > 0 ? opts.targets : undefined,
		dryRun: opts.dryRun,
		configDir,
	});

	// Summary
	console.log("\n─── Summary ───");
	let hasErrors = false;
	for (const r of results) {
		const status = r.errors.length > 0 ? "⚠" : "✓";
		if (r.errors.length > 0) hasErrors = true;
		console.log(`  ${status} ${r.target}: ${r.vars} vars (${r.type})`);
	}

	if (hasErrors) {
		process.exit(1);
	}
}

async function checkPrerequisites(
	config: ReturnType<typeof loadConfig>["config"],
	targetFilter: string[],
): Promise<void> {
	const targets =
		targetFilter.length > 0
			? targetFilter.map((t) => config.targets[t]).filter(Boolean)
			: Object.values(config.targets);

	const needsOp = targets.some(() => {
		for (const group of Object.values(config.groups)) {
			for (const val of Object.values(group)) {
				if (val.startsWith("op://")) return true;
			}
		}
		return false;
	});

	const needsGh = targets.some((t) => t.type === "github");

	// The Vercel target talks to the REST API directly and validates its own
	// auth, so only the 1Password and GitHub CLIs are checked here.
	if (needsOp)
		await assertCommand("op", "1Password CLI (https://developer.1password.com/docs/cli)");
	if (needsGh) await assertCommand("gh", "GitHub CLI (https://cli.github.com)");

	// Check 1Password session
	if (needsOp) {
		const proc = Bun.spawn(["op", "account", "list"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			console.error("✗ Not signed in to 1Password. Run: op signin");
			process.exit(1);
		}
	}
}

async function assertCommand(cmd: string, description: string): Promise<void> {
	const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error(`✗ ${cmd} not found. Install: ${description}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
