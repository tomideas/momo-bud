# Changelog

All notable changes to this project will be documented in this file.

---

## [2.21.2] - 2026-04-06
### Changed
- 同名模型下拉選單不再加 Provider 文字標籤（如 `(Ollama)`），僅靠 Provider icon 區分

---

## [2.21.1] - 2026-04-06
### Fixed — 本地 Provider 同名模型被誤刪
- Ollama / LM Studio 等本地 Provider 手動新增的模型若與其他雲端 Provider 預設模型同名（如在 Ollama 加 `kimi-k2.5`），會被 `sanitizeModels` 和載入時的跨 provider 過濾邏輯誤刪
- 修正：本地 Provider（ollama、lmstudio、無預設模型的 provider）跳過跨 provider 模型歸屬檢查，允許任意模型名稱

---

## [2.21.0] - 2026-04-06
### Added — Groq Provider
- 新增 Groq AI 供應商，預設模型 `openai/gpt-oss-120b` 和 `meta-llama/llama-4-scout-17b-16e-instruct`
- API Key 申請連結指向 https://console.groq.com/keys
- 設定頁顯示 Groq 免費方案說明：無須綁卡、每分鐘約 30 次請求、每日最高 14,400 次、全球頂尖推理速度
- `host_permissions` 加入 `api.groq.com`

---

## [2.20.1] - 2026-04-06
### Changed
- Google AI 預設模型更新為 `gemini-3.1-flash-lite-preview` 和 `gemini-3-flash-preview`

---

## [2.20.0] - 2026-04-06
### Fixed — 同名模型跨 Provider 共存
- 模型唯一識別改用 `provider::name` 組合 uid，不同 Provider 下的同名模型可同時啟用並出現在 sidebar 下拉選單
- 同名模型在下拉選單中自動加上 Provider 名稱標籤（如 `gemini-3.1-flash (Google AI)` / `gemini-3.1-flash (OpenRouter)`）
- 向下相容：舊格式的 model 選擇會自動遷移為新 uid 格式

---

## [2.19.5] - 2026-04-06
### Fixed — 測試連線不再彈出權限請求
- 將所有內建 AI Provider 的 API 域名加入 `manifest.json` 的 `host_permissions`，包括 DeepSeek、Google AI、MiniMax、Moonshot、NVIDIA、OpenRouter、Qwen
- 使用者按 Start Test 時不再觸發 Chrome「has requested additional permissions」彈窗
- 自訂 URL 或 localhost（Ollama / LM Studio）仍會透過 `optional_host_permissions` 動態請求

---

## [2.19.4] - 2026-04-05
### Changed — OpenClaw 設定頁 UX 重構
- **Start Test → Connect / Disconnect**：按鈕改為 Connect，連線成功後變為 Disconnect（hover 變紅），點擊可斷開連線
- **Connected 後自動載入 Session**：Connect 成功後自動呼叫 Load Sessions，不需手動操作
- **Session 切換自動載入對話記錄**：選擇不同 Session 後，側邊欄自動偵測 `providerConfigs.sessionKey` 變更並載入 `chat.history`
- **Enabled Models 預設 off**：未 Connected 前 toggle 為 off + disabled，Connected 後自動開啟
- **Load 按鈕改為 Refresh icon**：Session 旁的 Load 按鈕改為 🔄 refresh icon（`btn btn-outline small`），loading 時旋轉動畫
- **Setup Guide 移到右側**：與 Connect 按鈕同行，左邊 Connect，右邊 Setup Guide
- **Enabled Models 標題改為二級標題**：與 Session 一致的 `field-label` 樣式，左對齊
- **Session 切換提示**：切換 Session 時顯示「切換中…」→「✓ 已切換」狀態提示
- **Model name 簡化**：`openclaw:main` → `openclaw`（HTML、JS、utils.js）

---

## [2.18.1] - 2026-04-05
### Changed
- **OpenClaw 設定頁簡化**：OpenClaw provider 不再顯示完整的 "Enabled Models" 列表和 "Add Model" 按鈕，改為單一 `openclaw:main` 開關；切換回其他 provider 時恢復完整模型列表

---

## [2.17.9] - 2026-04-05
### Fixed — Provider Hint i18n 完整修復（2.17.5 ~ 2.17.9）

此問題經歷多次迭代才完全修復，記錄根因和陷阱以防再犯：

**問題**：設定頁 Provider Configuration 的 hint（"Leave empty to use default: ..." + "Apply for API Key here: ..."）在初始載入或切換語言時顯示不正確。

**根因分析（共 4 層）**：

1. **`data-i18n` 覆蓋動態內容（2.17.6）**
   - `providerBaseUrlHint` 有 `data-i18n="useDefaultUrl"`，i18n-loader 的 `__applyTranslations()` 會把 JS 動態生成的 innerHTML（含 URL + `<a>` 連結）覆蓋回簡單的翻譯字串
   - ✅ 修復：移除 HTML 中的 `data-i18n`，讓 JS 完全控制 hint 內容

