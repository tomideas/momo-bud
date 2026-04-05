/* js/utils.js — Shared utilities (single source of truth)
   Used by: sidepanel.js, options.js, background.js */

'use strict';

/* ── HTML Escaping ── */
function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ── Debounce ── */
function debounce(fn, wait) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
}

/* ── UUID ── */
function generateUUID() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = '';
  for (let i = 0; i < 16; i++) s += b[i].toString(16).padStart(2, '0');
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}

/* ── Short ID (for prompts etc.) ── */
function shortId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ── Build OpenAI-compatible chat completions URL ── */
function buildChatCompletionsUrl(base) {
  if (!base) base = 'https://api.openai.com/v1';
  base = String(base).trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  base = base.replace(/\/models\/?$/, ''); // LM Studio compat
  if (!/\/v1$/.test(base)) base = base + '/v1';
  return base + '/chat/completions';
}

/* ── Normalize endpoint URL ── */
function normalizeEndpoint(ep) {
  if (!ep) return '';
  return ep.replace(/\s+/g, '').replace(/\/+$/, '');
}

/* ── Provider icon mapping ── */
const PROVIDER_ICONS = {
  qwen:     'assets/icons/qwen.svg',
  openai:   'assets/icons/openai.svg',
  deepseek: 'assets/icons/deepseek.svg',
  google:   'assets/icons/google.svg',
  ollama:   'assets/icons/ollama.svg',
  lmstudio: 'assets/icons/lmstudio.svg',
  openclaw: 'assets/icons/openclaw.svg',
  nvidia:     'assets/icons/nvidia.svg',
  minimax:    'assets/icons/minimax.svg',
  moonshot:   'assets/icons/moonshot.svg',
  openrouter: 'assets/icons/openrouter.svg'
};

function getProviderIconUrl(providerId) {
  const path = PROVIDER_ICONS[providerId];
  if (path) return chrome.runtime.getURL(path);
  return '';
}

/* ── Provider defaults (single source of truth, alphabetical by name) ── */
const PROVIDER_DEFAULTS = {
  deepseek: {
    id: 'deepseek', name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  google: {
    id: 'google', name: 'Google AI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-pro-maxthinking']
  },
  lmstudio: {
    id: 'lmstudio', name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    models: []
  },
  minimax: {
    id: 'minimax', name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.chat/v1',
    models: ['MiniMax-Text-01', 'abab6.5s-chat', 'abab6.5-chat']
  },
  moonshot: {
    id: 'moonshot', name: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2']
  },
  nvidia: {
    id: 'nvidia', name: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['nvidia/nemotron-3-super-120b-a12b', 'moonshotai/kimi-k2.5'],
    enabledModels: []
  },
  ollama: {
    id: 'ollama', name: 'Ollama',
    baseUrl: 'https://ollama.com/v1',
    models: ['gpt-oss:120b', 'qwen3-vl:235b'],
    enabledModels: []
  },
  openclaw: {
    id: 'openclaw', name: 'OpenClaw',
    baseUrl: 'ws://127.0.0.1:18789',
    models: ['openclaw:main'],
    enabledModels: [],
    isOpenClaw: true
  },
  openai: {
    id: 'openai', name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['o3-mini', 'o1-mini', 'o1', 'o1-preview', 'gpt-4o-mini', 'gpt-4o-2024-11-20']
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat']
  },
  qwen: {
    id: 'qwen', name: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen-flash'],
    enabledModels: [],
    supportsThinking: true,
    defaultEnableThinking: false
  }
};

/* ── Capture presets ── */
const CAPTURE_PRESETS = {
  full:   { include: '', exclude: '' },
  reader: { include: '', exclude: 'header\nfooter\nnav\naside' }
};

/* ── Normalize exclude selectors ── */
function normalizeExcludeSelectors(raw) {
  if (!raw) return '';
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('\n');
}
