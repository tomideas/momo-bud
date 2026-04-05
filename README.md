# 🐹 Momo AI

[繁體中文](README.zh-TW.md) | English

**Friendly AI Chat Sidebar** — A Chrome extension that lets you chat with multiple AI models on any webpage.

## Features

- 11+ AI providers (OpenAI, Google Gemini, DeepSeek, Qwen, Ollama, LM Studio, OpenRouter, NVIDIA, MiniMax, Moonshot, OpenClaw, Custom)
- Sidebar chat interface
- Floating ball for quick access
- Web page capture & reference
- Web search (Google, DuckDuckGo, Brave, Tavily, SearXNG)
- Image upload & vision
- Thinking mode (Thinking / Reasoning)
- Text-to-Speech (TTS)
- Custom system prompts
- Chat history management
- Multi-language UI (繁中 / 簡中 / English)
- Keyboard shortcuts

## Installation

### From Release

1. Download the latest `momo-ai-*-chrome.zip` from [Releases](https://github.com/designkidd/momo-ai/releases)
2. Unzip the file
3. Open Chrome, go to `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked" and select the unzipped folder
6. Click the Momo icon in the toolbar to start

### From Source

1. Clone this repo
2. Open Chrome, go to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `sider/` folder

## Project Structure

```
sider/              # Chrome extension source
├── manifest.json   # MV3 manifest
├── background.js   # Service worker
├── sidepanel.*     # Sidebar UI
├── options.*       # Settings page
├── assets/         # Icons, i18n translations
├── js/             # Core modules
└── libs/           # Third-party libraries
docs/               # Documentation site
```

## License

MIT License
