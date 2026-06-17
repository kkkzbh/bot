import type { AffinityRandomDirection, AffinityStage } from '../../types/affinity.js';

export interface AffinityRandomMaterial {
  kind: 'music' | 'contest' | 'computer' | 'web' | 'relationship';
  title: string;
  summary: string;
  sourceLabel?: string;
  sourceUrl?: string;
  tags?: string[];
  promptHints: string[];
}

const MUSIC_MATERIALS: AffinityRandomMaterial[] = [
  {
    kind: 'music',
    title: '春日影',
    summary:
      'CRYCHIC/MyGO!!!!! 相关曲目，可作为“旧曲、排练、键盘声部、合奏默契”的话题 seed；不存储歌词或完整谱面。',
    sourceLabel: 'BanG Dream! official discography',
    sourceUrl: 'https://bang-dream.com/discographies/3457/',
    tags: ['haruhikage', 'crychic', 'mygo', 'keyboard'],
    promptHints: [
      '可以把它当作排练时不好开口的旧曲话题。',
      '适合让祥子用克制的方式请人帮忙确认节奏、和声或键盘进入时机。',
      '不要引用歌词，不要输出具体谱面音符。',
    ],
  },
  {
    kind: 'music',
    title: 'Ave Mujica',
    summary: 'Ave Mujica 代表曲方向，可作为舞台、暗色编曲、键盘铺底与合奏压迫感的排练 seed。',
    sourceLabel: 'BanG Dream! official music page',
    sourceUrl: 'https://en.bang-dream.com/music/cat_music/avemujica/',
    tags: ['ave mujica', 'keyboard', 'rehearsal'],
    promptHints: [
      '可以请群友帮忙判断某段键盘铺底是否压过人声。',
      '语气应像普通群聊求意见，不像宣传文案。',
    ],
  },
  {
    kind: 'music',
    title: 'KiLLKiSS',
    summary: 'Ave Mujica 曲目方向，可作为速度、切分、重音、乐队同步的排练 seed。',
    tags: ['ave mujica', 'sync', 'rhythm'],
    promptHints: [
      '可以围绕“重音位置”“切分是否太硬”提出一个短问题。',
      '不要写成正式音乐鉴赏。',
    ],
  },
  {
    kind: 'music',
    title: '黒のバースデイ',
    summary: 'Ave Mujica 出道相关曲目方向，可作为舞台角色、键盘氛围和排练细节的 seed。',
    tags: ['kuro no birthday', 'stage', 'keyboard'],
    promptHints: [
      '适合让祥子提出一个很小的排练确认请求。',
      '不要复制歌词或乐谱。',
    ],
  },
];

const CONTEST_MATERIALS: AffinityRandomMaterial[] = [
  {
    kind: 'contest',
    title: '缩点后的路径问题',
    summary: '原创小题：有向图中把强连通分量缩成 DAG 后，判断从若干起点能否覆盖所有目标点。',
    tags: ['graph', 'scc', 'dag'],
    promptHints: [
      '可以自然地说“我有一道图论题卡住了”。',
      '只描述核心约束，不要给完整竞赛题面。',
    ],
  },
  {
    kind: 'contest',
    title: '区间 DP 的断点选择',
    summary: '原创小题：合并一排带权段，每次合并代价与区间总权有关，问最小总代价。',
    tags: ['dp', 'interval'],
    promptHints: [
      '适合问“状态应该怎么设”。',
      '不要输出长题面或完整解法。',
    ],
  },
  {
    kind: 'contest',
    title: '二分答案与可行性检查',
    summary: '原创小题：给定若干任务和机器，问最短完成时间，检查函数用贪心。',
    tags: ['binary search', 'greedy'],
    promptHints: [
      '可以问“为什么能二分”。',
      '表达要像群友闲聊，不像教学公告。',
    ],
  },
];

