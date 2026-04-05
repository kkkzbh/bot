export {
  extractFirstIncomingVoice,
  extractTextContentWithoutVoice,
  mergeVoiceInputText,
  type IncomingVoiceElement,
} from '../../shared/voice/index.js';

const NEGATIVE_STYLE_KEYWORDS = [
  '与你无关',
  '请别问了',
  '失陪了',
  '不方便',
  '不想',
  '不要',
  '别再',
  '闭嘴',
  '烦',
  '讨厌',
  '滚',
  '免了',
  '算了',
  '拒绝',
  '住口',
];
const WHITESPACE_PATTERN = /\s+/g;
const UNIT_SPOKEN_MAP: Record<string, string> = {
  cm: '厘米',
  mm: '毫米',
  m: '米',
  km: '公里',
  kg: '千克',
  g: '克',
  '%': '百分之',
};
const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
const CHINESE_SMALL_UNITS = ['', '十', '百', '千'] as const;
const CHINESE_SECTION_UNITS = ['', '万', '亿', '兆'] as const;

export type VoiceStyle = 'white' | 'black';

export function pickVoiceStyle(text: string): VoiceStyle {
  const normalized = text.replace(WHITESPACE_PATTERN, '');
  return NEGATIVE_STYLE_KEYWORDS.some((keyword) => normalized.includes(keyword)) ? 'black' : 'white';
}

function integerToChinese(raw: string): string {
  const normalized = raw.replace(/^0+/, '') || '0';
  if (normalized === '0') return CHINESE_DIGITS[0];

  const digits = normalized.split('').map((char) => Number(char));
  const sections: string[] = [];

  for (let offset = digits.length; offset > 0; offset -= 4) {
    const start = Math.max(0, offset - 4);
    sections.unshift(digits.slice(start, offset).join(''));
  }

  let result = '';
  let pendingZero = false;

  sections.forEach((section, sectionIndex) => {
    const value = Number(section);
    if (!value) {
      pendingZero = result.length > 0;
      return;
    }

    let sectionText = '';
    const padded = section.padStart(4, '0');
    for (let index = 0; index < padded.length; index += 1) {
      const digit = Number(padded[index]);
      const unitIndex = padded.length - index - 1;
      if (!digit) {
        if (sectionText && !sectionText.endsWith(CHINESE_DIGITS[0])) {
          sectionText += CHINESE_DIGITS[0];
        }
        continue;
      }

      sectionText = sectionText.replace(/零+$/u, '');
      sectionText += `${CHINESE_DIGITS[digit]}${CHINESE_SMALL_UNITS[unitIndex]}`;
    }

    sectionText = sectionText.replace(/零+$/u, '');
    if (!sectionText) return;
    if (pendingZero && !result.endsWith(CHINESE_DIGITS[0])) {
      result += CHINESE_DIGITS[0];
    }
    pendingZero = false;
    result += `${sectionText}${CHINESE_SECTION_UNITS[sections.length - sectionIndex - 1]}`;
  });

  return result.replace(/^一十/u, '十').replace(/零+/gu, '零').replace(/零$/u, '');
}

function decimalToChinese(raw: string): string {
  const [integerPart, decimalPart] = raw.split('.');
  if (!decimalPart) return integerToChinese(integerPart);
  return `${integerToChinese(integerPart)}点${decimalPart
    .split('')
    .map((char) => CHINESE_DIGITS[Number(char)] ?? char)
    .join('')}`;
}

function normalizeVoiceMeasurements(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?)\s*(cm|mm|km|kg|m|g|%)/gi, (_, numberPart: string, unit: string) => {
    const normalizedUnit = unit.toLowerCase();
    if (normalizedUnit === '%') {
      return `百分之${decimalToChinese(numberPart)}`;
    }
    return `${decimalToChinese(numberPart)}${UNIT_SPOKEN_MAP[normalizedUnit] ?? unit}`;
  });
}

export function normalizeVoiceSynthesisText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  return normalizeVoiceMeasurements(normalized);
}

export function buildVoiceFailureReply(kind: 'too-long' | 'empty' | 'broken', maxSeconds = 60): string {
  switch (kind) {
    case 'too-long':
      return `……这段语音未免太长了些\n请控制在${maxSeconds}秒以内\n我可没有空听你漫无边际地拖下去`;
    case 'empty':
      return '……你这段语音里几乎什么都没有\n要么重新说清楚\n要么直接打字';
    case 'broken':
    default:
      return '……这段语音我没听清\n若还想让我回答\n就重新说一遍';
  }
}
