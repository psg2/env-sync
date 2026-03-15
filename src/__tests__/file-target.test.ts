import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncFile } from "../targets/file";
import type { FileTarget, ResolvedVar } from "../types";

const TMP = join(import.meta.dirname ?? ".", ".tmp-test-file");

function setup() {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
}

function teardown() {
	rmSync(TMP, { recursive: true, force: true });
}

describe("syncFile", () => {
	test("writes env file", async () => {
		setup();

		const target: FileTarget = {
			type: "file",
			path: ".env.local",
			groups: ["dev"],
			backup: false,
		};

		const vars: ResolvedVar[] = [
			{ key: "PORT", value: "3000", source: "3000" },
			{ key: "DB", value: "postgres://localhost", source: "postgres://localhost" },
		];

		await syncFile("local", target, vars, TMP, { dryRun: false });

		const content = readFileSync(join(TMP, ".env.local"), "utf-8");
		expect(content).toBe("PORT=3000\nDB=postgres://localhost\n");

		teardown();
	});

	test("backs up existing file", async () => {
		setup();
		const envPath = join(TMP, ".env");
		writeFileSync(envPath, "OLD=value\n");

		const target: FileTarget = {
			type: "file",
			path: ".env",
			groups: [],
			backup: true,
		};

		const vars: ResolvedVar[] = [{ key: "NEW", value: "val", source: "val" }];

		await syncFile("local", target, vars, TMP, { dryRun: false });

		// Original overwritten
		expect(readFileSync(envPath, "utf-8")).toBe("NEW=val\n");

		// Backup created
		const entries = readdirSync(TMP).filter((f) => f.startsWith(".env.bkp."));
		expect(entries.length).toBeGreaterThan(0);

		teardown();
	});

	test("dry run does not write", async () => {
		setup();

		const target: FileTarget = {
			type: "file",
			path: ".env.local",
			groups: [],
		};

		const vars: ResolvedVar[] = [{ key: "X", value: "1", source: "1" }];

		await syncFile("local", target, vars, TMP, { dryRun: true });

		expect(existsSync(join(TMP, ".env.local"))).toBe(false);

		teardown();
	});
});
