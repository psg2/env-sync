import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncVercel } from "../targets/vercel";
import type { ResolvedVar, VercelTarget } from "../types";

const TMP = join(import.meta.dirname ?? ".", ".tmp-test-vercel");
const HOME = join(TMP, "home");
const PROJECT = join(TMP, "project");

interface CapturedRequest {
	method: string;
	url: string;
	body?: Record<string, unknown>;
}

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalPath = process.env.PATH;
let requests: CapturedRequest[];

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	// The target reads the CLI token from the standard auth store and the
	// project id from `.vercel/project.json`; both are relocated into TMP.
	// XDG_CONFIG_HOME is honoured on every OS, so the test does not depend
	// on the macOS or Linux default path.
	mkdirSync(join(HOME, "xdg", "com.vercel.cli"), { recursive: true });
	writeFileSync(
		join(HOME, "xdg", "com.vercel.cli", "auth.json"),
		JSON.stringify({ token: "test-token" }),
	);
	process.env.XDG_CONFIG_HOME = join(HOME, "xdg");
	mkdirSync(join(PROJECT, ".vercel"), { recursive: true });
	writeFileSync(
		join(PROJECT, ".vercel", "project.json"),
		JSON.stringify({ projectId: "prj_test", orgId: "team_test", projectName: "app" }),
	);
	process.env.HOME = HOME;
	// Point PATH at an empty dir so the `vercel env pull` backup step fails
	// fast instead of depending on a locally installed CLI.
	process.env.PATH = TMP;

	requests = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: undefined;
		requests.push({ method, url, body });
		if (method === "GET") {
			return new Response(JSON.stringify({ envs: [] }), { status: 200 });
		}
		return new Response(JSON.stringify({}), { status: 200 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	process.env.HOME = originalHome;
	if (originalXdg === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdg;
	}
	process.env.PATH = originalPath;
	rmSync(TMP, { recursive: true, force: true });
});

describe("syncVercel", () => {
	test("stores 1Password-backed values as sensitive and literals as readable", async () => {
		const target: VercelTarget = {
			type: "vercel",
			environments: ["production"],
			groups: ["prod"],
		};
		const vars: ResolvedVar[] = [
			{ key: "API_KEY", value: "resolved-secret", source: "op://Production/app/API_KEY" },
			{ key: "APP_URL", value: "https://app.example.com", source: "https://app.example.com" },
		];

		const result = await syncVercel("production", target, vars, PROJECT, { dryRun: false });

		expect(result.errors).toEqual([]);
		const created = requests.filter((r) => r.method === "POST").map((r) => r.body);
		expect(created).toEqual([
			{ key: "API_KEY", value: "resolved-secret", target: ["production"], type: "sensitive" },
			{
				key: "APP_URL",
				value: "https://app.example.com",
				target: ["production"],
				type: "encrypted",
			},
		]);
	});
});
