import type { Context } from 'koishi';

export function ensureMemoryV3Tables(ctx: Context): void {
  ctx.model.extend(
    'memory_user',
    {
      id: 'unsigned',
      userKey: 'string',
      platform: 'string',
      userId: 'string',
      firstSeenAt: 'double',
      lastSeenAt: 'double',
      readEnabled: 'unsigned',
      writeEnabled: 'unsigned',
    },
    {
      autoInc: true,
      indexes: [['userKey']],
    },
  );

  ctx.model.extend(
    'memory_context',
    {
      id: 'unsigned',
      contextKey: 'string',
      platform: 'string',
      botSelfId: 'string',
      channelType: 'string',
      groupId: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      rawContextId: { type: 'string', nullable: true },
      firstSeenAt: 'double',
      lastSeenAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['contextKey'], ['platform', 'channelType']],
    },
  );

  ctx.model.extend(
    'memory_candidate_v3',
    {
      id: 'unsigned',
      batchId: 'string',
      candidateType: 'string',
      userKey: 'string',
      contextKey: 'string',
      conversationId: 'string',
      messageIds: { type: 'text', nullable: true },
      payload: 'text',
      reviewStatus: 'string',
      sensitivity: 'string',
      suggestedVisibility: 'string',
      finalVisibility: { type: 'string', nullable: true },
      dropReason: { type: 'text', nullable: true },
      providerRoute: 'string',
      rawTextHash: { type: 'string', nullable: true },
      createdAt: 'double',
      reviewedAt: { type: 'double', nullable: true },
      consolidatedAt: { type: 'double', nullable: true },
    },
    {
      autoInc: true,
      indexes: [['userKey', 'reviewStatus', 'createdAt'], ['batchId'], ['contextKey', 'reviewStatus']],
    },
  );

  ctx.model.extend(
    'memory_fact_v3',
    {
      id: 'unsigned',
      userKey: 'string',
      kind: 'string',
      topicKey: 'string',
      content: 'text',
      keywords: { type: 'text', nullable: true },
      importance: 'double',
      confidence: 'double',
      sensitivity: 'string',
      visibility: 'string',
      sourceContextKey: 'string',
      allowedContextKeys: { type: 'text', nullable: true },
      deniedContextKeys: { type: 'text', nullable: true },
      applicability: { type: 'text', nullable: true },
      validFrom: { type: 'double', nullable: true },
      validUntil: { type: 'double', nullable: true },
      expiresAt: { type: 'double', nullable: true },
      firstSeenAt: 'double',
      lastSeenAt: 'double',
      lastAccessedAt: { type: 'double', nullable: true },
      embeddingModel: { type: 'string', nullable: true },
      embedding: { type: 'text', nullable: true },
      version: 'unsigned',
      archived: 'unsigned',
      supersedesId: { type: 'unsigned', nullable: true },
      conflictSetId: { type: 'string', nullable: true },
    },
    {
      autoInc: true,
      indexes: [
        ['userKey', 'archived'],
        ['userKey', 'kind', 'topicKey', 'archived'],
        ['userKey', 'visibility', 'sensitivity', 'archived'],
        ['conflictSetId'],
        ['lastAccessedAt'],
      ],
    },
  );

  ctx.model.extend(
    'memory_episode_v3',
    {
      id: 'unsigned',
      userKey: 'string',
      title: 'string',
      summary: 'text',
      keywords: { type: 'text', nullable: true },
      importance: 'double',
      confidence: 'double',
      sensitivity: 'string',
      visibility: 'string',
      sourceContextKey: 'string',
      allowedContextKeys: { type: 'text', nullable: true },
      deniedContextKeys: { type: 'text', nullable: true },
      applicability: { type: 'text', nullable: true },
      periodStart: { type: 'double', nullable: true },
      periodEnd: { type: 'double', nullable: true },
      validFrom: { type: 'double', nullable: true },
      validUntil: { type: 'double', nullable: true },
      expiresAt: { type: 'double', nullable: true },
      firstSeenAt: 'double',
      lastSeenAt: 'double',
      lastAccessedAt: { type: 'double', nullable: true },
      embeddingModel: { type: 'string', nullable: true },
      embedding: { type: 'text', nullable: true },
      version: 'unsigned',
      archived: 'unsigned',
      supersedesId: { type: 'unsigned', nullable: true },
      conflictSetId: { type: 'string', nullable: true },
    },
    {
      autoInc: true,
      indexes: [
        ['userKey', 'archived'],
        ['userKey', 'sourceContextKey', 'archived'],
        ['userKey', 'visibility', 'sensitivity', 'archived'],
        ['periodStart'],
        ['lastAccessedAt'],
      ],
    },
  );

  ctx.model.extend(
    'memory_provenance',
    {
      id: 'unsigned',
      userKey: 'string',
      contextKey: 'string',
      memoryType: 'string',
      memoryId: 'unsigned',
      candidateId: { type: 'unsigned', nullable: true },
      conversationId: { type: 'string', nullable: true },
      messageIds: { type: 'text', nullable: true },
      source: 'string',
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['memoryType', 'memoryId'], ['userKey', 'contextKey'], ['conversationId']],
    },
  );

  ctx.model.extend(
    'memory_job_v3',
    {
      id: 'unsigned',
      jobKey: 'string',
      jobType: 'string',
      status: 'string',
      payload: 'text',
      retryCount: 'unsigned',
      nextRunAt: 'double',
      lockedAt: { type: 'double', nullable: true },
      lastError: { type: 'text', nullable: true },
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['jobType', 'status', 'nextRunAt'], ['jobKey'], ['status', 'lockedAt']],
    },
  );

  ctx.model.extend(
    'memory_audit_event',
    {
      id: 'unsigned',
      userKey: { type: 'string', nullable: true },
      contextKey: { type: 'string', nullable: true },
      eventType: 'string',
      memoryType: { type: 'string', nullable: true },
      memoryId: { type: 'unsigned', nullable: true },
      candidateId: { type: 'unsigned', nullable: true },
      turnId: { type: 'string', nullable: true },
      detail: { type: 'text', nullable: true },
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['userKey', 'contextKey', 'createdAt'], ['eventType', 'createdAt'], ['turnId']],
    },
  );

  ctx.model.extend(
    'memory_tombstone',
    {
      id: 'unsigned',
      userKey: 'string',
      contextKey: { type: 'string', nullable: true },
      memoryType: 'string',
      memoryId: { type: 'unsigned', nullable: true },
      topicKey: { type: 'string', nullable: true },
      sourceMessageId: { type: 'string', nullable: true },
      reason: { type: 'text', nullable: true },
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['userKey', 'memoryType', 'topicKey'], ['userKey', 'contextKey'], ['createdAt']],
    },
  );
}
