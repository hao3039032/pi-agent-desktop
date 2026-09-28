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

export function distroStrings(locale: string): DistroStrings {
  return locale.toLowerCase().startsWith("zh") ? zh : en;
}
