// 強化版 background.js (2025-10-02)

// ⚠️ Default prompts now live in prompt-defaults.js
importScripts('prompt-defaults.js');
importScripts('js/utils.js');

/* ── OpenClaw：修改 WebSocket Origin header ──
   Chrome 擴充功能的 WebSocket 連線會帶上 chrome-extension:// 作為 Origin，
   但 OpenClaw Gateway 需要 http:// 開頭的 Origin 才能正常推送事件。
   這裡用 declarativeNetRequest 動態攔截並修改 header（與 Copilot 做法一致）。
*/
function setupOpenClawOriginRules(){
  // 靜態規則：覆蓋常見的本地 Gateway 位址
  const staticRules = [
    { id:9001, priority:1,
      action:{ type:'modifyHeaders', requestHeaders:[{header:'Origin', operation:'set', value:'http://127.0.0.1:18789'}]},
      condition:{ urlFilter:'ws://127.0.0.1:18789/*', resourceTypes:['websocket']}},
    { id:9002, priority:1,
      action:{ type:'modifyHeaders', requestHeaders:[{header:'Origin', operation:'set', value:'http://localhost:18789'}]},
      condition:{ urlFilter:'ws://localhost:18789/*', resourceTypes:['websocket']}},
  ];
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: staticRules.map(r=>r.id),
    addRules: staticRules
  }, ()=>{
    if(chrome.runtime.lastError)
      console.warn('[OpenClaw] 靜態 Origin 規則設定失敗:', chrome.runtime.lastError);
    else
      console.log('[OpenClaw] 靜態 Origin 規則已設定');
  });
}

/* 動態添加規則：當用戶設定了自定義 Gateway URL 時，自動添加對應的 Origin 規則 */
function updateOpenClawDynamicRule(wsUrl){
  if(!wsUrl) return;
  try{
    const u = new URL(wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'));
    const httpOrigin = u.origin; // e.g. "http://140.245.56.126:2001"
    const wsFilter = wsUrl.replace(/\/+$/, '') + '/*';
    const ruleId = 9010;
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId, priority: 1,
        action:{ type:'modifyHeaders', requestHeaders:[{header:'Origin', operation:'set', value: httpOrigin}]},
        condition:{ urlFilter: wsFilter, resourceTypes:['websocket']}
      }]
    }, ()=>{
      if(chrome.runtime.lastError)
        console.warn('[OpenClaw] 動態 Origin 規則設定失敗:', chrome.runtime.lastError);
      else
        console.log('[OpenClaw] 動態 Origin 規則已設定:', wsFilter, '→', httpOrigin);
    });
  }catch(e){
    console.warn('[OpenClaw] URL 解析失敗:', e);
  }
}

function isSupportedUrl(url) {
  if (!url) return false;
  return !/^chrome:|^edge:|^brave:|^opera:|^chrome-extension:|^devtools:/.test(url);
}

async function ensureSidePanelForTab(tab) {
  try{
    // 使用全局配置而不是針對單個標籤頁，讓所有標籤頁共享同一個 sidepanel 內容
    if (chrome.sidePanel?.setOptions) {
      await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
      return true;
    }
  }catch(err){
    console.warn('[background] setOptions failed (will still try open)', err, tab);
  }
  return !!(tab?.windowId && chrome.sidePanel?.open);
}

async function ensureActionClickBehavior() {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      console.log('[background] setPanelBehavior openPanelOnActionClick:true');
      return true;
    }
  } catch (e) {
    console.warn('[background] setPanelBehavior failed', e);
  }
  return false;
}

