# Changelog

All notable changes to this project will be documented in this file.

---

## [2.16.5] - 2026-04-05
### Fixed
- **OpenClaw 回覆太慢導致「未回應」問題**：
  - `chat.send` RPC 超時從 30 秒增加到 60 秒
  - `chat.send` 超時時若事件流已有回應，不再直接結束，繼續等待回覆
  - 新增輪詢穩定檢查：備用輪詢取得回覆後若 15 秒內無新內容變化，自動視為完成

---

## [2.16.1] - 2026-04-05
### Fixed
- **OpenClaw 模式禁用聯網搜尋與引用頁面按鈕**：選擇 OpenClaw 模型時，Web Search 和 Reference Page 按鈕現在會被灰掉並禁用（opacity 0.35、pointer-events none），避免使用者誤觸無效功能；切換回其他模型時自動恢復

---

## [2.16.0] - 2026-04-05
### Added
- **UI Design System Specification** (`sider/UI-SPEC.md`): formal document covering all design tokens (light/dark), typography, spacing, border radius, component interaction states (4-state: default/hover/focus/disabled), dark mode rules, animation standards, responsive breakpoints, iconography, and accessibility guidelines
- **Cursor Rule** (`.cursor/rules/ui-design-system.mdc`): AI-readable condensed spec — auto-applies when editing CSS/HTML/JS under `sider/`
- **UI Preview Page** (`sider/ui-preview.html`): standalone visual reference with live light/dark toggle, color swatches, type scale, spacing bars, radius grid, and interactive component demos
- **Cross-file token aliases**: `options.css` now defines `--accent`/`--accent-hover`; `sidepanel.css` now defines `--bg-page`/`--bg-card`/`--bg-subtle`/`--bg-active`/`--bg-active-hover`/`--focus` — both naming conventions work in both files

### Changed
- **iframe-sidebar.css dark mode**: migrated from `@media (prefers-color-scheme: dark)` to `[data-theme="dark"]` attribute on sidebar container, driven by `chrome.storage` theme setting via `content-floatball.js`; dark background unified to `#202223` (was `#1a1a1a`)
- **Form element width alignment**: removed `max-width: 600px` from `.provider-select-wrapper`; added `box-sizing: border-box` to `.input` and `.provider-select-button`; `.inline-row > .input` now uses `flex:1` — all form elements align to card padding edges consistently

---

## [2.15.0] - 2026-04-04
### Added
- **OpenRouter server-side web search**: when web search is enabled and provider is OpenRouter, automatically appends `:online` suffix to model name — search is handled server-side via Exa/native engine, giving much better results than client-side DDG scraping
- **OpenRouter annotations**: parses `url_citation` annotations from OpenRouter responses and displays them in the search sources modal
- **Auto-trigger search on explicit intent**: messages starting with "查一下", "搜尋", "search for" etc. now auto-trigger web search even when the toggle is OFF
- **DuckDuckGo proxy fallback**: when direct HTML fetch fails, retries through the background service worker `proxy_fetch` to bypass CORS/anti-scraping blocks

### Changed
- **Search always fires when toggle is ON**: previously, `shouldSearch()` could still skip queries even when the user explicitly enabled search — now the toggle means "always search"
- **PROMPT_BUDGET tripled** from 2000 → 6000 characters — search results no longer get aggressively truncated
- **Per-result snippet limit** increased (≤3 results: 1200 chars each; >3 results: 600 chars each)
- **Improved search injection prompt**: follows OpenRouter-style format — simpler, more natural, explicitly tells model not to claim it lacks internet access
- **Removed OpenClaw web search injection**: OpenClaw has native search capability, no longer needs client-side injection

---

## [2.14.3] - 2026-04-04
### Added
- **Prompt visibility toggle**: each system prompt card now has an on/off switch — hidden prompts won't appear in the sidebar's prompt dropdown (data stored as `visible` property, defaults to `true`)

