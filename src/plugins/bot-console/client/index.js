import { defineComponent, h, onMounted, ref, watchEffect } from '../vue.js';
import { send } from '../client.js';

const FEATURE_KEYS = [
  'QQ_VOICE_ENABLED',
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'WEB_SEARCH_ENABLED',
  'POKEMON_BATTLE_ENABLED',
  'CHAT_NATURAL_TRIGGER_ENABLED',
  'TASK_AUTOMATION_INTENT_ENABLED',
  'QQBOT_LIVE_REPLY_ENABLED',
];

const MODEL_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'TASK_AUTOMATION_INTENT_MODEL',
  'TASK_AUTOMATION_DELIVERY_MODEL',
  'TASK_AUTOMATION_CHAT_REPLY_MODEL',
  'CHATLUNA_DEFAULT_MODEL',
  'CHATLUNA_DEFAULT_PRESET',
];

const BASIC_KEYS = [
  'CHAT_ENABLED_GROUPS',
  'CHAT_NATURAL_TRIGGER_GROUPS',
  'CHAT_NATURAL_TRIGGER_ALIASES',
  'CHATLUNA_COMMAND_AUTHORITY',
];

const FIELD_LABELS = {
  QQ_VOICE_ENABLED: 'QQ 语音总开关',
  QQ_VOICE_INPUT_ENABLED: '语音转文字',
  QQ_VOICE_OUTPUT_ENABLED: '语音回复',
  WEB_SEARCH_ENABLED: '联网搜索',
  POKEMON_BATTLE_ENABLED: '宝可梦对战',
  CHAT_NATURAL_TRIGGER_ENABLED: '群聊自然触发',
  TASK_AUTOMATION_INTENT_ENABLED: '任务意图识别',
  QQBOT_LIVE_REPLY_ENABLED: '发送期续写',
  OPENAI_BASE_URL: '模型接口地址',
  OPENAI_API_KEY: '模型接口密钥',
  OPENAI_MODEL: '默认模型',
  TASK_AUTOMATION_INTENT_MODEL: '任务意图模型',
  TASK_AUTOMATION_DELIVERY_MODEL: '任务投递模型',
  TASK_AUTOMATION_CHAT_REPLY_MODEL: '任务回复模型',
  CHATLUNA_DEFAULT_MODEL: '对话默认模型',
  CHATLUNA_DEFAULT_PRESET: '默认预设',
  CHAT_ENABLED_GROUPS: '自动化启用群',
  CHAT_NATURAL_TRIGGER_GROUPS: '自然触发群',
  CHAT_NATURAL_TRIGGER_ALIASES: '触发别名',
  CHATLUNA_COMMAND_AUTHORITY: '命令权限等级',
};

const ROLE_LABELS = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
};

const SERVICE_LABELS = {
  'qqbot.target': '机器人总控',
  'qqbot-koishi.service': '主机器人服务',
  'qqbot-stack.service': '依赖服务栈',
  'qqbot-voice-tts.service': '语音合成服务',
  'qqbot-voice-tts-tailnet.service': '语音 Tailnet 发布',
};

const SERVICE_HINTS = {
  'qqbot.target': '推荐直接操作这一项。它已经包含主机器人服务和依赖服务栈，不再单独拆开操作。',
  'qqbot-koishi.service': '机器人主程序。大多数聊天和控制功能依赖它。',
  'qqbot-stack.service': '依赖组件服务。桥接、外部接口或容器能力需要它。',
  'qqbot-voice-tts.service': '只有用到语音播报或语音回复时才需要。',
  'qqbot-voice-tts-tailnet.service': '仅在服务器需要经由 Tailnet 访问本机 TTS 时启用。它不会再启动第二份模型。',
};

const VISIBLE_SERVICE_UNITS = ['qqbot.target', 'qqbot-voice-tts.service', 'qqbot-voice-tts-tailnet.service'];

