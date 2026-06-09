import type { Context, Session } from 'koishi';
import type { MemoryAddress, MemoryRecordType, MemoryVisibility } from '../../types/memory-v3.js';
import { buildMemoryContextBlock } from './format.js';
import type { MemoryV3StatusService } from './status.js';
import type { MemoryV3Store } from './store.js';

function commandAddress(session: Session): MemoryAddress | null {
  const userId = session.userId?.trim();
  const botSelfId = session.bot?.selfId?.trim() || session.selfId?.trim();
  const platform = session.platform?.trim() || 'unknown';
  if (!userId || !botSelfId) return null;
  if (session.isDirect) {
    return {
      userKey: `${platform}:user:${userId}`,
      contextKey: `${platform}:bot:${botSelfId}:dm:${userId}`,
      channelType: 'direct',
      platform,
      botSelfId,
      userId,
      groupId: null,
      channelId: session.channelId?.trim() || null,
      rawContextId: session.channelId?.trim() || userId,
      conversationId: `command:${session.messageId ?? Date.now()}`,
      observedAt: Date.now(),
    };
  }
  const groupKey = session.guildId?.trim() || session.channelId?.trim();
  if (!groupKey) return null;
  return {
    userKey: `${platform}:user:${userId}`,
    contextKey: `${platform}:bot:${botSelfId}:group:${groupKey}`,
    channelType: 'group',
    platform,
    botSelfId,
    userId,
    groupId: session.guildId?.trim() || null,
    channelId: session.channelId?.trim() || null,
    rawContextId: groupKey,
    conversationId: `command:${session.messageId ?? Date.now()}`,
    observedAt: Date.now(),
  };
}

function parseMemoryRef(raw: string | undefined): { type: MemoryRecordType; id: number } | null {
  const text = String(raw ?? '').trim();
  const match = /^(fact|episode):?(\d+)$/i.exec(text) ?? /^([fe])(\d+)$/i.exec(text);
  if (!match) return null;
  const prefix = match[1]?.toLowerCase();
  const type: MemoryRecordType = prefix === 'episode' || prefix === 'e' ? 'episode' : 'fact';
  const id = Math.floor(Number(match[2]));
  return Number.isFinite(id) && id > 0 ? { type, id } : null;
}

function isVisibility(value: string): value is MemoryVisibility {
  return [
    'global',
    'private_only',
    'source_context_only',
    'allowed_contexts',
    'denied_contexts',
    'pending_review',
    'archived',
  ].includes(value);
}

