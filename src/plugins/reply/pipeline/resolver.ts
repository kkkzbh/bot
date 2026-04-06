import { sanitizeStructuredReplyText } from '../../shared/outbound/index.js';
import type { ResolvedAction, StructuredReply, TurnContext } from './types.js';

function normalizeMentionIds(mentions: string[] | undefined): string[] {
  return (mentions ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

export class ActionResolverService {
  resolve(reply: StructuredReply, turnContext: TurnContext): ResolvedAction[] {
    if (reply.decision === 'no_reply') {
      return [{ kind: 'no_reply' }];
    }

    const messages = reply.outbound_messages ?? [];
    if (!messages.length) {
      throw new Error('structured reply with decision=reply must include at least one outbound message.');
    }

    const resolved: ResolvedAction[] = [];
    const capabilitySnapshot = turnContext.capabilitySnapshot;
    const canVoice = capabilitySnapshot?.canVoice === true;
    const canSticker = capabilitySnapshot?.canSticker === true && (capabilitySnapshot?.stickerAvailableCount ?? 0) > 0;

    for (const message of messages) {
      if (message.type === 'voice') {
        const content = sanitizeStructuredReplyText(message.content, 'voice');
        if (!content) continue;
        if (!canVoice) {
          throw new Error('structured reply requested voice output but voice capability is unavailable.');
        }
        resolved.push({ kind: 'voice', content });
        continue;
      }

      if (message.type === 'meme') {
        const content = sanitizeStructuredReplyText(message.content, 'meme');
        if (!content) continue;
        if (!canSticker) {
          throw new Error('structured reply requested meme output but sticker capability is unavailable.');
        }
        resolved.push({ kind: 'sticker', intent: content });
        continue;
      }

      if (message.type === 'structured_block') {
        const content = sanitizeStructuredReplyText(message.content, 'structured_block');
        if (!content) continue;
        resolved.push({
          kind: 'structured_block',
          content,
        });
        continue;
      }

      const content = sanitizeStructuredReplyText(message.content, 'message');
      const mentions = normalizeMentionIds(message.mentions);
      if (!content && !mentions.length) {
        continue;
      }

      resolved.push({
        kind: 'message',
        content,
        mentions,
      });
    }

    if (!resolved.length) {
      return [{ kind: 'no_reply' }];
    }

    return resolved;
  }
}
