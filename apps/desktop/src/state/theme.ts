/**
 * OneTHU 主题插件系统 v1（2026-09-13 立项：「神秘的主题插件系统」）
 *
 * 主题就是一种插件：manifest.category === "theme"，模块导出 `theme`（ThemeDef）
 * 而非 default(ctx)。主题只做「令牌覆盖」——改 tokens.css 的 CSS 变量（配色/
 * 字体/圆角/阴影）、换品牌 logo、附加受信 CSS；不触碰组件结构与布局骨架
 * （原子化、左栏右内容、卡片上下左右的排布恒定，这是主题的边界契约）。
 *
 * 内置主题与外部安装的主题同权：都可以停用、删除；删除内置主题会记入
 * 「已删内置」名单（不在下轮启动复活），可一键恢复全部内置。
 */

import { useSyncExternalStore } from "react";

/** 主题定义（插件模块 export const theme: ThemeDef） */
export interface ThemeDef {
  /** 唯一 id（建议 onethu.theme.xxx / 反域名） */
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** 配色核心：tokens.css 变量覆盖（--accent / --accent-soft / --bg / --font-ui …） */
  vars: Record<string, string>;
  /** 字体栈覆盖 */
  fonts?: { ui?: string; mono?: string };
  /** 品牌 logo 替换（inline SVG 字符串，viewBox 24×24 最佳） */
  logo?: string;
  /** 附加 CSS（主题是受信代码，同插件；建议自行用 [data-theme] 限定作用域） */
  css?: string;
  /** 来源：builtin 内置 | plugin 插件安装（勿手填） */
  source?: "builtin" | "plugin";
}

/** 快照（useSyncExternalStore 消费） */
export interface ThemeSnapshot {
  themes: ThemeDef[];
  activeId: string | null;
  /** 当前主题的 logo SVG（无则 null → 用默认 BrandLogo） */
  logoSvg: string | null;
  /** 被删除的内置 id（恢复按钮可见性依据） */
  deletedBuiltins: string[];
}

/* ---------- 内置主题（令牌覆盖演示五种气质；全部可删） ---------- */

const BUILTIN_THEMES: ThemeDef[] = [
  {
    id: "onethu.theme.ivory",
    name: "象牙 · 默认",
    version: "1.0.0",
    author: "OneTHU",
    description: "中性蓝灰阶 + 业务蓝强调：tokens.css 原样，无覆盖。",
    vars: {},
    source: "builtin",
  },
  {
    id: "onethu.theme.violet",
    name: "紫水晶",
    version: "1.0.0",
    author: "OneTHU",
    description: "紫罗兰强调 + 淡雾紫晕染的交互层。",
    vars: {
      "--accent": "#7c3aed",
      "--accent-soft": "#f4edfe",
      "--accent-border": "#dcc9f9",
      "--hover": "rgba(76, 49, 125, 0.06)",
      "--active": "rgba(76, 49, 125, 0.1)",
      "--ring": "0 0 0 3px rgba(124, 58, 237, 0.22)",
      "--bg-soft": "#fbfaff",
      "--surface-2": "#f8f6fd",
    },
    source: "builtin",
  },
  {
    id: "onethu.theme.celadon",
    name: "青瓷",
    version: "1.0.0",
    author: "OneTHU",
    description: "青绿强调、瓷面冷调，水色融入软底。",
    vars: {
      "--accent": "#0e9384",
      "--accent-soft": "#e6f5f2",
      "--accent-border": "#bfe5df",
      "--hover": "rgba(14, 105, 97, 0.06)",
      "--active": "rgba(14, 105, 97, 0.1)",
      "--ring": "0 0 0 3px rgba(14, 147, 132, 0.22)",
      "--bg-soft": "#f8fbfa",
      "--surface-2": "#f2f8f6",
    },
    source: "builtin",
  },
  {
    id: "onethu.theme.warmsand",
    name: "暖沙",
    version: "1.0.0",
    author: "OneTHU",
    description: "沙金强调、暖纸底色，黄昏质感的纸面。",
    vars: {
      "--accent": "#c2740a",
      "--accent-soft": "#fbf1e0",
      "--accent-border": "#ecd9ab",
      "--hover": "rgba(120, 78, 20, 0.07)",
      "--active": "rgba(120, 78, 20, 0.12)",
      "--ring": "0 0 0 3px rgba(194, 116, 10, 0.22)",
      "--bg": "#fffdf9",
      "--bg-soft": "#faf6ee",
      "--surface-2": "#f7f2e8",
    },
    source: "builtin",
  },
  {
    id: "onethu.theme.midnight",
    name: "墨蓝夜航",
    version: "1.0.0",
    author: "OneTHU",
    description: "深海军蓝强调 + 冷雾蓝灰阶：夜航仪表盘的冷静。",
    vars: {
      "--accent": "#1d4ed8",
      "--accent-soft": "#e8eefb",
      "--accent-border": "#bcd0f3",
      "--hover": "rgba(29, 58, 113, 0.07)",
      "--active": "rgba(29, 58, 113, 0.12)",
      "--ring": "0 0 0 3px rgba(29, 78, 216, 0.24)",
      "--bg": "#fcfdff",
      "--bg-soft": "#f5f7fb",
      "--surface": "#ffffff",
      "--surface-2": "#f0f3f9",
      "--surface-3": "#e3e8f1",
    },
    source: "builtin",
  },
];