const ACTION_LABELS = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  enable: '启用开机自启',
};

const ACTIVE_STATE_LABELS = {
  active: '已运行',
  inactive: '未运行',
  failed: '运行失败',
  activating: '正在启动',
  deactivating: '正在停止',
  reloading: '正在重载',
  unknown: '未知',
};

const SUB_STATE_LABELS = {
  active: '已激活',
  running: '运行中',
  dead: '未运行',
  exited: '已退出',
  failed: '失败',
  start: '启动中',
  stop: '停止中',
  auto_restart: '自动重启中',
  listening: '监听中',
  plugged: '已接入',
  mounted: '已挂载',
  unknown: '未知',
};

const UNIT_FILE_STATE_LABELS = {
  enabled: '已启用开机自启',
  disabled: '未启用开机自启',
  static: '固定服务',
  indirect: '间接启用',
  masked: '已屏蔽',
  generated: '自动生成',
  transient: '临时服务',
  unknown: '未知',
};

const OVERVIEW_FEATURE_ITEMS = [
  ['QQ_VOICE_ENABLED', '语音'],
  ['WEB_SEARCH_ENABLED', '搜索'],
  ['CHAT_NATURAL_TRIGGER_ENABLED', '自然触发'],
  ['TASK_AUTOMATION_INTENT_ENABLED', '任务意图'],
  ['QQBOT_LIVE_REPLY_ENABLED', '发送期续写'],
];

const BOT_CONSOLE_TABS = [
  { id: 'overview', label: '服务总览' },
  { id: 'services', label: '运行控制' },
  { id: 'features', label: '功能开关' },
  { id: 'models', label: '模型接口' },
  { id: 'basic', label: '基础配置' },
  { id: 'presets', label: '角色预设' },
];

function formatDateTime(value) {
  if (!value) return '未记录';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return '未记录';
  }
}

function formatLatency(value) {
  if (value == null || !Number.isFinite(Number(value))) return '未记录';
  return `${Math.max(0, Math.round(Number(value)))} ms`;
}

function getFeatureStatusSummary(env) {
  return OVERVIEW_FEATURE_ITEMS.map(([key, label]) => ({
    key,
    label,
    enabled: normalizeBoolean(env?.[key]),
  }));
}

function getServiceSummaryText(services) {
  return ['qqbot.target', 'qqbot-koishi.service', 'qqbot-stack.service', 'qqbot-voice-tts.service', 'qqbot-voice-tts-tailnet.service']
    .map((unit) => {
      const service = getServiceStatusByUnit(services, unit);
      return service ? `${getServiceLabel(service)}：${getActiveStateLabel(service.activeState)}` : '';
    })
    .filter(Boolean)
    .join('；');
}

function getMemoryStatusLabel(snapshot) {
  if (!snapshot?.available || !snapshot?.enabled) return '未启用';
  if (!snapshot?.embedConfigured) return '未配置';
  const embed = snapshot.embed;
  if (!embed || embed.state === 'never') return '从未调用';
  if (embed.lastSource === 'probe') {
    return embed.state === 'success' ? '检测成功' : '检测失败';
  }
  return embed.state === 'success' ? '最近成功' : '最近失败';
}

function getMemoryStatusTone(snapshot) {
  const label = getMemoryStatusLabel(snapshot);
  if (label === '最近成功' || label === '检测成功') return 'success';
  if (label === '最近失败' || label === '检测失败') return 'danger';
  if (label === '未配置') return 'warning';
  return 'muted';
}

function canProbeEmbedding(snapshot, probePending) {
  if (probePending) return false;
  return Boolean(snapshot?.available && snapshot?.enabled && snapshot?.embedConfigured);
}

function renderStatusBadge(label, tone) {
  return `<span class="bc-status-badge ${tone ? `is-${tone}` : ''}">${escapeHtml(label)}</span>`;
}