### Changed
- **Smaller toggle switches** across the entire options page: 46×26px → 36×20px (knob 18px → 14px) for a cleaner, more modern look
- **Field labels** enlarged from 12px/secondary color to 14px/primary color — second-level headings now clearly stand out from body text
- **Web search toggle layout**: "Simple Search Mode", "Visit Website in Message", and "Internet Search ON by Default" toggles moved from left-of-hint to right-aligned (new `.toggle-row` layout matching Float Ball style)

---

## [2.14.2] - 2026-04-04
### Fixed
- **Options anchor scroll**: added `scroll-margin-top: 100px` to all sections so nav anchor jumps don't hide content behind the viewport top
- **Streaming auto-scroll**: reworked auto-follow logic using `requestAnimationFrame` and `_programmaticScroll` flag — user scroll-up now properly pauses auto-follow; removed `scroll-behavior: smooth` from chat scroller where it caused jank

---

## [2.14.1] - 2026-04-04
### Added
- **First-install language detection**: `background.js` now writes `zhVariant` to both local and sync storage on install, based on Chrome UI language (`chrome.i18n.getUILanguage()`)
- **`__detectBrowserLanguage()`** function in i18n-loader.js — all fallback defaults now use detected browser language instead of hardcoded `'hant'`

### Changed
- **Dark mode provider icons**: black SVG icons get `filter: brightness(0) invert(1)` in dark theme; colored brand SVGs (DeepSeek, Google, OpenRouter, Qwen, OpenClaw) excluded from inversion

---

## [2.14.0] - 2026-04-04
### Changed
- **Options sidebar redesign**: 7 nav items with SVG icons (General, Sidebar, AI Models, Web Search, Capture, TTS, Prompts); merged related sections per nav item via `data-sections`
- **TTS section** moved after Page Capture for better flow
- **Scroll spy** updated to use `data-sections` attribute for multi-section nav highlighting
- New i18n keys: `navGeneral`, `navSidebar`, `navAiModels`, `navWebSearch`, `navCapture`, `navTts`, `navPrompts`

---

## [2.13.3] - 2026-04-04
### Fixed
- **`shouldSearch` heuristics**: fixed `\b` word boundary failing with CJK characters; improved entity / alphanumeric query detection; added explicit triggers like `你查一下`

---

## [2.13.2] - 2026-04-04
### Added
- **Conservative `shouldSearch`**: default behavior is now no-search unless explicit signals detected (search keywords, question patterns, entity queries)

### Changed
- **Chat history panel**: width set to `min(240px, 72%)` with responsive tweaks
- **Custom dialog** dark mode styles improved; slightly narrower `max-width`

---

## [2.13.1] - 2026-04-04
### Fixed
- **Theme `auto` mode**: `applyTheme('auto')` now resolves to `dark`/`light` using `prefers-color-scheme` media query + live listener for system theme changes (both `options.js` and `sidepanel.js`)

---

## [2.13.0] - 2026-04-04
### Added (inspired by [page-assist](https://github.com/n4ze3m/page-assist))
- **Google HTML scraping**: New default search engine — scrapes Google search pages directly from Chrome (most stable, free, no API key needed)
- **DuckDuckGo HTML scraping**: Re-added as option via html.duckduckgo.com
- **Simple Internet Search toggle**: ON = use search snippets only (fast); OFF = visit result pages for full content (slower but more accurate RAG-like experience)
- **Total Search Results**: Configurable number of results (1-20, default 5)
- **Visit Website in Message**: Automatically detects URLs in user messages and fetches page content for the AI
- **Internet Search ON by Default**: Option to auto-enable web search for every new chat
- **SearXNG**: Open-source meta-search with 10 fallback instances (JSON + HTML fallback)

### Changed
- Default search provider changed from Tavily to Google (no API key needed)
- Redesigned web search settings page with all new options
- `performWebSearch` now combines URL-visited content with search results

---

