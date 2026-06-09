#!/usr/bin/env tsx
import { copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseMemoryV2Scope } from '../src/plugins/memory/migration/parse-v2-scope.js';
import { decideMigratedVisibility } from '../src/plugins/memory/migration/policy.js';

type Row = Record<string, unknown>;

interface Args {
  db: string;
  backup: boolean;
  verify: boolean;
  dropV2Tables: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: './data/koishi.db',
    backup: false,
    verify: false,
    dropV2Tables: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--db') args.db = argv[++index] ?? args.db;
    else if (item === '--backup') args.backup = true;
    else if (item === '--verify') args.verify = true;
    else if (item === '--drop-v2-tables') args.dropV2Tables = true;
    else if (item === '--help' || item === '-h') {
      console.log('usage: pnpm tsx scripts/migrate-memory-v2-to-v3.ts --db ./data/koishi.db --backup [--verify] [--drop-v2-tables]');
      process.exit(0);
    }
  }
  return args;
}

function sqlString(value: unknown): string {
  if (value == null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value: unknown, fallback = 0): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : String(fallback);
}

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
}

function execSql(dbPath: string, sql: string): void {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
}

function queryRows(dbPath: string, table: string): Row[] {
  try {
    const output = sqlite(dbPath, `SELECT * FROM ${table};`);
    return output ? JSON.parse(output) as Row[] : [];
  } catch {
    return [];
  }
}

function ensureTables(dbPath: string): void {
  execSql(dbPath, `
CREATE TABLE IF NOT EXISTS memory_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userKey TEXT NOT NULL,
  platform TEXT NOT NULL,
  userId TEXT NOT NULL,
  firstSeenAt REAL NOT NULL,
  lastSeenAt REAL NOT NULL,
  readEnabled INTEGER NOT NULL,
  writeEnabled INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_user_userKey_idx ON memory_user(userKey);
CREATE TABLE IF NOT EXISTS memory_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contextKey TEXT NOT NULL,
  platform TEXT NOT NULL,
  botSelfId TEXT NOT NULL,
  channelType TEXT NOT NULL,
  groupId TEXT,
  channelId TEXT,
  rawContextId TEXT,
  firstSeenAt REAL NOT NULL,
  lastSeenAt REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_context_contextKey_idx ON memory_context(contextKey);
CREATE TABLE IF NOT EXISTS memory_fact_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userKey TEXT NOT NULL,
  kind TEXT NOT NULL,
  topicKey TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  visibility TEXT NOT NULL,
  sourceContextKey TEXT NOT NULL,
  allowedContextKeys TEXT,
  deniedContextKeys TEXT,
  applicability TEXT,
  validFrom REAL,
  validUntil REAL,
  expiresAt REAL,
  firstSeenAt REAL NOT NULL,
  lastSeenAt REAL NOT NULL,
  lastAccessedAt REAL,
  embeddingModel TEXT,
  embedding TEXT,
  version INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  supersedesId INTEGER,
  conflictSetId TEXT
);
CREATE TABLE IF NOT EXISTS memory_episode_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userKey TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  keywords TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  visibility TEXT NOT NULL,
  sourceContextKey TEXT NOT NULL,
  allowedContextKeys TEXT,
  deniedContextKeys TEXT,
  applicability TEXT,
  periodStart REAL,
  periodEnd REAL,
  validFrom REAL,
  validUntil REAL,
  expiresAt REAL,
  firstSeenAt REAL NOT NULL,
  lastSeenAt REAL NOT NULL,
  lastAccessedAt REAL,
  embeddingModel TEXT,
  embedding TEXT,
  version INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  supersedesId INTEGER,
  conflictSetId TEXT
);
CREATE TABLE IF NOT EXISTS memory_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userKey TEXT NOT NULL,
  contextKey TEXT NOT NULL,
  memoryType TEXT NOT NULL,
  memoryId INTEGER NOT NULL,
  candidateId INTEGER,
  conversationId TEXT,
  messageIds TEXT,
  source TEXT NOT NULL,
  createdAt REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_job_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobKey TEXT NOT NULL,
  jobType TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  retryCount INTEGER NOT NULL,
  nextRunAt REAL NOT NULL,
  lockedAt REAL,
  lastError TEXT,
  createdAt REAL NOT NULL,
  updatedAt REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_audit_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userKey TEXT,
  contextKey TEXT,
  eventType TEXT NOT NULL,
  memoryType TEXT,
  memoryId INTEGER,
  candidateId INTEGER,
  turnId TEXT,
  detail TEXT,
  createdAt REAL NOT NULL
);
`);
}