function renderOverviewPanel(state) {
  const services = state.botState?.services ?? [];
  const env = state.botState?.env ?? state.envDraft ?? {};
  const memory = state.botState?.runtimeStatus?.memoryV2;
  const features = getFeatureStatusSummary(env);

  return `
    <section class="bc-panel">
      <div class="bc-panel-head">
        <div>
          <h2>运行总览</h2>
          <p>集中查看服务、当前对话配置、关键功能开关，以及长期记忆 / embedding 健康。</p>
        </div>
      </div>
      <div class="bc-status-grid">
        <article class="bc-status-card">
          <div class="bc-status-card-head">
            <strong>服务总览</strong>
            ${renderStatusBadge(getActiveStateLabel(getServiceStatusByUnit(services, 'qqbot.target')?.activeState ?? 'unknown'), 'muted')}
          </div>
          <p class="muted">${escapeHtml(getServiceSummaryText(services) || '暂无服务状态。')}</p>
        </article>

        <article class="bc-status-card">
          <div class="bc-status-card-head">
            <strong>对话配置</strong>
            ${renderStatusBadge(env.CHATLUNA_DEFAULT_PRESET || 'sakiko', 'muted')}
          </div>
          <p class="muted">默认模型：${escapeHtml(env.CHATLUNA_DEFAULT_MODEL || env.OPENAI_MODEL || '未设置')}</p>
          <p class="muted">默认预设：${escapeHtml(env.CHATLUNA_DEFAULT_PRESET || 'sakiko')}</p>
          <p class="muted">模型接口：${escapeHtml(env.OPENAI_BASE_URL || '未设置')}</p>
        </article>

        <article class="bc-status-card">
          <div class="bc-status-card-head">
            <strong>功能状态</strong>
            ${renderStatusBadge(`${features.filter((item) => item.enabled).length}/${features.length} 已开启`, 'muted')}
          </div>
          <div class="bc-status-chip-list">
            ${features
              .map((item) =>
                renderStatusBadge(`${item.label}${item.enabled ? ' 开' : ' 关'}`, item.enabled ? 'success' : 'muted'),
              )
              .join('')}
          </div>
        </article>

        <article class="bc-status-card bc-status-card-memory">
          <div class="bc-status-card-head">
            <strong>Long Memory / Embedding</strong>
            ${renderStatusBadge(getMemoryStatusLabel(memory), getMemoryStatusTone(memory))}
          </div>
          <p class="muted">memory-v2：${memory?.enabled ? '已启用' : '未启用'}</p>
          <p class="muted">extract 模型：${escapeHtml(memory?.extractModel || '未配置')}</p>
          <p class="muted">embedding：${escapeHtml(memory?.embedModel || '未配置')}</p>
          <p class="muted">provider：${escapeHtml(memory?.embedBaseUrl || '未配置')}</p>
          <p class="muted">
            队列：extract ${Number(memory?.jobs?.extractPending ?? 0)}/${Number(memory?.jobs?.extractProcessing ?? 0)}
            ，embed ${Number(memory?.jobs?.embedPending ?? 0)}/${Number(memory?.jobs?.embedProcessing ?? 0)}
          </p>
          <p class="muted">最近成功：${escapeHtml(formatDateTime(memory?.embed?.lastSuccessAt))}</p>
          <p class="muted">最近失败：${escapeHtml(formatDateTime(memory?.embed?.lastFailureAt))}</p>
          <p class="muted">最近耗时：${escapeHtml(formatLatency(memory?.embed?.lastLatencyMs))}</p>
          ${memory?.embed?.lastError ? `<p class="bc-status-error">${escapeHtml(memory.embed.lastError)}</p>` : ''}
          <div class="bc-status-actions">
            <button
              type="button"
              data-action="probe-embedding"
              ${canProbeEmbedding(memory, state.probePending) ? '' : 'disabled'}
            >
              ${state.probePending ? '检测中...' : '立即检测'}
            </button>
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderTopTabs(activeTab) {
  return `
    <nav class="bc-topbar" aria-label="机器人控制台分区">
      <div class="bc-tabbar">
        ${BOT_CONSOLE_TABS.map((tab) => `
          <button
            type="button"
            class="bc-tab ${tab.id === activeTab ? 'is-active' : ''}"
            data-tab="${escapeHtml(tab.id)}"
          >
            ${escapeHtml(tab.label)}
          </button>
        `).join('')}
      </div>
    </nav>
  `;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function normalizeBoolean(value) {
  return String(value ?? '').toLowerCase() !== 'false';
}

function createEmptyPreset() {
  return {
    name: '',
    originalName: '',
    keywords: [],
    prompts: [
      {
        role: 'system',
        content: '',
      },
    ],
  };
}

function clonePreset(preset) {
  return {
    name: preset?.name ?? '',
    originalName: preset?.originalName ?? preset?.name ?? '',
    keywords: [...(preset?.keywords ?? [])],
    prompts: (preset?.prompts ?? []).map((prompt) => ({
      role: prompt.role,
      content: prompt.content,
    })),
  };
}

function getFieldLabel(key) {
  return FIELD_LABELS[key] ?? key;
}

function getServiceLabel(service) {
  return SERVICE_LABELS[service?.unit] ?? service?.description ?? service?.unit ?? '未知服务';
}

function getServiceHint(service) {
  return SERVICE_HINTS[service?.unit] ?? '这是机器人运行过程中的一个服务组件。';
}

function getActiveStateLabel(value) {
  return ACTIVE_STATE_LABELS[value] ?? value;
}

function getSubStateLabel(value) {
  return SUB_STATE_LABELS[value] ?? value;
}

function getUnitFileStateLabel(value) {
  return UNIT_FILE_STATE_LABELS[value] ?? value;
}

function getAutoStartButtonLabel(service) {
  return service?.canEnable ? '启用开机自启' : '已启用开机自启';
}

function getVisibleServices(services) {
  return (services ?? []).filter((service) => VISIBLE_SERVICE_UNITS.includes(service.unit));
}

function getServiceStatusByUnit(services, unit) {
  return (services ?? []).find((service) => service.unit === unit);
}

function renderIncludedServiceStatuses(services, unit) {
  if (unit !== 'qqbot.target') return '';
  const koishi = getServiceStatusByUnit(services, 'qqbot-koishi.service');
  const stack = getServiceStatusByUnit(services, 'qqbot-stack.service');
  const items = [
    koishi ? `主机器人：${getActiveStateLabel(koishi.activeState)} / ${getSubStateLabel(koishi.subState)}` : '',
    stack ? `依赖服务：${getActiveStateLabel(stack.activeState)} / ${getSubStateLabel(stack.subState)}` : '',
  ].filter(Boolean);
  if (!items.length) return '';
  return `<p class="muted">已包含：${escapeHtml(items.join('；'))}</p>`;
}

function renderToggleCards(envDraft, changedKeys) {
  return FEATURE_KEYS.map((key) => {
    const checked = normalizeBoolean(envDraft[key]);
    return `
      <label class="bc-toggle-card ${checked ? 'is-enabled' : 'is-disabled'}">
        <div>
          <strong>${escapeHtml(getFieldLabel(key))}</strong>
        </div>
        <input type="checkbox" data-env-key="${escapeHtml(key)}" ${checked ? 'checked' : ''}>
        ${changedKeys.has(key) ? '<span class="bc-dirty-badge">已修改</span>' : ''}
      </label>
    `;
  }).join('');
}

function renderTextFields(keys, envDraft, changedKeys) {
  return keys.map((key) => `
    <label class="bc-field">
      <span>${escapeHtml(getFieldLabel(key))}</span>
      <input
        data-env-key="${escapeHtml(key)}"
        type="${key.includes('API_KEY') ? 'password' : 'text'}"
        value="${escapeHtml(envDraft[key] ?? '')}"
        spellcheck="false"
      >
      ${changedKeys.has(key) ? '<em class="bc-field-note">已修改</em>' : ''}
    </label>
  `).join('');
}

function renderPresetPrompts(preset) {
  return (preset.prompts ?? []).map((prompt, index) => `
    <div class="bc-prompt-card">
      <div class="bc-prompt-head">
        <label>
          <span>角色</span>
          <select data-prompt-role="${index}">
            ${['system', 'user', 'assistant', 'tool']
              .map((role) => `<option value="${role}" ${prompt.role === role ? 'selected' : ''}>${ROLE_LABELS[role] ?? role}</option>`)
              .join('')}
          </select>
        </label>
        <button type="button" class="ghost" data-remove-prompt="${index}">删除片段</button>
      </div>
      <textarea data-prompt-content="${index}" spellcheck="false">${escapeHtml(prompt.content ?? '')}</textarea>
    </div>
  `).join('');
}

function renderServicesPanel(state) {
  return `
    <article class="bc-panel">
      <div class="bc-panel-head">
        <div>
          <h2>运行控制</h2>
          <p>通常只需要启动“机器人总控”。主机器人和依赖服务已经并入总控，不再单独显示。</p>
        </div>
      </div>
      <div class="bc-services">
        ${getVisibleServices(state.botState?.services).map((service) => `
          <div class="bc-service-card">
            <div>
              <strong>${escapeHtml(getServiceLabel(service))}</strong>
              <p class="muted">${escapeHtml(getServiceHint(service))}</p>
              ${renderIncludedServiceStatuses(state.botState?.services, service.unit)}
              <p class="muted">当前状态：${escapeHtml(getActiveStateLabel(service.activeState))}</p>
              <p class="muted">运行情况：${escapeHtml(getSubStateLabel(service.subState))}</p>
              <p class="muted">开机自启：${escapeHtml(getUnitFileStateLabel(service.unitFileState))}</p>
            </div>
            <div class="bc-service-actions">
              <button type="button" data-service-action="start" data-unit="${escapeHtml(service.unit)}" ${service.canStart ? '' : 'disabled'}>启动</button>
              <button type="button" data-service-action="stop" data-unit="${escapeHtml(service.unit)}" ${service.canStop ? '' : 'disabled'}>停止</button>
              <button type="button" data-service-action="restart" data-unit="${escapeHtml(service.unit)}" ${service.canRestart ? '' : 'disabled'}>重启</button>
              <button type="button" data-service-action="enable" data-unit="${escapeHtml(service.unit)}" ${service.canEnable ? '' : 'disabled'}>${escapeHtml(getAutoStartButtonLabel(service))}</button>
            </div>
          </div>
        `).join('')}
      </div>
    </article>
  `;
}

function renderFeaturesPanel(state, changedKeys) {
  return `
    <article class="bc-panel">
      <div class="bc-panel-head">
        <div>
          <h2>功能开关</h2>
          <p>常用功能都可以在这里直接开关。</p>
        </div>
      </div>
      <div class="bc-toggle-grid">${renderToggleCards(state.envDraft, changedKeys)}</div>
    </article>
  `;
}

function renderModelsPanel(state, changedKeys, canSaveEnv) {
  return `
    <article class="bc-panel">
      <div class="bc-panel-head">
        <div>
          <h2>模型接口</h2>
          <p>填写模型接口地址、密钥和默认模型。</p>
        </div>
        <button type="button" class="primary" data-action="save-env" ${canSaveEnv ? '' : 'disabled'}>保存配置</button>
      </div>
      <div class="bc-field-grid">${renderTextFields(MODEL_KEYS, state.envDraft, changedKeys)}</div>
    </article>
  `;
}

function renderBasicPanel(state, changedKeys, canSaveEnv) {
  return `
    <article class="bc-panel">
      <div class="bc-panel-head">
        <div>
          <h2>基础配置</h2>
          <p>群号、触发词和权限设置。</p>
        </div>
        <button type="button" data-action="save-env-restart" ${canSaveEnv ? '' : 'disabled'}>保存并重启</button>
      </div>
      <div class="bc-field-grid">${renderTextFields(BASIC_KEYS, state.envDraft, changedKeys)}</div>
    </article>
  `;
}

function renderPresetsPanel(state, preset, canSavePreset, defaultPreset) {
  return `
    <section class="bc-panel bc-preset-layout">
      <div class="bc-panel-head">
        <div>
          <h2>角色预设</h2>
          <p>在这里新建、复制、修改和删除角色。</p>
        </div>
        <div class="bc-preset-actions">
          <button type="button" data-action="new-preset">新建</button>
          <button type="button" data-action="duplicate-preset" ${preset.name ? '' : 'disabled'}>复制</button>
          <button type="button" class="danger" data-action="delete-preset" ${preset.name ? '' : 'disabled'}>删除</button>
          <button type="button" class="primary" data-action="save-preset" ${canSavePreset ? '' : 'disabled'}>保存预设</button>
        </div>
      </div>
      <div class="bc-preset-grid">
        <aside class="bc-preset-list">
          ${(state.botState?.presets ?? []).map((item) => `
            <button
              type="button"
              class="${item.name === preset.name ? 'is-active' : ''}"
              data-open-preset="${escapeHtml(item.name)}"
            >
              <strong>${escapeHtml(item.name)}</strong>
              ${item.name === defaultPreset ? '<span class="bc-default-tag">默认</span>' : ''}
            </button>
          `).join('')}
        </aside>
        <div class="bc-preset-editor">
          <div class="bc-field-grid">
            <label class="bc-field">
              <span>预设名</span>
              <input type="text" data-preset-name value="${escapeHtml(preset.name ?? '')}" spellcheck="false">
            </label>
            <label class="bc-field bc-field-span">
              <span>关键词</span>
              <textarea data-preset-keywords spellcheck="false">${escapeHtml((preset.keywords ?? []).join('\n'))}</textarea>
              <em class="bc-field-note">一行一个关键词。</em>
            </label>
          </div>
          <div class="bc-panel-subhead">
            <strong>提示词片段</strong>
            <button type="button" data-action="add-prompt">新增片段</button>
          </div>
          <div class="bc-prompt-list">${renderPresetPrompts(preset)}</div>
        </div>
      </div>
    </section>
  `;
}

function renderActiveTabPanel(state, preset, changedKeys, canSaveEnv, canSavePreset, defaultPreset) {
  switch (state.activeTab) {
    case 'services':
      return renderServicesPanel(state);
    case 'features':
      return renderFeaturesPanel(state, changedKeys);
    case 'models':
      return renderModelsPanel(state, changedKeys, canSaveEnv);
    case 'basic':
      return renderBasicPanel(state, changedKeys, canSaveEnv);
    case 'presets':
      return renderPresetsPanel(state, preset, canSavePreset, defaultPreset);
    case 'overview':
    default:
      return renderOverviewPanel(state);
  }
}

function renderPage(root, state) {
  const preset = state.currentPreset ?? createEmptyPreset();
  const changedKeys = new Set(
    Object.keys(state.envDraft).filter((key) => (state.envDraft[key] ?? '') !== (state.originalEnv[key] ?? '')),
  );
  const canSaveEnv = changedKeys.size > 0;
  const canSavePreset = preset.name.trim() && preset.prompts.some((prompt) => prompt.content.trim());
  const defaultPreset = state.botState?.defaultPreset || 'sakiko';

  root.innerHTML = `
    <div class="bc-shell">
      <section class="bc-hero">
        <div>
          <p class="eyebrow">本地控制台</p>
          <h1>本地机器人管理台</h1>
          <p class="muted">这里可以直接开关功能、调整配置、管理角色。保存后通常需要重启才会生效。</p>
        </div>
        <div class="bc-hero-actions">
          <button type="button" data-action="refresh">刷新状态</button>
          <button type="button" class="primary" data-service-action="restart" data-unit="qqbot.target">重启机器人</button>
        </div>
      </section>

      ${state.error ? `<section class="bc-banner error">${escapeHtml(state.error)}</section>` : ''}
      ${state.notice ? `<section class="bc-banner">${escapeHtml(state.notice)}</section>` : ''}
      ${state.pendingRestart ? '<section class="bc-banner warning">已有未应用的改动，建议点一次“重启机器人”。</section>' : ''}

      ${renderTopTabs(state.activeTab)}

      <section class="bc-grid">
        ${renderActiveTabPanel(state, preset, changedKeys, canSaveEnv, canSavePreset, defaultPreset)}
      </section>
    </div>
  `;
}

const BotConsolePage = defineComponent({
  name: 'BotConsolePage',
  setup() {
    const root = ref();
    const state = ref({
      loading: true,
      error: '',
      notice: '',
      pendingRestart: false,
      probePending: false,
      activeTab: 'overview',
      botState: null,
      envDraft: {},
      originalEnv: {},
      currentPreset: createEmptyPreset(),
    });

    async function refreshState() {
      state.value.error = '';
      state.value.notice = '';
      const nextState = await send('bot-console/get-state');
      state.value.botState = nextState;
      state.value.originalEnv = { ...(nextState?.env ?? {}) };
      state.value.envDraft = { ...(nextState?.env ?? {}) };
      if (!state.value.currentPreset?.name && nextState?.presets?.length) {
        await openPreset(nextState.presets[0].name);
      }
    }

    async function openPreset(name) {
      const preset = await send('bot-console/get-preset', name);
      state.value.currentPreset = clonePreset(preset);
    }

    async function saveEnv(restartAfterSave) {
      const payload = {};
      for (const key of [...FEATURE_KEYS, ...MODEL_KEYS, ...BASIC_KEYS]) {
        payload[key] = state.value.envDraft[key] ?? '';
      }
      const result = await send('bot-console/save-env', payload);
      state.value.originalEnv = { ...(result?.env ?? {}) };
      state.value.envDraft = { ...(result?.env ?? {}) };
      state.value.pendingRestart = !!result?.restartRequired;
      state.value.notice = restartAfterSave ? '配置已保存，正在重启 bot。' : '配置已保存。';
      if (restartAfterSave) {
        await performServiceAction('qqbot.target', 'restart');
      }
    }

    async function savePreset() {
      const preset = clonePreset(state.value.currentPreset);
      preset.keywords = String(root.value.querySelector('[data-preset-keywords]')?.value ?? '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await send('bot-console/save-preset', preset);
      state.value.pendingRestart = !!result?.restartRequired;
      state.value.notice = `预设 ${preset.name} 已保存。`;
      await refreshState();
      await openPreset(result?.preset?.name ?? preset.name);
    }

    async function performServiceAction(unit, action) {
      await send('bot-console/service-action', unit, action);
      state.value.notice = `${SERVICE_LABELS[unit] ?? unit}已${ACTION_LABELS[action] ?? action}。`;
      await refreshState();
    }

    function attachEvents() {
      root.value.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const { action, unit, serviceAction, openPreset: openPresetName, removePrompt } = button.dataset;

        try {
          if (openPresetName) {
            await openPreset(openPresetName);
            return;
          }
          if (serviceAction && unit) {
            await performServiceAction(unit, serviceAction);
            return;
          }
          if (removePrompt != null) {
            state.value.currentPreset.prompts.splice(Number(removePrompt), 1);
            if (!state.value.currentPreset.prompts.length) {
              state.value.currentPreset.prompts.push({ role: 'system', content: '' });
            }
            return;
          }
          if (action === 'refresh') {
            await refreshState();
            return;
          }
          if (action === 'save-env') {
            await saveEnv(false);
            return;
          }
          if (action === 'save-env-restart') {
            await saveEnv(true);
            return;
          }
          if (action === 'probe-embedding') {
            state.value.probePending = true;
            const result = await send('bot-console/run-status-probe', 'embedding');
            if (result?.memoryV2?.snapshot) {
              state.value.botState = {
                ...(state.value.botState ?? {}),
                runtimeStatus: {
                  ...(state.value.botState?.runtimeStatus ?? {}),
                  memoryV2: result.memoryV2.snapshot,
                },
              };
            }
            if (result?.memoryV2?.ok) {
              state.value.notice = `Embedding 检测成功，耗时 ${formatLatency(result.memoryV2.latencyMs)}。`;
              state.value.error = '';
            } else {
              state.value.error = result?.memoryV2?.error || 'Embedding 检测失败。';
              state.value.notice = '';
            }
            return;
          }
          const targetTab = button.dataset.tab;
          if (targetTab) {
            state.value.activeTab = targetTab;
            return;
          }
          if (action === 'save-preset') {
            await savePreset();
            return;
          }
          if (action === 'new-preset') {
            state.value.currentPreset = createEmptyPreset();
            return;
          }
          if (action === 'duplicate-preset') {
            const next = clonePreset(state.value.currentPreset);
            next.name = next.name ? `${next.name}-copy` : '';
            next.originalName = '';
            state.value.currentPreset = next;
            return;
          }
          if (action === 'delete-preset') {
            if (!state.value.currentPreset.name) return;
            if (!window.confirm(`确认删除预设 ${state.value.currentPreset.name}？`)) return;
            await send(
              'bot-console/delete-preset',
              state.value.currentPreset.name,
              state.value.botState?.defaultPreset || 'sakiko',
            );
            state.value.pendingRestart = true;
            state.value.notice = `预设 ${state.value.currentPreset.name} 已删除。`;
            state.value.currentPreset = createEmptyPreset();
            await refreshState();
            return;
          }
          if (action === 'add-prompt') {
            state.value.currentPreset.prompts.push({ role: 'system', content: '' });
          }
        } catch (error) {
          state.value.error = error?.message || String(error);
        } finally {
          if (action === 'probe-embedding') {
            state.value.probePending = false;
          }
        }
      });

      root.value.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLSelectElement)) {
          return;
        }
        if (target.dataset.envKey) {
          state.value.envDraft[target.dataset.envKey] =
            target instanceof HTMLInputElement && target.type === 'checkbox' ? String(target.checked) : target.value;
          return;
        }
        if (target.dataset.presetName !== undefined) {
          state.value.currentPreset.name = target.value;
          return;
        }
        if (target.dataset.presetKeywords !== undefined) {
          state.value.currentPreset.keywords = target.value
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
          return;
        }
        if (target.dataset.promptRole != null) {
          const index = Number(target.dataset.promptRole);
          state.value.currentPreset.prompts[index].role = target.value;
          return;
        }
        if (target.dataset.promptContent != null) {
          const index = Number(target.dataset.promptContent);
          state.value.currentPreset.prompts[index].content = target.value;
        }
      });
    }

    onMounted(async () => {
      attachEvents();
      try {
        await refreshState();
      } catch (error) {
        state.value.error = error?.message || String(error);
      } finally {
        state.value.loading = false;
      }
    });

    watchEffect(() => {
      if (!root.value) return;
      renderPage(root.value, state.value);
    });

    return () => h('div', { class: 'bot-console-page', ref: root });
  },
});

export default (ctx) => {
  ctx.page({
    id: 'bot-console',
    path: '/bot-console',
    name: '机器人控制台',
    icon: 'activity:settings',
    order: 420,
    component: BotConsolePage,
  });
};
