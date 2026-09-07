import { describe, expect, test } from "vitest";
import { sync } from "./sync";
import type { Config } from "./types";

describe("sync", () => {
	test("throws for an unknown target name, listing the available ones", async () => {
		const config: Config = {
			groups: {},
			targets: {
				a: { type: "file", path: ".env.a", groups: [] },
				b: { type: "file", path: ".env.b", groups: [] },
			},
		};

		await expect(sync(config, { targets: ["nope"], dryRun: true, configDir: "." })).rejects.toThrow(
			"Unknown target 'nope'. Available: a, b",
		);
	});

	test("syncs every configured target, in config order, when opts.targets is omitted", async () => {
		const config: Config = {
			groups: {
				base: { SHARED: "from-base", ONLY_BASE: "b" },
				extra: { SHARED: "from-extra", ONLY_EXTRA: "e" },
			},
			targets: {
				first: { type: "file", path: ".env.first", groups: ["base", "extra"] },
				second: { type: "file", path: ".env.second", groups: ["extra"] },
			},
		};

		const results = await sync(config, { dryRun: true, configDir: "." });

		expect(results.map((r) => r.target)).toEqual(["first", "second"]);
		// "first" sees SHARED (from base, first group wins), ONLY_BASE, ONLY_EXTRA — 3 distinct keys.
		expect(results[0]).toMatchObject({ type: "file", vars: 3 });
		// "second" only references "extra" — SHARED, ONLY_EXTRA — 2 distinct keys.
		expect(results[1]).toMatchObject({ type: "file", vars: 2 });
	});

	test("keeps a target whose groups yield no vars in the results, with vars: 0 and no errors", async () => {
		const config: Config = {
			groups: { a: { X: "1" } },
			targets: {
				empty: { type: "file", path: ".env.empty", groups: [] },
				nonempty: { type: "file", path: ".env.nonempty", groups: ["a"] },
			},
		};

		const results = await sync(config, { dryRun: true, configDir: "." });

		expect(results).toHaveLength(2);
		expect(results.find((r) => r.target === "empty")).toEqual({
			target: "empty",
			type: "file",
			vars: 0,
			errors: [],
		});
	});
});
