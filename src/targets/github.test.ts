import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GitHubTarget, ResolvedVar } from "../types";
import { syncGitHub } from "./github";

const TMP = join(import.meta.dirname ?? ".", ".tmp-test-github");
const BIN_DIR = join(TMP, "bin");
const GH_PATH = join(BIN_DIR, "gh");
const GH_LOG = join(TMP, "gh.log");

const originalPath = process.env.PATH;

/**
 * Installs a real (not mocked) `gh` executable on PATH. Every invocation is
 * appended to GH_LOG, one line per call with args joined by "|" so a test
 * can assert both the exact arguments and the call order. A var named "BAD"
 * simulates a rejected secret (exit 1, "secret rejected" on stderr).
 */
function writeFakeGh(): void {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(BIN_DIR, { recursive: true });
	const script = `#!/bin/sh
(IFS='|'; echo "$*") >> "${GH_LOG}"

for arg in "$@"; do
	if [ "$arg" = "BAD" ]; then
		echo "secret rejected" >&2
		exit 1
	fi
done
exit 0
`;
	writeFileSync(GH_PATH, script);
	chmodSync(GH_PATH, 0o755);
}

function readLog(): string[] {
	if (!existsSync(GH_LOG)) return [];
	return readFileSync(GH_LOG, "utf-8").trim().split("\n").filter(Boolean);
}

function vars(...keys: string[]): ResolvedVar[] {
	return keys.map((key) => ({ key, value: `value-${key}`, source: `value-${key}` }));
}

describe("syncGitHub", () => {
	beforeEach(() => {
		writeFakeGh();
		process.env.PATH = `${BIN_DIR}${delimiter}${originalPath}`;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		rmSync(TMP, { recursive: true, force: true });
	});

	test("invokes gh secret set once per var, in order, with --repo when configured", async () => {
		const target: GitHubTarget = { type: "github", groups: [], repo: "org/repo" };
		const input = vars("ONE", "TWO");

		const result = await syncGitHub("gh", target, input, TMP, { dryRun: false });

		expect(result.errors).toEqual([]);
		expect(result.vars).toBe(input.length);
		expect(readLog()).toEqual([
			"secret|set|ONE|--body|value-ONE|--repo|org/repo",
			"secret|set|TWO|--body|value-TWO|--repo|org/repo",
		]);
	});

	test("omits --repo when not configured", async () => {
		const target: GitHubTarget = { type: "github", groups: [] };
		const input = vars("ONE");

		await syncGitHub("gh", target, input, TMP, { dryRun: false });

		expect(readLog()).toEqual(["secret|set|ONE|--body|value-ONE"]);
	});

	test("adds --env for a configured environment", async () => {
		const target: GitHubTarget = { type: "github", groups: [], environment: "staging" };
		const input = vars("ONE");

		await syncGitHub("gh", target, input, TMP, { dryRun: false });

		expect(readLog()).toEqual(["secret|set|ONE|--body|value-ONE|--env|staging"]);
	});

	test("adds --app dependabot for secretType dependabot", async () => {
		const target: GitHubTarget = { type: "github", secretType: "dependabot", groups: [] };
		const input = vars("ONE");

		await syncGitHub("gh", target, input, TMP, { dryRun: false });

		expect(readLog()).toEqual(["secret|set|ONE|--body|value-ONE|--app|dependabot"]);
	});

	test("reports a failing var in errors with the key and stderr, and keeps pushing the rest", async () => {
		const target: GitHubTarget = { type: "github", groups: [] };
		const input = vars("BEFORE", "BAD", "AFTER");

		const result = await syncGitHub("gh", target, input, TMP, { dryRun: false });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("BAD");
		expect(result.errors[0]).toContain("secret rejected");

		const log = readLog();
		expect(log).toHaveLength(3);
		expect(log[2]).toContain("AFTER");
	});

	test("dry run writes nothing to the log", async () => {
		const target: GitHubTarget = { type: "github", groups: [] };
		const input = vars("ONE");

		await syncGitHub("gh", target, input, TMP, { dryRun: true });

		expect(existsSync(GH_LOG)).toBe(false);
	});

	test("reports an error per var instead of throwing when gh is not installed", async () => {
		const emptyDir = join(TMP, "empty");
		mkdirSync(emptyDir, { recursive: true });
		process.env.PATH = emptyDir;

		const target: GitHubTarget = { type: "github", groups: [] };
		const input = vars("ONE", "TWO");

		const result = await syncGitHub("gh", target, input, TMP, { dryRun: false });

		expect(result.errors).toHaveLength(2);
		expect(result.errors[0]).toContain("ONE");
		expect(result.errors[1]).toContain("TWO");
	});
});
