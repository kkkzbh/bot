#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHATLUNA_ROOT_DIR="${CHATLUNA_ROOT_DIR:-}"

if [[ -z "$CHATLUNA_ROOT_DIR" ]]; then
  CHATLUNA_CORE_DIR="${CHATLUNA_CORE_DIR:-$ROOT_DIR/../chatluna/packages/core}"
  CHATLUNA_ROOT_DIR="$(cd -- "$CHATLUNA_CORE_DIR/../.." && pwd)"
fi

if [[ ! -d "$CHATLUNA_ROOT_DIR" ]]; then
  echo "[error] ChatLuna root directory not found: $CHATLUNA_ROOT_DIR" >&2
  exit 1
fi

mapfile -t BUILD_TARGETS < <(
  python3 - "$ROOT_DIR/package.json" "$CHATLUNA_ROOT_DIR" <<'PY'
from __future__ import annotations

import json
from pathlib import Path
import sys

qqbot_package_json = Path(sys.argv[1])
chatluna_root = Path(sys.argv[2])
linked_prefix = 'link:../chatluna/packages/'

qqbot_package = json.loads(qqbot_package_json.read_text(encoding='utf-8'))
dependencies = qqbot_package.get('dependencies', {})
build_targets: list[str] = []

for _, spec in dependencies.items():
    if not isinstance(spec, str) or not spec.startswith(linked_prefix):
        continue

    relative_path = spec[len(linked_prefix):].strip('/')
    if not relative_path:
        continue

    package_dir = chatluna_root / 'packages' / relative_path
    src_dir = package_dir / 'src'
    lib_dir = package_dir / 'lib'
    package_json = package_dir / 'package.json'

    if not src_dir.is_dir() or not package_json.is_file():
        raise SystemExit(f'missing src or package.json for linked ChatLuna package: {package_dir}')

    src_files = [package_json, *src_dir.rglob('*')]
    runtime_files = [*lib_dir.rglob('*.cjs'), *lib_dir.rglob('*.mjs')]
    src_mtime = max((path.stat().st_mtime for path in src_files if path.is_file()), default=0)
    runtime_mtime = min((path.stat().st_mtime for path in runtime_files if path.is_file()), default=0)

    if not lib_dir.is_dir() or not runtime_files or src_mtime > runtime_mtime:
        build_targets.append(package_dir.name)

for target in build_targets:
    print(target)
PY
)

if [[ "${#BUILD_TARGETS[@]}" -gt 0 ]]; then
  echo "[info] Building linked ChatLuna packages: ${BUILD_TARGETS[*]}"
  (cd "$CHATLUNA_ROOT_DIR" && pnpm run fast-build "${BUILD_TARGETS[@]}")
else
  echo "[info] Linked ChatLuna packages are up to date."
fi
