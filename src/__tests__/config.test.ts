import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findConfigFile, loadConfig } from "../config";

const TMP = join(import.meta.dirname ?? ".", ".tmp-test-config");

function setup() {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
}

function teardown() {
	rmSync(TMP, { recursive: true, force: true });
}

function writeYaml(name: string, content: string): string {
	const path = join(TMP, name);
	writeFileSync(path, content);
	return path;
}

describe("loadConfig", () => {
	test("parses a minimal valid config", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  dev:
    PORT: "3000"
    DB_URL: postgres://localhost/dev

targets:
  local:
    type: file
    path: .env.local
    groups: [dev]
`,
		);

		const { config } = loadConfig(path);

		expect(Object.keys(config.groups)).toEqual(["dev"]);
		expect(config.groups.dev.PORT).toBe("3000");
		expect(config.groups.dev.DB_URL).toBe("postgres://localhost/dev");

		expect(Object.keys(config.targets)).toEqual(["local"]);
		const target = config.targets.local;
		expect(target.type).toBe("file");
		if (target.type === "file") {
			expect(target.path).toBe(".env.local");
			expect(target.groups).toEqual(["dev"]);
			expect(target.backup).toBe(true);
		}

		teardown();
	});

	test("parses groups with op:// references", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  auth:
    SECRET: op://Vault/Item/SECRET
    API_KEY: plain-value

targets:
  local:
    type: file
    path: .env
    groups: [auth]
`,
		);

		const { config } = loadConfig(path);
		expect(config.groups.auth.SECRET).toBe("op://Vault/Item/SECRET");
		expect(config.groups.auth.API_KEY).toBe("plain-value");

		teardown();
	});

	test("parses vercel target", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  prod:
    KEY: value

targets:
  vercel-prod:
    type: vercel
    environments: [production]
    groups: [prod]
    project: my-app
`,
		);

		const { config } = loadConfig(path);
		const target = config.targets["vercel-prod"];
		expect(target.type).toBe("vercel");
		if (target.type === "vercel") {
			expect(target.environments).toEqual(["production"]);
			expect(target.project).toBe("my-app");
		}

		teardown();
	});

	test("parses github target", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  ci:
    TOKEN: secret123

targets:
  gh-secrets:
    type: github
    secretType: actions
    groups: [ci]
    repo: org/my-app
`,
		);

		const { config } = loadConfig(path);
		const target = config.targets["gh-secrets"];
		expect(target.type).toBe("github");
		if (target.type === "github") {
			expect(target.secretType).toBe("actions");
			expect(target.repo).toBe("org/my-app");
		}

		teardown();
	});

	test("rejects missing groups section", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
targets:
  local:
    type: file
    path: .env
    groups: [dev]
`,
		);

		expect(() => loadConfig(path)).toThrow("missing or invalid 'groups'");
		teardown();
	});

	test("rejects target referencing unknown group", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  dev:
    X: "1"

targets:
  local:
    type: file
    path: .env
    groups: [nonexistent]
`,
		);

		expect(() => loadConfig(path)).toThrow("unknown group 'nonexistent'");
		teardown();
	});

	test("rejects invalid vercel environment", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  prod:
    X: "1"

targets:
  v:
    type: vercel
    environments: [staging]
    groups: [prod]
`,
		);

		expect(() => loadConfig(path)).toThrow("invalid environment 'staging'");
		teardown();
	});

	test("skips null var values", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  dev:
    PRESENT: "yes"
    ABSENT: null

targets:
  local:
    type: file
    path: .env
    groups: [dev]
`,
		);

		const { config } = loadConfig(path);
		expect(config.groups.dev.PRESENT).toBe("yes");
		expect("ABSENT" in config.groups.dev).toBe(false);

		teardown();
	});
});

describe("findConfigFile", () => {
	test("finds config in given directory", () => {
		setup();
		writeYaml("env-sync.yaml", "groups: {}\ntargets: {}");
		const found = findConfigFile(TMP);
		expect(found).toBe(join(TMP, "env-sync.yaml"));
		teardown();
	});

	test("throws when not found", () => {
		setup();
		expect(() => findConfigFile(TMP)).toThrow("No env-sync.yaml found");
		teardown();
	});
});
