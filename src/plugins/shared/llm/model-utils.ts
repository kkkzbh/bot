export function resolvePlatform(model?: string): string | null {
  if (!model) return null;
  const value = model.trim();
  if (!value) return null;
  const index = value.indexOf('/');
  if (index <= 0) return null;
  return value.slice(0, index);
}

export function inferPlatformFromBaseUrl(baseUrl?: string): string | null {
  const value = baseUrl?.trim().toLowerCase();
  if (!value) return null;
  if (value.includes('siliconflow')) return 'siliconflow';
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('openai')) return 'openai';
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('googleapis') || value.includes('gemini')) return 'gemini';
  return null;
}

export function supportsStructuredReplyJsonSchema(model?: string | null): boolean {
  return isSiliconFlowKimiK25Model(model);
}

export function buildSiliconFlowKimiK25NonThinkingOverride(model?: string | null): Record<string, unknown> | null {
  if (!isSiliconFlowKimiK25Model(model)) return null;
  return {
    thinking: {
      type: 'disabled',
    },
  };
}

function isSiliconFlowKimiK25Model(model?: string | null): boolean {
  const value = model?.trim();
  if (!value) return false;
  return resolvePlatform(value) === 'siliconflow' && /kimi-k2\.5/i.test(value);
}

type NormalizeModelOptions = {
  availableModels?: string[];
  preferredPlatform?: string | null;
  defaultModel?: string | null;
};

export function normalizeRawModelName(input: string | null | undefined, options: NormalizeModelOptions = {}): string | null {
  const value = input?.trim();
  if (!value || value === '无') {
    return options.defaultModel?.trim() || null;
  }

  const available = (options.availableModels ?? []).map((item) => item.trim()).filter(Boolean);
  if (value.includes('/')) {
    if (available.includes(value)) return value;

    const nestedMatches = available.filter((item) => item.endsWith(`/${value}`));
    if (nestedMatches.length === 1) return nestedMatches[0];

    const preferred = options.preferredPlatform?.trim();
    if (preferred && nestedMatches.length > 1) {
      const preferredHit = nestedMatches.find((item) => item.startsWith(`${preferred}/`));
      if (preferredHit) return preferredHit;
    }

    const defaultPlatform = resolvePlatform(options.defaultModel ?? undefined);
    if (defaultPlatform && nestedMatches.length > 1) {
      const defaultHit = nestedMatches.find((item) => item.startsWith(`${defaultPlatform}/`));
      if (defaultHit) return defaultHit;
    }

    return value;
  }

  const suffixMatches = available.filter((item) => item.endsWith(`/${value}`));
  if (suffixMatches.length === 1) return suffixMatches[0];

  const preferred = options.preferredPlatform?.trim();
  if (preferred && suffixMatches.length > 1) {
    const preferredHit = suffixMatches.find((item) => item.startsWith(`${preferred}/`));
    if (preferredHit) return preferredHit;
  }

  const defaultPlatform = resolvePlatform(options.defaultModel ?? undefined);
  if (defaultPlatform && suffixMatches.length > 1) {
    const defaultHit = suffixMatches.find((item) => item.startsWith(`${defaultPlatform}/`));
    if (defaultHit) return defaultHit;
  }

  if (preferred) return `${preferred}/${value}`;
  if (defaultPlatform) return `${defaultPlatform}/${value}`;
  return value;
}
