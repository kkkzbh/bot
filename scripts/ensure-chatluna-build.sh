#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHATLUNA_CORE_DIR="${CHATLUNA_CORE_DIR:-$ROOT_DIR/../chatluna/packages/core}"
CHATLUNA_ROOT_DIR="$(cd -- "$CHATLUNA_CORE_DIR/../.." && pwd)"
CHATLUNA_YAKUMO="$CHATLUNA_ROOT_DIR/node_modules/.bin/yakumo"

if [[ ! -d "$CHATLUNA_CORE_DIR" ]]; then
  echo "[error] ChatLuna core directory not found: $CHATLUNA_CORE_DIR" >&2
  exit 1
fi

needs_build="$(
  python3 - "$CHATLUNA_CORE_DIR" <<'PY'
from pathlib import Path
import sys

core_dir = Path(sys.argv[1])
src_dir = core_dir / 'src'
lib_dir = core_dir / 'lib'
package_json = core_dir / 'package.json'

if not src_dir.is_dir() or not package_json.is_file():
    raise SystemExit('missing src or package.json')

if not lib_dir.is_dir():
    print('yes')
    raise SystemExit(0)

src_files = [package_json, *src_dir.rglob('*')]
runtime_files = [
    *lib_dir.rglob('*.cjs'),
    *lib_dir.rglob('*.mjs'),
]

src_mtime = max((path.stat().st_mtime for path in src_files if path.is_file()), default=0)
runtime_mtime = min((path.stat().st_mtime for path in runtime_files if path.is_file()), default=0)

print('yes' if src_mtime > runtime_mtime else 'no')
PY
)"

if [[ "$needs_build" == "yes" ]]; then
  echo "[info] Building linked ChatLuna core: $CHATLUNA_CORE_DIR"
  (cd "$CHATLUNA_ROOT_DIR" && pnpm run fast-build core)
else
  echo "[info] Linked ChatLuna core build is up to date."
fi
