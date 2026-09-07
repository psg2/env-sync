import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { collectVars, resolveSecrets } from "./resolver";
import type { Config } from "./types";

const TMP = join(import.meta.dirname ?? ".", ".tmp-test-resolver");
const BIN_DIR = join(TMP, "bin");
const OP_PATH = join(BIN_DIR, "op");
const OP_LOG = join(TMP, "op.log");

const originalPath = process.env.PATH;

function makeConfig(groups: Config["groups"]): Config {
	return { groups, targets: {} };
}

/**
 * Installs a real (not mocked) `op` executable on PATH that mimics the two
 * 1Password CLI subcommands env-sync relies on. Every invocation is logged
 * to OP_LOG so tests can assert `op` was (or wasn't) called at all.
 */
function writeFakeOp(): void {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(BIN_DIR, { recursive: true });
	const script = `#!/bin/sh
echo "$@" >> "${OP_LOG}"

resolve_field() {
	ref="$1"
	vault=$(echo "$ref" | awk -F'/' '{print $3}')
	field=$(echo "$ref" | awk -F'/' '{print $NF}')
	if [ "$field" = "EQ" ]; then
		echo "field=with=equals"
	else
		echo "$field-from-$vault"
	fi
}

if [ "$1" = "inject" ]; then
	input=$(cat)
	if echo "$input" | grep -q 'missing'; then
		echo "one or more references could not be resolved" >&2
		exit 1
	fi
	echo "$input" | while IFS= read -r line; do
		key=$(echo "$line" | cut -d'=' -f1)
		ref=$(echo "$line" | cut -d'=' -f2-)
		value=$(resolve_field "$ref")
		echo "$key=$value"
	done
	exit 0
elif [ "$1" = "read" ]; then
	ref="$2"
	if echo "$ref" | grep -q 'missing'; then
		echo "not found" >&2
		exit 1
	fi
	value=$(resolve_field "$ref")
	echo "$value"
	exit 0
fi

echo "unknown op subcommand: $1" >&2
exit 1
`;
	writeFileSync(OP_PATH, script);
	chmodSync(OP_PATH, 0o755);
}

describe("collectVars", () => {
	test("collects plain vars from a single group", () => {
		const config = makeConfig({
			dev: { PORT: "3000", DB: "postgres://localhost" },
		});

		const vars = collectVars(config, ["dev"]);
		expect(vars).toHaveLength(2);
		expect(vars.find((v) => v.key === "PORT")?.value).toBe("3000");
		expect(vars.find((v) => v.key === "DB")?.value).toBe("postgres://localhost");
	});

	test("collects op:// refs as-is", () => {
		const config = makeConfig({
			auth: { SECRET: "op://Vault/Item/SECRET" },
		});

		const vars = collectVars(config, ["auth"]);
		expect(vars[0].value).toBe("op://Vault/Item/SECRET");
		expect(vars[0].source).toBe("op://Vault/Item/SECRET");
	});

	test("merges multiple groups, first wins on conflict", () => {
		const config = makeConfig({
			base: { PORT: "3000", DB: "local" },
			override: { PORT: "8080", API: "https://api.com" },
		});

		// base listed first, so its PORT wins
		const vars = collectVars(config, ["base", "override"]);
		expect(vars.find((v) => v.key === "PORT")?.value).toBe("3000");
		expect(vars.find((v) => v.key === "DB")?.value).toBe("local");
		expect(vars.find((v) => v.key === "API")?.value).toBe("https://api.com");
	});

	test("returns vars ordered by group order then key insertion order, first group wins on a 3-way conflict", () => {
		const config = makeConfig({
			first: { SHARED: "from-first", A: "a" },
			second: { B: "b" },
			third: { SHARED: "from-third", C: "c" },
		});

		const vars = collectVars(config, ["first", "second", "third"]);

		// Order must follow group order, then insertion order within each
		// group — not "last group wins" and not alphabetically sorted.
		expect(vars.map((v) => v.key)).toEqual(["SHARED", "A", "B", "C"]);
		expect(vars.find((v) => v.key === "SHARED")?.value).toBe("from-first");
	});

	test("does not duplicate vars when a group name is listed twice", () => {
		const config = makeConfig({
			dev: { PORT: "3000", DB: "local" },
		});

		const vars = collectVars(config, ["dev", "dev"]);
		expect(vars).toHaveLength(2);
	});

	test("returns empty for unknown group", () => {
		const config = makeConfig({});
		const vars = collectVars(config, ["nonexistent"]);
		expect(vars).toHaveLength(0);
	});
});

