import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findConfigFile, loadConfig } from "./config";

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

	test("rejects an explicit null secretType instead of defaulting it", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  ci:
    X: "1"

targets:
  gh:
    type: github
    secretType: null
    groups: [ci]
`,
		);

		expect(() => loadConfig(path)).toThrow("invalid secretType 'null'");
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

	test("rejects an empty file", () => {
		setup();
		const path = writeYaml("env-sync.yaml", "");
		expect(() => loadConfig(path)).toThrow("empty or not an object");
		teardown();
	});

	test("rejects a config missing the targets section", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  dev:
    X: "1"
`,
		);
		expect(() => loadConfig(path)).toThrow("missing or invalid 'targets'");
		teardown();
	});

	test("rejects a target missing 'type'", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  dev:
    X: "1"

targets:
  local:
    groups: [dev]
`,
		);
		expect(() => loadConfig(path)).toThrow("missing 'type'");
		teardown();
	});

	test("rejects a target with an unknown type", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  dev:
    X: "1"

targets:
  local:
    type: s3
    groups: [dev]
`,
		);
		expect(() => loadConfig(path)).toThrow("unknown type 's3'");
		teardown();
	});

	test("rejects a target whose 'groups' is not an array", () => {
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
    groups: dev
`,
		);
		expect(() => loadConfig(path)).toThrow("missing 'groups' array");
		teardown();
	});

	test("rejects a file target missing 'path'", () => {
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
    groups: [dev]
`,
		);
		expect(() => loadConfig(path)).toThrow("missing 'path'");
		teardown();
	});

	test("rejects a vercel target with an empty 'environments' array", () => {
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
    environments: []
    groups: [prod]
`,
		);
		expect(() => loadConfig(path)).toThrow("missing 'environments' array");
		teardown();
	});

	test("rejects a github target with an invalid secretType", () => {
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
    secretType: codespaces
    groups: [ci]
`,
		);
		expect(() => loadConfig(path)).toThrow("invalid secretType 'codespaces'");
		teardown();
	});

	test("defaults a github target's secretType to 'actions' when omitted", () => {
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
    groups: [ci]
`,
		);
		const { config } = loadConfig(path);
		const target = config.targets["gh-secrets"];
		expect(target.type).toBe("github");
		if (target.type === "github") {
			expect(target.secretType).toBe("actions");
		}
		teardown();
	});

	test("honors an explicit backup: false on a file target", () => {
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
    groups: [dev]
    backup: false
`,
		);
		const { config } = loadConfig(path);
		const target = config.targets.local;
		expect(target.type).toBe("file");
		if (target.type === "file") {
			expect(target.backup).toBe(false);
		}
		teardown();
	});

	test("stringifies non-string scalar values", () => {
		setup();
		const path = writeYaml(
			"env-sync.yaml",
			`
groups:
  dev:
    PORT: 3000
    DEBUG: true

targets:
  local:
    type: file
    path: .env
    groups: [dev]
`,
		);
		const { config } = loadConfig(path);
		expect(config.groups.dev.PORT).toBe("3000");
		expect(config.groups.dev.DEBUG).toBe("true");
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

	test("also finds the .yml spelling", () => {
		setup();
		writeYaml("env-sync.yml", "groups: {}\ntargets: {}");
		const found = findConfigFile(TMP);
		expect(found).toBe(join(TMP, "env-sync.yml"));
		teardown();
	});

	test("searches upward from a nested directory", () => {
		setup();
		writeYaml("env-sync.yaml", "groups: {}\ntargets: {}");
		const nested = join(TMP, "a", "b");
		mkdirSync(nested, { recursive: true });
		const found = findConfigFile(nested);
		expect(found).toBe(join(TMP, "env-sync.yaml"));
		teardown();
	});
});
