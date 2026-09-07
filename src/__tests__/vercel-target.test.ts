import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncVercel } from "../targets/vercel";
import type { ResolvedVar, VercelTarget } from "../types";

const TMP = join(import.meta.dirname ?? ".", ".tmp-test-vercel");
const HOME = join(TMP, "home");
const PROJECT = join(TMP, "project");
const XDG = join(HOME, "xdg");
const AUTH_FILE = join(XDG, "com.vercel.cli", "auth.json");

interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: Record<string, unknown>;
}

type Responder = (
	method: string,
	pathname: string,
	url: URL,
) => { status: number; body?: unknown } | undefined;

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalVercelToken = process.env.VERCEL_TOKEN;
let requests: CapturedRequest[];

/** Installs a fetch mock that records every request and dispatches on method + pathname. */
function installFetch(respond: Responder): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: undefined;
		requests.push({ method, url: url.toString(), headers, body });

		const result = respond(method, url.pathname, url);
		if (!result) return new Response(JSON.stringify({}), { status: 200 });
		return new Response(result.body !== undefined ? JSON.stringify(result.body) : "", {
			status: result.status,
		});
	}) as typeof fetch;
}

/** Default responder: empty existing env list, everything else succeeds. */
function defaultResponder(
	method: string,
	pathname: string,
): { status: number; body?: unknown } | undefined {
	if (method === "GET" && /\/env$/.test(pathname)) {
		return { status: 200, body: { envs: [] } };
	}
	return { status: 200, body: {} };
}

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	// The target reads the CLI token from the standard auth store and the
	// project id from `.vercel/project.json`; both are relocated into TMP.
	// XDG_CONFIG_HOME is honoured on every OS, so the test does not depend
	// on the macOS or Linux default path.
	mkdirSync(join(XDG, "com.vercel.cli"), { recursive: true });
	writeFileSync(AUTH_FILE, JSON.stringify({ token: "test-token" }));
	process.env.XDG_CONFIG_HOME = XDG;
	mkdirSync(join(PROJECT, ".vercel"), { recursive: true });
	writeFileSync(
		join(PROJECT, ".vercel", "project.json"),
		JSON.stringify({ projectId: "prj_test", orgId: "team_test", projectName: "app" }),
	);
	// The target honors HOME at call time, which keeps the real auth store
	// out of the picture.
	process.env.HOME = HOME;
	delete process.env.VERCEL_TOKEN;

	requests = [];
	installFetch(defaultResponder);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	process.env.HOME = originalHome;
	if (originalXdg === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdg;
	}
	if (originalVercelToken === undefined) {
		delete process.env.VERCEL_TOKEN;
	} else {
		process.env.VERCEL_TOKEN = originalVercelToken;
	}
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

	test("uses VERCEL_TOKEN over the CLI auth store", async () => {
		process.env.VERCEL_TOKEN = "env-token";
		const target: VercelTarget = {
			type: "vercel",
			environments: ["production"],
			groups: ["prod"],
		};
		const vars: ResolvedVar[] = [
			{ key: "APP_URL", value: "https://app.example.com", source: "https://app.example.com" },
		];

		const result = await syncVercel("production", target, vars, PROJECT, { dryRun: false });

		expect(result.errors).toEqual([]);
		expect(requests.length).toBeGreaterThan(0);
		for (const r of requests) {
			expect(r.headers.authorization).toBe("Bearer env-token");
		}
	});

	test("reports a clear error when no token is available", async () => {
		rmSync(AUTH_FILE, { force: true });
		const target: VercelTarget = {
			type: "vercel",
			environments: ["production"],
			groups: ["prod"],
		};
		const vars: ResolvedVar[] = [
			{ key: "APP_URL", value: "https://app.example.com", source: "https://app.example.com" },
		];

		const result = await syncVercel("production", target, vars, PROJECT, { dryRun: false });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("VERCEL_TOKEN");
		expect(requests).toEqual([]);
	});

	test("writes a backup of the environment before overwriting", async () => {
		installFetch((method, pathname) => {
			if (method === "GET" && /\/env$/.test(pathname)) {
				return {
					status: 200,
					body: {
						envs: [
							{
								id: "1",
								key: "APP_URL",
								type: "encrypted",
								value: "https://app.example.com",
								target: ["production"],
							},
							{ id: "2", key: "API_KEY", type: "sensitive", target: ["production"] },
							{
								id: "3",
								key: "PREVIEW_ONLY",
								type: "encrypted",
								value: "x",
								target: ["preview"],
							},
							{
								id: "4",
								key: "BRANCH_VAR",
								type: "encrypted",
								value: "y",
								target: ["production"],
								gitBranch: "feat",
							},
						],
					},
				};
			}
			return { status: 200, body: {} };
		});

		const target: VercelTarget = {
			type: "vercel",
			environments: ["production"],
			groups: ["prod"],
		};
		const vars: ResolvedVar[] = [
			{ key: "APP_URL", value: "https://new.example.com", source: "https://new.example.com" },
		];

		const result = await syncVercel("production", target, vars, PROJECT, { dryRun: false });
		expect(result.errors).toEqual([]);

		const backupDir = join(PROJECT, ".env-sync-backups");
		const files = readdirSync(backupDir).filter((f) => /^vercel-production\..*\.env$/.test(f));
		expect(files).toHaveLength(1);
		const contents = readFileSync(join(backupDir, files[0] as string), "utf-8");

		expect(contents).toContain('APP_URL="https://app.example.com"');
		expect(contents).toContain("API_KEY");
		expect(contents).toContain("sensitive");
		expect(contents).not.toContain("PREVIEW_ONLY");
		expect(contents).not.toContain("BRANCH_VAR");

		const deleteIdx = requests.findIndex((r) => r.method === "DELETE" && r.url.includes("/env/1"));
		const postIdx = requests.findIndex((r) => r.method === "POST" && r.body?.key === "APP_URL");
		expect(deleteIdx).toBeGreaterThanOrEqual(0);
		expect(postIdx).toBeGreaterThan(deleteIdx);
	});

	test("redeploys the latest production deployment when redeploy is set", async () => {
		installFetch((method, pathname) => {
			if (method === "GET" && /\/env$/.test(pathname)) {
				return { status: 200, body: { envs: [] } };
			}
			if (method === "GET" && pathname.includes("/v6/deployments")) {
				return {
					status: 200,
					body: {
						deployments: [{ uid: "dpl_123", name: "app", url: "app-abc.vercel.app" }],
					},
				};
			}
			if (method === "POST" && pathname.includes("/v13/deployments")) {
				return { status: 200, body: { url: "app-new.vercel.app" } };
			}
			return { status: 200, body: {} };
		});

		const target: VercelTarget = {
			type: "vercel",
			environments: ["production"],
			groups: ["prod"],
			redeploy: true,
		};
		const vars: ResolvedVar[] = [
			{ key: "APP_URL", value: "https://app.example.com", source: "https://app.example.com" },
		];

		const result = await syncVercel("production", target, vars, PROJECT, { dryRun: false });
		expect(result.errors).toEqual([]);

		const redeployReq = requests.find(
			(r) => r.method === "POST" && r.url.includes("/v13/deployments"),
		);
		expect(redeployReq).toBeDefined();
		expect(redeployReq?.body).toMatchObject({
			deploymentId: "dpl_123",
			target: "production",
			meta: { action: "redeploy" },
		});

		const listReq = requests.find((r) => r.method === "GET" && r.url.includes("/v6/deployments"));
		expect(listReq?.url).toContain("target=production");
	});

	test("does not redeploy when a push failed", async () => {
		installFetch((method, pathname) => {
			if (method === "GET" && /\/env$/.test(pathname)) {
				return { status: 200, body: { envs: [] } };
			}
			if (method === "POST" && /\/env$/.test(pathname)) {
				return { status: 500, body: { error: "boom" } };
			}
			return { status: 200, body: {} };
		});

		const target: VercelTarget = {
			type: "vercel",
			environments: ["production"],
			groups: ["prod"],
			redeploy: true,
		};
		const vars: ResolvedVar[] = [
			{ key: "APP_URL", value: "https://app.example.com", source: "https://app.example.com" },
		];

		const result = await syncVercel("production", target, vars, PROJECT, { dryRun: false });
		expect(result.errors.length).toBeGreaterThan(0);

		const redeployReq = requests.find((r) => r.url.includes("/v13/deployments"));
		expect(redeployReq).toBeUndefined();
	});

	test("reports per-variable failures returned inside a 201 response", async () => {
		installFetch((method, pathname) => {
			if (method === "GET" && /\/env$/.test(pathname)) {
				return { status: 200, body: { envs: [] } };
			}
			if (method === "POST" && /\/env$/.test(pathname)) {
				return {
					status: 201,
					body: {
						created: [],
						failed: [{ error: { code: "ENV_CONFLICT", message: "already exists" } }],
					},
				};
			}
			return { status: 200, body: {} };
		});

		const target: VercelTarget = {
			type: "vercel",
			environments: ["production"],
			groups: ["prod"],
		};
		const vars: ResolvedVar[] = [
			{ key: "APP_URL", value: "https://app.example.com", source: "https://app.example.com" },
		];

		const result = await syncVercel("production", target, vars, PROJECT, { dryRun: false });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("APP_URL");
		expect(result.errors[0]).toContain("already exists");
	});
});
