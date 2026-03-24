#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${QQBOT_KOISHI_DB_PATH:-$ROOT_DIR/data/koishi.db}"
FAKE_USER_ID="${FAKE_USER_ID:-}"
CHAT_MODE="${1:-${CHAT_MODE:-}}"
ROOM_PREFIX="${ROOM_PREFIX:-codex-debug}"

usage() {
  cat <<'EOF'
Usage:
  FAKE_USER_ID=9123456789 prepare-debug-chat-state.sh tool_research_then_reply

Description:
  Ensure the probe private debug room exists for the fake user, pin its chatMode,
  and disable autoUpdate so local smoke can deterministically hit the target route.

Environment:
  QQBOT_KOISHI_DB_PATH  Override sqlite db path (default: data/koishi.db)
  FAKE_USER_ID          Required fake private-chat user id
  CHAT_MODE             Optional fallback for the positional chat mode
  ROOM_PREFIX           Debug room name prefix (default: codex-debug)
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

require_cmd python3

if [[ ! -f "$DB_PATH" ]]; then
  echo "[error] Missing database: $DB_PATH" >&2
  exit 1
fi

if [[ -z "$FAKE_USER_ID" ]] || ! [[ "$FAKE_USER_ID" =~ ^[0-9]+$ ]]; then
  echo "[error] FAKE_USER_ID must be a numeric user id." >&2
  exit 2
fi

if [[ -z "$CHAT_MODE" ]]; then
  echo "[error] Missing chat mode." >&2
  exit 2
fi

export DB_PATH FAKE_USER_ID CHAT_MODE ROOM_PREFIX

python3 <<'PY'
import os
import sqlite3
import time

db_path = os.environ['DB_PATH']
fake_user_id = os.environ['FAKE_USER_ID']
chat_mode = os.environ['CHAT_MODE'].strip()
room_prefix = os.environ['ROOM_PREFIX']
now = int(time.time() * 1000)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

try:
    rooms = conn.execute(
        """
        select roomId, conversationId
        from chathub_room
        where roomMasterId = ?
        order by updatedTime desc, roomId desc
        """,
        (fake_user_id,),
    ).fetchall()

    template = conn.execute(
        """
        select preset, model, password
        from chathub_room
        where model is not null
          and trim(model) != ''
          and preset is not null
          and trim(preset) != ''
        order by case when roomMasterId = '0' then 0 else 1 end, updatedTime desc, roomId desc
        limit 1
        """
    ).fetchone()

    preset = str(template['preset']) if template and template['preset'] else 'chatgpt'
    model = str(template['model']) if template and template['model'] else ''
    password = str(template['password']) if template and template['password'] else ''

    if not model:
        raise RuntimeError('no reusable room model found; cannot prepare debug room')

    updated_room_ids = []

    with conn:
        if rooms:
            for row in rooms:
                room_id = int(row['roomId'])
                conversation_id = str(row['conversationId']) if row['conversationId'] else f'codex-debug:{fake_user_id}:{room_id}'
                conn.execute(
                    """
                    update chathub_room
                    set conversationId = ?, chatMode = ?, autoUpdate = 0, updatedTime = ?
                    where roomId = ?
                    """,
                    (conversation_id, chat_mode, now, room_id),
                )
                conn.execute(
                    """
                    insert or ignore into chathub_conversation (id, latestId, additional_kwargs, updatedAt)
                    values (?, null, null, ?)
                    """,
                    (conversation_id, now),
                )
                conn.execute(
                    """
                    insert or ignore into chathub_room_member (userId, roomId, roomPermission, mute)
                    values (?, ?, 'owner', 0)
                    """,
                    (fake_user_id, room_id),
                )
                updated_room_ids.append(room_id)
        else:
            next_room_id = conn.execute(
                "select coalesce(max(roomId), 0) + 1 from chathub_room"
            ).fetchone()[0]
            conversation_id = f'codex-debug:{fake_user_id}'
            conn.execute(
                """
                insert into chathub_conversation (id, latestId, additional_kwargs, updatedAt)
                values (?, null, null, ?)
                """,
                (conversation_id, now),
            )
            conn.execute(
                """
                insert into chathub_room (
                  roomId, roomName, conversationId, roomMasterId, visibility,
                  preset, model, chatMode, password, autoUpdate, updatedTime
                ) values (?, ?, ?, ?, 'private', ?, ?, ?, ?, 0, ?)
                """,
                (
                    next_room_id,
                    f'{room_prefix}-{fake_user_id}',
                    conversation_id,
                    fake_user_id,
                    preset,
                    model,
                    chat_mode,
                    password,
                    now,
                ),
            )
            conn.execute(
                """
                insert into chathub_room_member (userId, roomId, roomPermission, mute)
                values (?, ?, 'owner', 0)
                """,
                (fake_user_id, next_room_id),
            )
            updated_room_ids.append(int(next_room_id))

        default_room_id = updated_room_ids[0]
        conn.execute(
            "delete from chathub_user where userId = ? and groupId is null",
            (fake_user_id,),
        )
        conn.execute(
            """
            insert into chathub_user (userId, defaultRoomId, groupId)
            values (?, ?, null)
            """,
            (fake_user_id, default_room_id),
        )

    print(f'rooms={len(updated_room_ids)} defaultRoomId={updated_room_ids[0]} chatMode={chat_mode}')
finally:
    conn.close()
PY