// 檢測瀏覽器語言，返回 'hant' (繁體)、'hans' (簡體) 或 'en' (英文)
function detectBrowserLanguage() {
  try {
    // 使用瀏覽器語言設定（Chrome 擴充功能的 UI 語言）
    const browserLang = chrome.i18n?.getUILanguage?.() || navigator.language || 'en';
    console.log('[background] Browser language detected:', browserLang);
    
    // 檢查是否為英文
    if (browserLang.startsWith('en')) {
      return 'en';
    }
    // 檢查是否為繁體中文區域（zh-TW, zh-HK, zh-MO）
    if (browserLang.startsWith('zh-TW') || browserLang.startsWith('zh-HK') || browserLang.startsWith('zh-MO')) {
      return 'hant';
    }
    // 檢查是否為簡體中文區域（zh-CN, zh-SG）
    if (browserLang.startsWith('zh-CN') || browserLang.startsWith('zh-SG')) {
      return 'hans';
    }
    // 如果只是 'zh'，默認繁體中文
    if (browserLang.startsWith('zh')) {
      return 'hant';
    }
  } catch (e) {
    console.warn('[background] Failed to detect browser language:', e);
  }
  // 默認返回英文（因為是國際化擴充功能）
  return 'en';
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[background] onInstalled', details);
  await ensureActionClickBehavior();

  // 設定 OpenClaw Origin 規則
  setupOpenClawOriginRules();
  // 讀取用戶已設定的 OpenClaw URL，動態添加規則
  chrome.storage.local.get(['providerConfigs'], (res)=>{
    if(res.providerConfigs){
      for(const [k,v] of Object.entries(res.providerConfigs)){
        if(v?.isOpenClaw && v?.baseUrl) updateOpenClawDynamicRule(v.baseUrl);
      }
    }
  });

  // 在安裝或更新時，向所有已打開的標籤頁注入 content script
  if (details.reason === 'install' || details.reason === 'update') {
    console.log('[background] Injecting content scripts to existing tabs...');
    
    // 確保 showFloatBall 有默認值
    const stored = await chrome.storage.sync.get(['showFloatBall']);
    if (stored.showFloatBall === undefined) {
      await chrome.storage.sync.set({ showFloatBall: true });
      console.log('[background] Set default showFloatBall: true');
    }
    
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        // 只在支援的 URL 上注入
        if (tab.id && tab.url && isSupportedUrl(tab.url)) {
          try {
            // 先清理舊的標記，允許重新注入
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                document.documentElement.classList.remove('momo-floatball-mounted');
              }
            });
            
            // 再注入 content script
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-floatball.js']
            });
            console.log(`[background] Injected to tab ${tab.id}: ${tab.url}`);
          } catch (err) {
            // 某些頁面可能不允許注入（如 chrome:// 頁面），靜默忽略
            console.debug(`[background] Skip tab ${tab.id}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn('[background] Failed to inject content scripts:', err);
    }
  }

  chrome.storage.sync.get(['prompts', 'selectedPrompt'], async (res) => {
    try {
      if (res.prompts) {
        const migrated = migratePromptIds(res.prompts, res.selectedPrompt);
        if (migrated.changed) {
          await chrome.storage.sync.set({
            prompts: migrated.prompts,
            selectedPrompt: migrated.selected || DEFAULT_PROMPT_ID
          });
          console.log('[background] migrated prompt ids');
        }
      } else {
        await chrome.storage.sync.set({
          prompts: cloneDefaultPrompts(),
          selectedPrompt: DEFAULT_PROMPT_ID
        });
        console.log('[background] default prompts set');
      }
    } catch (err) {
      console.warn('[background] prompt init error', err);
    }
  });

  chrome.storage.local.get(['chatSessions'], (res) => {
    if (!res.chatSessions) {
      chrome.storage.local.set({
        chatSessions: [],
        currentSessionId: null
      }, () => console.log('[background] initialized empty sessions'));
    }
  });

  if (details.reason === 'install') {
    const defaultQwenModels = [
      { name: 'qwen3-max', enabled: false, provider: 'qwen' },
      { name: 'qwen-flash', enabled: false, provider: 'qwen' }
    ];
    const qwenDef = PROVIDER_DEFAULTS.qwen;
    const defaultQwenProvider = {
      apiKey: '',
      customBaseUrl: '',
      models: [
        { name: 'qwen3-max', enabled: false },
        { name: 'qwen-flash', enabled: false }
      ],
      enableThinking: qwenDef.defaultEnableThinking || false
    };
    const defaultQwenConfig = {
      apiKey: '',
      baseUrl: qwenDef.baseUrl,
      enableThinking: qwenDef.defaultEnableThinking || false
    };

    Promise.all([
      chrome.storage.local.get(['customModels','providerConfigs','apiKey','apiEndpoint']),
      chrome.storage.sync.get(['activeProvider','model','provider_qwen','showFloatBall','zhVariant'])
    ]).then(([localRes, syncRes]) => {
      const localUpdates = {};
      const syncUpdates = {};

      if (!syncRes.provider_qwen) {
        syncUpdates.provider_qwen = defaultQwenProvider;
      }

      // 確保懸浮球默認開啟
      if (syncRes.showFloatBall === undefined) {
        syncUpdates.showFloatBall = true;
      }

      // 根據瀏覽器語言自動設定語言（僅首次安裝時）
      if (syncRes.zhVariant === undefined) {
        const detectedLang = detectBrowserLanguage();
        syncUpdates.zhVariant = detectedLang;
        localUpdates.zhVariant = detectedLang;
        console.log('[background] Auto-detected language from browser:', detectedLang);
      }

      const hasLegacyConfig = Boolean(localRes.apiKey || localRes.apiEndpoint);

      const existingModels = Array.isArray(localRes.customModels) ? localRes.customModels : [];
      if (existingModels.length === 0 && !hasLegacyConfig) {
        localUpdates.customModels = defaultQwenModels;
        syncUpdates.model = 'qwen3-max';
      }

      const existingConfigs = (localRes.providerConfigs && typeof localRes.providerConfigs === 'object') ? localRes.providerConfigs : {};
      if (!existingConfigs.qwen) {
        localUpdates.providerConfigs = { ...existingConfigs, qwen: defaultQwenConfig };
      }

      if (!syncRes.activeProvider && !hasLegacyConfig) {
        syncUpdates.activeProvider = 'qwen';
      }

      const syncKeys = Object.keys(syncUpdates);
      const localKeys = Object.keys(localUpdates);
      if (syncKeys.length > 0) {
        chrome.storage.sync.set(syncUpdates, () => {
          console.log('[background] applied default sync configuration');
        });
      }
      if (localKeys.length > 0) {
        chrome.storage.local.set(localUpdates, () => {
          console.log('[background] applied default local configuration');
        });
      }
      if (syncKeys.length > 0 || localKeys.length > 0) {
        console.log('[background] applied default Qwen configuration');
      }
    });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[background] onStartup');
  await ensureActionClickBehavior();
  // 設定 OpenClaw Origin 規則
  setupOpenClawOriginRules();
  chrome.storage.local.get(['providerConfigs'], (res)=>{
    if(res.providerConfigs){
      for(const [k,v] of Object.entries(res.providerConfigs)){
        if(v?.isOpenClaw && v?.baseUrl) updateOpenClawDynamicRule(v.baseUrl);
      }
    }
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  console.log('[background] command received:', command);
  if (command === 'toggle-sidebar') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const ok = await ensureSidePanelForTab(tab);
      if (ok && tab?.windowId && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        console.log('[background] side panel opened via command');
      } else {
        console.warn('[background] sidePanel.open not available');
      }
    } catch (e) {
      console.warn('[background] sidePanel open error', e);
    }
  }
});

// 使用 action.onClicked 來打開側邊面板
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[background] action clicked');
  try {
    const ok = await ensureSidePanelForTab(tab);
    if (ok && tab?.windowId && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      console.log('[background] sidepanel opened via action click');
    }
  } catch (e) {
    console.warn('[background] action click failed', e);
  }
});

let lastSidePanelState = new Map();
let lastFocusedTabId = null;

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastFocusedTabId = activeInfo?.tabId ?? null;
});

const markSidePanelState = (tabId, action) => {
  if (!tabId) return;
  const enabled = action === 'opened';
  lastSidePanelState.set(tabId, enabled);
  if (enabled) {
    chrome.tabs.get(tabId, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) return;
      if (tab?.windowId) {
        lastFocusedTabId = tab.id;
      }
    });
  }
};

const respondSidePanelState = (tabId, sendResponse) => {
  // 使用全局配置而不是針對單個標籤頁
  chrome.sidePanel.getOptions({}, (options) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn('[background] getOptions failed', err);
      sendResponse?.({ ok:false, error: err.message });
      return;
    }
    const enabled = !!options?.enabled;
    if (tabId) {
      lastSidePanelState.set(tabId, enabled);
    }
    sendResponse?.({ ok:true, enabled });
  });
};

// 監聽 storage 變化，自動更新 OpenClaw Origin 規則
chrome.storage.onChanged.addListener((changes, area)=>{
  if(area === 'local' && changes.providerConfigs){
    const newConfigs = changes.providerConfigs.newValue;
    if(newConfigs){
      for(const [k,v] of Object.entries(newConfigs)){
        if(v?.isOpenClaw && v?.baseUrl) updateOpenClawDynamicRule(v.baseUrl);
      }
    }
  }
});

// 接收 content script 懸浮球的開啟請求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  // Proxy fetch: side panel / options 請求 background 代理 HTTP 請求（繞過部分反爬）
  if(msg && msg.type === 'proxy_fetch'){
    (async ()=>{
      try {
        const { url, options } = msg;
        const resp = await fetch(url, options || {});
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, text });
      } catch(e) {
        sendResponse({ ok: false, status: 0, text: '', error: e.message });
      }
    })();
    return true;
  }
  if(msg && msg.type==='openclaw_update_origin' && msg.wsUrl){
    updateOpenClawDynamicRule(msg.wsUrl);
    return;
  }
  if(msg && msg.type==='open_sidepanel'){
    (async ()=>{
      try{
        const [tab] = sender?.tab ? [sender.tab] : await chrome.tabs.query({ active:true, currentWindow:true });
        const ok = await ensureSidePanelForTab(tab);
        if(ok && tab?.windowId && chrome.sidePanel?.open){
          await chrome.sidePanel.open({ windowId: tab.windowId });
          sendResponse?.({ ok:true });
        }else{
          sendResponse?.({ ok:false, reason:'no-sidepanel' });
        }
      }catch(e){
        console.warn('[background] open_sidepanel failed', e);
        sendResponse?.({ ok:false, error:String(e) });
      }
    })();
    return true; // keep channel open for async response
  }
  if(msg && msg.action === 'getSidePanelState'){
    const respond = (payload) => {
      if (sendResponse) {
        try { sendResponse(payload); } catch(_) {}
      }
    };

    const tab = sender?.tab;
    let tabId = tab?.id;
    if(!tabId){
      if (lastFocusedTabId) {
        tabId = lastFocusedTabId;
      }
    }
    if(tabId){
      const cached = lastSidePanelState.get(tabId);
      if (typeof cached === 'boolean') {
        respond({ ok:true, enabled: cached, cached:true });
        return true;
      }
      respondSidePanelState(tabId, respond);
      return true;
    }
    chrome.tabs.query({ active:true, currentWindow:true }, (tabs) => {
      const active = tabs && tabs[0];
      if(!active || !active.id){
        console.warn('[background] getSidePanelState: no tab id');
        respond({ ok:false, reason:'no-tab' });
        return;
      }
      respondSidePanelState(active.id, respond);
    });
    return true;
  }
  // 根據 content script 傳回的狀態決定開關，避免切換分頁後第一次點擊被忽略
  if(msg && msg.action === 'toggleSidePanel'){
    const useTab = (cb) => {
      if (sender?.tab?.id) {
        cb(sender.tab);
        return;
      }
      chrome.tabs.query({ active:true, currentWindow:true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) {
          console.warn('[background] toggleSidePanel: no active tab');
          sendResponse?.({ ok:false, reason:'no-tab' });
          return;
        }
        cb(tab);
      });
    };

    useTab((tab) => {
      const tabId = tab.id;
      const desired = msg.desiredAction === 'close' ? 'close'
                      : msg.desiredAction === 'open' ? 'open'
                      : null;

      const respond = (payload) => {
        if (sendResponse) {
          try { sendResponse(payload); } catch(_) {}
        }
      };

      const openPanel = () => {
        // 使用全局配置而不是針對單個標籤頁
        chrome.sidePanel.setOptions({ path:'sidepanel.html', enabled:true }, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn('[background] sidepanel enable failed', err);
            respond({ ok:false, error: err.message });
            return;
          }

          if (typeof chrome.sidePanel?.open !== 'function') {
            console.warn('[background] sidepanel.open unavailable');
            respond({ ok:false, error:'sidepanel-open-unavailable' });
            return;
          }

          chrome.sidePanel.open({ windowId: tab.windowId }, () => {
            const openErr = chrome.runtime.lastError;
            if (openErr) {
              console.warn('[background] sidepanel open failed', openErr);
              respond({ ok:false, error: openErr.message });
            } else {
              console.log('[background] sidepanel opened');
              markSidePanelState(tabId, 'opened');
              respond({ ok:true, action:'opened' });
            }
          });
        });
      };

      const closePanel = () => {
        // 使用全局配置而不是針對單個標籤頁
        chrome.sidePanel.setOptions({ enabled:false }, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn('[background] sidepanel disable failed', err);
            respond({ ok:false, error: err.message });
          } else {
            console.log('[background] sidepanel disabled');
            markSidePanelState(tabId, 'closed');
            respond({ ok:true, action:'closed' });
          }
        });
      };

      if (desired === 'open') {
        openPanel();
        return;
      }
      if (desired === 'close') {
        closePanel();
        return;
      }

      // 使用全局配置而不是針對單個標籤頁
      chrome.sidePanel.getOptions({}, (options) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn('[background] getOptions failed', err);
          openPanel();
          return;
        }
        if (options?.enabled) {
          closePanel();
        } else {
          openPanel();
        }
      });
    });
    
    return true; // 保持 message channel 開啟
  }
});
