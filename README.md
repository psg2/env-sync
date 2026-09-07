# @psg2/env-sync

Declarative env var management — one YAML config, multiple targets.

Define your env vars and secrets in `env-sync.yaml`, then sync them to local `.env` files, Vercel environments, or GitHub secrets in one command. Secrets are resolved from **1Password** at sync time.

## Install

```bash
pnpm add -g @psg2/env-sync
```

Or run it as a one-off without installing:

```bash
npx @psg2/env-sync
```

## Quick Start

Create `env-sync.yaml` in your project root:

```yaml
groups:
  local:
    PORT: "3000"
    DB_URL: postgres://localhost/myapp
    AUTH_SECRET: op://Development/myapp/AUTH_SECRET
    API_KEY: op://Development/myapp/API_KEY

  prod:
    AUTH_SECRET: op://Production/myapp/AUTH_SECRET
    API_KEY: op://Production/myapp/API_KEY

targets:
  local:
    type: file
    path: .env.local
    groups: [local]

  vercel-prod:
    type: vercel
    environments: [production]
    groups: [prod]
```

```bash
env-sync              # Sync all targets
env-sync local        # Just local .env.local
env-sync vercel-prod  # Just push to Vercel production
env-sync --dry-run    # Preview without changes
env-sync --list       # Show configured groups & targets
```

## Config Reference

### Groups

A **group** is a flat map of env vars. Each value is either a plain string or an `op://` 1Password reference.

```yaml
groups:
  my-group:
    PLAIN_VAR: some-value                 # Used as-is
    SECRET: op://Vault/Item/Field         # Resolved via 1Password CLI
```

When a target references multiple groups, vars are collected in order — **first group wins** on key conflicts.

### Targets

#### File

Writes a `.env`-style file. Backs up existing file before overwriting.

```yaml
targets:
  local:
    type: file
    path: .env.local          # Relative to env-sync.yaml
    groups: [infra, secrets]
    backup: true              # Default: true
```

#### Vercel

Pushes vars to Vercel environment(s) via the Vercel REST API. Before overwriting, the current variables of each environment are backed up to `.env-sync-backups/vercel-<env>.<timestamp>.env`, in `KEY="value"` format. Sensitive variables can't be read back through the API (nor by `vercel env pull`), so the backup records only their key and type as a comment.

Values resolved from `op://` references are stored as **Sensitive** variables (write-only on Vercel; the value can never be read back). Literal values stay as regular readable variables. Re-running the sync converts existing variables to the right type.

With `redeploy: true`, the latest READY deployment of the environment is redeployed through the API — the same effect as `vercel redeploy`. Skipped for `development`, which has no deployments.

```yaml
targets:
  vercel-prod:
    type: vercel
    environments: [production]          # preview, production, development
    groups: [prod-secrets]
    project: my-app                     # Optional (uses linked project)
    redeploy: true                      # Optional (default: false)
```

**Authentication:** the token is read from `VERCEL_TOKEN` first, then from the Vercel CLI auth store written by `vercel login` (e.g. `~/Library/Application Support/com.vercel.cli/auth.json` on macOS, `~/.local/share/com.vercel.cli/auth.json` on Linux, `%APPDATA%/com.vercel.cli/auth.json` on Windows). The project and team ids come from `.vercel/project.json`, created by `vercel link` (or written by hand with `projectId` and `orgId`). The `vercel` CLI itself is optional at runtime — it's only needed once, to produce the token and the linked project file.

#### GitHub

Pushes vars as GitHub repository secrets via the GitHub CLI.

```yaml
targets:
  github:
    type: github
    secretType: actions                 # actions (default) or dependabot
    groups: [ci-secrets]
    repo: org/repo                      # Optional (uses current repo)
    environment: staging                # Optional (repo-level if omitted)
```

## CLI

```
env-sync                       Sync all targets
env-sync <target> [target...]  Sync specific targets

Options:
  -c, --config <path>  Config file path (default: search upward)
  -n, --dry-run        Preview without making changes
  -l, --list           List configured targets and groups
  -h, --help           Show help
  -v, --version        Show version
```

## Prerequisites

| Feature | Requires |
|---------|----------|
| Runtime | Node 24 or newer |
| 1Password secrets | [`op` CLI](https://developer.1password.com/docs/cli) + `op signin` |
| Vercel targets | `VERCEL_TOKEN` env var, or `vercel login` (CLI optional) |
| GitHub targets | [`gh` CLI](https://cli.github.com) |

The CLI checks for `op` and `gh` before syncing and gives clear error messages; Vercel credentials are validated when the target runs.

## Examples

See [`examples/`](./examples/) for complete configs — [`simple.yaml`](./examples/simple.yaml) and [`full.yaml`](./examples/full.yaml).

## License

MIT
