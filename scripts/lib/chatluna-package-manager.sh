#!/usr/bin/env bash

chatluna_package_manager() {
  local root_dir="$1"
  node - "$root_dir/package.json" "${CHATLUNA_YARN_VERSION:-}" <<'NODE'
const fs = require('node:fs');

const packageJsonPath = process.argv[2];
const explicitYarnVersion = String(process.argv[3] || '').trim();
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const packageManager = pkg.packageManager;

if (typeof packageManager !== 'string' || packageManager.trim() === '') {
  if (explicitYarnVersion) {
    const version = explicitYarnVersion.startsWith('yarn@')
      ? explicitYarnVersion.slice('yarn@'.length)
      : explicitYarnVersion;
    if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version)) {
      console.error(`[error] Invalid explicit ChatLuna Yarn version: ${explicitYarnVersion}`);
      process.exit(1);
    }
    process.stdout.write(`yarn@${version}`);
    process.exit(0);
  }

  console.error(`[error] ChatLuna packageManager is missing in ${packageJsonPath}; set CHATLUNA_YARN_VERSION explicitly.`);
  process.exit(1);
}

process.stdout.write(packageManager.trim());
NODE
}

chatluna_run_yarn_with_package_manager() {
  local root_dir="$1"
  local package_manager="$2"
  shift 2

  case "$package_manager" in
    yarn@*)
      local yarn_version="${package_manager#yarn@}"
      if [[ -z "$yarn_version" ]]; then
        echo "[error] Invalid ChatLuna packageManager: $package_manager" >&2
        exit 1
      fi

      if command -v corepack >/dev/null 2>&1; then
        (cd "$root_dir" && COREPACK_ENABLE_PROJECT_SPEC=0 corepack "yarn@${yarn_version}" "$@")
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

chatluna_run_yarn() {
  local root_dir="$1"
  shift

  local package_manager
  package_manager="$(chatluna_package_manager "$root_dir")"
  chatluna_run_yarn_with_package_manager "$root_dir" "$package_manager" "$@"
}

chatluna_yarn_install() {
  local root_dir="$1"
  local package_manager
  package_manager="$(chatluna_package_manager "$root_dir")"
  case "$package_manager" in
    yarn@1.*)
      chatluna_run_yarn_with_package_manager "$root_dir" "$package_manager" install --frozen-lockfile
      ;;
    yarn@*)
      chatluna_run_yarn_with_package_manager "$root_dir" "$package_manager" install --no-immutable
      ;;
    *)
      echo "[error] Unsupported ChatLuna packageManager: $package_manager" >&2
      exit 1
      ;;
  esac
}

chatluna_yarn_install_immutable() {
  local root_dir="$1"
  local package_manager
  package_manager="$(chatluna_package_manager "$root_dir")"
  case "$package_manager" in
    yarn@1.*)
      chatluna_run_yarn_with_package_manager "$root_dir" "$package_manager" install --frozen-lockfile
      ;;
    yarn@*)
      chatluna_run_yarn_with_package_manager "$root_dir" "$package_manager" install --immutable
      ;;
    *)
      echo "[error] Unsupported ChatLuna packageManager: $package_manager" >&2
      exit 1
      ;;
  esac
}

chatluna_yarn_fast_build() {
  local root_dir="$1"
  shift
  chatluna_run_yarn "$root_dir" fast-build "$@"
}