## [2.10.7] - 2026-04-04
### Added
- **Search sources viewer**: 🔍 button appears in AI response action bar when web search was used; clicking it opens a modal showing all search result sources with titles, URLs, and snippets (similar to page reference viewer)
- **Search query optimization**: `extractSearchQuery()` strips instruction prefixes like "幫我查", "上網搜索", "請告訴我" etc. to get cleaner search keywords

### Changed
- **Search result injection**: Now uses a dedicated system message with strong Chinese instructions telling the AI to prioritize and cite search results (previously appended to user message, which models often ignored)

---

## [2.10.6] - 2026-04-04
### Fixed
- **Search query optimization**: Extracts keywords from user message instead of searching the entire sentence (strips "幫我查", "搜索", "上網找" etc.)
- **Search result injection**: Changed from appending to user message to a dedicated system message with strong Chinese instructions telling the AI to prioritize and cite search results
- OpenClaw path also uses improved injection format

---

## [2.10.5] - 2026-04-04
### Fixed
- **Provider switching**: Settings changes in options page now take effect immediately in side panel (added `storage.onChanged` listener)
- **DuckDuckGo**: Routes requests through background service worker (proxy_fetch) to bypass anti-bot detection; falls back to direct fetch if proxy fails
- **Default provider**: Changed from DuckDuckGo to Tavily (more reliable); DDG marked as "unstable" in UI
- **Toggle feedback**: Web search toggle now shows ON/OFF toast notification

---

## [2.10.4] - 2026-04-04
### Fixed
- **Tavily API**: Updated authentication from deprecated `api_key` in request body to `Authorization: Bearer` header (Tavily API 2026 format change)
- **DuckDuckGo**: Added 3 retry strategies (HTML POST, Lite POST, HTML GET), regex fallback parser, and User-Agent header for better compatibility
- **Test button**: Now shows detailed DDG debug info (raw HTML snippet, attempt log) when search returns no results, making diagnosis much easier

---

## [2.10.0] - 2026-04-04
### Added
- **Web Search**: new toggle button (globe icon) in the composer area enables live web search
  - When enabled, each message automatically searches the web and injects results as context before sending to the AI model
  - Default provider: **DuckDuckGo** (free, no API key required)
  - Optional provider: **Tavily** (higher quality results, requires free API key from tavily.com)
  - Works with both standard OpenAI-compatible API and OpenClaw WebSocket paths
  - Search state persists across sessions
  - New settings section in Options page for search provider configuration
  - Full i18n support (繁中 / 简中 / English)

---

## [2.9.33] - 2026-03-31
### Changed
- Settings page: all hardcoded Chinese strings replaced with English equivalents
  - `模型名稱` label → `Model Name`
  - `顯示思路` (CSS content) → `Show Thinking`
- Provider thinking hints (`THINKING_HINTS`) and Prefix hint now fully localised — hant / hans / en versions; hint re-renders after `currentLang` is resolved from storage (was always defaulting to `hant`)
- UI hover effects toned down across settings page — `.model-row`, `.icon-btn`, `.sp-card` hover now uses `var(--bg-card)` instead of hardcoded `#fff`; border no longer strengthens on hover
- System Prompt cards: active/selected state no longer shows coloured border or box-shadow — selection indicated by radio dot only; background stays `var(--bg-subtle)` in both light and dark mode (consistent interaction)
- Translator default prompt: Terminology Notes section updated to specify explanation language direction (Chinese explanation for English source, and vice-versa)

---

## [2.9.16] - 2026-03-30
### Changed
- Thinking toggle now aware of each model's actual capability (3 states):
  - **toggleable** — Qwen, Gemini 2.5, Claude, Kimi, MiniMax: button works normally
  - **always_on** — DeepSeek Reasoner, o1, o3: button locked + accent colour, tooltip explains
  - **unsupported** — GPT-4o, Ollama generic, LM Studio etc: button greyed out, tooltip explains
