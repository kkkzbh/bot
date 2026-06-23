#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${QQBOT_KOISHI_DB_PATH:-$ROOT_DIR/data/koishi.db}"
ROOM_PREFIX="${ROOM_PREFIX:-codex-debug}"
FAKE_USER_ID="${FAKE_USER_ID:-}"

usage() {
  cat <<'EOF'
Usage:
  cleanup-debug-chat-state.sh
  FAKE_USER_ID=9123456789 cleanup-debug-chat-state.sh

Description:
  Remove debug-generated ChatLuna rooms, conversations, messages, and fake users
  from the local Koishi sqlite database.

Environment:
  QQBOT_KOISHI_DB_PATH  Override sqlite db path (default: data/koishi.db)
  ROOM_PREFIX           Room-name prefix to match when FAKE_USER_ID is unset (default: codex-debug)
  FAKE_USER_ID          Exact fake private-chat user id to clean
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

require_cmd sqlite3
require_cmd python3

if [[ ! -f "$DB_PATH" ]]; then
  echo "[error] Missing database: $DB_PATH" >&2
  exit 1
fi

if [[ -n "$FAKE_USER_ID" ]] && ! [[ "$FAKE_USER_ID" =~ ^[0-9]+$ ]]; then
  echo "[error] FAKE_USER_ID must be numeric." >&2
  exit 2
fi

export DB_PATH ROOM_PREFIX FAKE_USER_ID

python3 <<'PY'
import os
import sqlite3
import sys

db_path = os.environ['DB_PATH']
room_prefix = os.environ['ROOM_PREFIX']
fake_user_id = os.environ.get('FAKE_USER_ID', '').strip()

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

try:
    if fake_user_id:
        room_rows = conn.execute(
            "select roomId, conversationId from chathub_room where roomMasterId = ?",
            (fake_user_id,),
        ).fetchall()
        user_ids = [fake_user_id]
    else:
        room_rows = conn.execute(
            "select roomId, conversationId, roomMasterId from chathub_room where roomName like ?",
            (f"{room_prefix}%",),
        ).fetchall()
        user_ids = sorted({str(row["roomMasterId"]) for row in room_rows if row["roomMasterId"]})

    room_ids = [int(row["roomId"]) for row in room_rows if row["roomId"] is not None]
    conversation_ids = [str(row["conversationId"]) for row in room_rows if row["conversationId"]]

    if not room_ids and not user_ids:
        print("rooms=0 conversations=0 users=0 messages=0")
        sys.exit(0)

    message_count = 0
    if conversation_ids:
        placeholders = ",".join("?" for _ in conversation_ids)
        message_count = conn.execute(
            f"select count(*) from chatluna_message where conversationId in ({placeholders})",
            conversation_ids,
        ).fetchone()[0]

    with conn:
        if room_ids:
            room_placeholders = ",".join("?" for _ in room_ids)
            conn.execute(
                f"delete from chathub_room_group_member where roomId in ({room_placeholders})",
                room_ids,
            )
            conn.execute(
                f"delete from chathub_room_member where roomId in ({room_placeholders})",
                room_ids,
            )
            conn.execute(
                f"delete from chathub_room where roomId in ({room_placeholders})",
                room_ids,
            )

        if conversation_ids:
            conv_placeholders = ",".join("?" for _ in conversation_ids)
            conn.execute(
                f"delete from chatluna_message where conversationId in ({conv_placeholders})",
                conversation_ids,
            )
            conn.execute(
                f"delete from chatluna_conversation where id in ({conv_placeholders})",
                conversation_ids,
            )

        if user_ids:
            user_placeholders = ",".join("?" for _ in user_ids)
            conn.execute(
                f"update chathub_user set defaultRoomId = null where userId in ({user_placeholders})",
                user_ids,
            )
            conn.execute(
                f"delete from chathub_user where userId in ({user_placeholders})",
                user_ids,
            )

    print(
        f"rooms={len(room_ids)} conversations={len(conversation_ids)} users={len(user_ids)} messages={message_count}"
    )
finally:
    conn.close()
PY
