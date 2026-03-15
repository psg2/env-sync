import { describe, expect, test } from "bun:test";
import { collectVars, resolveSecrets } from "../resolver";
import type { Config } from "../types";

function makeConfig(groups: Config["groups"]): Config {
	return { groups, targets: {} };
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