- Button auto-updates when user switches models
- Correct API params per provider when thinking is on:
  - Qwen / Kimi / MiniMax / Moonshot → `enable_thinking: true`
  - Gemini 2.5 → `thinkingConfig: { thinkingBudget: 8000 }`
  - Claude → `thinking: { type: "enabled", budget_tokens: 10000 }` + `temperature: 1`
  - DeepSeek Reasoner → `response_format: { type: "text" }` only (always on)
- Added i18n keys: `thinkingAlwaysOn`, `thinkingUnsupported`

---

## [2.9.15] - 2026-03-30
### Added
- Global thinking mode toggle button in the composer toolbar (lightbulb icon, next to page-context button)
- One click turns thinking on/off for **all** providers and models universally
- State persists via `chrome.storage.sync` (`globalThinking` key)
- When enabled: `enable_thinking: true` is sent in every API request, and `<think>` blocks are rendered regardless of model name or per-provider setting
- Per-provider thinking setting in options still works as before; global toggle is an OR override

---

## [2.9.14] - 2026-03-30
### Fixed
- Language switching broken after sync migration — `zhVariant` was removed from the local read, so first load after update always defaulted to `hant`
- Language/theme/font switches now write to **both** local (for instant reload) and sync (for cross-device)
- `sidepanel.js` `loadTheme()` and `awaitGetZhVariant()` now fall back to local if sync value is absent
- Added all UI settings back to local read as migration fallback (`zhVariant`, `theme`, `messageSize`, `messageWeight`, `showFloatBall`, capture settings)

---

## [2.9.13] - 2026-03-30
### Changed
- NVIDIA icon replaced with official LobeHub SVG (sourced from `@lobehub/icons-static-svg`) — uses `currentColor`, single-path design matching the real NVIDIA wordmark/eye logo

---

## [2.9.12] - 2026-03-30
### Changed
- All settings now sync across Google accounts via `chrome.storage.sync`
- Synced keys: provider configs (API keys, base URLs, models), `activeProvider`, `model`, `theme`, `zhVariant`, `messageSize`, `messageWeight`, `showFloatBall`, all page capture settings, `pageContextLimit`
- Chat sessions and computed aggregates (`customModels`, `providerConfigs`) remain in local storage
- `content-floatball.js` and `background.js` updated to read/write floatball state from sync
- `loadAll()` reads sync first with local fallback for seamless migration of existing users

---

## [2.9.11] - 2026-03-30
### Changed
- All provider models are now fully editable — users can delete or rename any default model
- Removed readonly lock and hidden delete button on default models in the model list
- Removed `ensureDefaultModels` enforcement from save, load, and persist flows (defaults only apply on first-time init)

---

## [2.9.10] - 2026-03-30
### Fixed
- Provider select button showed wrong icon (momo) for newly added providers — replaced hardcoded icon map with `PROVIDER_ICONS` from utils.js so all providers resolve correctly

---

## [2.9.9] - 2026-03-30
### Changed
- Provider list sorted alphabetically: DeepSeek → Google AI → LM Studio → MiniMax → Moonshot → NVIDIA → Ollama → OpenClaw → OpenAI → OpenRouter → Qwen

---

## [2.9.8] - 2026-03-30
### Added
- MiniMax provider (`api.minimaxi.chat/v1`), models: MiniMax-Text-01, abab6.5s-chat, abab6.5-chat
- Moonshot provider (`api.moonshot.cn/v1`), models: moonshot-v1-8k/32k/128k, kimi-k2
- OpenRouter provider (`openrouter.ai/api/v1`), preset models: GPT-4o, Claude 3.5 Sonnet, Gemini 2.5 Pro, DeepSeek
- Icons for all three providers sourced from LobeHub icons CDN

---

## [2.9.7] - 2026-03-30
### Changed
- NVIDIA icon replaced with proper eye/swirl logo SVG (traced from official PNG)

---

