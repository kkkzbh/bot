import { sanitizeStructuredReplySegmentContent } from '../../shared/outbound/index.js';
import type { ResolvedAction, StructuredReplyV1, TurnContext } from './types.js';

export class ActionResolverService {
  resolve(reply: StructuredReplyV1, turnContext: TurnContext): ResolvedAction[] {
    if (reply.decision === 'no_reply') {
      return [{ kind: 'no_reply' }];
    }

    const messages = reply.messages ?? [];
    if (!messages.length) {
      throw new Error('structured reply with decision=reply must include at least one message.');
    }

    const resolved: ResolvedAction[] = [];
    const capabilitySnapshot = turnContext.capabilitySnapshot;
    const canVoice = capabilitySnapshot?.canVoice === true;
    const canSticker = capabilitySnapshot?.canSticker === true && (capabilitySnapshot?.stickerAvailableCount ?? 0) > 0;

    for (const message of messages) {
      const content = sanitizeStructuredReplySegmentContent(message.content);
      if (!content) {
        throw new Error(`structured reply ${message.modality} message is empty after normalization.`);
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

      resolved.push({ kind: 'text', content });
    }

    if (!resolved.length) {
      throw new Error('structured reply resolved to zero executable actions.');
    }

    return resolved;
  }
}
