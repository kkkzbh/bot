import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chatluna room membership repair wiring', () => {
  it('writes defaultRoomId after room membership creation in joinConversationRoom', () => {
    const source = readFileSync(
      join(process.cwd(), '../chatluna/packages/core/src/chains/rooms.ts'),
      'utf8',
    );

    const memberCreateIndex = source.indexOf("await ctx.database.create('chathub_room_member'");
    const userUpsertIndex = source.lastIndexOf("await ctx.database.upsert('chathub_user'");

    expect(memberCreateIndex).toBeGreaterThan(-1);
    expect(userUpsertIndex).toBeGreaterThan(-1);
    expect(userUpsertIndex).toBeGreaterThan(memberCreateIndex);
  });

  it('repairs missing room membership in check_room before returning not_in_room', () => {
    const source = readFileSync(
      join(process.cwd(), '../chatluna/packages/core/src/middlewares/room/check_room.ts'),
      'utf8',
    );

    const repairIndex = source.indexOf('await joinConversationRoom(ctx, session, room)');
    const notInRoomIndex = source.indexOf("context.message = session.text('chatluna.room.not_in_room'");

    expect(source).toContain('joinConversationRoom');
    expect(repairIndex).toBeGreaterThan(-1);
    expect(notInRoomIndex).toBeGreaterThan(-1);
    expect(repairIndex).toBeLessThan(notInRoomIndex);
  });
});
