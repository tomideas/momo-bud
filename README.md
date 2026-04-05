# 🐹 Momo AI Bud

[繁體中文](README.zh-TW.md) | English

🐹 **Hey bud! Meet Momo** — your friendly AI companion, right in your browser. Momo AI Bud is a Chrome sidebar crafted by a designer who believes AI tools should feel warm, personal, and delightful ✨ — not just functional. Chat with 11+ AI models 🤖, search the web 🔍, capture pages 📄, upload images 🖼️, and think deeper 💡 — all from a cozy little sidebar that feels like talking to a friend 💬

![Momo AI Screenshot](docs/momo-preview.png)

## ✨ Features

- 🤖 11+ AI providers (OpenAI, Google Gemini, DeepSeek, Qwen, Ollama, LM Studio, OpenRouter, NVIDIA, Groq, MiniMax, Moonshot, OpenClaw, Custom)
- 💬 Sidebar chat interface
- 🎈 Floating ball for quick access
- 📄 Web page capture & reference
- 🔍 Web search (DuckDuckGo, Brave, Tavily)
- 🖼️ Image upload & vision
- 💡 Thinking mode (Thinking / Reasoning)
- 🔊 Text-to-Speech (TTS)
- 📝 Custom system prompts
- 🗂️ Chat history management
- 🌐 Multi-language UI (繁中 / 簡中 / English)
- ⌨️ Keyboard shortcuts

## 🆓 Free API Providers

No credit card needed. Get started in minutes:

| Provider | Free Models | Rate Limit | Get API Key | Models |
|----------|------------|------------|-------------|--------|
| **Ollama Cloud** | minimax-m2.7, kimi-k2.5 and more | 1 concurrent task, GPU quota resets every 5h / 7d | [ollama.com/settings/keys](https://ollama.com/settings/keys) | [List](https://ollama.com/v1/models) |
| **Google AI Studio** | gemini-3-flash-preview, gemini-3.1-flash-lite-preview | 1,500 RPD / 15 RPM, up to 1M token context | [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) | [List](https://ai.google.dev/gemini-api/docs/models) |
| **Groq** | Llama 3.3, DeepSeek-R1 | ~30 RPM / 14,400 RPD, blazing fast inference | [console.groq.com/keys](https://console.groq.com/keys) | [List](https://console.groq.com/docs/rate-limits) |
| **NVIDIA NIM** | Models marked "Free Endpoint" | ~40 RPM, no total limit | [build.nvidia.com/settings/api-keys](https://build.nvidia.com/settings/api-keys) | [List](https://build.nvidia.com/models) |

> **Base URLs**: Ollama Cloud `https://ollama.com/v1` · Google AI `https://generativelanguage.googleapis.com/v1beta` · Groq `https://api.groq.com/openai/v1` · NVIDIA `https://integrate.api.nvidia.com/v1`

## 📦 Installation

### From Release

1. 📥 Download the latest `momo-ai-*-chrome.zip` from [Releases](https://github.com/designkidd/momo-bud/releases)
2. 📂 Unzip the file
3. 🌐 Open Chrome, go to `chrome://extensions/`
4. 🔧 Enable "Developer mode"
5. 📁 Click "Load unpacked" and select the unzipped folder
6. 🐹 Click the Momo icon in the toolbar to start

### From Source

1. 🔗 Clone this repo
2. 🌐 Open Chrome, go to `chrome://extensions/`
3. 🔧 Enable "Developer mode"
4. 📁 Click "Load unpacked" and select the `sider/` folder

## 📖 Documentation

👉 [tomideas.github.io](https://tomideas.github.io)

## 🗂️ Project Structure

```
sider/              # 🧩 Chrome extension source
├── manifest.json   # 📋 MV3 manifest
├── background.js   # ⚙️ Service worker
├── sidepanel.*     # 💬 Sidebar UI
├── options.*       # 🔧 Settings page
├── assets/         # 🎨 Icons, i18n translations
├── js/             # 🧠 Core modules
└── libs/           # 📚 Third-party libraries
docs/               # 📖 Documentation site
```

## 📄 License

MIT License