const STORE_KEY = "onethu.theme.v1";
const STYLE_ID = "onethu-theme-style";

interface PersistShape {
  installed: ThemeDef[];
  activeId: string | null;
  deletedBuiltins: string[];
}

let state: PersistShape = { installed: [], activeId: null, deletedBuiltins: [] };
let logoSvg: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function persist(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* 配额/隐私模式：内存态照常工作，仅不落盘 */
  }
}

/** 启动装载：读持久态；首次（或内置缺失且未被删）播种内置主题 */
function bootstrap(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.installed)) {
        state = {
          installed: parsed.installed.filter((t) => t && typeof t.id === "string" && t.vars),
          activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
          deletedBuiltins: Array.isArray(parsed.deletedBuiltins) ? parsed.deletedBuiltins : [],
        };
      }
    }
  } catch {
    /* 损坏即重置 */
  }
  const deleted = new Set(state.deletedBuiltins);
  const have = new Set(state.installed.map((t) => t.id));
  const seeds = BUILTIN_THEMES.filter((b) => !deleted.has(b.id) && !have.has(b.id));
  if (seeds.length > 0) {
    state.installed = [...seeds, ...state.installed];
    persist();
  }
  applyActive();
}

/** 生成并注入主题样式；html[data-theme] 挂钩（清除用 null） */
function applyTheme(def: ThemeDef | null): void {
  const root = document.documentElement;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!def) {
    delete root.dataset.theme;
    if (style) style.textContent = "";
    logoSvg = null;
    return;
  }
  const varLines = Object.entries(def.vars)
    .filter(([k]) => /^--[\w-]+$/.test(k))
    .map(([k, v]) => `${k}: ${v};`);
  if (def.fonts?.ui) varLines.push(`--font-ui: ${def.fonts.ui};`);
  if (def.fonts?.mono) varLines.push(`--font-mono: ${def.fonts.mono};`);
  let css = `[data-theme="${def.id}"] {\n${varLines.join("\n")}\n}`;
  if (def.css && def.css.trim()) css += `\n/* 主题附加 CSS（受信） */\n${def.css}`;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
  root.dataset.theme = def.id;
  logoSvg = def.logo && def.logo.includes("<svg") ? def.logo : null;
}

/** 应用当前 activeId（找不到/为空 = 回归默认令牌） */
function applyActive(): void {
  const def = state.installed.find((t) => t.id === state.activeId) ?? null;
  applyTheme(def);
}

bootstrap();

/* ---------- 公开 API ---------- */

function snapshot(): ThemeSnapshot {
  return { themes: state.installed, activeId: state.activeId, logoSvg, deletedBuiltins: state.deletedBuiltins };
}

export function subscribeThemes(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useThemes(): ThemeSnapshot {
  return useSyncExternalStore(subscribeThemes, snapshot);
}

export function activateTheme(id: string): boolean {
  const def = state.installed.find((t) => t.id === id);
  if (!def) return false;
  state.activeId = id;
  applyTheme(def);
  persist();
  emit();
  return true;
}

/** 停用主题：回到基础令牌（不删除） */
export function deactivateTheme(): void {
  state.activeId = null;
  applyTheme(null);
  persist();
  emit();
}

/** 安装/覆盖一个主题（插件路径或 JSON 导入共用） */
export function installTheme(def: ThemeDef, source: "builtin" | "plugin" = "plugin"): ThemeDef {
  const clean: ThemeDef = {
    id: String(def.id || "").trim(),
    name: String(def.name || def.id || "未命名主题"),
    version: String(def.version || "1.0.0"),
    author: def.author,
    description: def.description,
    vars: def.vars && typeof def.vars === "object" ? def.vars : {},
    fonts: def.fonts,
    logo: def.logo,
    css: def.css,
    source,
  };
  if (!clean.id) throw new Error("主题 id 不能为空");
  const i = state.installed.findIndex((t) => t.id === clean.id);
  if (i >= 0) state.installed[i] = clean;
  else state.installed.push(clean);
  if (state.activeId === clean.id) applyTheme(clean);
  persist();
  emit();
  return clean;
}

/** 删除主题（内置同权可删；删内置记入名单不复活） */
export function removeTheme(id: string): void {
  const def = state.installed.find((t) => t.id === id);
  state.installed = state.installed.filter((t) => t.id !== id);
  if (def?.source === "builtin" && !state.deletedBuiltins.includes(id)) {
    state.deletedBuiltins.push(id);
  }
  if (state.activeId === id) {
    state.activeId = null;
    applyTheme(null);
  }
  persist();
  emit();
}

/** 恢复全部被删的内置主题 */
export function restoreBuiltins(): number {
  const deleted = new Set(state.deletedBuiltins);
  const have = new Set(state.installed.map((t) => t.id));
  const back = BUILTIN_THEMES.filter((b) => deleted.has(b.id) || !have.has(b.id));
  state.installed = [...back, ...state.installed];
  state.deletedBuiltins = [];
  persist();
  emit();
  return back.length;
}

/** 插件侧查询：某主题 id 是否已在架上（供 loader 提示覆盖安装） */
export function hasTheme(id: string): boolean {
  return state.installed.some((t) => t.id === id);
}
