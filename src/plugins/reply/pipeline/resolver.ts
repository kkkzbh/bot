import { normalizeMention, sanitizeStructuredReplySegmentContent } from '../../shared/outbound/index.js';
import type { ResolvedAction, StructuredReply, TurnContext } from './types.js';

export class ActionResolverService {
  resolve(reply: StructuredReply, turnContext: TurnContext): ResolvedAction[] {
    if (reply.decision === 'no_reply') {
      return [{ kind: 'no_reply' }];
    }

    const messages = reply.messages ?? [];
    if (!messages.length) {
      throw new Error('structured reply with decision=reply must include at least one message.');
    }

    const resolved: ResolvedAction[] = [];
    const capabilitySnapshot = turnContext.capabilitySnapshot;
    const canMultiline = capabilitySnapshot?.canMultiline === true;
    const canVoice = capabilitySnapshot?.canVoice === true;
    const canSticker = capabilitySnapshot?.canSticker === true && (capabilitySnapshot?.stickerAvailableCount ?? 0) > 0;

    for (const message of messages) {
      if (message.modality === 'mention') {
        const mention = normalizeMention({
          userId: message.userId,
          content: message.content,
        });
        if (!mention) {
          continue;
        }
        resolved.push({ kind: 'mention', mention });
        continue;
      }

      const content = sanitizeStructuredReplySegmentContent(message.content);
      if (!content) {
        continue;
      }

      if (message.modality === 'voice') {
        if (!canVoice) {
          throw new Error('structured reply requested voice output but voice capability is unavailable.');
        }
        resolved.push({ kind: 'voice', content });
        continue;
      }

      if (message.modality === 'meme') {
        if (!canSticker) {
          throw new Error('structured reply requested meme output but sticker capability is unavailable.');
        }
        resolved.push({ kind: 'sticker', intent: content });
        continue;
      }

      if (message.modality === 'multiline') {
        if (!canMultiline) {
          throw new Error('structured reply requested multiline output but multiline capability is unavailable.');
        }
        resolved.push({
          kind: 'multiline',
          semantic: message.semantic,
          content,
        });
        continue;
      }

      resolved.push({ kind: 'text', content });
    }

    if (!resolved.length) {
      return [{ kind: 'no_reply' }];
    }

    return resolved;
  }
}
