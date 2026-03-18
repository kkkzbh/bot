#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  push-with-dotenv.sh [git-push-args...]

Description:
  Sync local server env to GitHub Actions secret QQBOT_DOTENV, then push current branch.
  - If upstream exists: git push
  - If upstream does not exist: git push -u origin <current-branch>

Environment:
  ENV_FILE             Path to server env file (default: <repo-root>/.env.server)
  DOTENV_SECRET_NAME   GitHub secret name (default: QQBOT_DOTENV)
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] Missing command: $1" >&2
    exit 2
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd git
require_cmd gh

if ! gh auth status >/dev/null 2>&1; then
  echo "[error] gh is not authenticated. Run: gh auth login" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "[error] Not inside a git repository." >&2
  exit 2
fi

env_file="${ENV_FILE:-$repo_root/.env.server}"
secret_name="${DOTENV_SECRET_NAME:-QQBOT_DOTENV}"
branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)"

if [[ ! -f "$env_file" ]]; then
  echo "[error] env file not found: $env_file" >&2
  exit 2
fi

if [[ ! -s "$env_file" ]]; then
  echo "[error] env file is empty: $env_file" >&2
  exit 2
fi

echo "[info] Syncing $env_file -> GitHub secret $secret_name"
gh secret set "$secret_name" < "$env_file"

echo "[info] Pushing branch: $branch"
if [[ "$#" -gt 0 ]]; then
  git -C "$repo_root" push "$@"
elif git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git -C "$repo_root" push
else
  git -C "$repo_root" push -u origin "$branch"
fi
