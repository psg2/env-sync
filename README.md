# @psg2/env-sync

Declarative env var management — one YAML config, multiple targets.

Define your env vars and secrets in `env-sync.yaml`, then sync them to local `.env` files, Vercel environments, or GitHub secrets in one command. Secrets are resolved from **1Password** at sync time.

## Install

```bash
bun add -g @psg2/env-sync
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

Pushes vars to Vercel environment(s) via the Vercel REST API. Backs up current env vars before overwriting.

Values resolved from `op://` references are stored as **Sensitive** variables (write-only on Vercel; the value can never be read back). Literal values stay as regular readable variables. Re-running the sync converts existing variables to the right type.

```yaml
targets:
  vercel-prod:
    type: vercel
    environments: [production]          # preview, production, development
    groups: [prod-secrets]
    project: my-app                     # Optional (uses linked project)
    redeploy: true                      # Optional (default: false)
```

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
| 1Password secrets | [`op` CLI](https://developer.1password.com/docs/cli) + `op signin` |
| Vercel targets | [`vercel` CLI](https://vercel.com/docs/cli) |
| GitHub targets | [`gh` CLI](https://cli.github.com) |

The CLI checks for required tools before syncing and gives clear error messages.

## Examples

See [`examples/`](./examples/) for complete configs — [`simple.yaml`](./examples/simple.yaml) and [`full.yaml`](./examples/full.yaml).

## License

MIT