function upsertUserAndContext(dbPath: string, scope: NonNullable<ReturnType<typeof parseMemoryV2Scope>>, timestamp: number): void {
  execSql(dbPath, `
INSERT INTO memory_user(userKey, platform, userId, firstSeenAt, lastSeenAt, readEnabled, writeEnabled)
SELECT ${sqlString(scope.userKey)}, ${sqlString(scope.platform)}, ${sqlString(scope.userId)}, ${timestamp}, ${timestamp}, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM memory_user WHERE userKey = ${sqlString(scope.userKey)});
UPDATE memory_user SET lastSeenAt = MAX(lastSeenAt, ${timestamp}) WHERE userKey = ${sqlString(scope.userKey)};
INSERT INTO memory_context(contextKey, platform, botSelfId, channelType, groupId, channelId, rawContextId, firstSeenAt, lastSeenAt)
SELECT ${sqlString(scope.contextKey)}, ${sqlString(scope.platform)}, ${sqlString(scope.botSelfId)}, ${sqlString(scope.scopeType === 'user' ? 'direct' : 'group')}, ${sqlString(scope.groupId)}, ${sqlString(scope.groupId)}, ${sqlString(scope.groupId ?? scope.userId)}, ${timestamp}, ${timestamp}
WHERE NOT EXISTS (SELECT 1 FROM memory_context WHERE contextKey = ${sqlString(scope.contextKey)});
UPDATE memory_context SET lastSeenAt = MAX(lastSeenAt, ${timestamp}) WHERE contextKey = ${sqlString(scope.contextKey)};
`);
}

function migrateFacts(dbPath: string): number {
  let count = 0;
  for (const row of queryRows(dbPath, 'memory_fact')) {
    const scope = parseMemoryV2Scope(String(row.scopeType ?? ''), String(row.scopeKey ?? ''));
    if (!scope) continue;
    const content = String(row.content ?? '').trim();
    if (!content) continue;
    const policy = decideMigratedVisibility({ scope, content, archived: Number(row.archived ?? 0) });
    if (policy.drop) continue;
    const firstSeenAt = Number(row.firstSeenAt ?? Date.now());
    const lastSeenAt = Number(row.lastSeenAt ?? firstSeenAt);
    upsertUserAndContext(dbPath, scope, lastSeenAt);
    execSql(dbPath, `
INSERT INTO memory_fact_v3(userKey, kind, topicKey, content, keywords, importance, confidence, sensitivity, visibility, sourceContextKey, allowedContextKeys, deniedContextKeys, applicability, validFrom, validUntil, expiresAt, firstSeenAt, lastSeenAt, lastAccessedAt, embeddingModel, embedding, version, archived, supersedesId, conflictSetId)
VALUES (${sqlString(scope.userKey)}, ${sqlString(row.kind ?? 'preference')}, ${sqlString(row.topicKey ?? 'memory-fact')}, ${sqlString(content)}, ${sqlString(row.keywords)}, ${sqlNumber(row.importance, 0.6)}, ${sqlNumber(row.confidence, 0.8)}, ${sqlString(policy.sensitivity)}, ${sqlString(policy.visibility)}, ${sqlString(scope.contextKey)}, NULL, NULL, NULL, NULL, NULL, NULL, ${sqlNumber(firstSeenAt)}, ${sqlNumber(lastSeenAt)}, NULL, NULL, NULL, ${sqlNumber(row.version, 1)}, ${Number(policy.visibility === 'archived')}, NULL, NULL);
INSERT INTO memory_provenance(userKey, contextKey, memoryType, memoryId, candidateId, conversationId, messageIds, source, createdAt)
VALUES (${sqlString(scope.userKey)}, ${sqlString(scope.contextKey)}, 'fact', (SELECT MAX(id) FROM memory_fact_v3), NULL, NULL, ${sqlString(row.sourceMessageIds)}, 'migration', ${Date.now()});
INSERT INTO memory_audit_event(userKey, contextKey, eventType, memoryType, memoryId, candidateId, turnId, detail, createdAt)
VALUES (${sqlString(scope.userKey)}, ${sqlString(scope.contextKey)}, 'migration_import', 'fact', (SELECT MAX(id) FROM memory_fact_v3), NULL, NULL, ${sqlString(JSON.stringify({ from: 'memory-v2', reason: policy.reason }))}, ${Date.now()});
INSERT INTO memory_job_v3(jobKey, jobType, status, payload, retryCount, nextRunAt, lockedAt, lastError, createdAt, updatedAt)
VALUES ('reembed:fact:' || (SELECT MAX(id) FROM memory_fact_v3), 'reembed', 'pending', json_object('recordType','fact','recordId',(SELECT MAX(id) FROM memory_fact_v3)), 0, ${Date.now()}, NULL, NULL, ${Date.now()}, ${Date.now()});
`);
    count += 1;
  }
  return count;
}