2. **`currentLang` 設定時序（2.17.7）**
   - `loadProviderConfig` 的 i18n 重新呼叫在 `currentLang` 設定之前執行，`t()` 使用 fallback `'en'`
   - ✅ 修復：把重新呼叫移到 `await __applyTranslations(lang)` 完成且 `currentLang` 已設定之後

3. **語言切換未觸發 hint 更新（2.17.8）**
   - 切換語言時只呼叫了 `applyLanguageConversion()`，沒有重新呼叫 `loadProviderConfig`
   - ✅ 修復：語言切換 callback 中加入 `await applyLanguageConversion()` + `loadProviderConfig()`

4. **`applyLanguageConversion` 的 async 陷阱（2.17.9）**
   - 函數標記為 `async` 但內部用 `chrome.storage.local.get(key, callback)` — callback 模式不會被 `await` 等待，Promise 立即 resolve
   - ✅ 修復：改用 `await chrome.storage.local.get(key)`（MV3 Promise API），讓 `await` 真正等待完成

**設計原則（避免再犯）**：
- 動態生成的 UI 內容不要加 `data-i18n`，否則 i18n-loader 會覆蓋
- 依賴 i18n 翻譯的 UI 更新必須在 `__applyTranslations()` 完成後執行
- MV3 中 `chrome.storage` API 優先用 Promise 版本，避免 callback + async 的陷阱
- 語言切換時，所有 JS 動態生成的 i18n 內容都需要手動重新渲染

---

## [2.17.3] - 2026-04-05
### Added
- **所有雲端 Provider 加入 API Key 申請連結**：新增 Moonshot、NVIDIA、MiniMax、OpenRouter 的 API Key 申請頁面連結（LM Studio、Ollama、OpenClaw 為本地服務，不需要）

---

## [2.17.2] - 2026-04-05
### Changed
- **所有 AI Provider 預設模型精簡為兩個主流模型**（全部預設關閉）：
  - DeepSeek: `deepseek-chat`, `deepseek-reasoner`
  - Google AI: `gemini-2.5-flash`, `gemini-2.5-pro`
  - MiniMax: `MiniMax-Text-01`, `abab6.5s-chat`
  - Moonshot: `kimi-k2.5`, `kimi-k2`
  - NVIDIA: `nemotron-3-super-120b-a12b`, `nemotron-3-nano-30b-a3b`
  - OpenAI: `gpt-5.4-mini`, `gpt-5.4`
  - OpenRouter: `anthropic/claude-sonnet-4.6`, `deepseek/deepseek-chat`
  - Qwen: `qwen3-max`, `qwen-plus`
  - Ollama: 清空預設（本地模型由使用者自行新增）
  - LM Studio / OpenClaw: 不變

---

## [2.17.1] - 2026-04-05
### Fixed
- **「載入」按鈕中文未 i18n**：`options.html` 中 OpenClaw Session 的「載入」按鈕和 placeholder 文字改為英文預設並加上 `data-i18n="loadSessions"`，中文系統由 i18n-loader 自動替換

---

## [2.17.0] - 2026-04-05
### Changed
- **全面 i18n 國際化**：移除所有 JS 檔案中的 hardcoded 中文字串（約 50+ 處），改用 i18n key 或英文 fallback
  - `js/openclaw.js`：5 處錯誤訊息改為英文
  - `sidepanel.js`：OpenClaw 錯誤、頁面引用 UI、session 標題、圖片 alt、搜尋結果、格式化錯誤訊息等
  - `options.js`：按鈕文字、WebSocket 錯誤、TTS 預覽 fallback 等
  - `content-floatball.js`：3 個 tooltip 改為英文
- **i18n JSON 新增 25 個 key**（`en.json`、`hant.json`、`hans.json` 三語同步）

### Fixed
- **英文系統不再顯示中文錯誤訊息**：如「載入失敗」「連線逾時」「無可用 Session」等

---

## [2.16.5] - 2026-04-05
### Fixed
- **OpenClaw 回覆太慢導致「未回應」問題**：
  - `chat.send` RPC 超時從 30 秒增加到 60 秒
  - `chat.send` 超時時若事件流已有回應，不再直接結束，繼續等待回覆
  - 新增輪詢穩定檢查：備用輪詢取得回覆後若 15 秒內無新內容變化，自動視為完成

---

## [2.16.4] - 2026-04-05
### Changed
- **移除 hardcoded API Key**：NVIDIA、Ollama、Qwen 的 `defaultApiKey` 和 `enforceDefaultEnabled` 已移除，所有模型預設為關閉

---

## [2.16.3] - 2026-04-05
### Changed
- **模型選擇器固定寬度**：`#modelSelector` 寬度固定為 160px，不再隨模型名稱長度變動

---

## [2.16.2] - 2026-04-05
### Changed
- **按鈕順序調整**：Upload Image 和 Reference Page 按鈕位置互換（圖片上傳在前）

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