export function registerMemoryCommands(
  ctx: Context,
  store: MemoryV3Store,
  statusService: MemoryV3StatusService,
): void {
  ctx.command('memory', '长期记忆管理');

  ctx.command('memory.status', '查看长期记忆状态').action(async () => {
    const snapshot = await statusService.getSnapshot();
    return [
      `memory-v3: ${snapshot.enabled ? 'enabled' : 'disabled'}`,
      `read/write: ${snapshot.readEnabled ? 'on' : 'off'} / ${snapshot.writeEnabled ? 'on' : 'off'}`,
      `extract: ${snapshot.extractConfigured ? snapshot.extractModel : 'not configured'}`,
      `embedding: ${snapshot.embedConfigured ? snapshot.embedModel : 'not configured'}`,
      `jobs: extract ${snapshot.jobs.extractPending}/${snapshot.jobs.extractProcessing}, review ${snapshot.jobs.privacyReviewPending}, consolidate ${snapshot.jobs.consolidatePending}, embed ${snapshot.jobs.embedPending}/${snapshot.jobs.embedProcessing}, dead ${snapshot.jobs.deadLetter}`,
    ].join('\n');
  });

  ctx.command('memory.show [mode:text]', '查看长期记忆').action(async ({ session }, mode) => {
    if (!session) return '缺少会话。';
    const address = commandAddress(session);
    if (!address) return '无法识别当前会话。';
    if ((mode === 'private' || mode === 'export') && !session.isDirect) return '私密记忆只能在私聊查看。';
    const [facts, episodes] = await Promise.all([
      store.listFactsForUser(address.userKey),
      store.listEpisodesForUser(address.userKey),
    ]);
    const scopedFacts = mode === 'this-group'
      ? facts.filter((item) => item.sourceContextKey === address.contextKey)
      : facts;
    const scopedEpisodes = mode === 'this-group'
      ? episodes.filter((item) => item.sourceContextKey === address.contextKey)
      : episodes;
    const prompt = buildMemoryContextBlock(scopedFacts.slice(0, 20), scopedEpisodes.slice(0, 20), 1600);
    return prompt ?? '当前没有可展示的长期记忆。';
  });

  ctx.command('memory.forget <ref:text>', '忘记指定记忆').action(async ({ session }, ref) => {
    if (!session) return '缺少会话。';
    const address = commandAddress(session);
    const parsed = parseMemoryRef(ref);
    if (!address || !parsed) return '用法：memory.forget fact:1 或 memory.forget episode:2';
    const ok = await store.forgetMemory({ userKey: address.userKey, type: parsed.type, id: parsed.id });
    return ok ? '已删除并写入 tombstone。' : '找不到这条记忆。';
  });

  ctx.command('memory.forget-topic <topic:text>', '忘记一个 fact topic').action(async ({ session }, topic) => {
    if (!session) return '缺少会话。';
    const address = commandAddress(session);
    if (!address || !topic?.trim()) return '用法：memory.forget-topic <topicKey>';
    const count = await store.forgetTopic(address.userKey, topic.trim());
    return `已删除 ${count} 条 topic 记忆并写入 tombstone。`;
  });

  ctx.command('memory.forget-this-group', '忘记当前群来源记忆').action(async ({ session }) => {
    if (!session) return '缺少会话。';
    const address = commandAddress(session);
    if (!address || address.channelType !== 'group') return '这个命令只能在群聊里使用。';
    const count = await store.forgetContext(address.userKey, address.contextKey);
    return `已删除当前群来源的 ${count} 条记忆。`;
  });

  ctx.command('memory.forget-all', '忘记当前用户所有长期记忆').action(async ({ session }) => {
    if (!session || !session.isDirect) return '全部导出/删除只能在私聊中执行。';
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    const count = await store.forgetAll(address.userKey);
    return `已删除 ${count} 条长期记忆。`;
  });

  ctx.command('memory.visibility <ref:text> <visibility:text>', '修改记忆可见性').action(async ({ session }, ref, visibility) => {
    if (!session) return '缺少会话。';
    const address = commandAddress(session);
    const parsed = parseMemoryRef(ref);
    if (!address || !parsed || !visibility || !isVisibility(visibility)) {
      return '用法：memory.visibility fact:1 global|private_only|source_context_only|pending_review|archived';
    }
    const ok = await store.updateVisibility({ userKey: address.userKey, type: parsed.type, id: parsed.id, visibility });
    return ok ? '已更新可见性。' : '找不到这条记忆。';
  });

  ctx.command('memory.edit <ref:text> <content:text>', '编辑记忆内容').action(async ({ session }, ref, content) => {
    if (!session) return '缺少会话。';
    const address = commandAddress(session);
    const parsed = parseMemoryRef(ref);
    if (!address || !parsed || !content?.trim()) return '用法：memory.edit fact:1 新内容';
    const ok = await store.editMemory({ userKey: address.userKey, type: parsed.type, id: parsed.id, content });
    return ok ? '已更新内容并排队重新向量化。' : '找不到这条记忆。';
  });

  ctx.command('memory.review <candidateId:number> <action:text>', '审核待确认记忆').action(async ({ session }, candidateId, action) => {
    if (!session?.isDirect) return '审核只能在私聊中执行。';
    if (action !== 'approve' && action !== 'reject' && action !== 'private') {
      return 'action 必须是 approve、reject 或 private。';
    }
    const ok = await store.reviewCandidate({ candidateId: Number(candidateId), action });
    return ok ? '已更新审核状态。' : '找不到候选记忆。';
  });

  ctx.command('memory.export', '导出当前用户长期记忆').action(async ({ session }) => {
    if (!session?.isDirect) return '导出只能在私聊中执行。';
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    const [facts, episodes] = await Promise.all([
      store.listFactsForUser(address.userKey),
      store.listEpisodesForUser(address.userKey),
    ]);
    return JSON.stringify({ userKey: address.userKey, facts, episodes }, null, 2);
  });

  ctx.command('memory.pause', '暂停当前用户记忆写入').action(() => '当前版本请在控制台关闭用户 writeEnabled。');
  ctx.command('memory.resume', '恢复当前用户记忆写入').action(() => '当前版本请在控制台开启用户 writeEnabled。');
  ctx.command('memory.why', '查看召回来源').action(() => '召回来源会写入 memory_audit_event 的 recall_selected 事件。');
}