describe("resolveSecrets (dry run)", () => {
	test("masks op:// references in dry run", async () => {
		const vars = [
			{ key: "SECRET", value: "op://Vault/Item/SECRET", source: "op://Vault/Item/SECRET" },
			{ key: "PLAIN", value: "hello", source: "hello" },
		];

		const { resolved, errors } = await resolveSecrets(vars, { dryRun: true });
		expect(errors).toHaveLength(0);
		expect(resolved.find((v) => v.key === "SECRET")?.value).toBe("<secret:SECRET>");
		expect(resolved.find((v) => v.key === "PLAIN")?.value).toBe("hello");
	});
});

describe("resolveSecrets against a real op executable", () => {
	beforeEach(() => {
		writeFakeOp();
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		rmSync(TMP, { recursive: true, force: true });
	});

	test("plain values pass through untouched and op:// values are replaced, keeping the original source", async () => {
		process.env.PATH = `${BIN_DIR}${delimiter}${originalPath}`;
		const vars = [
			{ key: "PLAIN", value: "hello", source: "hello" },
			{ key: "SECRET", value: "op://VaultA/item/API_KEY", source: "op://VaultA/item/API_KEY" },
		];

		const { resolved, errors } = await resolveSecrets(vars, { dryRun: false });

		expect(errors).toEqual([]);
		expect(resolved.find((v) => v.key === "PLAIN")).toEqual({
			key: "PLAIN",
			value: "hello",
			source: "hello",
		});
		const secret = resolved.find((v) => v.key === "SECRET");
		expect(secret?.value).toBe("API_KEY-from-VaultA");
		// The Vercel target decides sensitive-vs-encrypted from `source`, so
		// losing the original op:// reference here is a real regression.
		expect(secret?.source).toBe("op://VaultA/item/API_KEY");
	});

	test("keeps a resolved value containing '=' whole instead of truncating at the first sign", async () => {
		process.env.PATH = `${BIN_DIR}${delimiter}${originalPath}`;
		const vars = [{ key: "SECRET", value: "op://VaultA/item/EQ", source: "op://VaultA/item/EQ" }];

		const { resolved, errors } = await resolveSecrets(vars, { dryRun: false });

		expect(errors).toEqual([]);
		expect(resolved[0]?.value).toBe("field=with=equals");
	});

	test("falls back to individual resolution when the batch fails, reporting only the missing key", async () => {
		process.env.PATH = `${BIN_DIR}${delimiter}${originalPath}`;
		const vars = [
			{ key: "GOOD", value: "op://VaultA/item/goodfield", source: "op://VaultA/item/goodfield" },
			{
				key: "BAD",
				value: "op://VaultA/item/missingfield",
				source: "op://VaultA/item/missingfield",
			},
		];

		const { resolved, errors } = await resolveSecrets(vars, { dryRun: false });

		expect(resolved.find((v) => v.key === "GOOD")?.value).toBe("goodfield-from-VaultA");
		expect(resolved.find((v) => v.key === "BAD")).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("BAD");
	});

	test("reports an error per var instead of throwing when op is not installed", async () => {
		const emptyDir = join(TMP, "empty");
		mkdirSync(emptyDir, { recursive: true });
		process.env.PATH = emptyDir;

		const vars = [
			{ key: "SECRET", value: "op://VaultA/item/API_KEY", source: "op://VaultA/item/API_KEY" },
		];

		const { resolved, errors } = await resolveSecrets(vars, { dryRun: false });

		expect(resolved).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("SECRET");
	});

	test("dry run never invokes op", async () => {
		process.env.PATH = `${BIN_DIR}${delimiter}${originalPath}`;
		const vars = [
			{ key: "SECRET", value: "op://VaultA/item/API_KEY", source: "op://VaultA/item/API_KEY" },
		];

		await resolveSecrets(vars, { dryRun: true });

		expect(existsSync(OP_LOG)).toBe(false);
	});
});
