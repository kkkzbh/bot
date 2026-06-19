#!/usr/bin/env bash

chatluna_package_manager() {
  local root_dir="$1"
  node - "$root_dir/package.json" <<'NODE'
const fs = require('node:fs');

const packageJsonPath = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const packageManager = pkg.packageManager;

if (typeof packageManager !== 'string' || packageManager.trim() === '') {
  console.error(`[error] ChatLuna packageManager is missing in ${packageJsonPath}`);
  process.exit(1);
}

process.stdout.write(packageManager.trim());
NODE
}

chatluna_run_yarn() {
  local root_dir="$1"
  shift

  local package_manager
  package_manager="$(chatluna_package_manager "$root_dir")"

  case "$package_manager" in
    yarn@*)
      local yarn_version="${package_manager#yarn@}"
      if [[ -z "$yarn_version" ]]; then
        echo "[error] Invalid ChatLuna packageManager: $package_manager" >&2
        exit 1
      fi

      if command -v corepack >/dev/null 2>&1; then
        (cd "$root_dir" && corepack "yarn@${yarn_version}" "$@")
      elif command -v npm >/dev/null 2>&1; then
        (cd "$root_dir" && npm exec --yes "@yarnpkg/cli-dist@${yarn_version}" -- "$@")
      else
        echo "[error] ChatLuna requires yarn@${yarn_version}; install corepack or npm." >&2
        exit 1
      fi
      ;;
    *)
      echo "[error] Unsupported ChatLuna packageManager: $package_manager" >&2
      exit 1
      ;;
  esac
}

chatluna_yarn_install() {
  local root_dir="$1"
  chatluna_run_yarn "$root_dir" install --no-immutable
}

chatluna_yarn_install_immutable() {
  local root_dir="$1"
  chatluna_run_yarn "$root_dir" install --immutable
}

chatluna_yarn_fast_build() {
  local root_dir="$1"
  shift
  chatluna_run_yarn "$root_dir" fast-build "$@"
}
