#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  cleanup-probe-room.sh <fake_user_id>

Description:
  Remove the synthetic private debug room created by probe-local-bot.sh for the
  given fake user id, including room members, messages, conversation rows and
  default-room bindings.
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

fake_user_id="${1:-${FAKE_USER_ID:-}}"
if [[ -z "$fake_user_id" ]]; then
  echo "[error] Missing fake user id." >&2
  usage >&2
  exit 2
fi

if ! [[ "$fake_user_id" =~ ^[0-9]+$ ]]; then
  echo "[error] fake_user_id must be numeric." >&2
  exit 2
fi

require_cmd sqlite3

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
cd "$repo_root"

db_path="data/koishi.db"
if [[ ! -f "$db_path" ]]; then
  echo "[error] Database not found: $db_path" >&2
  exit 1
fi

room_row="$(
  sqlite3 -separator $'\t' "$db_path" "
    select r.roomId, coalesce(r.conversationId, ''), coalesce(r.roomName, ''), coalesce(r.visibility, '')
    from chathub_user u
    join chathub_room r on r.roomId = u.defaultRoomId
    where u.userId = '$fake_user_id'
    order by case when coalesce(u.groupId, '0') = '0' then 0 else 1 end, r.roomId desc
    limit 1;
  "
)"

if [[ -z "$room_row" ]]; then
  printf '{"ok":true,"deleted":false,"fakeUserId":"%s","reason":"no_room"}\n' "$fake_user_id"
  exit 0
fi

IFS=$'\t' read -r room_id conversation_id room_name visibility <<<"$room_row"
if [[ -z "$room_id" || -z "$conversation_id" ]]; then
  printf '{"ok":false,"deleted":false,"fakeUserId":"%s","error":"incomplete_room_record"}\n' "$fake_user_id"
  exit 1
fi

message_count="$(
  sqlite3 "$db_path" "select count(*) from chathub_message where conversation = '$conversation_id';"
)"

room_member_count="$(
  sqlite3 "$db_path" "select count(*) from chathub_room_member where roomId = $room_id;"
)"

room_group_member_count="$(
  sqlite3 "$db_path" "select count(*) from chathub_room_group_member where roomId = $room_id;"
)"

bound_user_count="$(
  sqlite3 "$db_path" "select count(*) from chathub_user where defaultRoomId = $room_id;"
)"

sqlite3 "$db_path" <<SQL
BEGIN IMMEDIATE;
delete from chathub_room_member where roomId = $room_id;
delete from chathub_room_group_member where roomId = $room_id;
delete from chathub_message where conversation = '$conversation_id';
delete from chathub_conversation where id = '$conversation_id';
update chathub_user set defaultRoomId = null where defaultRoomId = $room_id;
delete from chathub_room where roomId = $room_id;
COMMIT;
SQL

printf '{"ok":true,"deleted":true,"fakeUserId":"%s","roomId":%s,"conversationId":"%s","roomName":"%s","visibility":"%s","deletedMessages":%s,"deletedRoomMembers":%s,"deletedRoomGroupMembers":%s,"clearedDefaultUsers":%s}\n' \
  "$fake_user_id" \
  "$room_id" \
  "$conversation_id" \
  "$(printf '%s' "$room_name" | tr '"' "'" )" \
  "$(printf '%s' "$visibility" | tr '"' "'" )" \
  "${message_count:-0}" \
  "${room_member_count:-0}" \
  "${room_group_member_count:-0}" \
  "${bound_user_count:-0}"
