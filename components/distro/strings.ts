/**
 * Distro UI copy. Kept out of lib/i18n/messages/* so upstream merges of the
 * message catalogs never conflict with fork-only strings.
 */
const zh = {
  setupTitle: "连接服务",
  setupIntro: "首次使用请填写服务地址和 API Key，之后可在「设置 → 通用 → 服务配置」中修改。",
  sectionTitle: "服务配置",
  sectionHint: "模型对话和联网搜索共用这里的服务地址与 API Key。地址变更后在此修改即可。",
  baseUrl: "服务地址 (Base URL)",
  apiKey: "API Key",
  apiKeyKeep: "已保存，留空则保持不变",
  npmMirrorLabel: "使用国内 npm 镜像（registry.npmmirror.com）加速插件与技能安装",
  save: "保存",
  saving: "保存中…",
  saved: "已保存",
  later: "稍后",
  loadError: "读取配置失败",
};

const zhTW: typeof zh = {
  setupTitle: "連線服務",
  setupIntro: "首次使用請填寫服務位址和 API Key，之後可在「設定 → 一般 → 服務設定」中修改。",
  sectionTitle: "服務設定",
  sectionHint: "模型對話和網路搜尋共用這裡的服務位址與 API Key。位址變更後在此修改即可。",
  baseUrl: "服務位址 (Base URL)",
  apiKey: "API Key",
  apiKeyKeep: "已儲存，留空則保持不變",
  npmMirrorLabel: "使用中國大陸 npm 鏡像（registry.npmmirror.com）加速外掛與技能安裝",
  save: "儲存",
  saving: "儲存中…",
  saved: "已儲存",
  later: "稍後",
  loadError: "讀取設定失敗",
};

const en: typeof zh = {
  setupTitle: "Connect to the service",
  setupIntro: "Enter the service address and API key to get started. You can change them later in Settings → General → Service.",
  sectionTitle: "Service",
  sectionHint: "Chat models and web search share this service address and API key. Update it here when the address changes.",
  baseUrl: "Service address (Base URL)",
  apiKey: "API Key",
  apiKeyKeep: "Saved — leave empty to keep it",
  npmMirrorLabel: "Use the China npm mirror (registry.npmmirror.com) for faster installs",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  later: "Later",
  loadError: "Failed to load the configuration",
};

export type DistroStrings = typeof zh;

/**
 * Traditional Chinese follows lib/i18n/registry.ts's zh-TW resolution (zh-TW,
 * zh-Hant*, zh-HK, zh-MO); every other zh* variant reads Simplified.
 */
export function distroStrings(locale: string): DistroStrings {
  const normalized = locale.toLowerCase();
  const traditional = normalized === "zh-tw" || normalized.startsWith("zh-tw-")
    || normalized === "zh-hk" || normalized.startsWith("zh-hk-")
    || normalized === "zh-mo" || normalized.startsWith("zh-mo-")
    || normalized === "zh-hant" || normalized.startsWith("zh-hant-");
  if (traditional) return zhTW;
  return normalized.startsWith("zh") ? zh : en;
}
