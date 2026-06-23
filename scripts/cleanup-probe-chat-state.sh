#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_db_path() {
  if [[ -n "${QQBOT_KOISHI_DB_PATH:-}" ]]; then
    printf '%s\n' "${QQBOT_KOISHI_DB_PATH}"
    return
  fi

  printf '%s\n' "${ROOT_DIR}/data/koishi.db"
}

usage() {
  cat <<'EOF'
Usage:
  cleanup-probe-chat-state.sh <fake_user_id> <group_id>

Description:
  Remove temporary probe chat state for a non-default probe group, including the
  cloned room, conversation messages, room membership, and the chathub_user mapping.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

fake_user_id="${1:-}"
group_id="${2:-}"
if [[ -z "$fake_user_id" || -z "$group_id" ]]; then
  echo "[error] Missing fake_user_id or group_id." >&2
  usage >&2
  exit 2
fi

if ! [[ "$fake_user_id" =~ ^[0-9]+$ ]] || ! [[ "$group_id" =~ ^[0-9]+$ ]]; then
  echo "[error] fake_user_id and group_id must be numeric." >&2
  exit 2
fi

db_path="$(resolve_db_path)"
if [[ ! -f "$db_path" ]]; then
  echo "[error] koishi db not found: $db_path" >&2
  exit 2
fi

room_id="$(
  sqlite3 "$db_path" "select defaultRoomId from chathub_user where userId='${fake_user_id}' and groupId='${group_id}' limit 1;" \
    | tr -d '\n'
)"

if [[ -z "$room_id" ]]; then
  exit 0
fi

conversation_id="$(
  sqlite3 "$db_path" "select conversationId from chathub_room where roomId=${room_id} and roomMasterId='${fake_user_id}' limit 1;" \
    | tr -d '\n'
)"

conversation_cleanup_sql=""
if [[ -n "$conversation_id" ]]; then
  conversation_cleanup_sql=$'delete from chatluna_message where conversationId='"'${conversation_id}'"$';\n'"delete from chatluna_conversation where id='${conversation_id}';"
fi

sqlite3 "$db_path" <<SQL
begin immediate;
delete from chathub_room_member where roomId=${room_id};
delete from chathub_user where userId='${fake_user_id}' and groupId='${group_id}';
delete from chathub_room where roomId=${room_id} and roomMasterId='${fake_user_id}';
${conversation_cleanup_sql}
commit;
SQL

echo "[info] cleaned probe state: user=${fake_user_id} group=${group_id} room=${room_id}" >&2