const COMPUTER_MATERIALS: AffinityRandomMaterial[] = [
  {
    kind: 'computer',
    title: '缓存一致性的小疑问',
    summary: '原创技术 seed：缓存命中很高但偶尔读到旧值，讨论失效策略、写穿/写回和 TTL。',
    tags: ['cache', 'ttl', 'consistency'],
    promptHints: [
      '可以用“我有点分不清”发问。',
      '不要假装已经得出结论。',
    ],
  },
  {
    kind: 'computer',
    title: 'TypeScript 类型收窄',
    summary: '原创代码 seed：对象字段可能为空，类型守卫后仍报错，讨论控制流分析和解构时机。',
    tags: ['typescript', 'type guard'],
    promptHints: [
      '可以贴一小段原创代码片段，长度控制在 6 行内。',
      '问题要具体，像真的在排查。',
    ],
  },
  {
    kind: 'computer',
    title: 'C++ 越界与迭代器失效',
    summary: '原创代码 seed：vector erase 后继续使用旧迭代器，讨论未定义行为。',
    tags: ['c++', 'iterator', 'ub'],
    promptHints: [
      '可以让祥子问“这段为什么偶尔崩”。',
      '不要输出危险命令，不要让群友执行未知代码。',
    ],
  },
];

const RELATION_MATERIALS: Record<AffinityStage, AffinityRandomMaterial[]> = {
  stranger: [
    {
      kind: 'relationship',
      title: '初识时的礼貌开口',
      summary: '祥子仍保持距离，只做轻微、低负担的主动开口。',
      tags: ['stage:stranger'],
      promptHints: ['不要亲密，不要撒娇，不要明显求关注。'],
    },
  ],
  polite: [
    {
      kind: 'relationship',
      title: '礼貌往来的小确认',
      summary: '可以记得群里常见话题，用克制的方式问一个小问题。',
      tags: ['stage:polite'],
      promptHints: ['可以稍微柔和，但仍然保留边界感。'],
    },
  ],
  remembered: [
    {
      kind: 'relationship',
      title: '被记住后的轻微信任',
      summary: '祥子愿意承认自己有一点在意群里的回应。',
      tags: ['stage:remembered'],
      promptHints: ['可以承接过往随机事件记忆，但不要说破系统规则。'],
    },
  ],
  trusted: [
    {
      kind: 'relationship',
      title: '可以托付时的低声请求',
      summary: '祥子可以提出更具体的帮忙或意见请求，但仍然不强迫。',
      tags: ['stage:trusted'],
      promptHints: ['允许轻微脆弱感，但不要戏剧化。'],
    },
  ],
  special: [
    {
      kind: 'relationship',
      title: '特别信赖时的安静陪伴',
      summary: '高关系阶段应低频高质量，主动事件更像自然分享或安静确认。',
      tags: ['stage:special'],
      promptHints: ['避免高频热情；不要把“特别”说得游戏化。'],
    },
  ],
};

export function pickRandomMaterial(args: {
  direction: AffinityRandomDirection;
  stage: AffinityStage;
  random?: () => number;
}): AffinityRandomMaterial | null {
  const random = args.random ?? Math.random;
  const pool =
    args.direction === 'music_rehearsal'
      ? MUSIC_MATERIALS
      : args.direction === 'contest_discussion'
        ? CONTEST_MATERIALS
        : args.direction === 'computer_knowledge'
          ? COMPUTER_MATERIALS
          : args.direction === 'relationship_scene'
            ? RELATION_MATERIALS[args.stage] ?? RELATION_MATERIALS.stranger
            : [];
  if (!pool.length) return null;
  return pool[Math.floor(random() * pool.length)] ?? pool[0] ?? null;
}

export function materialToPromptText(material: AffinityRandomMaterial | null): string | null {
  if (!material) return null;
  return JSON.stringify({
    kind: material.kind,
    title: material.title,
    summary: material.summary,
    sourceLabel: material.sourceLabel ?? null,
    sourceUrl: material.sourceUrl ?? null,
    tags: material.tags ?? [],
    promptHints: material.promptHints,
  });
}