## [2.9.6] - 2026-03-30
### Changed
- Replaced all native browser `confirm()` / `alert()` dialogs with custom-styled modals matching the extension UI (teal accent, rounded corners, dark mode support)
- Affects: delete session, delete all/selected sessions, export, import, reset prompts, image upload warnings, streaming warnings, TTS, paste errors (17 call sites total)

---

## [2.9.5] - 2026-03-29
### Fixed
- Empty sessions (no messages sent) no longer appear in chat history
- Clicking "New Chat" while already on an empty session no longer creates a duplicate empty entry
- Empty sessions are cleaned up from storage on every save

---

## [2.9.4] - 2026-03-29
### Changed
- Welcome screen suggestions updated (方案 D):
  - 隨機給我一個沒用但有趣的冷知識 🎲
  - 幫我想一個今天說出去能唬人的話 🎭
  - 給我一句讓人覺得我很有深度的話 ✨

---

## [2.9.2] - 2026-03-29
### Added
- NVIDIA provider: OpenAI-compatible endpoint (`integrate.api.nvidia.com/v1`), model `moonshotai/kimi-k2.5`

---

## [2.9.1] - 2026-03-29
### Added
- Settings page: left sidebar navigation with anchor links for quick section jumping
- Scroll spy — current section is highlighted as you scroll
- Sidebar auto-hides on screens ≤ 820px (responsive)

---

## [2.9.0] - 2026-03-29
### Added
- **OpenClaw provider (beta)**: WebSocket-based AI gateway integration
  - Session selector: load and switch between OpenClaw gateway sessions
  - Auto-reconnect with backoff strategy
  - RPC protocol aligned with Copilot architecture
  - Tutorial modal with step-by-step setup instructions (Server setup + Device Auth)
- **Google AI provider**: Gemini 2.5 Flash / Pro / Pro MaxThinking models
- **Thinking mode toggle**: enable `enable_thinking` parameter for supported providers (Qwen, etc.)
- **Image upload**: attach multiple images to messages (base64 encoded, inline preview)
- **Page content capture**:
  - Expand/collapse preview card in the composer area
  - Cancel capture mid-flight
  - Tracks last captured URL to avoid redundant re-fetches
- **Adaptive streaming renderer**: throttles DOM updates by content length (80ms / 300ms / 800ms intervals) to prevent jank on long responses
- **Character counter** in the message input
- **Scroll-to-bottom button** with intelligent auto-follow (pauses when user scrolls up)
- **i18n system**: full Traditional Chinese / Simplified Chinese / English UI localization

### Changed
- Shared code extracted into dedicated modules: `js/utils.js`, `js/storage.js`, `js/openclaw.js`, `js/markdown.js`
- Provider defaults (models, base URLs, icons) now centralized in `js/utils.js`
- Default prompts moved to `prompt-defaults.js` (shared by sidepanel + background)
- Background service worker uses `declarativeNetRequest` to rewrite WebSocket `Origin` header for OpenClaw (static rules for 127.0.0.1 + dynamic rule for custom gateway URLs)
- Qwen models updated: added `qwen3-max`; default model is `qwen-flash`
- Ollama models updated: `qwen3-vl:235b` added

### Fixed
- Side panel now uses global configuration (not per-tab), ensuring consistent state across all tabs
- Provider icon path resolution uses `chrome.runtime.getURL` to avoid CSP issues

---

## [2.8.0] - 2026-03-28
### Added
- `floatball-frame.html` for the floating ball iframe

### Changed
- Background service worker refactored: auto-injects floatball content script on install/update to all tabs
- Browser language auto-detected on first install (English / Traditional Chinese / Simplified Chinese)

---

## [pre-2.8.0] - (no git history before this point)
### Notes
- Baseline feature set: streaming chat, multi-provider support (Qwen, OpenAI, DeepSeek), Markdown rendering, chat session history, page content capture (Readability + Turndown), system prompt management, dark/light theme