function migrateEpisodes(dbPath: string): number {
  let count = 0;
  for (const row of queryRows(dbPath, 'memory_episode')) {
    const scope = parseMemoryV2Scope(String(row.scopeType ?? ''), String(row.scopeKey ?? ''));
    if (!scope) continue;
    const summary = String(row.summary ?? '').trim();
    if (!summary) continue;
    const policy = decideMigratedVisibility({ scope, content: summary, archived: Number(row.archived ?? 0) });
    if (policy.drop) continue;
    const firstSeenAt = Number(row.firstSeenAt ?? Date.now());
    const lastSeenAt = Number(row.lastSeenAt ?? firstSeenAt);
    upsertUserAndContext(dbPath, scope, lastSeenAt);
    execSql(dbPath, `
INSERT INTO memory_episode_v3(userKey, title, summary, keywords, importance, confidence, sensitivity, visibility, sourceContextKey, allowedContextKeys, deniedContextKeys, applicability, periodStart, periodEnd, validFrom, validUntil, expiresAt, firstSeenAt, lastSeenAt, lastAccessedAt, embeddingModel, embedding, version, archived, supersedesId, conflictSetId)
VALUES (${sqlString(scope.userKey)}, ${sqlString(row.title ?? '迁移事件')}, ${sqlString(summary)}, ${sqlString(row.keywords)}, ${sqlNumber(row.importance, 0.62)}, ${sqlNumber(row.confidence, 0.8)}, ${sqlString(policy.sensitivity)}, ${sqlString(policy.visibility)}, ${sqlString(scope.contextKey)}, NULL, NULL, NULL, ${row.periodStart == null ? 'NULL' : sqlNumber(row.periodStart)}, ${row.periodEnd == null ? 'NULL' : sqlNumber(row.periodEnd)}, NULL, NULL, NULL, ${sqlNumber(firstSeenAt)}, ${sqlNumber(lastSeenAt)}, ${row.lastAccessedAt == null ? 'NULL' : sqlNumber(row.lastAccessedAt)}, NULL, NULL, 1, ${Number(policy.visibility === 'archived')}, NULL, NULL);
INSERT INTO memory_provenance(userKey, contextKey, memoryType, memoryId, candidateId, conversationId, messageIds, source, createdAt)
VALUES (${sqlString(scope.userKey)}, ${sqlString(scope.contextKey)}, 'episode', (SELECT MAX(id) FROM memory_episode_v3), NULL, NULL, ${sqlString(row.sourceMessageIds)}, 'migration', ${Date.now()});
INSERT INTO memory_audit_event(userKey, contextKey, eventType, memoryType, memoryId, candidateId, turnId, detail, createdAt)
VALUES (${sqlString(scope.userKey)}, ${sqlString(scope.contextKey)}, 'migration_import', 'episode', (SELECT MAX(id) FROM memory_episode_v3), NULL, NULL, ${sqlString(JSON.stringify({ from: 'memory-v2', reason: policy.reason }))}, ${Date.now()});
INSERT INTO memory_job_v3(jobKey, jobType, status, payload, retryCount, nextRunAt, lockedAt, lastError, createdAt, updatedAt)
VALUES ('reembed:episode:' || (SELECT MAX(id) FROM memory_episode_v3), 'reembed', 'pending', json_object('recordType','episode','recordId',(SELECT MAX(id) FROM memory_episode_v3)), 0, ${Date.now()}, NULL, NULL, ${Date.now()}, ${Date.now()});
`);
    count += 1;
  }
  return count;
}

function verify(dbPath: string): void {
  const output = sqlite(dbPath, `
SELECT 'users' AS name, COUNT(*) AS count FROM memory_user
UNION ALL SELECT 'facts', COUNT(*) FROM memory_fact_v3
UNION ALL SELECT 'episodes', COUNT(*) FROM memory_episode_v3
UNION ALL SELECT 'jobs', COUNT(*) FROM memory_job_v3
UNION ALL SELECT 'audit', COUNT(*) FROM memory_audit_event;
`);
  console.log(output);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  if (args.backup) {
    const backupPath = `${dbPath}.memory-v2-backup-${Date.now()}`;
    copyFileSync(dbPath, backupPath);
    console.log(`backup: ${backupPath}`);
  }
  ensureTables(dbPath);
  const factCount = migrateFacts(dbPath);
  const episodeCount = migrateEpisodes(dbPath);
  console.log(`migrated facts=${factCount} episodes=${episodeCount}`);
  if (args.verify) verify(dbPath);
  if (args.dropV2Tables) {
    execSql(dbPath, 'DROP TABLE IF EXISTS memory_fact; DROP TABLE IF EXISTS memory_episode; DROP TABLE IF EXISTS memory_job;');
    console.log('dropped legacy memory tables');
  }
}

main();
