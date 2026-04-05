# 🐹 Momo AI Bud

繁體中文 | [English](README.md)

🐹 **嘿，夥伴！來認識 Momo** — 你的瀏覽器裡，住著一隻溫暖的小夥伴。Momo AI Bud 是一款由設計師打造的 Chrome 側邊欄，相信 AI 工具不該只有功能，更該有溫度、有個性、有陪伴感 ✨。支援 11+ AI 模型對話 🤖、聯網搜尋 🔍、頁面擷取 📄、圖片理解 🖼️、深度思考 💡 — 一切都在一個小小的側邊欄裡，像跟朋友聊天一樣自然 💬

![Momo AI 截圖](docs/momo-preview.png)

📖 **完整說明文件**：[designkidd.github.io](https://designkidd.github.io) — 安裝指南、功能介紹、供應商設定、更新日誌等。

## 功能

- 支援 11+ AI 供應商（OpenAI、Google Gemini、DeepSeek、Qwen、Ollama、LM Studio、OpenRouter、NVIDIA、Groq、MiniMax、Moonshot、OpenClaw、自訂）
- 側邊欄聊天介面
- 浮球快速啟動
- 網頁內容擷取與引用
- 聯網搜尋（DuckDuckGo、Brave、Tavily）
- 圖片上傳與理解
- 思考模式（Thinking / Reasoning）
- 語音朗讀（TTS）
- 自訂系統提示詞
- 聊天記錄管理
- 多語言介面（繁中 / 簡中 / English）
- 快捷鍵支援

## 🆓 免費 API 供應商

無需信用卡，幾分鐘即可開始使用：

| 供應商 | 免費模型 | 頻率限制 | 申請 API Key | 模型列表 |
|--------|---------|---------|-------------|---------|
| **Ollama Cloud** | minimax-m2.7、kimi-k2.5 等 | 單一並行任務，GPU 配額每 5 小時 / 7 天重置 | [ollama.com/settings/keys](https://ollama.com/settings/keys) | [查看模型](https://ollama.com/v1/models) |
| **Google AI Studio** | gemini-3-flash-preview、gemini-3.1-flash-lite-preview | 每日 1,500 次 / 每分鐘 15 次，最高 100 萬 Token 上下文 | [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) | [查看模型](https://ai.google.dev/gemini-api/docs/models) |
| **Groq** | Llama 3.3、DeepSeek-R1 | 每分鐘 ~30 次 / 每日 14,400 次，全球頂尖推理速度 | [console.groq.com/keys](https://console.groq.com/keys) | [查看模型](https://console.groq.com/docs/rate-limits) |
| **NVIDIA NIM** | 標註「Free Endpoint」的模型 | 每分鐘 ~40 次，無總量限制 | [build.nvidia.com/settings/api-keys](https://build.nvidia.com/settings/api-keys) | [查看模型](https://build.nvidia.com/models) |

> **API 端點**：Ollama Cloud `https://ollama.com/v1` · Google AI `https://generativelanguage.googleapis.com/v1beta` · Groq `https://api.groq.com/openai/v1` · NVIDIA `https://integrate.api.nvidia.com/v1`

## 安裝

### 從 Release 下載

1. 到 [Releases](https://github.com/designkidd/momo-bud/releases) 下載最新的 `momo-ai-*-chrome.zip`
2. 解壓縮
3. 開啟 Chrome，前往 `chrome://extensions/`
4. 開啟「開發人員模式」
5. 點擊「載入未封裝項目」，選擇解壓縮後的資料夾
6. 點擊工具列上的 Momo 圖示開始使用

### 從原始碼安裝

1. Clone 此專案
2. 開啟 Chrome，前往 `chrome://extensions/`
3. 開啟「開發人員模式」
4. 點擊「載入未封裝項目」，選擇 `sider/` 資料夾

## 說明文件

📖 [designkidd.github.io](https://designkidd.github.io)

## 專案結構

```
sider/              # Chrome 擴充功能原始碼
├── manifest.json   # MV3 manifest
├── background.js   # Service worker
├── sidepanel.*     # 側邊欄 UI
├── options.*       # 設定頁面
├── assets/         # 圖示、i18n 翻譯
├── js/             # 核心模組
└── libs/           # 第三方函式庫
docs/               # 說明文件網站
```

## 授權

MIT License
