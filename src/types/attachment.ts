import 'koishi';
import type { BaseMessage } from '@langchain/core/messages';

export type QqbotAttachmentKind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'file';

export type QqbotAttachmentDerivativeKind =
  | 'pdf_text'
  | 'pdf_page_preview'
  | 'text_excerpt'
  | 'audio_transcript';

export interface QqbotAttachmentRecord {
  id: number;
  refId: string;
  conversationId: string;
  messageRole: string;
  messageId: string | null;
  senderId: string | null;
  senderName: string | null;
  kind: QqbotAttachmentKind;
  filename: string | null;
  mimeType: string | null;
  storageFileId: string;
  storageUrl: string;
  byteSize: number;
  hash: string | null;
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface QqbotAttachmentDerivativeRecord {
  id: number;
  attachmentRefId: string;
  kind: QqbotAttachmentDerivativeKind;
  orderIndex: number;
  mimeType: string | null;
  storageFileId: string | null;
  storageUrl: string | null;
  textContent: string | null;
  metadata: string | null;
  byteSize: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface QqbotAttachmentProviderCacheRecord {
  id: number;
  attachmentRefId: string;
  representationKey: string;
  provider: string;
  fileId: string;
  mimeType: string | null;
  detail: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface QqbotAttachmentRef {
  refId: string;
  kind: QqbotAttachmentKind;
  filename: string | null;
  mimeType: string | null;
  storageFileId: string;
  storageUrl: string;
  byteSize: number;
  hash: string | null;
  createdAt: number;
  senderId?: string | null;
  senderName?: string | null;
}

export interface QqbotResolvedAttachmentSelection {
  selected: QqbotAttachmentRecord[];
  ambiguous: QqbotAttachmentRecord[];
  requestedCount: number;
  kindHint: QqbotAttachmentKind | 'attachment' | null;
  reason: 'explicit_ref' | 'filename' | 'relative_latest' | 'relative_batch' | 'none';
}

export interface QqbotAttachmentContextProjection {
  refId: string;
  kind: QqbotAttachmentKind;
  filename: string | null;
  mimeType: string | null;
  byteSize: number;
  createdAt: number;
  senderName: string | null;
  processedText: string | null;
  summaryText: string | null;
  replayable: boolean;
  providerRepresentations: string[];
}

export interface QqbotAttachmentReplayItem {
  refId: string;
  kind: QqbotAttachmentKind;
  filename: string | null;
  representationKind: 'text' | 'image_url' | 'file_url';
  provider: string;
  providerHandle: string;
  fileId: string | null;
  url: string | null;
  mimeType: string | null;
  processedText: string | null;
  summaryText: string | null;
  expiresAt?: number | null;
  cacheHit: boolean;
}

export interface QqbotAttachmentReplaySkip {
  refId: string;
  reason: string;
}

export interface QqbotRequestBudgetPolicy {
  historyWindow: number;
  historyTriggerCount: number;
  historyTokenRatio: number;
}

export interface QqbotAttachmentServiceLike {
  archiveMessageAttachments(args: {
    conversationId: string;
    message: BaseMessage;
  }): Promise<QqbotAttachmentRef[]>;
  listRecentAttachments(conversationId: string, limit: number): Promise<QqbotAttachmentRecord[]>;
  resolveReferencedAttachments(args: {
    conversationId: string;
    userText: string;
    limit: number;
    recent?: QqbotAttachmentRecord[];
  }): Promise<QqbotResolvedAttachmentSelection>;
  buildAttachmentContextMessages(args: {
    attachments: QqbotAttachmentRecord[];
    userText: string;
    maxInjectTotalBytes: number;
    maxInjectPerFileBytes: number;
    maxPdfPreviewPagesPerFile: number;
    maxPdfPreviewPagesTotal: number;
    maxTextCharsPerFile: number;
  }): Promise<{
    messages: BaseMessage[];
    projections: QqbotAttachmentContextProjection[];
    injected: QqbotAttachmentRecord[];
    skipped: Array<{ refId: string; reason: string }>;
  }>;
  replayAttachments(args: {
    conversationId: string;
    refs: string[];
    purpose: string;
    provider: string;
  }): Promise<{
    resolved: QqbotAttachmentReplayItem[];
    skipped: QqbotAttachmentReplaySkip[];
    cacheHits: number;
  }>;
}

declare module 'koishi' {
  interface Tables {
    qqbot_attachment: QqbotAttachmentRecord;
    qqbot_attachment_derivative: QqbotAttachmentDerivativeRecord;
    qqbot_attachment_provider_cache: QqbotAttachmentProviderCacheRecord;
  }

  interface Context {
    qqbotAttachment?: QqbotAttachmentServiceLike;
  }
}
