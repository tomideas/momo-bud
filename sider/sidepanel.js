/* sidepanel.js
   Enhanced Markdown (no third-party) + Streaming
   Ultra Compact Bubbles + Single-line shrink
   Quick Scroll-To-Bottom (autoFollow)
   Teal Accent (v9) – CSS handles colors
   Date: 2025-10-02 */

'use strict';
console.time('[SP] boot');

const SHOW_SYSTEM_PROMPT_BUBBLE = false;
const STREAM_TEMPERATURE = 0.7;
const ENFORCE_HOST_PERMISSION = false;

/* Composer sizing */
const COMPOSER_BASE_HEIGHT = 44;
const COMPOSER_MAX_HEIGHT  = 200;
let lastComposerHeight = COMPOSER_BASE_HEIGHT;

/* Quick scroll config */
let autoFollow = true;
const AUTO_FOLLOW_BREAK_OFFSET = 80;
const SHOW_SCROLL_BTN_THRESHOLD = 80;
const AUTO_FOLLOW_REARM_OFFSET = 150;

let prompts = [];
let sessions = [];
let currentSessionId = null;
let selectedSessionIds = new Set();

let streaming = false;
let streamAbortController = null;
let preferMarkdown = true;
let missingApiAlerted = false;
let chatWithPageEnabled = false;
let webSearchEnabled = false;
let pageContextBusy = false;
let pageContextCancelRequested = false; // 取消抓取標誌
let pageContextErrorResetHandle = null;
let lastCapturedPageUrl = null; // 追蹤最後引用的頁面 URL
let pageContextTransitionToken = 0; // 協調多次快速切換

// 圖片上傳相關
let uploadedImages = []; // 存儲上傳的圖片 {data: base64, type: 'image/jpeg', name: 'filename'}

// 串流渲染節流：避免大段文本高頻率更新造成卡頓
const STREAM_RENDER_INTERVAL_MS = 80; // 基础更新间隔（12.5 FPS）
const STREAM_RENDER_MAX_LENGTH = 30000; // 超过此长度时降低更新频率
const STREAM_RENDER_LONG_INTERVAL_MS = 300; // 长内容的更新间隔（3.3 FPS）
const STREAM_RENDER_VERY_LONG_LENGTH = 80000; // 超长内容阈值
const STREAM_RENDER_VERY_LONG_INTERVAL_MS = 800; // 超长内容的更新间隔（1.25 FPS）
const streamUpdateTimers = new Map(); // ts -> { timer, latest, isMarkdown }
const streamingContexts = new Map(); // ts -> { model, modelProvider, modelThinkingParams }

/* ── PROVIDER_ICONS & getProviderIconUrl now in js/utils.js ── */

// 自動捲動
let scrollRAF = null;
let _programmaticScroll = false;
let _streamScrollInterval = null;
let isFirstMessage = false;
let lastScrollPosition = 0;
let currentStreamingMessageTs = null;

/* ── OpenClawGateway, extractOpenClawText now in js/openclaw.js ── */

/* OpenClaw：透過 WebSocket 聊天（完全對齊 Copilot） */
async function streamOpenClawChat(assistantTs){
  const model = els.modelSelector.value;
  const { customModels, providerConfigs } = await chrome.storage.local.get(['customModels','providerConfigs']);

  let modelProvider = null;
  if(Array.isArray(customModels)){
    const md = customModels.find(m => m.name === model);
    modelProvider = md?.provider;
  }
  const cfg = providerConfigs?.[modelProvider];
  if(!cfg?.isOpenClaw) throw new Error('Not an OpenClaw provider');

  const wsUrl = cfg.baseUrl;
  const token = cfg.apiKey || '';

  if(!wsUrl) throw new Error(sp_t('openclawMissingUrl'));

  const lang = await awaitGetZhVariant();

  // 確保 Origin 規則已更新（通知 background）
  try{ chrome.runtime.sendMessage({ type:'openclaw_update_origin', wsUrl }); }catch(e){}

  // 確保連線（先連線才能讀到 hello 回應）
  if(!openclawGateway) openclawGateway = new OpenClawGateway();
  try{
    await openclawGateway.ensureConnected({ url: wsUrl, token });
    updateThinkingStatus(assistantTs, '');
  }catch(e){
    throw new Error(sp_t('openclawConnectFailed') + ': ' + e.message);
  }

  // sessionKey 優先順序（與 Copilot Eg() 一致）：
  // 1. 使用者在選項頁面明確設定的
  // 2. hello 回應中的 mainSessionKey
  // 3. 預設 agent:main:main
  let sessionKey = (cfg.sessionKey || '').trim();
  if(!sessionKey){
    const snap = openclawGateway.hello?.snapshot;
    const mainKey = snap?.sessionDefaults?.mainSessionKey?.trim()
                 || snap?.sessionDefaults?.mainKey?.trim()
                 || '';
    sessionKey = mainKey || 'agent:main:main';
    console.log('[OpenClaw] hello snapshot sessionDefaults:', JSON.stringify(snap?.sessionDefaults));
  }
  console.log('[OpenClaw] 使用 sessionKey:', sessionKey);

  // 取得最新的使用者訊息
  const session = getCurrentSession();
  if(!session) throw new Error('No active session');
  const userMessages = session.messages.filter(m => m.role === 'user');
  const lastUserMsg = userMessages[userMessages.length - 1];

  let userText = '';
  let userImages = [];
  if(lastUserMsg){
    if(typeof lastUserMsg.content === 'string'){
      userText = lastUserMsg.content;
    } else if(Array.isArray(lastUserMsg.content)){
      userText = lastUserMsg.content.filter(p => p.type === 'text').map(p => p.text).join(' ');
      userImages = lastUserMsg.content.filter(p => p.type === 'image_url').map(p => p.image_url?.url || '');
    }
  }

  // 構建 chat.send 參數（與 Copilot ju() 一致）
  const idempotencyKey = crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(16).slice(2));
  const sendParams = {
    sessionKey,
    message: userText || '',
    idempotencyKey,
    deliver: false
  };
  // 圖片附件（與 Copilot 格式完全一致：{ type, mimeType, content }）
  if(userImages.length > 0){
    sendParams.attachments = userImages.map(url => {
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if(m) return { type:'image', mimeType: m[1], content: m[2] };
      return null;
    }).filter(Boolean);
  }

  showThinkingDots(assistantTs, '');

  // ── 狀態 ──
  let chatStream = '';           // 事件流累積的文本
  let chatRunId = idempotencyKey;
  let cleanup = null;
  let done = false;
  let pollTimer = null;
  let pollDelayTimer = null;
  let overallTimeout = null;
  let finishResolve = null;
  let eventCount = 0;           // 所有事件計數
  let chatEventCount = 0;       // chat 事件計數（delta/final）
  let pollCount = 0;
  const sendTs = Date.now();    // 發送時間戳，用於輪詢過濾

  // ── 完成處理 ──
  function finish(text){
    if(done) return;
    done = true;
    if(cleanup) cleanup();
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
    if(pollDelayTimer){ clearTimeout(pollDelayTimer); pollDelayTimer = null; }
    if(overallTimeout){ clearTimeout(overallTimeout); overallTimeout = null; }
    hideThinkingDots(assistantTs);
    if(finishResolve) finishResolve(text || '');
  }

  const finishPromise = new Promise(r => { finishResolve = r; });

  // ── 從 chat.history 獲取最終回覆（與 Copilot 的 sn() 一致）──
  async function fetchFinalFromHistory(){
    try{
      const hist = await openclawGateway.request('chat.history',
        { sessionKey, limit: 20 }, { timeoutMs: 8000 });
      const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
      // 找最後一條 user 後的 assistant 回覆
      let lastUserIdx = -1;
      for(let i = msgs.length - 1; i >= 0; i--){
        if(msgs[i].role === 'user'){ lastUserIdx = i; break; }
      }
      for(let i = lastUserIdx + 1; i < msgs.length; i++){
        const m = msgs[i];
        if(m.role !== 'assistant') continue;
        const text = extractOpenClawText(m);
        if(text && typeof text === 'string'){
          return text.replace(/\[\[\s*reply_to:[^\]]+\]\]/g, '').trim();
        }
      }
    }catch(e){
      console.warn('[OpenClaw] fetchFinalFromHistory 失敗:', e.message);
    }
    return null;
  }

  // ── 1) 事件監聽（即時串流 — 主要機制，與 Copilot 一致） ──
  cleanup = openclawGateway.onEvent((evt)=>{
    if(done) return;
    const evtName = evt.event || '';
    const payload = evt.payload || {};
    eventCount++;

    console.log('[OpenClaw] 事件 #'+eventCount+':', evtName, 'state:', payload.state,
      JSON.stringify(payload).slice(0, 600));

    if(evtName === 'agent'){
      // agent 事件表示 OpenClaw 正在工作（如 web_search、web_fetch）
      const agentData = payload.data || payload;
      const toolName = agentData.name || agentData.tool || payload.action || payload.type || '';
      const phase = agentData.phase || '';
      if(toolName){
        updateThinkingStatus(assistantTs, '');
      } else {
        updateThinkingStatus(assistantTs, '');
      }
      return;
    }

    if(evtName === 'chat'){
      if(payload.sessionKey && payload.sessionKey !== sessionKey) return;

      if(payload.state === 'delta'){
        chatEventCount++;
        const text = extractOpenClawText(payload.message);
        if(typeof text === 'string'){
          // 事件流永遠覆蓋（不做長度比較，避免舊輪詢文本擋住新回覆）
          chatStream = text;
          hideThinkingDots(assistantTs);
          replaceMessageContent(assistantTs, chatStream, true);
          scheduleAutoFollow();
        }
        return;
      }
      if(payload.state === 'final'){
        chatEventCount++;
        console.log('[OpenClaw] 收到 final 事件, chatStream 長度:', chatStream.length);
        // 嘗試從 final 事件提取文本
        const ft = extractOpenClawText(payload.message);
        if(ft) chatStream = ft;

        // 與 Copilot 一致：如果 chatStream 為空（無 delta，如 tool call 後直接 final），
        // 從 chat.history 重新載入回覆
        if(!chatStream){
          updateThinkingStatus(assistantTs, '');
          fetchFinalFromHistory().then(text => {
            if(text) chatStream = text;
            finish(chatStream);
          });
        } else {
          finish(chatStream);
        }
        return;
      }
      if(payload.state === 'aborted'){
        finish(chatStream || sp_t('openclawAborted'));
        return;
      }
      if(payload.state === 'error'){
        finish(sp_t('openclawError').replace('{{msg}}', payload.errorMessage || 'unknown'));
        return;
      }
    }
  });

  // ── 2) 發送 chat.send ──
  updateThinkingStatus(assistantTs, '');
  try{
    await openclawGateway.request('chat.send', sendParams, { timeoutMs: 60000 });
    console.log('[OpenClaw] chat.send 已確認');
    updateThinkingStatus(assistantTs, '');
  }catch(e){
    // chat.send RPC 超時不代表訊息沒送出，Gateway 可能正在處理（web search 等）
    // 如果已經收到事件流回應，繼續等待；否則才報錯
    if(eventCount > 0 || chatEventCount > 0){
      console.warn('[OpenClaw] chat.send RPC 超時但事件流有回應，繼續等待:', e.message);
    } else {
      console.error('[OpenClaw] chat.send 失敗且無事件流:', e.message);
      finish(null);
      throw new Error(sp_t('openclawSendFailed') + ': ' + e.message);
    }
  }

  // ── 3) chat.history 輪詢（僅在事件流完全失效時啟動的後備方案） ──
  // 與 Copilot 一致：正常情況只靠事件流。輪詢延遲 12 秒才啟動，且僅在沒收到任何 chat 事件時才生效。
  async function pollHistory(){
    if(done) return;
    // 如果已經收到 chat 事件（delta/final），事件流正常工作，不需要輪詢
    if(chatEventCount > 0){
      console.log('[OpenClaw] 事件流正常，跳過輪詢');
      if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
      return;
    }
    pollCount++;
    updateThinkingStatus(assistantTs, '');
    try{
      const hist = await openclawGateway.request('chat.history',
        { sessionKey, limit: 20 }, { timeoutMs: 8000 });
      if(done) return;
      // 再次檢查：如果在輪詢期間收到了 chat 事件，忽略輪詢結果
      if(chatEventCount > 0) return;

      const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
      console.log('[OpenClaw] 備用輪詢 #'+pollCount+':', msgs.length, '條');

      // 策略：找到最後一條 user 消息，只看它之後的 assistant 回覆
      // 這樣避免把上一輪的 assistant 回覆當作本輪回覆
      let lastUserIdx = -1;
      for(let i = msgs.length - 1; i >= 0; i--){
        if(msgs[i].role === 'user'){ lastUserIdx = i; break; }
      }
      // 在最後 user 之後找 assistant 回覆
      for(let i = lastUserIdx + 1; i < msgs.length; i++){
        const m = msgs[i];
        if(m.role !== 'assistant') continue;
        const text = extractOpenClawText(m);
        if(text && typeof text === 'string'){
          const cleaned = text.replace(/\[\[\s*reply_to:[^\]]+\]\]/g, '').trim();
          if(cleaned){
            chatStream = cleaned;
            hideThinkingDots(assistantTs);
            replaceMessageContent(assistantTs, chatStream, true);
            scheduleAutoFollow();
            console.log('[OpenClaw] 備用輪詢回覆:', cleaned.slice(0, 100));
          }
        }
      }
    }catch(e){
      console.warn('[OpenClaw] 備用輪詢 #'+pollCount+' 失敗:', e.message);
    }
  }
  // 12 秒後才啟動輪詢，且僅在事件流無 chat 回應時
  // 有 agent 事件但無 chat 事件 = OpenClaw 在工作但事件流可能漏掉 chat，需要輪詢補救
  pollDelayTimer = setTimeout(()=>{
    if(done || chatEventCount > 0) return;
    console.log('[OpenClaw] 12 秒無 chat 事件（agent 事件:', eventCount, '），啟動備用輪詢');
    pollHistory();
    pollTimer = setInterval(pollHistory, 3000);
  }, 12000);

  // ── 4) 總超時 180 秒（OpenClaw 可能需要做 web search / fetch） ──
  // 超時時，如果事件流有回應（agent events），嘗試從 history 取回覆
  overallTimeout = setTimeout(async ()=>{
    if(done) return;
    if(chatStream){
      finish(chatStream);
      return;
    }
    // 有 agent 事件但沒有 chat 回覆 → 嘗試從 history 取
    if(eventCount > 0){
      console.log('[OpenClaw] 超時但有事件，嘗試從 history 取回覆');
      const text = await fetchFinalFromHistory();
      if(text){
        finish(text);
        return;
      }
    }
    finish(null);
  }, 180000);

  // ── 5) 輪詢穩定檢查：如果備用輪詢已取得回覆且 15 秒內無新內容變化，視為完成 ──
  let lastPollText = '';
  let pollStableCount = 0;
  const pollStableCheck = setInterval(()=>{
    if(done){ clearInterval(pollStableCheck); return; }
    if(!chatStream || chatEventCount > 0){ pollStableCount = 0; lastPollText = ''; return; }
    // 只在備用輪詢模式下（無 chat 事件）檢查穩定性
    if(chatStream === lastPollText){
      pollStableCount++;
      if(pollStableCount >= 3){
        console.log('[OpenClaw] 備用輪詢回覆已穩定 15 秒，視為完成');
        clearInterval(pollStableCheck);
        finish(chatStream);
      }
    } else {
      lastPollText = chatStream;
      pollStableCount = 0;
    }
  }, 5000);

  // 等待完成
  const result = await finishPromise;

  if(!result){
    replaceMessageContent(assistantTs, sp_t('openclawNoResponse'), false);
    return;
  }
  finalizeStreamingMessage(assistantTs);
  finalizeAssistantMessageContent(assistantTs, result);
}

/* ── 思考中三點動畫 ── */
function showThinkingDots(ts, statusText){
  const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
  if(!msgEl) return;
  let dots = msgEl.querySelector('.openclaw-thinking');
  if(dots) return;
  dots = document.createElement('div');
  dots.className = 'openclaw-thinking';
  dots.innerHTML = '<span></span><span></span><span></span>'
    + (statusText ? '<span class="oc-status">' + statusText + '</span>' : '');
  const contentEl = msgEl.querySelector('.message-content') || msgEl;
  contentEl.prepend(dots);
}

function updateThinkingStatus(ts, statusText){
  const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
  if(!msgEl) return;
  const dots = msgEl.querySelector('.openclaw-thinking');
  if(!dots) return;
  let el = dots.querySelector('.oc-status');
  if(!el){
    el = document.createElement('span');
    el.className = 'oc-status';
    dots.appendChild(el);
  }
  el.textContent = statusText || '';
}

function hideThinkingDots(ts){
  const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
  if(!msgEl) return;
  const dots = msgEl.querySelector('.openclaw-thinking');
  if(dots) dots.remove();
}

/* ================= End OpenClaw ================= */

function scheduleAutoFollow(){
  if(isFirstMessage) return;
  if(!autoFollow) return;
  doAutoScroll();
}

function doAutoScroll(){
  const scroller = getScrollContainer();
  if(!scroller) return;
  _programmaticScroll = true;
  scroller.scrollTop = scroller.scrollHeight;
  lastScrollPosition = scroller.scrollTop;
  if(scrollRAF) cancelAnimationFrame(scrollRAF);
  scrollRAF = requestAnimationFrame(()=>{
    scrollRAF = null;
    _programmaticScroll = true;
    scroller.scrollTop = scroller.scrollHeight;
    lastScrollPosition = scroller.scrollTop;
    setTimeout(()=>{ _programmaticScroll = false; }, 80);
  });
}

function startStreamingScroll(){
  stopStreamingScroll();
  _streamScrollInterval = setInterval(()=>{
    if(!autoFollow || !streaming) return;
    doAutoScroll();
  }, 120);
}

function stopStreamingScroll(){
  if(_streamScrollInterval){
    clearInterval(_streamScrollInterval);
    _streamScrollInterval = null;
  }
  _programmaticScroll = false;
}

// 建議問題的翻譯鍵（動態載入）
const SUGGESTION_KEYS = ['suggestion1', 'suggestion2', 'suggestion3'];

/* ================= Welcome zh apply ================= */
async function getTimeBasedGreeting(lang){
  lang = lang || (awaitGetZhVariant.cached) || _defaultLang();
  const hour = new Date().getHours();
  
  let titleKey, subtitleKey;
  let icon = '';
  
  if(hour >= 5 && hour < 12){
    // 早上 5:00-11:59
    titleKey = 'greetingMorning';
    subtitleKey = 'greetingMorningSub';
    icon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16"><path d="M8 3a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 3m8 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5m-13.5.5a.5.5 0 0 0 0-1h-2a.5.5 0 0 0 0 1zm11.157-6.157a.5.5 0 0 1 0 .707l-1.414 1.414a.5.5 0 1 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0m-9.9 2.121a.5.5 0 0 0 .707-.707L3.05 5.343a.5.5 0 1 0-.707.707zM8 7a4 4 0 0 0-4 4 .5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5 4 4 0 0 0-4-4"/></svg>';
  } else if(hour >= 12 && hour < 18){
    // 中午/下午 12:00-17:59
    titleKey = 'greetingAfternoon';
    subtitleKey = 'greetingAfternoonSub';
    icon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16"><path d="M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0m0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13m8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5M3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8m10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0m-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0m9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707M4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708"/></svg>';
  } else if(hour >= 18 && hour < 23){
    // 晚上 18:00-22:59
    titleKey = 'greetingEvening';
    subtitleKey = 'greetingEveningSub';
    icon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16"><path d="M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277q.792-.001 1.533-.16a.79.79 0 0 1 .81.316.73.73 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.75.75 0 0 1 6 .278"/><path d="M10.794 3.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 0 1 0 .412l-1.162.387a1.73 1.73 0 0 0-1.097 1.097l-.387 1.162a.217.217 0 0 1-.412 0l-.387-1.162A1.73 1.73 0 0 0 9.31 6.593l-1.162-.387a.217.217 0 0 1 0-.412l1.162-.387a1.73 1.73 0 0 0 1.097-1.097zM13.863.099a.145.145 0 0 1 .274 0l.258.774c.115.346.386.617.732.732l.774.258a.145.145 0 0 1 0 .274l-.774.258a1.16 1.16 0 0 0-.732.732l-.258.774a.145.145 0 0 1-.274 0l-.258-.774a1.16 1.16 0 0 0-.732-.732l-.774-.258a.145.145 0 0 1 0-.274l.774-.258c.346-.115.617-.386.732-.732z"/></svg>';
  } else {
    // 深夜 23:00-4:59
    titleKey = 'greetingNight';
    subtitleKey = 'greetingNightSub';
    icon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16"><path d="M11.473 11a4.5 4.5 0 0 0-8.72-.99A3 3 0 0 0 3 16h8.5a2.5 2.5 0 0 0 0-5z"/><path d="M11.286 1.778a.5.5 0 0 0-.565-.755 4.595 4.595 0 0 0-3.18 5.003 5.5 5.5 0 0 1 1.055.209A3.6 3.6 0 0 1 9.83 2.617a4.593 4.593 0 0 0 4.31 5.744 3.58 3.58 0 0 1-2.241.634q.244.477.394 1a4.59 4.59 0 0 0 3.624-2.04.5.5 0 0 0-.565-.755 3.593 3.593 0 0 1-4.065-5.422z"/></svg>';
  }
  
  // 使用翻譯系統取得文字
  const title = typeof window.__tAsync === 'function' 
    ? await window.__tAsync(titleKey, lang)
    : (typeof window.__t === 'function' ? window.__t(titleKey, lang) : titleKey);
  const subtitle = typeof window.__tAsync === 'function'
    ? await window.__tAsync(subtitleKey, lang)
    : (typeof window.__t === 'function' ? window.__t(subtitleKey, lang) : subtitleKey);
  
  return { title, subtitle, icon };
}

async function applyWelcomeZh(){
  try{
    const lang = (awaitGetZhVariant.cached) || _defaultLang();
    if(!els.welcomeSection) return;
    
    // 獲取基於時間的問候語（使用翻譯）
    const greeting = await getTimeBasedGreeting(lang);
    
    const h1 = els.welcomeSection.querySelector('.hero-title');
    const p  = els.welcomeSection.querySelector('.hero-subtitle');
    
    if(h1) {
      // 如果是中文，可能需要繁簡轉換
      if(lang !== 'en' && typeof window.__zhConvert === 'function') {
        h1.textContent = __zhConvert(greeting.title, lang);
      } else {
        h1.textContent = greeting.title;
      }
    }
    if(p) {
      // 如果是中文，可能需要繁簡轉換
      if(lang !== 'en' && typeof window.__zhConvert === 'function') {
        p.textContent = __zhConvert(greeting.subtitle, lang);
      } else {
        p.textContent = greeting.subtitle;
      }
    }
    
    // 在 momo 卡通旁邊添加時間圖標
    const momoSticker = document.querySelector('.momo-sticker');
    if(momoSticker && momoSticker.parentElement) {
      // 移除舊的圖標（如果有）
      const oldIcon = momoSticker.parentElement.querySelector('.time-icon');
      if(oldIcon) oldIcon.remove();
      
      // 創建新圖標
      const iconEl = document.createElement('div');
      iconEl.className = 'time-icon';
      iconEl.innerHTML = greeting.icon;
      
      // 插入到 momo 之前
      momoSticker.parentElement.insertBefore(iconEl, momoSticker);
    }
  }catch(e){ console.warn('[SP] applyWelcomeZh failed', e); }
}

const $ = s => document.querySelector(s);
let els = {};

const UNSUPPORTED_PROTOCOL_RE = /^chrome:|^edge:|^brave:|^opera:|^chrome-extension:|^devtools:/;
const PAGE_CONTEXT_BODY_MAX = 20000; // 默認 20000 字符，用戶可在設置中調整到 200000
const PAGE_CONTEXT_SELECTION_MAX = 2000; // 也增加選擇文本的限制
const GLOBAL_PAGE_ORIGINS = ['https://*/*','http://*/*'];
/* DEFAULT_PROMPT_ID & PROMPT_ID_MIGRATION now in prompt-defaults.js */
/* Cache zhVariant for quick access */
/* sp_t(key) — sync i18n helper using cached language */
/* ---- Custom dialog helpers (replaces native confirm/alert) ---- */
function _spDialog(msg, isConfirm){
  return new Promise(resolve=>{
    const okText   = sp_t('ok')     || '確定';
    const cancelText = sp_t('cancel') || '取消';
    const ov=document.createElement('div');
    ov.className='custom-dialog-overlay';
    ov.innerHTML=`<div class="custom-dialog-box"><p class="custom-dialog-msg">${escapeHtml(String(msg))}</p><div class="custom-dialog-actions">${isConfirm?`<button class="custom-dialog-btn custom-dialog-btn-cancel">${escapeHtml(cancelText)}</button>`:''}<button class="custom-dialog-btn custom-dialog-btn-ok">${escapeHtml(okText)}</button></div></div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(()=>ov.classList.add('show'));
    function close(v){ov.classList.remove('show');setTimeout(()=>ov.remove(),200);resolve(v);}
    ov.querySelector('.custom-dialog-btn-ok').addEventListener('click',()=>close(true));
    ov.querySelector('.custom-dialog-btn-cancel')?.addEventListener('click',()=>close(false));
  });
}
function showConfirm(msg){return _spDialog(msg,true);}
function showAlert(msg){return _spDialog(msg,false);}

function sp_t(key){
  const lang = awaitGetZhVariant.cached || _defaultLang();
  return (typeof window.__t === 'function') ? window.__t(key, lang) : key;
}
function sp_tpl(key, vars){
  let s = sp_t(key);
  if(vars) Object.keys(vars).forEach(k=>{ s = s.replace(new RegExp('\\{\\{'+k+'\\}\\}','g'), vars[k]); });
  return s;
}
function _defaultLang() {
  return (typeof window.__detectBrowserLanguage === 'function') ? window.__detectBrowserLanguage() : 'en';
}
async function awaitGetZhVariant(){
  try{
    const syncData = await chrome.storage.sync.get('zhVariant');
    const localData = await chrome.storage.local.get('zhVariant');
    const zhVariant = syncData.zhVariant || localData.zhVariant;
    awaitGetZhVariant.cached = zhVariant || _defaultLang();
    return awaitGetZhVariant.cached;
  }catch{ return _defaultLang(); }
}

/* migratePromptIds now in prompt-defaults.js */

function setButtonTooltip(btn, text){
  if(!btn) return;
  if(text){
    btn.setAttribute('data-tooltip', text);
  }else{
    btn.removeAttribute('data-tooltip');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  try { init(); } catch(e){ showFatal('init() error', e); }
});

/* ================= Toast Helper ================= */
let toastTimer;
function showToast(message) {
  const toast = document.getElementById('globalToast');
  const toastMessage = document.getElementById('globalToastMessage');
  if(!toast || !toastMessage) return;
  
  // 清除之前的定时器
  if(toastTimer) clearTimeout(toastTimer);
  
  // 设置消息并显示
  toastMessage.textContent = message;
  toast.style.display = 'flex';
  
  // 3 秒后自动隐藏
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

/* ================= Fatal Helper ================= */
function showFatal(message, error) {
  console.error('[SP][FATAL]', message, error);
  let box = document.getElementById('sp-fatal');
  if (!box) {
    box = document.createElement('div');
    Object.assign(box.style,{
      position:'fixed',top:'8px',left:'8px',right:'8px',padding:'12px',
      background:'#ffecec',color:'#b00020',border:'1px solid #f5b3b3',
      fontSize:'13px',zIndex:99999,borderRadius:'8px',fontFamily:'monospace',
      whiteSpace:'pre-wrap'
    });
    box.id='sp-fatal';
    document.body.appendChild(box);
  }
  box.textContent='[SidePanel Error] '+message+(error?('\n'+(error.stack||error.message)):'');
}

/* ================= Init ================= */
// 處理 sidepanel 打開時自動創建新對話
async function handleSidePanelOpen(){
  try{
    // 檢查是否剛剛打開 sidepanel
    const lastOpenTime = sessionStorage.getItem('sidepanelOpenTime');
    const now = Date.now();
    
    // 如果沒有記錄或距離上次打開超過5分鐘，創建新對話
    if(!lastOpenTime || (now - parseInt(lastOpenTime)) > 300000){
      console.log('[SP] SidePanel opened, creating new session');
      // 如果已經有對話且有內容，創建新對話
      if(sessions.length > 0 && currentSessionId){
        const currentSession = sessions.find(s => s.id === currentSessionId);
        if(currentSession && currentSession.messages && currentSession.messages.length > 0){
          createNewSession(true);
          console.log('[SP] New session created on panel open');
        }
      }
    }
    
    // 更新打開時間
    sessionStorage.setItem('sidepanelOpenTime', now.toString());
  }catch(e){
    console.warn('[SP] handleSidePanelOpen failed', e);
  }
}

async function init(){
  cacheDom();
  if(!assertDom()) return;
  // 確保 momo 圖片存在且使用擴展絕對路徑
  try{
    const url=chrome.runtime?.getURL ? chrome.runtime.getURL('assets/icons/momo.png') : 'assets/icons/momo.png';
    let wrap=document.querySelector('.momo-wrap');
    if(!wrap){
      wrap=document.createElement('div');
      wrap.className='momo-wrap';
      // bubble
      const bubble=document.createElement('div');
      bubble.className='momo-bubble';
      bubble.textContent=sp_t('momoEasterEgg');
      // image
      const img=document.createElement('img');
      img.className='momo-sticker';
      img.alt=''; img.setAttribute('aria-hidden','true');
      img.src=url;
      wrap.appendChild(bubble);
      wrap.appendChild(img);
      if(els.chatRegion){
        els.chatRegion.insertBefore(wrap, els.chatRegion.firstChild);
      } else {
        document.body.appendChild(wrap);
      }
    } else {
      const img=wrap.querySelector('img.momo-sticker');
      if(img && img.getAttribute('src')!==url) img.setAttribute('src', url);
    }
  }catch(e){ console.warn('[SP] momo image setup failed', e); }
  bindEvents();
  await Promise.all([
    loadTheme(),
    loadPrompts(),
    loadSessions(),
    loadModels(),
    loadChatWithPageState(),
    loadWebSearchState(),
    awaitGetZhVariant() // 初始化繁簡偏好快取
  ]);
  
  // 每次打開 sidepanel 時自動創建新對話
  await handleSidePanelOpen();
  
  ensureSession();
  renderAllMessages();
  renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
  applyWelcomeZh().catch(err => console.warn('[SP] applyWelcomeZh failed:', err));
  observeScroll();
  setupScrollButton();

  preventBrowserRestoreAndResetComposer();
  autoGrow(els.messageInput, { force:true });
  setInputEngagedState();
  updateSendButtonState();
  setupPermissionWatchers();
  setupPageChangeWatcher();

  console.timeEnd('[SP] boot');
}

/* ================= DOM ================= */
function cacheDom(){
  els = {
    chatRegion: document.querySelector('.chat-region'),
    promptSelector: $('#promptSelector'),
    modelSelector: $('#modelSelector'),
    sendButton: $('#sendButton'),
    messageInput: $('#messageInput'),
    charCount: $('#charCount'),
    chatMessages: $('#chatMessages'),
    newChatButton: $('#newChatButton'),
    historyButton: $('#historyButton'),
    webSearchButton: $('#webSearchButton'),
    pageContextButton: $('#pageContextButton'),
    settingsButton: $('#settingsButton'),
    welcomeSection: $('#welcomeSection'),
    suggestionList: $('#suggestionList'),
    historyPanel: $('#historyPanel'),
    closeHistoryBtn: $('#closeHistoryBtn'),
    selectAllSessionsBtn: $('#selectAllSessionsBtn'),
    clearAllSessionsBtn: $('#clearAllSessionsBtn'),
    exportSessionsBtn: $('#exportSessionsBtn'),
    sessionList: $('#sessionList'),
    scrollToBottomBtn: $('#scrollToBottomBtn'),
    textareaWrapper: document.querySelector('.textarea-wrapper'),
    modelRowWrap: document.querySelector('.model-row-wrap'),
    root: $('.sidebar-frame'),
    imageUploadButton: $('#imageUploadButton'),
    imageFileInput: $('#imageFileInput'),
    imagePreviewContainer: $('#imagePreviewContainer'),
    pageContentPreview: $('#pageContentPreview'),
    pageContentCard: $('#pageContentCard'),
    pageContentTitle: $('#pageContentTitle'),
    pageContentMeta: $('#pageContentMeta'),
    pageContentRemove: $('#pageContentRemove'),
    pageContentExpanded: $('#pageContentExpanded'),
    pageContentBody: $('#pageContentBody'),
    historyBackdrop: $('#historyBackdrop')
  };
}
function assertDom(){
  const required=['promptSelector','modelSelector','sendButton','messageInput','chatMessages'];
  const miss=required.filter(k=>!els[k]);
  if(miss.length){ showFatal('Missing DOM: '+miss.join(', ')); return false; }
  return true;
}

/* ================= Events ================= */
function bindEvents(){
  els.sendButton.addEventListener('click', ()=> streaming?stopStreaming():onSend());

  els.webSearchButton?.addEventListener('click', ()=>toggleWebSearch());
  els.pageContextButton?.addEventListener('click', ()=>handlePageContextToggle());

  els.messageInput.addEventListener('keydown', e=>{
    if(e.isComposing) return;
    // Enter (no modifier) or Cmd/Ctrl+Enter → send
    if(e.key==='Enter' && !e.shiftKey){
      e.preventDefault();
      streaming?stopStreaming():onSend();
    }
    if(e.key==='Enter' && (e.metaKey || e.ctrlKey)){
      e.preventDefault();
      streaming?stopStreaming():onSend();
    }
  });
  els.messageInput.addEventListener('input', ()=>{
    autoGrow(els.messageInput);
    updateSendButtonState();
    setInputEngagedState();
    updateCharCount();
    // 不需要在這裡滾動，autoGrow 已經處理了
  });
  els.messageInput.addEventListener('focus', ()=>{
    if(!els.messageInput.value.trim()){
      autoGrow(els.messageInput,{force:true});
      setInputEngagedState();
    }
  });
  els.messageInput.addEventListener('blur', setInputEngagedState);

  els.newChatButton?.addEventListener('click', ()=>createNewSession());
  els.historyButton?.addEventListener('click', ()=>{
    const opening = !els.historyPanel.classList.contains('open');
    els.historyPanel.classList.toggle('open');
    els.historyBackdrop?.classList.toggle('show', opening);
    if(opening){
      selectedSessionIds.clear();
      renderSessionList();
    }
  });
  els.closeHistoryBtn?.addEventListener('click', ()=>{
    els.historyPanel.classList.remove('open');
    els.historyBackdrop?.classList.remove('show');
  });
  els.historyBackdrop?.addEventListener('click', ()=>{
    els.historyPanel.classList.remove('open');
    els.historyBackdrop?.classList.remove('show');
  });
  els.selectAllSessionsBtn?.addEventListener('click', toggleSelectAllSessions);
  els.clearAllSessionsBtn?.addEventListener('click', deleteSelectedOrAllSessions);
  els.exportSessionsBtn?.addEventListener('click', exportSessions);

  els.promptSelector.addEventListener('change', async e=>{
    // 用戶在當前會話中切換提示詞，但不保存為默認值
    // 每次打開 sidepanel 時都會重置為 options 中設置的默認提示詞
    syncSystemMessage();
  });
  els.modelSelector.addEventListener('change', async e=>{
    await chrome.storage.sync.set({ model: e.target.value });
    updateOpenClawPromptVisibility();
  });
  els.settingsButton.addEventListener('click', openSettingsSafe);

  // Global Escape key → stop streaming
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape' && streaming) stopStreaming();
  });

  els.scrollToBottomBtn?.addEventListener('click', ()=>scrollToBottom(true));
  
  // 頁面內容卡片點擊（展開/收起）
  els.pageContentCard?.addEventListener('click', (e)=>{
    // 如果點擊的是移除按鈕，不展開
    if(e.target.closest('.page-content-remove')) return;
    togglePageContentExpanded();
  });
  
  // 頁面內容移除按鈕
  els.pageContentRemove?.addEventListener('click', (e)=>{
    e.stopPropagation(); // 阻止觸發卡片點擊
    removePageContent();
  });

  // 圖片上傳事件
  els.imageUploadButton?.addEventListener('click', ()=>els.imageFileInput.click());
  els.imageFileInput?.addEventListener('change', handleImageUpload);

  // 剪貼板粘貼圖片事件
  els.messageInput?.addEventListener('paste', handlePaste);

  chrome.storage.onChanged.addListener((changes, area)=>{
    // 語言變更同時監聽 local 和 sync（background 首次安裝可能只寫 sync）
    if((area==='local' || area==='sync') && changes.zhVariant){
      const lang = changes.zhVariant.newValue || _defaultLang(); 
      awaitGetZhVariant.cached = lang;
      if(lang === 'en'){
        document.documentElement.setAttribute('lang', 'en');
      } else {
        document.documentElement.setAttribute('lang', lang==='hans'?'zh-CN':'zh-TW');
      }
      if(typeof window.__applyTranslations === 'function'){
        window.__applyTranslations(lang).catch(err => {
          console.warn('[SP] Failed to apply translations:', err);
        });
      }
      renderAllMessages();
      renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
      applyWelcomeZh().catch(err => console.warn('[SP] applyWelcomeZh failed:', err));
    }
    if(area==='local'){
      if(changes.theme) applyTheme(changes.theme.newValue);
      if(changes.messageSize){
        const s = String(changes.messageSize.newValue || '14');
        document.documentElement.style.setProperty('--message-size', s + 'px');
      }
      if(changes.messageWeight){
        const w = String(changes.messageWeight.newValue || '500');
        document.documentElement.style.setProperty('--message-weight', w);
      }
      if(changes.customModels || changes.model) loadModels();
      if(changes.apiKey) missingApiAlerted=false;
      if(changes.webSearchEnabled != null){
        const val = !!changes.webSearchEnabled.newValue;
        console.log('[SP] storage webSearchEnabled changed →', val);
        applyWebSearchEnabled(val, { persist: false });
      }
    }
    // 只監聽本地存儲的變化（提示詞現在統一保存在本地）
    if(area==='local'){
      if(changes.prompts || changes.defaultPrompt || changes.selectedPrompt){
        console.log('[SP] Storage local change detected for prompts, reloading...');
        loadPrompts().then(syncSystemMessage);
      }
    }
  });
}

/* ================= Theme ================= */
async function loadTheme(){
  try{
    const [syncTheme, localTheme] = await Promise.all([
      chrome.storage.sync.get(['theme','messageSize','messageWeight','zhVariant']),
      chrome.storage.local.get(['theme','messageSize','messageWeight','zhVariant'])
    ]);
    const theme = syncTheme.theme || localTheme.theme;
    const messageSize = syncTheme.messageSize || localTheme.messageSize;
    const messageWeight = syncTheme.messageWeight || localTheme.messageWeight;
    const zhVariant = syncTheme.zhVariant || localTheme.zhVariant;
    if(theme) applyTheme(theme);
    if(messageSize){
      document.documentElement.style.setProperty('--message-size', String(messageSize) + 'px');
    }
    if(messageWeight){
      document.documentElement.style.setProperty('--message-weight', String(messageWeight));
    }
    const lang = zhVariant || _defaultLang();
    // 設定語言屬性
    if(lang === 'en'){
      document.documentElement.setAttribute('lang', 'en');
    } else {
      document.documentElement.setAttribute('lang', lang==='hans'?'zh-CN':'zh-TW');
    }
    
    // 應用翻譯（同步等待，確保 sp_t() 可用且 DOM 翻譯完成）
    if(typeof window.__applyTranslations === 'function'){
      try{ await window.__applyTranslations(lang); }catch(err){
        console.warn('[SP] Failed to apply translations:', err);
      }
    }
    // 緩存 lang 以供 sp_t() 使用
    awaitGetZhVariant.cached = lang;
    
    console.log('[SP] Language loaded:', lang, '| converter ready:', typeof window.__zhConvert);
  }catch(e){}
}
function applyTheme(t){
  if(t==='auto'){
    const resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', resolved);
  } else {
    document.documentElement.setAttribute('data-theme', t);
  }
}
(function(){
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', ()=>{
    if(document.documentElement.getAttribute('data-theme')==='auto' || !document.documentElement.hasAttribute('data-theme')){
      return;
    }
    chrome.storage.local.get('theme', r=>{
      if(r.theme==='auto') applyTheme('auto');
    });
  });
})();

/* ================= Prompts ================= */
async function loadPrompts(){
  try{
    // 只從本地存儲讀取，避免同步和本地混用造成的問題
    const local = await chrome.storage.local.get(['prompts','defaultPrompt','selectedPrompt']);
    console.log('[SP] loadPrompts - Reading from LOCAL storage only');
    
    let promptList=Array.isArray(local.prompts)?local.prompts:[];
    let selectedId=local.defaultPrompt || local.selectedPrompt || null;
    
    // 如果本地沒有數據，檢查同步存儲（僅用於遷移舊數據）
    if(!promptList.length){
      const sync = await chrome.storage.sync.get(['prompts','defaultPrompt','selectedPrompt']);
      if(Array.isArray(sync.prompts) && sync.prompts.length > 0){
        console.log('[SP] loadPrompts - Found old data in sync storage, migrating to local...');
        promptList = sync.prompts;
        selectedId = sync.defaultPrompt || sync.selectedPrompt || null;
        // 遷移到本地存儲
        await chrome.storage.local.set({ prompts:promptList, defaultPrompt:selectedId });
        // 清除同步存儲
        await chrome.storage.sync.remove(['prompts','defaultPrompt','selectedPrompt']);
        console.log('[SP] loadPrompts - Migrated to local storage');
      }
    }
    
    if(promptList.length){
      const migrated=migratePromptIds(promptList, selectedId);
      promptList=migrated.prompts;
      selectedId=migrated.selected || DEFAULT_PROMPT_ID;
      
      // 清理名稱中的"預設"/"Default" 標籤（從舊數據中移除）
      let needsCleanup=false;
      promptList.forEach(p=>{
        if(p.name && (p.name.endsWith('預設') || p.name.endsWith('Default'))){
          p.name=p.name.replace(/預設$|Default$/, '').trim();
          needsCleanup=true;
        }
      });
      
      if(migrated.changed || needsCleanup){
        // 保存到本地存儲
        await chrome.storage.local.set({ prompts:promptList, defaultPrompt:selectedId });
      }
    }
    prompts=promptList;
    console.log('[SP] loadPrompts - Loaded', prompts.length, 'prompts:', prompts.map(p => ({ id: p.id, name: p.name })));
    const visiblePrompts=prompts.filter(p=>p.visible !== false);
    const sel=els.promptSelector;
    sel.innerHTML='';
    if(!visiblePrompts.length){
      sel.innerHTML=`<option value="">${sp_t('noPrompt')}</option>`;
      return;
    }
    visiblePrompts.forEach(p=>{
      const o=document.createElement('option');
      o.value=p.id; o.textContent=p.name;
      sel.appendChild(o);
    });
    const effective=selectedId && visiblePrompts.some(p=>p.id===selectedId)
      ? selectedId
      : visiblePrompts[0]?.id;
    if(effective){
      sel.value=effective;
      console.log('[SP] loadPrompts - Selected prompt:', effective);
    }
  }catch(e){ showFatal('Failed to load prompts', e); }
}
function getSelectedPromptObj(){ return prompts.find(p=>p.id===els.promptSelector.value); }

/* ================= Models ================= */
async function loadModels() {
  try {
    const [{ customModels }, { model }] = await Promise.all([
      chrome.storage.local.get('customModels'),
      chrome.storage.sync.get('model')
    ]);
    let list=customModels;
    if(typeof list==='string'){ try{ list=JSON.parse(list);}catch{ list=[]; } }
    if(!Array.isArray(list)) list=[];
    const enabled=list.filter(m=>m?.enabled===true||m?.enabled===1||m?.enabled==='1'||m?.active||m?.on);
    const sel=els.modelSelector;
    sel.innerHTML='';
    
    // 如果沒有啟用的模型，顯示空白
    if(!enabled.length){
      sel.innerHTML=`<option value="">${sp_t('noModels')}</option>`;
      sel.value='';
      await chrome.storage.sync.set({ model: '' });
      buildModelDropdown(enabled);
      return;
    }
    
    enabled.forEach(m=>{
      const name=m.name||m.id||m.model;
      if(!name) return;
      const o=document.createElement('option');
      o.value=name;
      o.textContent=name;
      sel.appendChild(o);
    });
    
    if(model && enabled.some(m=>(m.name||m.id||m.model)===model)){
      sel.value=model;
    } else {
      sel.value=enabled[0].name || enabled[0].id || enabled[0].model;
      await chrome.storage.sync.set({ model: sel.value });
    }
    // 構建帶圖標的自定義下拉選單
    buildModelDropdown(enabled);
    // 載入後檢查是否為 OpenClaw，調整提示詞選擇器
    updateOpenClawPromptVisibility();
  } catch(e){
    console.error('[models] 載入模型失敗', e);
    els.modelSelector.innerHTML=`<option value="">${sp_t('loadFailed')}</option>`;
    buildModelDropdown([]);
  }
}

/* ── 自定義模型下拉選單（帶服務商圖標） ── */
function buildModelDropdown(enabledModels){
  const wrap = els.modelSelector.closest('.select-wrap.model-select');
  if(!wrap) return;

  // 隱藏原生 select
  els.modelSelector.style.display = 'none';
  wrap.querySelector('.select-arrow')?.style && (wrap.querySelector('.select-arrow').style.display = 'none');

  // 如果已存在自定義下拉，先移除
  wrap.querySelector('.cm-dropdown')?.remove();

  const dd = document.createElement('div');
  dd.className = 'cm-dropdown';

  // 觸發按鈕
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cm-dropdown-btn';
  dd.appendChild(btn);

  // 下拉列表（向上展開）
  const listEl = document.createElement('div');
  listEl.className = 'cm-dropdown-list';
  dd.appendChild(listEl);

  // 選中的值
  const currentVal = els.modelSelector.value;

  function findProvider(name){
    const m = enabledModels.find(x => (x.name||x.id||x.model) === name);
    return m?.provider || '';
  }

  function renderBtn(modelName){
    const provider = findProvider(modelName);
    const iconUrl = getProviderIconUrl(provider);
    btn.innerHTML = '';
    if(iconUrl){
      const img = document.createElement('img');
      img.className = 'cm-icon';
      img.src = iconUrl;
      img.alt = '';
      btn.appendChild(img);
    } else {
      // 閃電圖標作為通用回退
      const fallback = document.createElement('span');
      fallback.className = 'cm-icon-fallback';
      fallback.innerHTML = '⚡';
      btn.appendChild(fallback);
    }
    const span = document.createElement('span');
    span.className = 'cm-label';
    span.textContent = modelName || sp_t('noModels');
    btn.appendChild(span);
  }

  function renderList(){
    listEl.innerHTML = '';
    enabledModels.forEach(m => {
      const name = m.name || m.id || m.model;
      if(!name) return;
      const item = document.createElement('div');
      item.className = 'cm-dropdown-item' + (name === els.modelSelector.value ? ' selected' : '');
      item.dataset.value = name;

      const iconUrl = getProviderIconUrl(m.provider || '');
      if(iconUrl){
        const img = document.createElement('img');
        img.className = 'cm-icon';
        img.src = iconUrl;
        img.alt = '';
        item.appendChild(img);
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'cm-icon-fallback';
        fallback.innerHTML = '⚡';
        item.appendChild(fallback);
      }
      const span = document.createElement('span');
      span.className = 'cm-item-label';
      span.textContent = name;
      item.appendChild(span);

      if(name === els.modelSelector.value){
        const check = document.createElement('span');
        check.className = 'cm-check';
        check.textContent = '✓';
        item.appendChild(check);
      }

      item.addEventListener('click', () => {
        els.modelSelector.value = name;
        els.modelSelector.dispatchEvent(new Event('change', { bubbles: true }));
        renderBtn(name);
        renderList();
        closeDropdown();
      });
      listEl.appendChild(item);
    });
  }

  function toggleDropdown(){
    const open = dd.classList.toggle('open');
    if(open) renderList();
  }
  function closeDropdown(){
    dd.classList.remove('open');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  // 點擊外部關閉
  document.addEventListener('click', (e) => {
    if(!dd.contains(e.target)) closeDropdown();
  });

  renderBtn(currentVal);
  wrap.appendChild(dd);
}

/* ================= OpenClaw Prompt Visibility ================= */
async function updateOpenClawPromptVisibility(){
  try{
    const model = els.modelSelector.value || '';
    const { customModels } = await chrome.storage.local.get('customModels');
    let isOpenClaw = false;
    if(Array.isArray(customModels)){
      const md = customModels.find(m => (m.name||m.id||m.model) === model);
      isOpenClaw = md?.provider === 'openclaw';
    }
    // 禁用提示詞選擇器（灰色不可操作），但不隱藏
    const promptWrap = els.promptSelector?.closest('.select-wrap.prompt-select');
    if(promptWrap){
      promptWrap.style.opacity = isOpenClaw ? '0.35' : '';
      promptWrap.style.pointerEvents = isOpenClaw ? 'none' : '';
    }
    if(els.promptSelector){
      els.promptSelector.disabled = isOpenClaw;
    }
    // 禁用時鐘（歷史）與新對話按鈕，OpenClaw 歷史由 chat.history 自動載入
    for(const btn of [els.historyButton, els.newChatButton]){
      if(!btn) continue;
      btn.style.opacity = isOpenClaw ? '0.35' : '';
      btn.style.pointerEvents = isOpenClaw ? 'none' : '';
      btn.disabled = isOpenClaw;
    }
    // 禁用聯網搜尋與引用頁面按鈕，OpenClaw 有原生搜尋能力且不支援頁面引用
    for(const btn of [els.webSearchButton, els.pageContextButton]){
      if(!btn) continue;
      btn.style.opacity = isOpenClaw ? '0.35' : '';
      btn.style.pointerEvents = isOpenClaw ? 'none' : '';
      btn.disabled = isOpenClaw;
      if(isOpenClaw) btn.setAttribute('aria-pressed','false');
    }
    // 切換離開 OpenClaw 時，恢復按鈕但重置狀態
    if(!isOpenClaw){
      if(els.webSearchButton && !webSearchEnabled){
        els.webSearchButton.classList.remove('active');
      }
      if(els.pageContextButton && !chatWithPageEnabled){
        els.pageContextButton.classList.remove('active');
      }
    }
    if(isOpenClaw){
      console.log('[SP] OpenClaw 模型已選取，禁用系統提示詞選擇器、歷史按鈕、聯網搜尋與引用頁面，自動載入對話記錄');
      loadAndShowOpenClawHistory();
    } else {
      // 切換離開 OpenClaw：若當前 session 含 OpenClaw 歷史，建立新對話
      const session = getCurrentSession();
      if(session && session.messages.some(m => m._fromOpenClawHistory)){
        createNewSession();
      }
    }
  }catch(e){
    console.warn('[SP] updateOpenClawPromptVisibility error:', e);
  }
}

/* 檢查當前模型是否為 OpenClaw */
async function isCurrentModelOpenClaw(){
  try{
    const model = els.modelSelector.value || '';
    const { customModels } = await chrome.storage.local.get('customModels');
    if(Array.isArray(customModels)){
      const md = customModels.find(m => (m.name||m.id||m.model) === model);
      return md?.provider === 'openclaw';
    }
  }catch(e){}
  return false;
}

/* ================= OpenClaw History Loader ================= */
let _openclawHistoryToken = 0; // increments on each call; stale async results are discarded

async function loadAndShowOpenClawHistory(){
  const myToken = ++_openclawHistoryToken;
  const isStale = () => myToken !== _openclawHistoryToken;

  const { customModels, providerConfigs } = await chrome.storage.local.get(['customModels','providerConfigs']);
  if(isStale()) return;
  const model = els.modelSelector.value || '';
  const md = Array.isArray(customModels) ? customModels.find(m => (m.name||m.id||m.model) === model) : null;
  const modelProvider = md?.provider || '';
  const cfg = providerConfigs?.[modelProvider];
  if(!cfg?.isOpenClaw) return;

  const wsUrl = (cfg.baseUrl || '').replace(/\/+$/,'');
  const token = cfg.apiKey || '';
  if(!wsUrl){ showToast(sp_t('gatewayUrlNotSet')); return; }

  try{
    // Reuse existing connection or create new one
    if(!openclawGateway) openclawGateway = new OpenClawGateway();
    if(!openclawGateway.connected){
      try{ chrome.runtime.sendMessage({ type:'openclaw_update_origin', wsUrl }); }catch(e){}
      await new Promise(r=>setTimeout(r, 300));
      await openclawGateway.ensureConnected({ url: wsUrl, token });
    }
    if(isStale()) return;

    // Resolve sessionKey (same priority as sendOpenClawMessage)
    let sessionKey = (cfg.sessionKey || '').trim();
    if(!sessionKey){
      const snap = openclawGateway.hello?.snapshot;
      sessionKey = snap?.sessionDefaults?.mainSessionKey?.trim()
                || snap?.sessionDefaults?.mainKey?.trim()
                || 'agent:main:main';
    }

    const hist = await openclawGateway.request(
      'chat.history', { sessionKey, limit: 100 }, { timeoutMs: 10000 }
    );
    if(isStale()) return;

    const raw = Array.isArray(hist?.messages) ? hist.messages : [];
    if(raw.length === 0) return; // 無記錄靜默忽略

    // Map OpenClaw messages to local session format
    const mapped = raw
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => {
        const text = extractOpenClawText(m);
        if(!text) return null;
        const content = m.role === 'assistant'
          ? text.replace(/\[\[\s*reply_to:[^\]]+\]\]/g, '').trim()
          : text;
        return {
          role: m.role,
          content,
          ts: m.ts || m.timestamp || (Date.now() - (raw.length - i) * 1000),
          _fromOpenClawHistory: true
        };
      })
      .filter(Boolean);

    if(mapped.length === 0 || isStale()) return;

    const session = getCurrentSession();
    if(!session) return;

    // Keep system prompt at top, replace conversation messages
    const systemMsg = session.messages.find(m => m.role === 'system' && !m._pageContext);
    session.messages = [...(systemMsg ? [systemMsg] : []), ...mapped];

    persistSessions();
    renderAllMessages();
    // 三段確保：rAF 等首次 paint，50ms 等圖片佔位，150ms 等全部 layout 穩定
    requestAnimationFrame(()=> scrollToBottom(true));
    setTimeout(()=> scrollToBottom(true), 50);
    setTimeout(()=> scrollToBottom(true), 150);

  }catch(e){
    if(isStale()) return; // 已切換模型，靜默丟棄
    console.error('[OpenClaw History]', e);
    showToast(sp_t('loadFailed') + ': ' + e.message);
  }
}

/* ================= Web Search ================= */
async function loadWebSearchState(){
  try{
    const { webSearchEnabled: stored } = await chrome.storage.local.get('webSearchEnabled');
    applyWebSearchEnabled(!!stored, { persist: false });
  }catch{
    applyWebSearchEnabled(false, { persist: false });
  }
}

function applyWebSearchEnabled(enabled, { persist = true } = {}){
  webSearchEnabled = !!enabled;
  const btn = els.webSearchButton;
  if(btn){
    btn.setAttribute('aria-pressed', String(webSearchEnabled));
    btn.classList.toggle('active', webSearchEnabled);
    const tip = sp_t('webSearch') + (webSearchEnabled ? ' ✓' : '');
    setButtonTooltip(btn, tip);
    btn.setAttribute('aria-label', tip);
  }
  if(persist){
    const p = chrome.storage.local.set({ webSearchEnabled });
    if(p && typeof p.catch === 'function') p.catch(()=>{});
  }
}

function toggleWebSearch(){
  const newState = !webSearchEnabled;
  applyWebSearchEnabled(newState);
  console.log('[SP] Web search toggled:', newState);
}

/**
 * Determine if a user message needs web search.
 * Returns { needed: boolean, reason: string }
 *
 * Strategy (conservative / Claude-style):
 *   1. Check explicit "DO search" signals first (URLs, explicit requests, real-time keywords).
 *   2. Check "SKIP search" patterns (creative, coding, chat, general knowledge…).
 *   3. Default → needed: false. Only search when there is a clear signal.
 *
 * Multilingual heuristics: ZH (Traditional/Simplified), EN, JA, KO, ES, FR, DE, PT.
 */
function shouldSearch(msg){
  if(!msg || !msg.trim()) return { needed: false, reason: 'empty' };
  const m = msg.trim();
  const lo = m.toLowerCase();

  // ── Always search: message contains a URL ──
  if(/https?:\/\/\S+/.test(m)) return { needed: true, reason: 'has-url' };

  // ── DO search: explicit request (allows common CJK prefixes) ──
  if(/(^|你|幫我|幫忙|請|麻煩|能不能|可以|可否|帮我|帮忙|请|麻烦)(搜尋|搜索|搜一下|查一下|查查|查找|查看看|上網搜|上網查|上網找|聯網搜|聯網查|網上搜|網上查|網上找|搜一搜|查一查)/i.test(m))
    return { needed: true, reason: 'explicit-search' };
  if(/(search for |look up |google |find me |find out |検索して|調べて|검색해|busca |cherche |suche )/i.test(m))
    return { needed: true, reason: 'explicit-search' };

  // ── DO search: specific named entity / identifier + question ──
  // Alphanumeric identifiers (e.g. "COMFYUI-qwen2511", "GPT-4o", "iPhone16")
  const hasSpecificName = /[A-Za-z]{2,}[\w.-]*\d|\d[\w.-]*[A-Za-z]{2,}/.test(m);
  const hasQuestionWord = /(是什麼|是什么|是啥|什麼是|什么是|知道|聽過|听过|有沒有|有没有|what is|what's|what are|do you know|have you heard|tell me about)/i.test(m);
  if(hasSpecificName && hasQuestionWord)
    return { needed: true, reason: 'entity-lookup' };
  // Standalone: specific identifier without common words → likely needs lookup
  if(hasSpecificName && m.length < 50)
    return { needed: true, reason: 'entity-lookup' };

  // ── DO search: real-time / factual signals ──

  // Price / shopping
  if(/(價格|價錢|多少錢|售價|定價|价格|多少钱|price|cost|how much|pricing|値段|가격|precio|prix|preis|preço)/i.test(m))
    return { needed: true, reason: 'price' };

  // News / current events
  if(/(新聞|最新|最近|新闻|latest|recent|breaking|news|update|headline|ニュース|最新の|뉴스|최신|noticias|actualités|nachrichten|notícias)/i.test(m))
    return { needed: true, reason: 'news' };

  // Time-sensitive: today, now, current
  if(/(今天|今日|目前|現在|當前|即時|现在|当前|today|current|right now|currently|at the moment|this week|this month|今日の|현재|오늘|hoy|aujourd'hui|heute|hoje)/i.test(m))
    return { needed: true, reason: 'time-sensitive' };

  // Weather
  if(/(天氣|氣溫|溫度|weather|forecast|temperature|天気|날씨|clima|météo|wetter|tempo)/i.test(m))
    return { needed: true, reason: 'weather' };

  // Stock / finance / crypto
  if(/(股票|股價|匯率|幣價|stock|share price|exchange rate|crypto|bitcoin|market cap|株価|주가|bolsa|bourse|aktien|ações)/i.test(m))
    return { needed: true, reason: 'finance' };

  // Sports results
  if(/(比分|賽果|比賽結果|score|match result|game result|試合結果|경기 결과|resultado)/i.test(m))
    return { needed: true, reason: 'sports' };

  // Election / who won
  if(/(who won|who is winning|election results|選舉|大選|投票結果)/i.test(m))
    return { needed: true, reason: 'events' };

  // Release / launch / availability
  if(/(release date|發售|上市|發布|出售|when does .+ come out|when is .+ released|when will .+ launch|発売日|출시일)/i.test(m))
    return { needed: true, reason: 'release' };

  // Year references (current or last year — likely wants fresh info)
  const yr = new Date().getFullYear();
  if(new RegExp(`\\b(${yr}|${yr - 1})\\b`).test(m))
    return { needed: true, reason: 'year-ref' };

  // Specific real-world entity lookup (brand + product, company + something)
  if(/(推薦|推荐|評價|评价|review|recommend|rating|比較.{0,6}(哪個|哪个)|vs\.?\s)/i.test(m)
     && /(品牌|牌子|產品|产品|手機|手机|電腦|电脑|laptop|phone|camera|app|軟體|软件|software|car|車|hotel|酒店|餐廳|餐厅|restaurant)/i.test(m))
    return { needed: true, reason: 'product-lookup' };

  // Travel / place info (likely needs up-to-date info)
  if(/(怎麼去|怎么去|how to get to|directions to|航班|機票|机票|flight|travel to|visa|簽證|签证|開放時間|开放时间|opening hours)/i.test(m))
    return { needed: true, reason: 'travel' };

  // ── SKIP search: creative / internal tasks ──

  // Creative writing / brainstorming
  const creativeRe = new RegExp(
    '^(' +
    '幫我想|幫我寫|幫我編|幫我創|幫忙想|幫忙寫|想一個|寫一個|編一個|' +
    '創作|生成|產生|造句|作詩|寫詩|寫故事|寫文案|寫標語|寫段|' +
    '帮我想|帮我写|帮忙写|写一个|编一个|写故事|写文案|' +
    'help me write|write me |write a |create a |generate |compose |draft |' +
    'come up with|make up |think of |brainstorm|invent |imagine |' +
    '書いて|作って|考えて|創作して|物語を|詩を|' +
    '써줘|만들어|작성해|' +
    'escribe |écris |schreib |escreva ' +
    ')', 'i'
  );
  if(creativeRe.test(m)) return { needed: false, reason: 'creative' };

  // Coding / programming
  if(/```[\s\S]*```/.test(m)) return { needed: false, reason: 'code-block' };
  const codeRe = new RegExp(
    '^(' +
    '寫程式|寫代碼|寫程式碼|寫代码|修復|修复|写代码|写程序|' +
    'write code|write a function|write a script|write a program|' +
    'fix this code|fix the bug|debug |implement |refactor |' +
    'code this|build a function|' +
    'コードを|プログラムを|코드를' +
    ')', 'i'
  );
  if(codeRe.test(m)) return { needed: false, reason: 'coding' };

  // Translation
  const translateRe = /^(翻譯|翻译|幫我翻|帮我翻|translate|翻訳して|번역해|traduce|traduire|übersetze|traduza)\b/i;
  if(translateRe.test(m)) return { needed: false, reason: 'translation' };

  // Summarize / rewrite / proofread
  const rewriteRe = /^(總結|摘要|概括|重寫|改寫|潤飾|精簡|总结|改写|润色|summarize|summarise|rewrite|paraphrase|proofread|rephrase|shorten|要約して|요약해|résumer|zusammenfassen|resumir)\b/i;
  if(rewriteRe.test(m)) return { needed: false, reason: 'rewrite' };

  // Math / calculation
  const mathRe = /^(計算|算一下|算算|請算|幫我算|计算|请算|calculate|compute|solve|what is \d|how many|combien|berechne|calcular)\b/i;
  if(mathRe.test(m)) return { needed: false, reason: 'math' };

  // Roleplay / persona
  const roleplayRe = /^(假設你是|你現在是|你扮演|請扮演|假设你是|你现在是|act as |pretend you|you are a |play the role|from now on you|あなたは|너는)\b/i;
  if(roleplayRe.test(m)) return { needed: false, reason: 'roleplay' };

  // Explain a concept (answerable from training data)
  const explainRe = /^(解釋|說明|解释|说明|explain |define |what is a |what are |how does .{0,30} work|教えて|알려줘|explique|erkläre)\b/i;
  if(explainRe.test(m) && m.length < 100) return { needed: false, reason: 'explain' };

  // List / comparison (generic knowledge)
  const listRe = /^(列出|列舉|比較|对比|list |compare |pros and cons|advantages|differences? between|リストアップ|비교해)\b/i;
  if(listRe.test(m) && m.length < 120) return { needed: false, reason: 'list' };

  // Greetings / simple chat
  const greetRe = /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|ok|yes|no|sure|你好|哈囉|嗨|早安|午安|晚安|謝謝|谢谢|好的|了解|知道了|沒問題|こんにちは|ありがとう|안녕|감사|hola|bonjour|danke|obrigado)\b/i;
  if(greetRe.test(m) && m.length < 40) return { needed: false, reason: 'greeting' };

  // Questions about the AI itself (ZH / EN / JA / KO)
  if(/(你是誰|你是谁|你叫什麼|你叫什么|你可以做什麼|你可以做什么|你能做什麼|你能做什么|你會什麼|你会什么|介紹一下你|介绍一下你|what can you do|who are you|what are you|tell me about yourself|自己紹介|너는 누구)/i.test(m))
    return { needed: false, reason: 'about-ai' };

  // Opinion / advice / how-to (general knowledge, no real-time data needed)
  const adviceRe = /^(怎麼|怎样|如何|為什麼|为什么|為何|为何|應該|应该|可以怎麼|可以怎样|有什麼方法|有什么方法|what should|how should|how do i |how can i |how to |why does |why is |should i |can you help|可以幫|可以帮|教我|告訴我|告诉我|請問|请问|想問|想问|what do you think|do you think)/i;
  if(adviceRe.test(m) && m.length < 80) return { needed: false, reason: 'advice' };

  // Emotional / conversational
  if(/(開心|難過|焦慮|壓力|心情|感覺|害怕|無聊|累了|生氣|开心|难过|焦虑|压力|心情|感觉|害怕|无聊|累了|生气|I feel |I'm feeling |I am feeling |I'm sad|I'm happy|I'm tired|I'm bored|lonely|stressed|anxious|depressed)/i.test(m))
    return { needed: false, reason: 'emotional' };

  // "What is X" / "X 是什麼" — general concept questions (but NOT if it contains a specific identifier)
  if(/(是什麼|是什么|是啥|係乜|what is |what's )/i.test(m) && m.length < 60 && !/[A-Za-z]{2,}/.test(m))
    return { needed: false, reason: 'concept-q' };

  // Simple instructions / commands to the AI
  if(/^(請|幫我|幫忙|麻煩|能不能|可不可以|please |can you |could you |would you |help me )/i.test(m) && m.length < 60)
    return { needed: false, reason: 'instruction' };

  // Very short messages (but not if it looks like an explicit search request)
  if(m.length < 10 && !/\d/.test(m) && !/(查|搜|找|search|look|find)/i.test(m))
    return { needed: false, reason: 'too-short' };

  // Default: do NOT search — only search when there is a clear signal above
  return { needed: false, reason: 'no-signal' };
}

function extractSearchQuery(userMessage){
  if(!userMessage) return '';
  let q = userMessage.trim();
  // Strip common Chinese instruction prefixes that shouldn't be part of the search
  const prefixes = [
    /^(請|幫我|幫忙|麻煩|能不能|可以|可否|能否|你能|你可以)/,
    /^(搜尋|搜索|查一下|查查|查找|找一下|找找|搜一下|上網搜|上網查|上網找|網上搜|網上查|網上找|聯網搜|聯網查)/,
    /^(告訴我|說說|介紹|解釋|分析|了解)/,
    /^(一下|看看|幫我看)/,
    /^(關於|有關|regarding|about)\s*/i,
  ];
  let changed = true;
  while(changed){
    changed = false;
    for(const re of prefixes){
      const before = q;
      q = q.replace(re, '').trim();
      if(q !== before) changed = true;
    }
  }
  // Remove trailing question marks and common endings
  q = q.replace(/[？?。.!！~～，,]+$/g, '').trim();
  q = q.replace(/(的資訊|的信息|的消息|的最新消息|的價格|嗎|呢|吧|啊|呀)$/g, function(m, offset){
    // Keep "價格" if there's a subject before it (e.g. "iPhone 價格")
    if(m === '的價格' && offset > 0) return ' 價格';
    return '';
  }).trim();

  // If we stripped too much, use the original
  if(q.length < 2) q = userMessage.trim();
  // Limit search query length
  if(q.length > 120) q = q.slice(0, 120);

  console.log('[WebSearch] extractSearchQuery:', JSON.stringify(userMessage.slice(0,60)), '→', JSON.stringify(q));
  return q;
}

async function performWebSearch(query){
  if(!query || !query.trim()) return null;

  const cfg = await WebSearch.getConfig();
  let websiteContent = null;

  // Visit website in message: detect URLs and fetch their content
  if(cfg.visitWebsiteInMessage !== false){
    try{
      const visit = await WebSearch.visitWebsitesInMessage(query);
      if(visit.hasUrls && visit.contents.length > 0){
        console.log('[WebSearch] Visited', visit.contents.length, 'URL(s) from message');
        websiteContent = visit.contents;
      }
    }catch(e){
      console.warn('[WebSearch] visitWebsitesInMessage error:', e);
    }
  }

  // If message contains URLs, use visited content; also do a search if no URLs or URLs failed
  const searchQuery = extractSearchQuery(query);
  let searchResults = null;

  if(searchQuery){
    try{
      console.log('[WebSearch] Searching:', searchQuery);
      const results = await WebSearch.search(searchQuery);
      if(results && results.length){
        console.log('[WebSearch] Got', results.length, 'results');
        searchResults = results;
      } else {
        console.warn('[WebSearch] No results returned');
      }
    }catch(e){
      console.error('[WebSearch] Search error:', e);
    }
  }

  // Build combined context
  let text = '';
  const allResults = [];

  if(websiteContent && websiteContent.length > 0){
    for(const wc of websiteContent){
      text += `[Visited Page] ${wc.url}\n${wc.content.slice(0, 1500)}\n\n`;
      allResults.push({ title: wc.url, url: wc.url, snippet: wc.content.slice(0, 200) });
    }
  }

  if(searchResults && searchResults.length > 0){
    text += WebSearch.formatResultsAsContext(searchResults, searchQuery);
    allResults.push(...searchResults);
  }

  if(!text){
    showToast(sp_t('webSearchNoResults'));
    return null;
  }

  return { text, results: allResults, query: searchQuery || query };
}

/* ================= Page Context ================= */
async function loadChatWithPageState(){
  try{
    const { chatWithPageEnabled: stored } = await chrome.storage.local.get('chatWithPageEnabled');
    let desired=!!stored;
    if(desired && chrome.permissions){
      try{
        const has=await chrome.permissions.contains({ origins: GLOBAL_PAGE_ORIGINS });
        if(!has) desired=false;
      }catch(e){ desired=false; }
    }
    applyChatWithPageEnabled(desired, { persist:false });
    if(desired!==!!stored){
      const maybe=chrome.storage?.local?.set?.({ chatWithPageEnabled: desired });
      if(maybe && typeof maybe.catch==='function') maybe.catch(()=>{});
    }
  }catch(e){
    applyChatWithPageEnabled(false, { persist:false });
  }
}

function applyChatWithPageEnabled(enabled, { persist = true } = {}){
  chatWithPageEnabled=!!enabled;
  const btn=els.pageContextButton;
  if(btn){
    btn.setAttribute('aria-pressed', String(chatWithPageEnabled));
    // 移除所有狀態類，恢復默認
    btn.classList.remove('active');
    btn.classList.remove('error');
    btn.classList.remove('outdated');
    const tip=sp_t('referencePage');
    setButtonTooltip(btn, tip);
    btn.setAttribute('aria-label', tip);
    if(!chatWithPageEnabled){
      pageContextTransitionToken++;
    }
  }
  if(persist){
    const maybePromise=chrome.storage.local.set({ chatWithPageEnabled });
    if(maybePromise && typeof maybePromise.catch==='function'){
      maybePromise.catch(()=>{});
    }
  }
  if(!chatWithPageEnabled){
    lastCapturedPageUrl = null; // 清除引用記錄
  }
  
  // 立即檢查頁面狀態（如果啟用了引用功能）
  if(chatWithPageEnabled){
    checkPageContextStatus();
  }
}

function setPageContextBusy(busy){
  pageContextBusy=!!busy;
  const btn=els.pageContextButton;
  if(btn){
    btn.classList.toggle('busy', busy);
    // 不禁用按鈕，這樣用戶可以點擊取消，且 tooltip 可以顯示
    // btn.disabled=busy;
  }
}

async function checkPageContextStatus(){
  if(!chatWithPageEnabled) return;
  
  try{
    const tab = await getActiveTab();
    const btn = els.pageContextButton;
    if(!btn || !tab) return;
    
    // 檢查當前頁面是否可讀取
    const isCurrentPageSupported = isSupportedPageUrl(tab.url);
    
    // 如果當前頁面不支援，顯示警告
    if(!isCurrentPageSupported){
      btn.classList.add('outdated');
      const tip = sp_t('cannotRead');
      setButtonTooltip(btn, tip);
      btn.setAttribute('aria-label', tip);
      return;
    }
    
    // 如果沒有引用記錄，移除 outdated 狀態
    if(!lastCapturedPageUrl){
      btn.classList.remove('outdated');
      return;
    }
    
    // 比較當前頁面 URL 與引用的頁面 URL
    const isSamePage = tab.url === lastCapturedPageUrl;
    
    // 更新按鈕狀態
    btn.classList.toggle('outdated', !isSamePage);
    
    if(!isSamePage){
      const tip = sp_t('cannotRead');
      setButtonTooltip(btn, tip);
      btn.setAttribute('aria-label', tip);
    } else {
      // 如果是同一頁面，恢復正常提示
      const tip = sp_t('referencePage');
      setButtonTooltip(btn, tip);
      btn.setAttribute('aria-label', tip);
    }
  }catch(e){
    console.warn('[pageContext] checkStatus failed', e);
  }
}

function getPageTitle(url){
  try{
    const urlObj = new URL(url);
    return urlObj.hostname;
  }catch{
    return sp_t('oldPage');
  }
}

function setupPageChangeWatcher(){
  // 初始檢查
  checkPageContextStatus();
  
  // 使用輪詢方式定期檢查頁面狀態（每 500ms 檢查一次，更快反應）
  let lastCheckedUrl = null;
  
  // 立即獲取當前 URL
  (async () => {
    try {
      const tab = await getActiveTab();
      if(tab) lastCheckedUrl = tab.url;
    } catch(e) {}
  })();
  
  setInterval(async () => {
    try {
      const tab = await getActiveTab();
      if(!tab) return;
      
      // 檢查 URL 是否變化（包括同一個 tab 內的導航）
      if(tab.url !== lastCheckedUrl) {
        console.log('[pageContext] 🔄 URL changed from', lastCheckedUrl, 'to', tab.url);
        lastCheckedUrl = tab.url;
        
        // 視覺反饋：僅在啟用引用時才進行顏色轉換
        const btn = els.pageContextButton;
        if(btn) {
          // 清理狀態
          pageContextTransitionToken++;
          btn.classList.remove('outdated');
        }
        
        // 如果啟用了引用且頁面支援，自動更新引用的 URL
        if(chatWithPageEnabled && isSupportedPageUrl(tab.url)) {
          lastCapturedPageUrl = tab.url;
          console.log('[pageContext] Auto-updated captured URL to:', tab.url);
        }
        
        // 檢查並更新按鈕狀態（未啟用時不需檢測）
        if(chatWithPageEnabled){
          checkPageContextStatus();
        }
      }
    } catch(e) {
      console.warn('[pageContext] Polling error:', e);
    }
  }, 500); // 每 0.5 秒檢查一次，更快反應
}

function flagPageContextError(message){
  const btn=els.pageContextButton;
  if(!btn) return;
  btn.classList.add('error');
  const tipMessage = message === 'PAGE_UNREADABLE'
    ? sp_t('cannotRead')
    : sp_tpl('referencePage_error',{msg:message});
  const tip=tipMessage;
  setButtonTooltip(btn, tip);
  btn.setAttribute('aria-label', tip);
  if(pageContextErrorResetHandle){
    clearTimeout(pageContextErrorResetHandle);
  }
  pageContextErrorResetHandle=setTimeout(()=>{
    btn.classList.remove('error');
    const base=sp_t('referencePage');
    setButtonTooltip(btn, base);
    btn.setAttribute('aria-label', base);
    pageContextErrorResetHandle=null;
  },4200);
}

function setupPermissionWatchers(){
  if(!chrome.permissions) return;
  if(setupPermissionWatchers._installed) return;
  const matchGlobal=(origins)=>origins?.some?.(o=>GLOBAL_PAGE_ORIGINS.includes(o));
  const handleAdded=(info)=>{
    if(matchGlobal(info.origins)){
      storeGlobalPermissionFlag(true);
    }
  };
  const handleRemoved=(info)=>{
    if(matchGlobal(info.origins)){
      storeGlobalPermissionFlag(false);
      if(chatWithPageEnabled){
        applyChatWithPageEnabled(false);
        flagPageContextError(sp_t('permissionCancelled'));
      }
      setPageContextBusy(false);
    }
  };
  try{
    chrome.permissions.onAdded?.addListener(handleAdded);
    chrome.permissions.onRemoved?.addListener(handleRemoved);
    setupPermissionWatchers._installed=true;
  }catch(e){ console.warn('[pageContext] 無法註冊權限監聽', e); }
}

// 顯示頁面內容預覽卡片
// 存儲當前頁面內容
let currentPageContent = '';

// 更新頁面內容預覽卡片（顯示所有引用的頁面）
function updatePageContextPreview(){
  if(!els.pageContentPreview) return;
  
  const session = getCurrentSession();
  if(!session) return;
  
  // 只找到等待使用的頁面上下文消息（不包括已經發送過的）
  const pageContextMessages = session.messages.filter(m => m._pendingPageContext);
  
  if(pageContextMessages.length === 0){
    hidePageContentPreview();
    return;
  }
  
  // 計算總字符數
  const totalLength = pageContextMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  
  // 設置標題
  if(els.pageContentTitle){
    if(pageContextMessages.length === 1){
      const msg = pageContextMessages[0];
      const displayTitle = msg.pageTitle || sp_t('untitledPage');
      els.pageContentTitle.textContent = displayTitle.length > 50 
        ? displayTitle.substring(0, 50) + '...' 
        : displayTitle;
    } else {
      els.pageContentTitle.textContent = sp_tpl('pagesReferenced',{count:pageContextMessages.length});
    }
  }
  
  // 設置元數據
  if(els.pageContentMeta){
    if(pageContextMessages.length === 1){
      const msg = pageContextMessages[0];
      const domain = msg.pageUrl ? new URL(msg.pageUrl).hostname : sp_t('unknownSource');
      const lengthText = `${(totalLength / 1000).toFixed(1)}k 字符`;
      els.pageContentMeta.textContent = `${domain} • ${lengthText}`;
    } else {
      const lengthText = `${(totalLength / 1000).toFixed(1)}k 字符`;
      els.pageContentMeta.textContent = sp_tpl('totalLengthDetails',{length:lengthText});
    }
  }
  
  // 存儲第一個頁面的完整內容（用於展開查看）
  currentPageContent = pageContextMessages[0]?.content || '';
  
  // 顯示預覽卡片
  if(els.pageContentExpanded){ els.pageContentExpanded.style.display = 'none'; }
  if(els.pageContentCard){ els.pageContentCard.classList.remove('expanded'); }
  els.pageContentPreview.style.display = 'block';
}

function showPageContentPreview(title, url, contentLength, fullContent = ''){
  if(!els.pageContentPreview) return;
  
  // 存儲完整內容
  currentPageContent = fullContent;
  
  // 設置標題（最多顯示 50 字符）
  const displayTitle = title || sp_t('untitledPage');
  if(els.pageContentTitle){
    els.pageContentTitle.textContent = displayTitle.length > 50 
      ? displayTitle.substring(0, 50) + '...' 
      : displayTitle;
  }
  
  // 設置元數據（URL + 內容長度）
  if(els.pageContentMeta){
    const domain = url ? new URL(url).hostname : sp_t('unknownSource');
    const lengthText = contentLength ? `${(contentLength / 1000).toFixed(1)}k 字符` : '';
    els.pageContentMeta.textContent = `${domain} • ${lengthText}`;
  }
  
  // 確保展開區域是收起狀態
  if(els.pageContentExpanded){
    els.pageContentExpanded.style.display = 'none';
  }
  if(els.pageContentCard){
    els.pageContentCard.classList.remove('expanded');
  }
  
  // 顯示預覽卡片
  els.pageContentPreview.style.display = 'block';
  
  console.log('[pageContentPreview] Shown:', { title: displayTitle, url, contentLength, hasContent: !!fullContent });
}

// 隱藏頁面內容預覽卡片
function hidePageContentPreview(){
  if(!els.pageContentPreview) return;
  els.pageContentPreview.style.display = 'none';
  console.log('[pageContentPreview] Hidden');
}

// 切換展開/收起頁面內容
function togglePageContentExpanded(){
  if(!els.pageContentExpanded || !els.pageContentCard) return;
  
  const session = getCurrentSession();
  if(!session) return;
  
  // 只顯示等待使用的頁面上下文（不包括已經發送過的）
  const pageContextMessages = session.messages.filter(m => m._pendingPageContext);
  if(pageContextMessages.length === 0) return;
  
  // 如果只有一頁，直接打開模態框
  if(pageContextMessages.length === 1){
    showPageContextModal(pageContextMessages[0]);
    return;
  }
  
  // 多頁時才有展開/收起交互
  const isExpanded = els.pageContentExpanded.style.display !== 'none';
  
  if(isExpanded){
    // 收起
    els.pageContentExpanded.style.display = 'none';
    els.pageContentCard.classList.remove('expanded');
    console.log('[pageContentPreview] Collapsed');
  }else{
    // 展開，顯示卡片列表
    if(els.pageContentBody){
      els.pageContentBody.innerHTML = ''; // 清空
      
      pageContextMessages.forEach((msg, index) => {
        const card = document.createElement('div');
        card.className = 'page-card';
        
        const domain = msg.pageUrl ? new URL(msg.pageUrl).hostname : sp_t('unknownSource');
        const lengthText = msg.content ? `${(msg.content.length / 1000).toFixed(1)}k 字符` : '0k';
        const title = msg.pageTitle || sp_t('untitledPage');
        
        card.innerHTML = `<div class="page-card-header"><div class="page-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></div><div class="page-card-info"><div class="page-card-title">${escapeHtml(title.length > 40 ? title.substring(0, 40) + '...' : title)}</div><div class="page-card-meta">${escapeHtml(domain)} • ${lengthText}</div></div><button class="page-card-remove" data-ts="${msg.ts}" title="移除此頁面">✕</button></div>`;
        
        // 添加移除按鈕的事件監聽
        const removeBtn = card.querySelector('.page-card-remove');
        removeBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          removeSinglePageContext(msg.ts);
        });
        
        // 添加卡片點擊事件，查看該頁面內容
        card.addEventListener('click', (e) => {
          // 如果點擊的是移除按鈕，不觸發查看
          if(e.target.closest('.page-card-remove')) return;
          showPageContextModal(msg);
        });
        
        els.pageContentBody.appendChild(card);
      });
    }
    
    els.pageContentExpanded.style.display = 'block';
    els.pageContentCard.classList.add('expanded');
    console.log('[pageContentPreview] Expanded');
  }
}

// HTML 轉義函數
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 移除單個頁面上下文
function removeSinglePageContext(ts){
  const session = getCurrentSession();
  if(!session) return;
  
  // 從 session.messages 中移除
  const index = session.messages.findIndex(m => m.ts === ts);
  if(index !== -1){
    session.messages.splice(index, 1);
  }
  
  // 從 DOM 中移除
  const node = els.chatMessages?.querySelector(`.message[data-ts="${ts}"]`);
  node?.remove();
  
  // 更新預覽卡片
  updatePageContextPreview();
  
  // 更新發送按鈕狀態
  updateSendButtonState();
  
  // 如果還在展開狀態，重新渲染列表
  if(els.pageContentExpanded && els.pageContentExpanded.style.display !== 'none'){
    togglePageContentExpanded(); // 收起
    setTimeout(() => togglePageContentExpanded(), 0); // 重新展開
  }
  
  console.log('[pageContext] Removed single page context:', ts);
}

// 移除頁面內容
function removePageContent(){
  const session = getCurrentSession();
  if(!session) return;
  
  // 只移除等待使用的頁面上下文（不包括已經發送過的）
  const pageContextMessages = session.messages.filter(m => m._pendingPageContext);
  
  if(pageContextMessages.length === 0) return;
  
  // 直接清除所有等待中的頁面上下文消息（無需確認）
  session.messages = session.messages.filter(m => !m._pendingPageContext);
  
  // 從 DOM 中移除
  pageContextMessages.forEach(m => {
    const node = els.chatMessages?.querySelector(`.message[data-ts="${m.ts}"]`);
    node?.remove();
  });
  
  // 隱藏預覽卡片
  hidePageContentPreview();
  
  // 清空存儲的內容
  currentPageContent = '';
  
  // 更新發送按鈕狀態
  updateSendButtonState();
  
  console.log(`[pageContentPreview] Removed ${pageContextMessages.length} pending page context(s) from conversation`);
}

/* ================= Global Thinking Toggle ================= */
/* ── Thinking capability per model/provider ──
   Returns: 'toggleable' | 'always_on' | 'unsupported'
   Auto-detect from model name only — actual params controlled by user's thinkingParams field */
function getThinkingCapability(model, provider){
  if(!model) return 'unsupported';
  const m = model.toLowerCase();
  if(/reasoner|deepseek-r1/.test(m)) return 'always_on';
  if(/\bo[13]-?(mini|preview)?$/.test(m)) return 'always_on';
  if(/qwen/.test(m)) return 'toggleable';
  if(/gemini-2\.5/.test(m)) return 'toggleable';
  if(/claude/.test(m)) return 'toggleable';
  if(/kimi|moonshot/.test(m)) return 'toggleable';
  if(/minimax/.test(m)) return 'toggleable';
  if(provider === 'qwen' || provider === 'moonshot' || provider === 'minimax') return 'toggleable';
  return 'unsupported';
}

/* Returns the provider id for the currently selected model */
function _currentModelProvider(){
  const cmDropdown = document.querySelector('.cm-dropdown');
  if(cmDropdown){
    const active = cmDropdown.querySelector('.cm-item.selected, .cm-item[aria-selected="true"]');
    if(active?.dataset?.provider) return active.dataset.provider;
  }
  // fallback: scan native select options dataset
  const opt = els.modelSelector?.selectedOptions?.[0];
  return opt?.dataset?.provider || null;
}

async function handlePageContextToggle(){
  // 如果正在捕獲，再次點擊時終止
  if(pageContextBusy){
    console.log('[pageContext] ⏹️ Terminate requested');
    pageContextCancelRequested = true;
    // 設置存儲標誌，讓 content script 也能檢測到終止
    await chrome.storage.local.set({ pageCaptureCancelled: true });
    const btn = els.pageContextButton;
    if(btn){
      setButtonTooltip(btn, sp_t('terminatingCapture'));
      btn.setAttribute('aria-label', sp_t('terminatingCapture'));
    }
    return;
  }
  
  // 重置取消標誌（包括存儲中的）
  pageContextCancelRequested = false;
  await chrome.storage.local.set({ pageCaptureCancelled: false });
  
  // 執行頁面內容捕獲（一次性動作）
  setPageContextBusy(true);
  const btn = els.pageContextButton;
  
  try{
    // 檢查權限
    const globalGranted=await ensureGlobalPagePermission({ requestIfNeeded:true });
    if(!globalGranted){
      flagPageContextError(sp_t('needAllSitesPermission'));
      return;
    }
    
    const tab=await getActiveTab();
    if(!tab?.id) throw new Error('找不到目前分頁');
    if(!isSupportedPageUrl(tab.url)) throw new Error('PAGE_UNREADABLE'); // sentinel — matched in flagPageContextError
    
    // 更新按鈕狀態：顯示正在捕獲
    if(btn){
      btn.classList.add('active');
      const lang = awaitGetZhVariant.cached || _defaultLang();
      const tip = window.__t ? window.__t('capturingPage', lang) : '捕獲中（點擊終止）';
      setButtonTooltip(btn, tip);
      btn.setAttribute('aria-label', tip);
      console.log('[pageContext] 🎯 Tooltip set to:', tip, 'data-tooltip:', btn.getAttribute('data-tooltip'));
    }
    
    console.log('[pageContext] Starting capture from URL:', tab.url);
    
    // 檢查是否需要清除舊的頁面上下文
    const session = getCurrentSession();
    if(session){
      const pageContextMessages = session.messages.filter(m => m._pageContext);
      
      // 如果有舊的頁面上下文，檢查是否已經被使用（即：之後有用戶消息和AI回復）
      if(pageContextMessages.length > 0){
        const lastPageContextTs = Math.max(...pageContextMessages.map(m => m.ts));
        const messagesAfter = session.messages.filter(m => m.ts > lastPageContextTs);
        const hasUserMessage = messagesAfter.some(m => m.role === 'user');
        const hasAssistantReply = messagesAfter.some(m => m.role === 'assistant');
        
        // 如果頁面上下文已經被使用（有用戶消息和AI回復），清除所有舊的頁面上下文
        if(hasUserMessage && hasAssistantReply){
          console.log('[pageContext] Previous context was used, clearing old contexts');
          session.messages = session.messages.filter(m => !m._pageContext);
          
          // 從 DOM 中移除
          pageContextMessages.forEach(m => {
            const node = els.chatMessages?.querySelector(`.message[data-ts="${m.ts}"]`);
            node?.remove();
          });
          
          // 隱藏預覽卡片
          hidePageContentPreview();
        } else {
          // 如果還沒使用，檢查是否達到上限
          const MAX_PAGE_CONTEXTS = 5;
          if(pageContextMessages.length >= MAX_PAGE_CONTEXTS){
            const lang = awaitGetZhVariant.cached || _defaultLang();
            const limitMsg = window.__t ? window.__t('pageContextLimitReached', lang) : '已達到引用頁面數量上限';
            showToast(`${limitMsg}（${MAX_PAGE_CONTEXTS} ${lang === 'en' ? 'pages' : '個'}）`);
            if(btn){
              btn.classList.remove('active');
              const refPageText = window.__t ? window.__t('referencePage', lang) : '引用頁面';
              setButtonTooltip(btn, refPageText);
              btn.setAttribute('aria-label', refPageText);
            }
            return;
          }
        }
      }
    }
    
    // 執行捕獲
    const ctx = await capturePageContext();
    
    console.log('[pageContext] ✅ Capture result:', {
      hasMessage: !!ctx?.message,
      messageLength: ctx?.message?.length || 0,
      hasMetaUrl: !!ctx?.meta?.url,
      metaTitle: ctx?.meta?.title,
      wasTerminated: pageContextCancelRequested
    });
    
    // 如果被終止，但有內容，顯示提示
    if(pageContextCancelRequested && ctx?.message){
      console.log('[pageContext] ⏹️ Capture terminated by user, but content was collected');
    }
    
    if(!ctx) throw new Error('__cannotExtract__');
    if(!ctx.message) throw new Error('__captureEmpty__');
    
    // 添加新的頁面上下文消息（已在前面檢查過數量限制）
    if(ctx.message){
      appendMessage({
        role:'system',
        content: ctx.message,
        ts: Date.now(),
        _pageContext: true,
        _pendingPageContext: true, // 標記為等待使用的頁面內容
        pageUrl: ctx.meta?.url,
        pageTitle: ctx.meta?.title,
        bodyTruncated: ctx.meta?.bodyTruncated || pageContextCancelRequested
      });
      
      const statusMsg = pageContextCancelRequested 
        ? `Context added (terminated by user), length: ${ctx.message.length}` 
        : `Context added to conversation, length: ${ctx.message.length}`;
      console.log('[pageContext]', statusMsg);
      
      // 更新頁面內容預覽卡片（顯示所有引用的頁面）
      updatePageContextPreview();
      
      // 更新發送按鈕狀態，允許直接發送頁面內容
      updateSendButtonState();
      
      // 恢復按鈕正常狀態
      if(btn){
        btn.classList.remove('active');
        const lang = awaitGetZhVariant.cached || _defaultLang();
        const refPageText = window.__t ? window.__t('referencePage', lang) : '引用頁面';
        setButtonTooltip(btn, refPageText);
        btn.setAttribute('aria-label', refPageText);
      }
    }
  }catch(err){
    console.warn('[pageContext] capture failed', err);
    // 始終顯示錯誤（終止操作不會拋出錯誤）
    if(!pageContextCancelRequested){
      const errMsg = err?.message || '';
      const displayErr = errMsg === '__cannotExtract__' ? sp_t('cannotExtract')
        : errMsg === '__captureEmpty__' ? sp_t('captureEmpty')
        : errMsg || sp_t('testFailed');
      flagPageContextError(displayErr);
    }else{
      console.log('[pageContext] ⏹️ Capture terminated by user');
      // 終止後恢復按鈕狀態
      if(btn){
        btn.classList.remove('active');
        const lang = awaitGetZhVariant.cached || _defaultLang();
        const refPageText = window.__t ? window.__t('referencePage', lang) : '引用頁面';
        setButtonTooltip(btn, refPageText);
        btn.setAttribute('aria-label', refPageText);
      }
    }
  }finally{
    setPageContextBusy(false);
    pageContextCancelRequested = false; // 重置終止標誌
    // 清除存儲中的終止標誌
    chrome.storage.local.set({ pageCaptureCancelled: false }).catch(()=>{});
  }
}

// 使用 Readability 進行智能內容提取
async function captureWithReadability(){
  const tab = await getActiveTab();
  if(!tab?.id) throw new Error('找不到目前分頁');
  if(!isSupportedPageUrl(tab.url)) throw new Error('此頁面不支援擷取');
  
  const globalGranted = await ensureGlobalPagePermission({ requestIfNeeded:false });
  if(!globalGranted) throw new Error('未授權讀取此頁面');
  
  console.log('[Readability] Starting intelligent content extraction...');
  
  // 從頁面獲取完整 HTML
  const [{ result: htmlString } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // 添加 base 元素以保持相對 URL 正確
      let baseEl = document.querySelector('base');
      if (!baseEl) {
        baseEl = document.createElement('base');
        baseEl.setAttribute('href', window.location.href);
        document.head.insertBefore(baseEl, document.head.firstChild);
      }
      
      // 移除隱藏元素
      const removeHidden = (root) => {
        const iterator = document.createNodeIterator(
          root,
          NodeFilter.SHOW_ELEMENT,
          (node) => {
            const name = node.nodeName.toLowerCase();
            if(['script', 'style', 'noscript'].includes(name)) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(node);
            if(style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_SKIP;
          }
        );
        const toRemove = [];
        let node;
        while(node = iterator.nextNode()) toRemove.push(node);
        toRemove.forEach(n => n.parentNode?.removeChild(n));
      };
      
      removeHidden(document.body);
      
      return document.documentElement.outerHTML;
    }
  });
  
  if(!htmlString) throw new Error('無法獲取頁面 HTML');
  
  console.log('[Readability] HTML obtained, length:', htmlString.length);
  
  // 在 sidepanel 上下文中使用 Readability 解析
  const parser = new DOMParser();
  const dom = parser.parseFromString(htmlString, 'text/html');
  
  if(!dom || dom.documentElement.nodeName === 'parsererror'){
    throw new Error('HTML 解析失敗');
  }
  
  // 使用 Readability 提取主要內容
  const reader = new Readability(dom, {
    charThreshold: 200, // 降低閾值，對產品頁面更友好
    classesToPreserve: ['highlight', 'code', 'pre']
  });
  
  const article = reader.parse();
  
  // 初始化 Turndown 服務
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**'
  });
  
  // 添加 GFM 支持（表格、刪除線等）
  if(typeof turndownPluginGfm !== 'undefined'){
    turndownService.use(turndownPluginGfm.gfm);
  }
  
  // 保留某些 HTML 標籤
  turndownService.keep(['sub', 'sup', 'u', 'mark']);
  
  let markdown = '';
  let extractedTitle = '';
  let extractedExcerpt = '';
  
  if(!article || !article.content){
    console.warn('[Readability] No article content found (likely marketing/product page), using fallback extraction');
    
    // Fallback: 手動提取整個 body，但排除導航/footer
    const bodyClone = dom.body.cloneNode(true);
    const excludeSelectors = ['header', 'footer', 'nav', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'];
    excludeSelectors.forEach(sel => {
      bodyClone.querySelectorAll(sel).forEach(el => el.remove());
    });
    
    // 提取標題
    const h1 = bodyClone.querySelector('h1');
    extractedTitle = h1?.textContent?.trim() || dom.title || '';
    
    // 轉換為 Markdown
    markdown = turndownService.turndown(bodyClone.innerHTML || '');
    extractedExcerpt = bodyClone.textContent?.substring(0, 200).trim() || '';
    
    console.log('[Readability] Fallback extraction:', {
      title: extractedTitle,
      excerpt: extractedExcerpt.substring(0, 100),
      markdownLength: markdown.length
    });
  } else {
    console.log('[Readability] Article extracted:', {
      title: article.title,
      excerpt: article.excerpt?.substring(0, 100),
      contentLength: article.content.length,
      textLength: article.textContent?.length
    });
    
    // 轉換為 Markdown
    markdown = turndownService.turndown(article.content);
    extractedTitle = article.title || dom.title || '';
    extractedExcerpt = article.excerpt || '';
  }
  
  console.log('[Readability] Converted to Markdown, length:', markdown.length);
  
  // 獲取字符限制
  const { pageContextLimit } = await chrome.storage.local.get(['pageContextLimit']);
  const bodyLimit = pageContextLimit || PAGE_CONTEXT_BODY_MAX;
  
  // 格式化為消息（先不截斷，讓 formatPageContextPayload 處理）
  const formattedData = {
    title: extractedTitle,
    url: tab.url,
    bodyExcerpt: markdown, // 暫時使用完整內容
    bodyTruncated: false,
    metaDesc: extractedExcerpt,
    headings: [],
    selection: ''
  };
  
  // 先生成完整消息
  let message = formatPageContextPayload(tab.url, formattedData);
  
  // 如果總消息長度超過限制，截斷
  let actualTruncated = false;
  if(message.length > bodyLimit){
    // 計算需要為正文保留多少空間
    const overhead = message.length - markdown.length; // 標題、URL 等的長度
    const allowedBodyLength = Math.max(1000, bodyLimit - overhead); // 至少保留 1000 字符給正文
    
    // 截斷正文
    formattedData.bodyExcerpt = markdown.substring(0, allowedBodyLength);
    formattedData.bodyTruncated = true;
    actualTruncated = true;
    
    // 重新生成消息
    message = formatPageContextPayload(tab.url, formattedData);
    
    console.log('[Readability] Message truncated:', {
      originalLength: markdown.length + overhead,
      truncatedLength: message.length,
      bodyLimit,
      overhead
    });
  }
  
  console.log('[Readability] ✅ Extraction complete:', {
    messageLength: message.length,
    truncated: actualTruncated
  });
  
  return {
    message: message,
    meta: {
      url: tab.url,
      title: article.title || dom.title,
      bodyTruncated: actualTruncated,
      extractionMethod: 'Readability + Markdown'
    }
  };
}

// 智能滾動捕獲（針對虛擬滾動網站）
async function captureWithSmartScroll(){
  const tab=await getActiveTab();
  if(!tab?.id) throw new Error('找不到目前分頁');
  if(!isSupportedPageUrl(tab.url)) throw new Error('此頁面不支援擷取');
  
  const globalGranted=await ensureGlobalPagePermission({ requestIfNeeded:false });
  if(!globalGranted) throw new Error('未授權讀取此頁面');
  if(!chrome.scripting?.executeScript) throw new Error('瀏覽器版本不支援擷取頁面');

  const settings = await chrome.storage.local.get(['pageContextLimit']);
  const bodyLimit = settings.pageContextLimit || PAGE_CONTEXT_BODY_MAX;

  // 執行智能滾動捕獲
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target:{ tabId: tab.id },
    func:async (bodyLimit)=>{
      console.log('[smartScroll] Starting intelligent scroll capture...');
      
      const normalize=(str)=>{
        if(!str) return '';
        return str
          .replace(/\u00a0/g,' ')
          .replace(/\t/g,' ')
          .replace(/\r/g,'')
          .replace(/ +/g,' ')
          .replace(/\n{3,}/g,'\n\n')
          .trim();
      };

      // 滾動到頂部
      window.scrollTo(0, 0);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const capturedContent = new Set(); // 使用 Set 自動去重
      const scrollStep = window.innerHeight * 0.6; // 每次滾動 60% 視口高度（更小的步長捕獲更多）
      let currentScroll = 0;
      let previousHeight = document.documentElement.scrollHeight;
      let noNewContentCount = 0;
      
      // 查找主要內容容器
      const findMainContainer = () => {
        const selectors = [
          '#gridItemRoot', '#zg-ordered-list', '#zg_browseRoot',
          '[data-component-type="s-search-result"]', '.s-result-list',
          '#search', '[role="main"]', 'main', '#content', '.content'
        ];
        for(const sel of selectors){
          const el = document.querySelector(sel);
          if(el && el.innerText && el.innerText.length > 200) return el;
        }
        return document.body;
      };
      
      const mainContainer = findMainContainer();
      console.log('[smartScroll] Using container:', mainContainer.tagName, mainContainer.id || mainContainer.className);
      
      // 記錄上一次捕獲的項目數量
      let lastItemCount = 0;
      let scrollCount = 0;
      const maxScrolls = 60;
      
      // 逐步滾動並捕獲內容
      while(noNewContentCount < 5 && scrollCount < maxScrolls){
        // 檢查是否需要終止
        const { pageCaptureCancelled } = await chrome.storage.local.get(['pageCaptureCancelled']);
        if(pageCaptureCancelled){
          console.log('[smartScroll] ⏹️ Capture terminated by user, returning collected content');
          break; // 終止捕獲，但保留已收集的內容
        }
        
        scrollCount++;
        
        // 捕獲當前視口內可見的文本
        // 優先捕獲產品卡片、列表項等有意義的元素
        const selectors = [
          '[data-asin]', '[data-component-type]', 'li', 
          'article', '.s-result-item', '[class*="item"]',
          'h1', 'h2', 'h3', 'h4', 'p', 'span', 'a', 'div'
        ];
        
        let newItemsThisRound = 0;
        
        for(const selector of selectors){
          const elements = document.querySelectorAll(selector);
          for(const el of elements){
            // 跳過 script、style、noscript 元素
            if(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH'].includes(el.tagName)) continue;
            
            // 檢查元素本身或父元素是否為 script
            let parent = el.parentElement;
            let isInScript = false;
            while(parent && parent !== document.body){
              if(['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)){
                isInScript = true;
                break;
              }
              parent = parent.parentElement;
            }
            if(isInScript) continue;
            
            const rect = el.getBoundingClientRect();
            // 檢查元素是否在視口範圍內
            if(rect.top < window.innerHeight + 300 && rect.bottom > -300){
              const text = el.innerText?.trim();
              if(text && text.length >= 5 && text.length < 3000){
                // 過濾掉看起來像 JavaScript 代碼的文本
                if(text.includes('function(') || 
                   text.includes('P.when(') || 
                   text.includes('var ') ||
                   text.includes('.execute(') ||
                   text.includes('A.declarative(') ||
                   text.match(/^\s*\{/)){
                  continue;
                }
                
                if(!capturedContent.has(text)){
                  capturedContent.add(text);
                  newItemsThisRound++;
                }
              }
            }
          }
        }
        
        const totalItems = capturedContent.size;
        const itemGrowth = totalItems - lastItemCount;
        
        console.log('[smartScroll] Scroll #' + scrollCount + ':', 
                    'Position:', Math.round(currentScroll), 
                    'New items:', newItemsThisRound,
                    'Total items:', totalItems,
                    'Growth:', itemGrowth,
                    'NoNewCount:', noNewContentCount);
        
        // 檢查是否有新項目
        if(newItemsThisRound < 3){ // 如果新項目少於 3 個
          noNewContentCount++;
          console.log('[smartScroll] ⚠️ Low growth (' + newItemsThisRound + ' items). Count:', noNewContentCount, '/ 5');
        } else {
          noNewContentCount = 0;
          console.log('[smartScroll] ✅ Growing! Captured', newItemsThisRound, 'new items');
        }
        
        lastItemCount = totalItems;
        
        // 滾動到下一個位置
        currentScroll += scrollStep;
        window.scrollTo({ top: currentScroll, behavior: 'auto' });
        
        // 等待內容加載（給 Amazon 足夠時間加載）
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 檢查頁面高度變化
        const newHeight = document.documentElement.scrollHeight;
        const isAtBottom = (currentScroll + window.innerHeight >= newHeight - 100);
        
        if(isAtBottom && newHeight === previousHeight){
          console.log('[smartScroll] ✅ Reached bottom of page (height:', newHeight + ')');
          // 到底部後再多滾動幾次確保捕獲完整
          if(noNewContentCount >= 2) break;
        }
        
        if(newHeight > previousHeight){
          console.log('[smartScroll] 📈 Page grew from', previousHeight, 'to', newHeight);
        }
        previousHeight = newHeight;
      }
      
      console.log('[smartScroll] 🏁 Capture finished after', scrollCount, 'scrolls');
      
      // 滾動回頂部
      window.scrollTo({ top: 0, behavior: 'smooth' });
      
      const fullContent = Array.from(capturedContent).join('\n');
      const title = document.title || '';
      const url = window.location.href;
      
      console.log('[smartScroll] ✅ Capture complete!');
      console.log('[smartScroll] - Total items:', capturedContent.size);
      console.log('[smartScroll] - Total content length:', fullContent.length, 'chars');
      console.log('[smartScroll] - After limit:', Math.min(fullContent.length, bodyLimit), 'chars');
      
      return {
        title: normalize(title),
        url,
        body: normalize(fullContent).slice(0, bodyLimit),
        selection: '',
        headings: [],
        metaDesc: normalize(document.querySelector('meta[name="description"]')?.content||''),
        isLikelyIncomplete: fullContent.length > bodyLimit
      };
    },
    args:[bodyLimit]
  });

  if(!result) throw new Error('未能擷取內容');
  
  console.log('[smartScroll] 📦 Raw result:', {
    hasTitle: !!result.title,
    hasBody: !!result.body,
    bodyLength: result.body?.length || 0,
    hasMetaDesc: !!result.metaDesc
  });
  
  // 將 result 轉換為與正常捕獲一致的格式（使用函數開頭已獲取的 tab）
  const formattedData = {
    title: result.title,
    url: result.url,
    bodyExcerpt: result.body, // 將 body 作為 bodyExcerpt
    bodyTruncated: result.isLikelyIncomplete,
    metaDesc: result.metaDesc,
    headings: result.headings || [],
    selection: result.selection || ''
  };
  
  // 生成完整消息
  let message = formatPageContextPayload(tab.url || '', formattedData);
  
  // 如果總消息長度超過限制，需要進一步截斷（使用與開頭相同的限制）
  let actualTruncated = result.isLikelyIncomplete;
  const totalLimit = bodyLimit; // 使用函數開頭獲取的限制
  
  if(message.length > totalLimit){
    const overhead = message.length - result.body.length;
    const allowedBodyLength = Math.max(1000, totalLimit - overhead);
    
    // 重新截斷正文
    formattedData.bodyExcerpt = result.body.substring(0, allowedBodyLength);
    formattedData.bodyTruncated = true;
    actualTruncated = true;
    
    // 重新生成消息
    message = formatPageContextPayload(tab.url || '', formattedData);
    
    console.log('[smartScroll] Message truncated to fit limit:', {
      originalLength: result.body.length + overhead,
      truncatedLength: message.length,
      limit: totalLimit
    });
  }
  
  console.log('[smartScroll] 📝 Formatted message length:', message.length);
  
  return {
    message: message,
    meta: {
      url: result.url,
      title: result.title,
      bodyTruncated: actualTruncated,
      isVirtualScrollSite: true,
      isLikelyIncomplete: actualTruncated
    }
  };
}

async function capturePageContext(){
  const tab=await getActiveTab();
  if(!tab?.id) throw new Error('找不到目前分頁');
  if(!isSupportedPageUrl(tab.url)) throw new Error('此頁面不支援擷取');
  
  // 記錄引用的頁面 URL（每次捕獲時更新）
  lastCapturedPageUrl = tab.url;
  console.log('[pageContext] Capturing from URL:', lastCapturedPageUrl);
  
  // 檢測是否為虛擬滾動網站（需要滾動才能加載內容的網站）
  // 這些網站的內容是動態加載的，必須滾動才能看到更多內容
  const isVirtualScrollSite = /amazon\.|twitter\.com|x\.com|reddit\.com|youtube\.com|youtu\.be/.test(tab.url);
  if(isVirtualScrollSite){
    console.log('[pageContext] Detected virtual scrolling site (dynamic content loading), using smart scroll mode');
    return await captureWithSmartScroll();
  } else {
    console.log('[pageContext] Static page, using direct capture (Readability)');
  }
  
  // 使用 Readability 模式進行智能內容提取（僅限 reader 模式）
  const { pageCaptureMode } = await chrome.storage.sync.get(['pageCaptureMode']);
  const mode = pageCaptureMode || 'reader';
  
  if(mode === 'reader'){
    console.log('[pageContext] Using Readability + Markdown mode for intelligent content extraction');
    return await captureWithReadability();
  }
  
  const globalGranted=await ensureGlobalPagePermission({ requestIfNeeded:false });
  if(!globalGranted) throw new Error('未授權讀取此頁面');
  if(!chrome.scripting?.executeScript) throw new Error('瀏覽器版本不支援擷取頁面');

  const { pageCaptureInclude, pageCaptureExclude, pageContextLimit } = await chrome.storage.sync.get(['pageCaptureInclude','pageCaptureExclude','pageContextLimit']);
  
  // 使用用戶設定的字符限制，如果沒有設定則使用默認值
  const bodyLimit = pageContextLimit || PAGE_CONTEXT_BODY_MAX;
  console.log('[pageContext] Using body limit:', bodyLimit);
  console.log('[pageContext] Capture mode: custom');
  const includeSelector=(pageCaptureInclude||'').trim()||'';
  const excludeSelectors=(pageCaptureExclude||'')
    .split(/\r?\n/)
    .map(s=>s.trim())
    .filter(Boolean);

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target:{ tabId: tab.id },
    func:(bodyLimit, selectionLimit, mode, includeSelector, excludeSelectors)=>{
      const normalize=(str)=>{
        if(!str) return '';
        return str
          .replace(/\u00a0/g,' ')
          .replace(/\t/g,' ')
          .replace(/\r/g,'')
          .replace(/ +/g,' ')
          .replace(/\n{3,}/g,'\n\n')
          .trim();
      };
      const pickRoots=()=>{
        // 模式 1: 'full' - 整個頁面 (使用完整 HTML)
        if(mode === 'full'){
          console.log('[pageContext] Mode: full (整個頁面 - Markdown)');
          // 返回特殊标记，表示需要完整 HTML
          return [{ _fullPage: true }];
        }
        
        // 模式 2: 'custom' - 自訂 CSS 選擇器
        if(mode === 'custom' && includeSelector){
          console.log('[pageContext] Mode: custom with selector:', includeSelector);
          try{
            const list=Array.from(document.querySelectorAll(includeSelector)).filter(Boolean);
            if(list.length) return list;
          }catch(e){
            console.warn('[pageContext] Custom selector failed:', e);
          }
        }
        
        // 模式 3: 'reader' - Markdown 智能提取 (默認)
        console.log('[pageContext] Mode: reader (Markdown 智能提取)');
        
        // reader 模式：使用整個頁面，通過 excludeSelectors 排除 header/footer/nav/aside
        const body = document.body || document.documentElement;
        return body ? [body] : [];
        
        // 以下代碼不再執行（保留作為參考）
        // 針對 GitHub 特殊處理
        const isGitHub = window.location.hostname.includes('github.com');
        if(isGitHub){
          console.log('[pageContext] Detected GitHub, using specialized selectors');
          const githubSelectors = [
            // GitHub README 和文件內容
            '#readme article',
            '#readme',
            '.markdown-body',
            // GitHub Issues/PR 內容
            '.js-discussion',
            '.timeline-comment-wrapper',
            // GitHub 代碼文件
            '.blob-wrapper',
            // GitHub 主要內容區域
            '#repo-content-pjax-container',
            '[data-pjax-container]',
            // 通用主要內容
            'main',
            '#js-repo-pjax-container'
          ];
          
          for(const selector of githubSelectors){
            try{
              const elements = Array.from(document.querySelectorAll(selector));
              if(elements.length > 0){
                console.log('[pageContext] Testing GitHub selector:', selector, '- found', elements.length, 'elements');
                const visible = elements.filter(el => {
                  const style = window.getComputedStyle(el);
                  const rect = el.getBoundingClientRect();
                  return style.display !== 'none' 
                    && style.visibility !== 'hidden' 
                    && rect.width > 0 
                    && rect.height > 0;
                });
                if(visible.length > 0){
                  const preview = visible[0].innerText?.slice(0, 100) || '';
                  console.log('[pageContext] ✅ Found GitHub content using:', selector, '- preview:', preview);
                  return visible;
                }
              }
            }catch(e){
              console.warn('[pageContext] Error checking GitHub selector:', selector, e);
            }
          }
        }
        
        // 自動檢測可見的彈窗/模態框內容
        // 常見的彈窗選擇器，優先級從高到低
        const modalSelectors = [
          // Inoreader 特定選擇器
          '.article_content',
          '.article_full_contents',
          '[class*="article"][class*="content"]',
          // 阿里郵箱特定選擇器（優先級最高）
          '[class*="mail-reader"]',
          '[class*="reader-box"]',
          '[class*="detail-panel"]',
          '[class*="mail-detail"]',
          '[class*="content-panel"]',
          '.mail-reader',
          '.mail-reader-container',
          '.reader-body',
          '.reader-content',
          '#mail-detail',
          '#reader',
          '[id*="reader"]',
          '[id*="detail"]',
          // Amazon 特定選擇器（優先匹配）
          '#gridItemRoot',
          '#zg-ordered-list',
          '#zg_browseRoot',
          '[data-component-type="s-search-result"]',
          '.s-result-list',
          // 通用郵箱網站選擇器（Gmail、Outlook 等）
          '[role="main"] [role="article"]',
          '.mail-detail',
          '.email-content',
          '.message-body',
          '.message-content',
          '[class*="mail"][class*="detail"]',
          '[class*="mail"][class*="content"]',
          '[class*="email"][class*="content"]',
          '[class*="message"][class*="body"]',
          // 通用 ARIA 和語義化選擇器
          '[role="dialog"] article',
          '[role="dialog"]',
          '[role="article"]',
          '[role="main"]',
          // 通用模態框選擇器
          '.modal.show article',
          '.modal.show',
          '.modal.is-active',
          '.modal.open',
          '.dialog',
          '.overlay.active article',
          '.overlay.active',
          // HTML5 語義化標籤（優先使用 main）
          'main',
          'main article',
          'article',
          // 通用內容容器
          '#content',
          '#main-content',
          '.content',
          '.main-content'
        ];
        
        for(const selector of modalSelectors){
          try{
            const modals = Array.from(document.querySelectorAll(selector));
            if(modals.length > 0){
              console.log('[pageContext] Testing selector:', selector, '- found', modals.length, 'elements');
            }
            // 過濾出可見的元素（檢查 display 和 visibility）
            // 移除視口限制，以捕獲整個頁面內容（包括滾動區域外的）
            const visible = modals.filter(el => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              // 只檢查元素是否被隱藏，不檢查是否在視口內
              const isVisible = style.display !== 'none' 
                && style.visibility !== 'hidden' 
                && rect.width > 0 
                && rect.height > 0;
              if(!isVisible && modals.length <= 3){
                console.log('[pageContext] Element not visible:', {
                  selector,
                  display: style.display,
                  visibility: style.visibility,
                  rect: {width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom}
                });
              }
              return isVisible;
            });
            if(visible.length > 0){
              const contentText = visible[0].innerText || '';
              const contentLength = contentText.length;
              const preview = contentText.slice(0, 100);
              
              // 如果內容太少（少於 200 字符），可能不是主要內容，繼續嘗試下一個選擇器
              if(contentLength < 200){
                console.log('[pageContext] ⚠️ Content too short (', contentLength, 'chars), trying next selector...');
                continue;
              }
              
              console.log('[pageContext] ✅ Found visible content using:', selector, '- count:', visible.length, '- length:', contentLength, '- preview:', preview);
              return visible;
            }
          }catch(e){
            console.warn('[pageContext] ❌ Error checking selector:', selector, e);
          }
        }
        
        // reader 模式：使用整個 body，通過 excludeSelectors 排除導覽元素
        console.log('[pageContext] Using body with exclude selectors (header/footer/nav/aside)');
        const fallback=document.body || document.documentElement;
        return fallback ? [fallback] : [];
      };
      const roots=pickRoots();
      if(!roots.length) return null;
      
      // 檢查是否為 full 模式（需要完整 HTML）
      if(roots[0] && roots[0]._fullPage){
        console.log('[pageContext] Full page mode: extracting complete HTML');
        // 獲取完整 HTML
        const fullHTML = document.documentElement.outerHTML;
        
        // 清理危險元素（在臨時 DOM 中進行）
        const tempDoc = document.implementation.createHTMLDocument('');
        tempDoc.documentElement.innerHTML = fullHTML;
        
        // 移除 script、style、noscript 等
        const dangerousTags = ['script', 'style', 'noscript', 'iframe', 'object', 'embed'];
        dangerousTags.forEach(tag => {
          tempDoc.querySelectorAll(tag).forEach(el => el.remove());
        });
        
        // 移除危險屬性
        const dangerousAttrs = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'];
        tempDoc.querySelectorAll('*').forEach(el => {
          dangerousAttrs.forEach(attr => {
            if(el.hasAttribute(attr)) el.removeAttribute(attr);
          });
        });
        
        // 應用排除選擇器（如果有的話）
        if(Array.isArray(excludeSelectors) && excludeSelectors.length){
          console.log('[pageContext] Applying exclude selectors to full page:', excludeSelectors);
          excludeSelectors.forEach(sel=>{
            if(!sel) return;
            try{
              tempDoc.querySelectorAll(sel).forEach(node=>node.remove());
            }catch(e){
              console.warn('[pageContext] Error applying exclude selector:', sel, e);
            }
          });
        }
        
        const cleanedHTML = tempDoc.documentElement.outerHTML;
        const bodyText = tempDoc.body ? (tempDoc.body.innerText || tempDoc.body.textContent || '') : '';
        const body = normalize(bodyText);
        
        const headings=Array.from(tempDoc.querySelectorAll('h1, h2, h3'))
          .map(h=>normalize(h.textContent||''))
          .filter(Boolean)
          .slice(0, 10);
        const metaDesc=normalize(tempDoc.querySelector('meta[name="description"]')?.content||'');
        const bodyExcerpt=body.slice(0, bodyLimit);
        
        return {
          title: normalize(document.title||''),
          lang: normalize(document.documentElement?.lang||''),
          selection: '',
          selectionTruncated: false,
          metaDesc,
          headings,
          bodyExcerpt: cleanedHTML, // 返回 HTML 而不是純文本
          bodyHTML: cleanedHTML, // 額外字段標記這是 HTML
          bodyTruncated: body.length > bodyExcerpt.length,
          isVirtualScrollSite: false,
          isLikelyIncomplete: false
        };
      }
      
      // 創建 clone 容器用於排除選擇器
      const container=document.createElement('div');
      roots.forEach(node=>{
        try{
          container.appendChild(node.cloneNode(true));
        }catch(e){
          /* ignore clone errors */
        }
      });
      if(!container.childNodes.length) return null;
      
      // 應用排除選擇器（移除 header、footer、nav、aside 等導覽元素）
      if(Array.isArray(excludeSelectors) && excludeSelectors.length){
        console.log('[pageContext] Applying exclude selectors:', excludeSelectors);
        let totalRemoved = 0;
        excludeSelectors.forEach(sel=>{
          if(!sel) return;
          try{
            const elements = container.querySelectorAll(sel);
            console.log('[pageContext] Removing', elements.length, 'elements matching:', sel);
            totalRemoved += elements.length;
            elements.forEach(node=>node.remove());
          }catch(e){
            console.warn('[pageContext] Error applying exclude selector:', sel, e);
          }
        });
        console.log('[pageContext] Total elements removed:', totalRemoved);
      }

      const selectionRaw=(window.getSelection?.().toString()||'').trim();
      const selection=normalize(selectionRaw).slice(0, selectionLimit);
      
      // 從已經移除導覽元素的容器中提取內容
      const bodyRawDirect = container.innerText || container.textContent || '';
      const body=normalize(bodyRawDirect);
      
      const headings=Array.from(container.querySelectorAll('h1, h2, h3'))
        .map(h=>normalize(h.textContent||''))
        .filter(Boolean)
        .slice(0, 10);
      const metaDesc=normalize(document.querySelector('meta[name="description"]')?.content||'');
      const bodyExcerpt=body.slice(0, bodyLimit);
      
      // 調試信息
      console.log('[pageContext] Content length:', body.length, 'characters');
      console.log('[pageContext] Excerpt length:', bodyExcerpt.length, 'characters');
      
      // 虛擬滾動警告
      const isVirtualScrollSite = /twitter\.com|x\.com|reddit\.com|openrouter\.ai|github\.com|inoreader\.com|amazon\.|youtube\.com|youtu\.be/.test(window.location.hostname);
      
      // 判斷內容是否可能不完整：
      // 1. 虛擬滾動網站：總是顯示警告（因為無法判斷是否完整）
      // 2. 內容被截斷：原始內容超過設定上限，提示用戶可以調高上限
      const isLikelyIncomplete = isVirtualScrollSite || body.length > bodyExcerpt.length;
      
      if(isVirtualScrollSite){
        console.warn('[pageContext] ⚠️ 虛擬滾動網站，內容可能不完整：' + window.location.hostname);
      }
      if(body.length > bodyExcerpt.length){
        console.warn('[pageContext] ⚠️ 內容已截斷，原始：' + body.length + ' → 截取：' + bodyExcerpt.length + '（上限：' + bodyLimit + '）');
      }
      return {
        title: normalize(document.title||''),
        lang: normalize(document.documentElement?.lang||''),
        selection,
        selectionTruncated: selectionRaw.length>selection.length,
        metaDesc,
        headings,
        bodyExcerpt,
        bodyTruncated: body.length>bodyExcerpt.length,
        isVirtualScrollSite: isVirtualScrollSite,
        isLikelyIncomplete: isLikelyIncomplete
      };
    },
    args:[bodyLimit, PAGE_CONTEXT_SELECTION_MAX, mode, includeSelector, excludeSelectors]
  });

  if(!result) throw new Error('找不到可用的頁面文字');
  
  // 如果返回的是 HTML（full 模式），轉換為 Markdown
  if(result.bodyHTML){
    console.log('[pageContext] Converting full page HTML to Markdown');
    try{
      // 初始化 Turndown 服務
      const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
        strongDelimiter: '**'
      });
      
      // 添加 GFM 支持
      if(typeof turndownPluginGfm !== 'undefined'){
        turndownService.use(turndownPluginGfm.gfm);
      }
      
      // 保留某些 HTML 標籤
      turndownService.keep(['sub', 'sup', 'u', 'mark']);
      
      // 轉換為 Markdown
      const htmlLength = result.bodyHTML.length;
      const markdown = turndownService.turndown(result.bodyHTML);
      
      // 獲取字符限制
      const { pageContextLimit } = await chrome.storage.sync.get(['pageContextLimit']);
      const bodyLimit = pageContextLimit || PAGE_CONTEXT_BODY_MAX;
      
      // 截斷 markdown（如果超過限制）
      const markdownExcerpt = markdown.length > bodyLimit 
        ? markdown.substring(0, bodyLimit) 
        : markdown;
      
      // 更新結果
      result.bodyExcerpt = markdownExcerpt;
      result.bodyTruncated = markdown.length > bodyLimit;
      delete result.bodyHTML; // 移除 HTML 字段
      
      console.log('[pageContext] Converted to Markdown:', {
        originalHTMLLength: htmlLength,
        markdownLength: markdown.length,
        excerptLength: markdownExcerpt.length,
        truncated: result.bodyTruncated
      });
    }catch(e){
      console.error('[pageContext] Failed to convert HTML to Markdown:', e);
      // 降級為純文本
      const { pageContextLimit } = await chrome.storage.sync.get(['pageContextLimit']);
      const bodyLimit = pageContextLimit || PAGE_CONTEXT_BODY_MAX;
      
      const tempDoc = document.implementation.createHTMLDocument('');
      tempDoc.documentElement.innerHTML = result.bodyHTML;
      const plainText = tempDoc.body?.innerText || tempDoc.body?.textContent || '';
      result.bodyExcerpt = plainText.slice(0, bodyLimit);
      result.bodyTruncated = plainText.length > bodyLimit;
      delete result.bodyHTML;
    }
  }
  
  return {
    message: formatPageContextPayload(tab.url||'', result),
    meta: {
      url: tab.url||'',
      title: result.title||'',
      bodyTruncated: result.bodyTruncated,
      isVirtualScrollSite: result.isVirtualScrollSite,
      isLikelyIncomplete: result.isLikelyIncomplete
    }
  };
}

async function getActiveTab(){
  try{
    let tabs=await chrome.tabs.query({ active:true, currentWindow:true });
    if(!tabs?.length){
      tabs=await chrome.tabs.query({ active:true, lastFocusedWindow:true });
    }
    return tabs && tabs.length? tabs[0]:null;
  }catch(e){
    console.warn('[pageContext] getActiveTab failed', e);
    return null;
  }
}

function isSupportedPageUrl(url){
  if(!url) return false;
  if(UNSUPPORTED_PROTOCOL_RE.test(url)) return false;
  if(/^about:blank/.test(url)) return false;
  return /^https?:/i.test(url);
}

function storeGlobalPermissionFlag(granted){
  try{
    const maybe=chrome.storage?.local?.set?.({ chatWithPageGlobalGranted: !!granted });
    if(maybe && typeof maybe.catch==='function') maybe.catch(()=>{});
  }catch(e){}
}

async function ensureGlobalPagePermission({ requestIfNeeded = false } = {}){
  if(!chrome.permissions) return true;
  try{
    const has=await chrome.permissions.contains({ origins: GLOBAL_PAGE_ORIGINS });
    if(has){
      storeGlobalPermissionFlag(true);
      return true;
    }
    if(!requestIfNeeded){
      storeGlobalPermissionFlag(false);
      return false;
    }
    if(!chrome.permissions.request) return false;
    const granted=await chrome.permissions.request({ origins: GLOBAL_PAGE_ORIGINS });
    storeGlobalPermissionFlag(granted);
    return !!granted;
  }catch(e){
    console.warn('[pageContext] ensureGlobalPagePermission failed', e);
    return false;
  }
}

function formatPageContextPayload(url, data, lang = null){
  console.log('[formatPageContextPayload] Input data:', {
    hasTitle: !!data.title,
    hasUrl: !!url,
    hasBodyExcerpt: !!data.bodyExcerpt,
    bodyExcerptLength: data.bodyExcerpt?.length || 0,
    hasMetaDesc: !!data.metaDesc,
    headingsCount: data.headings?.length || 0,
    lang: lang || 'auto'
  });
  
  // 只返回頁面節錄內容，不包含元數據
  if(data.bodyExcerpt){
    return data.bodyExcerpt + (data.bodyTruncated ? '…' : '');
  }
  
  return '';
}

/* ================= Sessions ================= */
async function loadSessions(){
  try{
    const d=await chrome.storage.local.get(['chatSessions','currentSessionId']);
    sessions=d.chatSessions||[];
    currentSessionId=d.currentSessionId||null;
  }catch(e){ showFatal('讀取對話失敗', e); }
}
function ensureSession(){
  if(!currentSessionId || !sessions.some(s=>s.id===currentSessionId)){
    createNewSession(true);
  }
  syncSystemMessage();
}
function getCurrentSession(){ return sessions.find(s=>s.id===currentSessionId); }
function createNewSession(silent=false){
  // If user-triggered and current session is already empty, just reset UI — don't add to history
  if(!silent){
    const cur=getCurrentSession();
    if(cur && !cur.messages.some(m=>m.role==='user')){
      renderAllMessages();
      renderSessionList();
      syncSystemMessage();
      renderSuggestionsIfNeeded().catch(err=>console.warn('[SP] renderSuggestionsIfNeeded failed:',err));
      resetComposerIfEmpty();
      hidePageContentPreview();
      return;
    }
  }
  const id=Date.now().toString();
  sessions.unshift({ id, title:'新對話', createdAt:Date.now(), messages:[] });
  currentSessionId=id;
  persistSessions();
  if(!silent){
    renderAllMessages();
    renderSessionList();
  }
  syncSystemMessage();
  renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
  resetComposerIfEmpty();
  hidePageContentPreview(); // 隱藏頁面內容預覽
}
function deleteSession(id){
  const idx=sessions.findIndex(s=>s.id===id);
  if(idx>-1) sessions.splice(idx,1);
  if(currentSessionId===id){
    currentSessionId=sessions[0]?.id || null;
    if(!currentSessionId) createNewSession(true);
  }
  persistSessions();
  renderSessionList();
  renderAllMessages();
  renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
  resetComposerIfEmpty();
}
function renameSession(id,title){
  const s=sessions.find(s=>s.id===id);
  if(s && title){
    s.title=title;
    persistSessions();
    renderSessionList();
  }
}
function switchSession(id){
  if(id===currentSessionId) return;
  currentSessionId=id;
  persistSessions();
  renderAllMessages();
  renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
  els.historyPanel?.classList.remove('open');
  els.historyBackdrop?.classList.remove('show');
  resetComposerIfEmpty();
  requestAnimationFrame(()=>{ scrollToBottom(true); updateScrollBtnVisibility(); });
  setTimeout(()=>{ scrollToBottom(true); updateScrollBtnVisibility(); }, 50);
  setTimeout(()=>{ scrollToBottom(true); updateScrollBtnVisibility(); }, 150);
  
  // 檢查新會話是否有頁面上下文消息，有則顯示預覽
  const session = getCurrentSession();
  // 更新頁面內容預覽（自動顯示所有引用的頁面）
  updatePageContextPreview();
}
function persistSessions(){
  // Remove empty sessions that are not the current one
  sessions = sessions.filter(s=>s.id===currentSessionId || s.messages.some(m=>m.role==='user'));
  // Auto-cleanup old/empty sessions when over limit
  if(sessions.length > StorageHelper.MAX_SESSIONS){
    sessions = StorageHelper.cleanupSessions(sessions);
  }
  chrome.storage.local.set({ chatSessions:sessions, currentSessionId });
}

function toggleSelectAllSessions(){
  if(selectedSessionIds.size === sessions.length){
    selectedSessionIds.clear();
  } else {
    selectedSessionIds.clear();
    sessions.forEach(s=> selectedSessionIds.add(s.id));
  }
  renderSessionList();
}

async function deleteSelectedOrAllSessions(){
  if(selectedSessionIds.size > 0){
    const n = selectedSessionIds.size;
    if(!await showConfirm(sp_tpl('confirmDeleteSelected',{n}))) return;
    const wasCurrent = selectedSessionIds.has(currentSessionId);
    sessions = sessions.filter(s=> !selectedSessionIds.has(s.id));
    selectedSessionIds.clear();
    if(wasCurrent || !sessions.some(s=> s.id === currentSessionId)){
      currentSessionId = sessions[0]?.id || null;
      if(!currentSessionId) createNewSession(true);
    }
    persistSessions();
    renderSessionList();
    renderAllMessages();
    renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
    resetComposerIfEmpty();
  } else {
    if(await showConfirm(sp_t('confirmDeleteAll'))){
      sessions=[]; createNewSession(true); persistSessions();
      renderSessionList(); renderAllMessages(); renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
      resetComposerIfEmpty();
    }
  }
}

/* ================= Export / Import ================= */
async function exportSessions(){
  const data=JSON.stringify({version:1,exportedAt:new Date().toISOString(),sessions},null,2);
  const blob=new Blob([data],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`ai_sidebar_sessions_${Date.now()}.json`; a.click();
  URL.revokeObjectURL(url); await showAlert(sp_t('exportDone'));
}
function importSessionsFromFile(e){
  const file=e.target.files?.[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=async ()=>{
    try{
      const obj=JSON.parse(reader.result);
      if(!Array.isArray(obj.sessions)){ await showAlert(sp_t('importFormatError')); return; }
      if(await showConfirm(sp_t('confirmImport'))){
        sessions=obj.sessions.concat(sessions);
        const seen=new Set();
        sessions=sessions.filter(s=>!seen.has(s.id)&&seen.add(s.id));
        persistSessions(); renderSessionList(); await showAlert(sp_t('importDone'));
      }
    }catch(err){ await showAlert(sp_tpl('parseFailed',{msg:err.message})); }
  };
  reader.readAsText(file,'UTF-8');
  e.target.value='';
}

/* ================= Session List UI ================= */
function startInlineRename(item, s){
  const titleEl = item.querySelector('.session-title');
  if(!titleEl || item.classList.contains('session-item-editing')) return;
  const currentTitle = s.title;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-title-input';
  input.value = currentTitle;
  input.setAttribute('aria-label', sp_t('editTitle'));
  item.classList.add('session-item-editing');
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  function finish(commit){
    if(!input.isConnected) return;
    const next = commit && input.value.trim() ? input.value.trim() : null;
    item.classList.remove('session-item-editing');
    if(next != null && next !== currentTitle){
      renameSession(s.id, next);
      return;
    }
    const span = document.createElement('span');
    span.className = 'session-title';
    span.textContent = currentTitle;
    span.title = currentTitle;
    input.replaceWith(span);
  }

  input.addEventListener('blur', ()=> finish(true));
  input.addEventListener('keydown', e=>{
    if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
    else if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
  });
}

/* Translate stored default session titles to current language */
function translateSessionTitle(title){
  if(title === '新對話' || title === 'New Chat' || title === '新对话') return sp_t('newChat');
  if(title === '圖片' || title === 'Image' || title === '图片') return sp_t('imageSessionTitle');
  if(title === '頁面內容' || title === 'Page Content' || title === '页面内容') return sp_t('pageContentSessionTitle');
  return title;
}

function renderSessionList(){
  const listEl=els.sessionList; if(!listEl)return;
  listEl.innerHTML='';
  sessions.filter(s=>s.messages.some(m=>m.role==='user')).forEach(s=>{
    const selected = selectedSessionIds.has(s.id);
    const item=document.createElement('div');
    item.className='session-item'+(s.id===currentSessionId?' active':'')+(selected?' selected':'');
    item.dataset.id=s.id;
    item.innerHTML=`
      <label class="session-check-wrap">
        <input type="checkbox" class="session-check" ${selected?'checked':''} aria-label="${sp_t('selectSession')}">
      </label>
      <span class="session-title" title="${escapeHtml(translateSessionTitle(s.title))}">${escapeHtml(translateSessionTitle(s.title))}</span>
      <div class="session-actions">
        <button class="rename-session-btn" title="${sp_t('renameSession')}"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="delete-session-btn" title="${sp_t('delete')}" aria-label="${sp_t('delete')}"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>`;
    const checkWrap = item.querySelector('.session-check-wrap');
    checkWrap.addEventListener('mousedown',e=>{ e.stopPropagation(); });
    checkWrap.addEventListener('click',e=>{ e.stopPropagation(); });
    item.querySelector('.session-check').addEventListener('change',e=>{
      e.stopPropagation();
      if(selectedSessionIds.has(s.id)) selectedSessionIds.delete(s.id);
      else selectedSessionIds.add(s.id);
      item.classList.toggle('selected', selectedSessionIds.has(s.id));
    });
    item.addEventListener('click',e=>{
      if(e.target.closest('.session-actions') || e.target.closest('.session-check-wrap')) return;
      if(item.classList.contains('session-item-editing')) return;
      switchSession(s.id);
    });
    item.querySelector('.rename-session-btn').addEventListener('click',e=>{
      e.stopPropagation();
      startInlineRename(item, s);
    });
    item.querySelector('.delete-session-btn').addEventListener('click',async e=>{
      e.stopPropagation();
      if(await showConfirm(sp_t('confirmDeleteSession'))) deleteSession(s.id);
    });
    listEl.appendChild(item);
  });
}
/* escapeHtml now in js/utils.js */

/* ================= Suggestions ================= */
let renderingSuggestions = false;
async function renderSuggestionsIfNeeded(){
  // 防止並行調用導致重複渲染
  if(renderingSuggestions) {
    console.log('[SP] renderSuggestionsIfNeeded already in progress, skipping');
    return;
  }
  
  const session=getCurrentSession(); if(!session) return;
  const hasUser=session.messages.some(m=>m.role==='user');
  const visible=session.messages.filter(m=>m.role!=='system');
  if(hasUser || visible.length){
    els.root?.classList.add('chatting');
    renderingSuggestions = false;
  }else{
    renderingSuggestions = true;
    els.root?.classList.remove('chatting');
    if(!els.suggestionList) {
      renderingSuggestions = false;
      return;
    }
    
    // 清空現有內容，防止重複
    els.suggestionList.innerHTML='';
    
    const lang = (awaitGetZhVariant.cached) || _defaultLang();
    
    try {
      // 使用翻譯系統載入建議問題
      for(const key of SUGGESTION_KEYS){
        let text = '';
        if(typeof window.__tAsync === 'function'){
          text = await window.__tAsync(key, lang);
        } else if(typeof window.__t === 'function'){
          text = window.__t(key, lang);
        } else {
          // 回退到硬編碼（不應該發生）
          text = key;
        }
        
        // 如果是中文且語言不是繁體，需要轉換
        if(lang !== 'en' && typeof window.__zhConvert === 'function' && lang === 'hans'){
          text = __zhConvert(text, 'hans');
        }
        
        const card=document.createElement('div');
        card.className='suggestion-card';
        card.textContent=text;
        card.addEventListener('click',()=>{
          els.messageInput.value=text;
          autoGrow(els.messageInput);
          updateSendButtonState();
          setInputEngagedState();
          onSend();
        });
        els.suggestionList.appendChild(card);
      }
    } catch (e) {
      console.error('[SP] Error rendering suggestions:', e);
    } finally {
      renderingSuggestions = false;
    }
  }
}

/* ================= System Prompt Sync ================= */
function syncSystemMessage(){
  const session=getCurrentSession(); if(!session)return;

  // OpenClaw 不使用自訂系統提示詞（Agent 自帶 prompt），跳過同步但保留現有內容
  const model = els.modelSelector?.value || '';
  if(model.startsWith('openclaw:') || model.startsWith('agent:')){
    return; // 不修改也不刪除，僅跳過
  }

  const p=getSelectedPromptObj(); if(!p)return;
  if(!session.messages.length || session.messages[0].role!=='system'){
    session.messages.unshift({ role:'system', content:p.prompt, ts:Date.now() });
  } else if(session.messages[0].content!==p.prompt){
    session.messages[0].content=p.prompt;
  }
  persistSessions(); renderAllMessages();
}

/* ================= Rendering ================= */

// 統一的函數來管理歡迎區和卡通的顯示/隱藏（通過滾動自然消失）
function updateWelcomeVisibility(){
  const session = getCurrentSession();
  const sidebarFrame = els.root; // .sidebar-frame 元素
  const momoWrap = document.querySelector('.momo-wrap'); // 卡通元素
  
  if (!session) {
    // 沒有會話時，移除 chatting 類，顯示歡迎區
    if (sidebarFrame) sidebarFrame.classList.remove('chatting');
    // 卡通恢復正常顯示（不透明）
    if (momoWrap) {
      momoWrap.style.display = 'block';
      momoWrap.classList.remove('as-background');
      requestAnimationFrame(() => {
        momoWrap.classList.remove('hidden');
      });
    }
    return;
  }
  
  // 檢查是否有實際的對話消息（排除系統消息和頁面上下文消息）
  const hasConversationMessages = session.messages.some(m => 
    (m.role === 'user' || m.role === 'assistant') && !m._pageContext
  );
  
  if (hasConversationMessages) {
    // 有對話消息時，添加 chatting 類（改變布局）
    // 卡通和歡迎區一起消失
    if (sidebarFrame && !sidebarFrame.classList.contains('chatting')) {
      sidebarFrame.classList.add('chatting');
      
      // 隱藏卡通（和歡迎區一起消失）
      if (momoWrap) {
        momoWrap.classList.add('hidden');
        momoWrap.classList.remove('as-background');
        momoWrap.style.display = 'none';
      }
      
      // 標記為第一條消息，防止自動滾動到底部
      isFirstMessage = true;
      
      // 立即滾動到頂部，讓消息從頂部顯示（無動畫，立即執行）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (els.chatRegion && els.chatMessages) {
            // 禁用自動跟隨
            autoFollow = false;
            
            // 立即滾動到頂部，讓第一條消息置頂
            els.chatRegion.scrollTop = 0;
            
            // 稍後清除第一條消息標記，允許後續消息正常滾動
            setTimeout(() => {
              isFirstMessage = false;
            }, 500);
          }
        });
      });
    } else if (sidebarFrame && sidebarFrame.classList.contains('chatting')) {
      // 如果已經有 chatting 類，確保卡通是隱藏的
      if (momoWrap) {
        momoWrap.classList.add('hidden');
        momoWrap.classList.remove('as-background');
        momoWrap.style.display = 'none';
      }
    }
  } else {
    // 沒有對話消息時，移除 chatting 類，顯示歡迎區
    if (sidebarFrame) sidebarFrame.classList.remove('chatting');
    // 卡通恢復正常顯示（不透明）
    if (momoWrap) {
      momoWrap.style.display = 'block';
      momoWrap.classList.remove('as-background');
      requestAnimationFrame(() => {
        momoWrap.classList.remove('hidden');
      });
    }
  }
}

function renderAllMessages(){
  const session=getCurrentSession();
  const container=els.chatMessages;
  if(!container)return;
  container.innerHTML='';
  if(!session)return;
  const list=session.messages.filter(m=>SHOW_SYSTEM_PROMPT_BUBBLE?true:(m.role!=='system' || m._pageContext));
  list.forEach(m=>container.appendChild(renderMessage(m)));
  
  // 更新歡迎區和卡通的顯示狀態（通過添加/移除 chatting 類和滾動）
  updateWelcomeVisibility();
  
  // 只有在沒有對話消息時才滾動到底部（顯示歡迎區時）
  const hasConversationMessages = session.messages.some(m => 
    (m.role === 'user' || m.role === 'assistant') && !m._pageContext
  );
  
  if (!hasConversationMessages) {
    scrollToBottom();
  }
}

function renderMessage(msg){
  // 確保訊息角色有效
  const role = msg.role || 'assistant'; // 使用局部變量，不修改原始 msg
  if(!msg.role || (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system')){
    console.warn('[renderMessage] Invalid role:', msg.role, '| Full msg:', JSON.stringify(msg));
  }
  
  // 如果是頁面內容系統消息，不渲染（因為已經在 AI 回答底部顯示按鈕）
  if(msg._pageContext && msg.role === 'system'){
  const wrap=document.createElement('div');
    wrap.style.display='none'; // 隱藏但保留在 DOM 中以維持消息順序
  wrap.dataset.ts=msg.ts;
    return wrap;
  }
  
  const wrap=document.createElement('div');
  const messageClass = role==='user'?'user-message':(role==='system'?'system-message':'assistant-message');
  const pageContextClass = msg._pageContext?' page-context-message':'';
  wrap.className=`message ${messageClass}${msg._streaming?' streaming':''}${pageContextClass}`;
  wrap.dataset.ts=msg.ts;
  wrap.dataset.role=role; // 添加角色數據屬性用於調試
  
  const content=document.createElement('div');
  content.className='message-content';
  
  // 用於存儲圖片容器（稍後添加到wrap，而不是content）
  let separateImagesContainer = null;
  
  // 正常渲染消息內容
  {
    // 處理多模態內容（文本+圖片）
    if(Array.isArray(msg.content)){
      // 多模態消息
      // 先處理所有圖片
      const imageParts = msg.content.filter(part => part.type === 'image_url');
      if(imageParts.length > 0){
        separateImagesContainer = document.createElement('div');
        separateImagesContainer.className = 'message-images';
        
        imageParts.forEach(part=>{
          const img = document.createElement('img');
          img.className = 'message-image';
          img.src = part.image_url.url;
          img.alt = '上傳的圖片';
          img.onclick = ()=>{
            // 點擊圖片放大顯示
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
            const modalImg = document.createElement('img');
            modalImg.src = part.image_url.url;
            modalImg.style.cssText = 'max-width:90%;max-height:90%;border-radius:8px;';
            modal.appendChild(modalImg);
            modal.onclick = ()=> modal.remove();
            document.body.appendChild(modal);
          };
          separateImagesContainer.appendChild(img);
        });
        
        // 不再添加到 content，稍後添加到 wrap
      }
      
      // 然後處理文字
      msg.content.forEach(part=>{
        if(part.type === 'text'){
          const zhPref = (awaitGetZhVariant.cached) ?? _defaultLang();
          const original = String(part.text || '');
          const converted = (typeof window.__zhConvert==='function' && zhPref) 
            ? __zhConvert(original, zhPref) 
            : original;
          
          const textDiv = document.createElement('div');
          if(preferMarkdown && role!=='system' && !msg._streaming){
            textDiv.innerHTML=renderMarkdownBlocks(converted);
          }else{
            textDiv.innerHTML=escapeHtml(converted);
          }
          content.appendChild(textDiv);
        }
      });
    } else if(msg.images && msg.images.length > 0){
      // 兼容舊格式：單獨的 images 字段
      // 先處理圖片
      separateImagesContainer = document.createElement('div');
      separateImagesContainer.className = 'message-images';
      msg.images.forEach(img=>{
        const imgEl = document.createElement('img');
        imgEl.className = 'message-image';
        imgEl.src = `data:${img.type};base64,${img.data}`;
        imgEl.alt = img.name || '上傳的圖片';
        imgEl.onclick = ()=>{
          const modal = document.createElement('div');
          modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
          const modalImg = document.createElement('img');
          modalImg.src = imgEl.src;
          modalImg.style.cssText = 'max-width:90%;max-height:90%;border-radius:8px;';
          modal.appendChild(modalImg);
          modal.onclick = ()=> modal.remove();
          document.body.appendChild(modal);
        };
        separateImagesContainer.appendChild(imgEl);
      });
      // 不再添加到 content，稍後添加到 wrap
      
      // 然後添加文字
      const textPart = String(msg.content||'');
      if(textPart){
        const zhPref = (awaitGetZhVariant.cached) ?? _defaultLang();
        const converted = (typeof window.__zhConvert==='function' && zhPref) 
          ? __zhConvert(textPart, zhPref) 
          : textPart;
        const textDiv = document.createElement('div');
        if(preferMarkdown && role!=='system' && !msg._streaming){
          textDiv.innerHTML=renderMarkdownBlocks(converted);
        }else{
          textDiv.innerHTML=escapeHtml(converted);
        }
        content.appendChild(textDiv);
      }
    } else {
      // 純文本消息
      const zhPref = (awaitGetZhVariant.cached) ?? _defaultLang();
      const original = String(msg.content||'');
      const converted = (typeof window.__zhConvert==='function' && zhPref) 
        ? __zhConvert(original, zhPref) 
        : original;
      
      // 調試輸出（首次或變更時）
      if(!renderMessage._logged || renderMessage._lastZh !== zhPref){
        console.log('[SP] renderMessage zh:', zhPref, '| sample:', original.slice(0,20), '→', converted.slice(0,20));
        renderMessage._logged = true;
        renderMessage._lastZh = zhPref;
      }
      
      if(preferMarkdown && role!=='system' && !msg._streaming){
        content.innerHTML=renderMarkdownBlocks(converted);
      }else{
        content.innerHTML=escapeHtml(converted);
      }
      if(role==='user' && !msg._streaming){
    const plain=content.textContent;
    if(plain && !/\n/.test(plain) && plain.length<=40){
      content.classList.add('single-line');
        }
      }
    }
  }
  
  // 為用戶消息添加頁面引用標籤（放在消息上方）
  if(role === 'user' && msg._hasPageContext){
    const attachmentsContainer = document.createElement('div');
    attachmentsContainer.className = 'message-attachments';
    
    const lang = (awaitGetZhVariant.cached) || _defaultLang();
    const labelText = typeof window.__t === 'function' ? window.__t('pageReferenced', lang) : '引用頁面';
    const titleText = typeof window.__t === 'function' ? window.__t('referencePage', lang) : '引用頁面';
    
    const pageIndicator = document.createElement('div');
    pageIndicator.className = 'message-attachment-indicator';
    pageIndicator.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
      </svg>
      <span>${labelText}</span>
    `;
    pageIndicator.title = titleText;
    
    attachmentsContainer.appendChild(pageIndicator);
    wrap.appendChild(attachmentsContainer);
  }
  
  // 如果有圖片，添加圖片容器（在content之前）
  if(separateImagesContainer){
    wrap.appendChild(separateImagesContainer);
  }
  
  // 對於用戶消息，只有在 content 有內容時才添加（避免顯示空的氣泡）
  // 對於 AI 和系統消息，始終添加 content
  if(role === 'user'){
    const hasContent = content.textContent.trim() !== '' || content.querySelector('*') !== null;
    if(hasContent){
      wrap.appendChild(content);
    }
  } else {
    // AI 和系統消息始終顯示 content
    wrap.appendChild(content);
  }
  
  if(role!=='system'){
    wrap.appendChild(buildMessageActions(msg));
  }
  
  // 不再在這裡添加附件指示器，而是在 buildMessageActions 中添加
  
  return wrap;
}

function buildPageContextActions(msg){
  const bar=document.createElement('div');
  bar.className='message-actions';
  
  const viewBtn=document.createElement('button');
  viewBtn.className='message-action-btn';
  viewBtn.type='button';
  viewBtn.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  viewBtn.title=sp_t('viewCapturedContent');
  viewBtn.setAttribute('aria-label',sp_t('viewCapturedContent'));
  viewBtn.addEventListener('click', e=>{
    e.stopPropagation();
    showPageContextModal(msg);
  });
  
  bar.appendChild(viewBtn);
  
  // 顯示來源 URL（如果有）
  if(msg.pageUrl){
    const urlSpan=document.createElement('span');
    urlSpan.className='page-context-url';
    urlSpan.textContent=new URL(msg.pageUrl).hostname;
    urlSpan.title=msg.pageUrl;
    bar.appendChild(urlSpan);
  }
  
  return bar;
}

function buildMessageActions(msg){
  const bar=document.createElement('div');
  bar.className='message-actions';
  const ICONS = {
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>`,
    retry:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0-.48-5H7"></path></svg>`,
    edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1.768 1.768 0 0 1 2.5 2.5L12 14l-4 1 1-4 9.375-8.375Z"/></svg>`,
    speak: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`
  };
  function btn(icon,label,handler,id){
    const b=document.createElement('button');
    b.className='message-action-btn'; b.type='button';
    b.classList.add('tooltip-btn');
    b.innerHTML=icon; 
    b.title=label; 
    b.setAttribute('aria-label',label);
    b.setAttribute('data-tooltip', label);
    if(id) b.dataset.btnId = id;
    b.addEventListener('click', e=>{ e.stopPropagation(); handler(b); });
    return b;
  }
  
  // 依系統／瀏覽器語言回傳「圖片」佔位符（複製時用）
  function getImagePlaceholder() {
    const lang = (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage?.()
      ? chrome.i18n.getUILanguage()
      : navigator.language || navigator.userLanguage || ''
    ).toLowerCase();
    if (lang.startsWith('zh')) return '[圖片]';
    return '[Image]';
  }

  // 將訊息內容轉為純文字（供複製／token 估算）：多模態時圖片以佔位符替代，避免 [object Object]
  function contentToCopyableText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const placeholder = getImagePlaceholder();
      return content.map(part => {
        if (part && part.type === 'text') return String(part.text ?? '');
        if (part && part.type === 'image_url') return placeholder;
        return '';
      }).join('');
    }
    return String(content);
  }

  // 供複製時使用：去除思考內容（支持多種標籤格式）
  function stripThinkBlocks(src=''){
    if(!src) return '';
    // 先反轉義可能被轉義的標籤
    src = String(src)
      .replace(/&lt;think&gt;/gi, '<think>').replace(/&lt;\/think&gt;/gi, '</think>')
      .replace(/&lt;thinking&gt;/gi, '<thinking>').replace(/&lt;\/thinking&gt;/gi, '</thinking>')
      .replace(/&lt;thought&gt;/gi, '<thought>').replace(/&lt;\/thought&gt;/gi, '</thought>');
    // 移除所有思考標籤及其內容
    return src.replace(/<(think|thinking|thought)>[\s\S]*?(?:<\/\1>|$)/gi, '');
  }
  
  if(msg.role==='assistant'){
    bar.appendChild(btn(ICONS.copy,sp_t('copy'),()=>{
      // 先轉為可複製文字（圖片→[圖片]），再去思路、依中文偏好轉換後複製
      const zhPref = (awaitGetZhVariant.cached) ?? _defaultLang();
      const original = contentToCopyableText(msg.content);
      const noThink = stripThinkBlocks(original);
      const converted = (typeof window.__zhConvert==='function' && zhPref) 
        ? __zhConvert(noThink, zhPref) 
        : noThink;
      navigator.clipboard.writeText(converted);
    }));
    bar.appendChild(btn(ICONS.retry,sp_t('retry'),()=>retryAssistant(msg)));
    bar.appendChild(btn(ICONS.speak,sp_t('readAloud'),(btnEl)=>speakMessage(msg, btnEl), 'speak-btn'));
    
    // 如果當前會話包含頁面內容，在 AI 回覆中添加附件按鈕
    const session=getCurrentSession();
    if(session?.messages){
      const pageContextMessages = session.messages.filter(m => m._pageContext && m.role === 'system');
      if(pageContextMessages.length > 0){
        // 檢查是否有任何頁面有警告（內容不完整）
        const hasWarning = pageContextMessages.some(m => m.bodyTruncated || m.isLikelyIncomplete);
        
        // 添加頁面內容附件按鈕到操作欄（類似截圖中的附件圖標）
        const pageIcon = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`;
        const tooltipText = hasWarning ? '查看引用內容（可能不完整）' : '查看引用內容';
        bar.appendChild(btn(pageIcon, tooltipText, () => showPageContextModal(pageContextMessages)));
      }
    }

    // 如果此 AI 回覆有搜尋結果，添加搜尋來源按鈕
    if(msg._webSearchResults && msg._webSearchResults.length > 0){
      const searchIcon = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
      const searchTip = sp_t('viewSearchSources') || `搜尋來源 (${msg._webSearchResults.length})`;
      bar.appendChild(btn(searchIcon, searchTip, () => showWebSearchModal(msg._webSearchResults, msg._webSearchQuery)));
    }
    
    // 添加 token 計數顯示到最右邊
    if(msg.content && !msg._streaming){
      const tokens = estimateTokens(contentToCopyableText(msg.content));
      const tokenSpan = document.createElement('span');
      tokenSpan.className = 'message-token-count';
      tokenSpan.textContent = `~${tokens}`;
      tokenSpan.title = sp_tpl('estimatedTokens',{n:tokens});
      bar.appendChild(tokenSpan);
    }
  }else if(msg.role==='user'){
    bar.appendChild(btn(ICONS.edit,sp_t('edit'),()=>editUserMessage(msg)));
    bar.appendChild(btn(ICONS.copy,sp_t('copy'),()=>{
      // 先轉為可複製文字（圖片→[圖片]），再依中文偏好轉換後複製
      const zhPref = (awaitGetZhVariant.cached) ?? _defaultLang();
      const original = contentToCopyableText(msg.content);
      const converted = (typeof window.__zhConvert==='function' && zhPref) 
        ? __zhConvert(original, zhPref) 
        : original;
      navigator.clipboard.writeText(converted);
    }));
  }
  return bar;
}

/* ================= Message Ops ================= */
function editUserMessage(msg){
  const wrap=els.chatMessages.querySelector(`.message[data-ts="${msg.ts}"]`);
  if(!wrap)return;
  let contentEl=wrap.querySelector('.message-content');
  
  // 如果沒有 content 元素（例如只有圖片的消息），創建一個
  if(!contentEl){
    contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    // 插入到 actions 之前
    const actionsEl = wrap.querySelector('.message-actions');
    if(actionsEl){
      wrap.insertBefore(contentEl, actionsEl);
    } else {
      wrap.appendChild(contentEl);
    }
  }
  
  // 暫停自動跟隨，記住目前滾動位置，避免跳到最底
  const prevScroll = els.chatMessages.scrollTop;
  const prevAutoFollow = autoFollow; autoFollow=false;
  wrap.classList.add('editing');
  
  // 確保內容元素可見（移除可能的 display:none）
  contentEl.style.display = '';
  
  // 提取文本內容：處理多模態格式（content 可能是數組）
  let textContent = '';
  let existingImages = [];
  
  if (Array.isArray(msg.content)) {
    // 多模態格式：提取文本和圖片
    msg.content.forEach(item => {
      if (item.type === 'text' && item.text) {
        textContent = item.text;
      } else if (item.type === 'image_url' && item.image_url && item.image_url.url) {
        // 從 image_url.url 中提取 base64 數據
        const url = item.image_url.url;
        if (url.startsWith('data:')) {
          // 解析 data URL: data:image/jpeg;base64,...
          const parts = url.split(',');
          const header = parts[0]; // data:image/jpeg;base64
          const base64Data = parts[1] || '';
          
          if (base64Data) {
            const mimeMatch = header.match(/data:([^;]+)/);
            const type = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            
            existingImages.push({
              data: base64Data,
              type: type,
              name: `image-${existingImages.length + 1}`
            });
          }
        }
      }
    });
    
    // 如果有 images 字段，優先使用它（因為它可能包含文件名等信息）
    if (msg.images && msg.images.length > 0) {
      existingImages = msg.images.map(img => ({
        data: img.data,
        type: img.type || 'image/jpeg',
        name: img.name || 'image'
      }));
    }
  } else if (typeof msg.content === 'string') {
    // 純文本或舊格式
    textContent = msg.content;
    // 如果有 images 字段，使用它
    if (msg.images && msg.images.length > 0) {
      existingImages = msg.images.map(img => ({
        data: img.data,
        type: img.type || 'image/jpeg',
        name: img.name || 'image'
      }));
    }
  } else {
    textContent = String(msg.content || '');
  }
  
  // 將原有圖片載入到 uploadedImages（用於編輯）- 保存原始數據的副本
  uploadedImages = existingImages.map(img => ({
    data: img.data,
    type: img.type || 'image/jpeg',
    name: img.name || 'image'
  }));
  
  console.log('[SP] editUserMessage - loaded images:', uploadedImages.length, 'text:', textContent);
  
  const ta=document.createElement('textarea');
  ta.value=textContent;
  ta.className='message-edit-textarea';
  contentEl.innerHTML='';
  contentEl.classList.add('editing');
  
  // 定義更新圖片預覽的函數（需要在這裡定義，以便後續使用）
  const updateEditImagePreview = () => {
    let imagePreviewWrapper = contentEl.querySelector('.message-edit-image-preview');
    
    // 如果沒有預覽容器但需要顯示圖片，創建它
    if (!imagePreviewWrapper && uploadedImages.length > 0) {
      imagePreviewWrapper = document.createElement('div');
      imagePreviewWrapper.className = 'message-edit-image-preview';
      imagePreviewWrapper.style.cssText = 'margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 8px;';
      
      // 找到插入位置：在 ta 之前（文字輸入框之前）
      if (ta && ta.parentNode === contentEl) {
        contentEl.insertBefore(imagePreviewWrapper, ta);
      } else {
        // 如果找不到 ta，插入到最前面
        contentEl.insertBefore(imagePreviewWrapper, contentEl.firstChild);
      }
    }
    
    if (imagePreviewWrapper) {
      // 清空並重新渲染所有圖片
      imagePreviewWrapper.innerHTML = '';
      uploadedImages.forEach((img, index) => {
        const item = document.createElement('div');
        item.style.cssText = 'position: relative; width: 80px; height: 80px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border);';
        
        const imgEl = document.createElement('img');
        imgEl.src = `data:${img.type};base64,${img.data}`;
        imgEl.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
        imgEl.alt = img.name || '圖片';
        
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '×';
        removeBtn.style.cssText = 'position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%; background: rgba(0,0,0,0.6); color: white; border: none; cursor: pointer; font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center; z-index: 10;';
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          uploadedImages.splice(index, 1);
          updateEditImagePreview();
        };
        
        item.appendChild(imgEl);
        item.appendChild(removeBtn);
        imagePreviewWrapper.appendChild(item);
      });
      
      // 如果沒有圖片了，移除預覽區域
      if (uploadedImages.length === 0) {
        imagePreviewWrapper.remove();
      }
    }
  };
  
  // 添加圖片上傳按鈕（使用與主輸入框相同的圖標樣式）
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'message-edit-upload-btn plain-icon-btn tooltip-btn';
  uploadBtn.setAttribute('data-tooltip', sp_t('uploadImage'));
  uploadBtn.setAttribute('aria-label', sp_t('uploadImage'));
  uploadBtn.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; padding: 4px; margin: 0;';
  uploadBtn.onclick = () => {
    els.imageFileInput?.click();
  };
  
  // 添加 SVG 圖標（與主輸入框的圖片上傳按鈕相同）
  const uploadIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  uploadIcon.setAttribute('viewBox', '0 0 24 24');
  uploadIcon.setAttribute('width', '20');
  uploadIcon.setAttribute('height', '20');
  uploadIcon.setAttribute('stroke', 'currentColor');
  uploadIcon.setAttribute('fill', 'none');
  uploadIcon.setAttribute('stroke-width', '1.8');
  uploadIcon.setAttribute('stroke-linecap', 'round');
  uploadIcon.setAttribute('stroke-linejoin', 'round');
  uploadIcon.setAttribute('aria-hidden', 'true');
  
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '3');
  rect.setAttribute('y', '3');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '18');
  rect.setAttribute('rx', '2');
  rect.setAttribute('ry', '2');
  
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '8.5');
  circle.setAttribute('cy', '8.5');
  circle.setAttribute('r', '1.5');
  
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '21 15 16 10 5 21');
  
  uploadIcon.appendChild(rect);
  uploadIcon.appendChild(circle);
  uploadIcon.appendChild(polyline);
  uploadBtn.appendChild(uploadIcon);
  
  // 添加元素到 DOM（按正確順序）
  // 1. 如果有圖片，先添加圖片預覽容器
  if (uploadedImages.length > 0) {
    // 先創建圖片預覽容器（不調用 updateEditImagePreview，因為它依賴於 uploadBtn）
    const imagePreviewWrapper = document.createElement('div');
    imagePreviewWrapper.className = 'message-edit-image-preview';
    imagePreviewWrapper.style.cssText = 'margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 8px;';
    contentEl.appendChild(imagePreviewWrapper);
    
    // 渲染圖片
    uploadedImages.forEach((img, index) => {
      const item = document.createElement('div');
      item.style.cssText = 'position: relative; width: 80px; height: 80px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border);';
      
      const imgEl = document.createElement('img');
      imgEl.src = `data:${img.type};base64,${img.data}`;
      imgEl.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      imgEl.alt = img.name || '圖片';
      
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%; background: rgba(0,0,0,0.6); color: white; border: none; cursor: pointer; font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center; z-index: 10;';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        uploadedImages.splice(index, 1);
        updateEditImagePreview();
      };
      
      item.appendChild(imgEl);
      item.appendChild(removeBtn);
      imagePreviewWrapper.appendChild(item);
    });
  }
  
  // 2. 先添加文本輸入框
  contentEl.appendChild(ta);
  
  requestAnimationFrame(()=>{
    autoSizeEditTextarea(ta);
    // 先把容器滾到該訊息上緣，再聚焦，避免瀏覽器把焦點推到底
    const top = wrap.offsetTop - 12; // 12px padding
    els.chatMessages.scrollTo({ top, behavior:'instant' in Element.prototype ? 'instant' : 'auto' });
    ta.focus({ preventScroll:true });
    const len=ta.value.length;
    ta.setSelectionRange(len,len);
    // 還原滾動位置（兩次 rAF 確保佈局完成）
    requestAnimationFrame(()=>{ els.chatMessages.scrollTop = prevScroll; });
  });
  ta.addEventListener('input',()=>autoSizeEditTextarea(ta));
  
  // 監聽圖片上傳，更新預覽（在編輯模式下）
  let isEditingMode = true;
  const editImageUploadHandler = async (e) => {
    if (!isEditingMode) {
      // 如果不在編輯模式，使用原有處理（不應該發生）
      return;
    }
    
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      for(const file of files){
        if(!file.type.startsWith('image/')){
          continue;
        }
        if(file.size > 5 * 1024 * 1024){
          showAlert(sp_tpl('imageUploadTooLarge',{name:file.name}));
          continue;
        }
        try{
          const base64 = await fileToBase64(file);
          uploadedImages.push({
            data: base64,
            type: file.type,
            name: file.name
          });
        }catch(err){
          console.error('圖片轉換失敗:', err);
          showAlert(sp_tpl('imageUploadFailed',{name:file.name}));
        }
      }
      e.target.value = '';
      // 更新編輯區域的圖片預覽
      updateEditImagePreview();
    }
  };
  
  // 暫時替換處理函數（編輯模式）
  if (els.imageFileInput) {
    els.imageFileInput.removeEventListener('change', handleImageUpload);
    els.imageFileInput.addEventListener('change', editImageUploadHandler);
  }
  
  // 添加鍵盤事件：Enter 發送，Shift+Enter 換行，Escape 取消
  ta.addEventListener('keydown', async (e) => {
    if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      const v = ta.value.trim();
      if(!v && !uploadedImages.length) return;
      autoFollow = prevAutoFollow;
      await submitEditedUserMessage(msg, v, uploadedImages);
    } else if(e.key === 'Escape'){
      e.preventDefault();
      isEditingMode = false;
      // 恢復原有的圖片處理函數
      if (els.imageFileInput) {
        els.imageFileInput.removeEventListener('change', editImageUploadHandler);
        els.imageFileInput.addEventListener('change', handleImageUpload);
      }
      uploadedImages = []; // 清空編輯時的圖片
      autoFollow = prevAutoFollow;
      renderAllMessages();
    }
  });
  
  const row=document.createElement('div');
  row.className='message-edit-actions';
  
  // 將圖片上傳按鈕添加到行的左側
  row.appendChild(uploadBtn);
  
  // 添加一個分隔符（flex spacer）來推動按鈕到右側
  const spacer = document.createElement('div');
  spacer.style.cssText = 'flex: 1;';
  row.appendChild(spacer);
  
  const send=document.createElement('button');
  send.textContent=sp_t('saveEdit');
  send.type='button';
  send.className='message-edit-btn primary';
  const cancel=document.createElement('button');
  cancel.textContent=sp_t('cancel');
  cancel.type='button';
  cancel.className='message-edit-btn secondary';
  send.addEventListener('click',async()=>{
    const v=ta.value.trim();
    if(!v && !uploadedImages.length) return;
    isEditingMode = false;
    autoFollow = prevAutoFollow; // 恢復自動跟隨
    // 恢復原有的圖片處理函數
    if (els.imageFileInput) {
      els.imageFileInput.removeEventListener('change', editImageUploadHandler);
      els.imageFileInput.addEventListener('change', handleImageUpload);
    }
    await submitEditedUserMessage(msg, v, uploadedImages);
  });
  cancel.addEventListener('click',()=>{ 
    isEditingMode = false;
    // 恢復原有的圖片處理函數
    if (els.imageFileInput) {
      els.imageFileInput.removeEventListener('change', editImageUploadHandler);
      els.imageFileInput.addEventListener('change', handleImageUpload);
    }
    uploadedImages = []; // 清空編輯時的圖片
    autoFollow = prevAutoFollow; 
    renderAllMessages(); 
  });
  row.appendChild(cancel);
  row.appendChild(send);
  contentEl.appendChild(row);
}
async function submitEditedUserMessage(msg, newContent, editedImages = []){
  if(streaming){
    await showAlert(sp_t('streamingEditWarning'));
    return;
  }
  const session=getCurrentSession(); if(!session) return;
  const idx=session.messages.findIndex(m=>m.ts===msg.ts);
  if(idx===-1) return;

  const target=session.messages[idx];
  if(!target || target.role!=='user') return;
  const now=Date.now();
  
  // 構建更新後的消息：支持文本和圖片
  const updatedMessage = { ...target, ts:now };
  
  if (editedImages && editedImages.length > 0) {
    // 有圖片：使用多模態格式
    const content = [];
    if (newContent && newContent.trim()) {
      content.push({ type: 'text', text: newContent });
    }
    editedImages.forEach(img => {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.type};base64,${img.data}`
        }
      });
    });
    updatedMessage.content = content;
    updatedMessage.images = editedImages.map(img => ({
      data: img.data,
      type: img.type,
      name: img.name
    }));
  } else {
    // 純文本
    updatedMessage.content = newContent;
    // 如果原有圖片但編輯時刪除了，也要清除 images 字段
    delete updatedMessage.images;
  }
  
  session.messages[idx] = updatedMessage;
  if(idx < session.messages.length-1){
    session.messages=session.messages.slice(0, idx+1);
  }
  persistSessions();
  renderAllMessages();
  
  // 清空編輯時的圖片
  uploadedImages = [];

  const ts=Date.now();
  appendMessage({ role:'assistant', content:'', ts, _streaming:true });
  streaming=true; setSendButtonState(); renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
  try{
    await streamChatCompletion(ts);
  }catch(e){
    const errHtml = escapeHtml('（錯誤）'+formatErrorMessage(e));
    replaceMessageContent(ts, errHtml);
    // Add inline retry button to the error message
    setTimeout(()=>{
      const node = els.chatMessages?.querySelector(`.message[data-ts="${ts}"] .message-content`);
      if(node && !node.querySelector('.inline-retry-btn')){
        const retryBtn = document.createElement('button');
        retryBtn.className = 'inline-retry-btn';
        retryBtn.textContent = sp_t('retry');
        retryBtn.addEventListener('click', ()=>{
          const msg = getCurrentSession()?.messages.find(m=>m.ts===ts);
          if(msg) retryAssistant(msg);
        });
        node.appendChild(retryBtn);
      }
    }, 0);
  }finally{
    streaming=false; finalizeStreamingMessage(ts); setSendButtonState();
    resetComposerIfEmpty();
  }
}
async function retryAssistant(msg){
  if(streaming){ await showAlert(sp_t('streamingStopWarning')); return; }
  const session=getCurrentSession(); if(!session)return;
  const idx=session.messages.findIndex(m=>m.ts===msg.ts);
  if(idx===-1)return;
  session.messages.splice(idx,1);
  persistSessions(); renderAllMessages();
  const ts=Date.now();
  const streamingMsg = { role:'assistant', content:'', ts, _streaming:true };
  session.messages.push(streamingMsg);
  persistSessions();
  els.chatMessages.appendChild(renderMessage(streamingMsg));
  updateWelcomeVisibility();
  streaming=true; setSendButtonState();
  try{
    await streamChatCompletion(ts);
  }catch(e){
    replaceMessageContent(ts,'（重試失敗）'+formatErrorMessage(e));
  }finally{
    streaming=false; finalizeStreamingMessage(ts); setSendButtonState();
  }
}

// 語音合成朗讀功能
let currentSpeech = null;
let currentSpeakButton = null;
let _ttsVoicesReady = false;
const SPEAK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" fill="currentColor"/></svg>`;

if(window.speechSynthesis){
  window.speechSynthesis.cancel();
  if(window.speechSynthesis.getVoices().length > 0) _ttsVoicesReady = true;
}

function _ensureVoices(){
  return new Promise(resolve=>{
    if(_ttsVoicesReady || !window.speechSynthesis) { resolve(); return; }
    const voices = window.speechSynthesis.getVoices();
    if(voices.length > 0){ _ttsVoicesReady = true; resolve(); return; }
    const timer = setTimeout(()=>{ _ttsVoicesReady = true; resolve(); }, 800);
    window.speechSynthesis.onvoiceschanged = ()=>{
      clearTimeout(timer);
      _ttsVoicesReady = true;
      resolve();
    };
  });
}

// 朗讀前：去除思路區塊、HTML 標籤、符號與 emoji
function sanitizeSpeakText(src=''){
  if(!src) return '';
  let t = String(src)
    .replace(/&lt;think&gt;/gi, '<think>').replace(/&lt;\/think&gt;/gi, '</think>')
    .replace(/&lt;thinking&gt;/gi, '<thinking>').replace(/&lt;\/thinking&gt;/gi, '</thinking>')
    .replace(/&lt;thought&gt;/gi, '<thought>').replace(/&lt;\/thought&gt;/gi, '</thought>');
  t = t.replace(/<(think|thinking|thought)>[\s\S]*?(?:<\/\1>|$)/gi, '');
  t = t.replace(/<[^>]+>/g, '');
  // Markdown: headings, bold, italic, code blocks, inline code, links, images, lists
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2');
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/^[\s]*[-*+]\s+/gm, '');
  t = t.replace(/^[\s]*\d+\.\s+/gm, '');
  t = t.replace(/^>\s+/gm, '');
  t = t.replace(/\|/g, ' ');
  t = t.replace(/^[-=]{3,}$/gm, '');
  // Emoji (all Unicode emoji ranges)
  t = t.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
  t = t.replace(/[\u{1F300}-\u{1F5FF}]/gu, '');
  t = t.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');
  t = t.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '');
  t = t.replace(/[\u{2600}-\u{26FF}]/gu, '');
  t = t.replace(/[\u{2700}-\u{27BF}]/gu, '');
  t = t.replace(/[\u{FE00}-\u{FE0F}]/gu, '');
  t = t.replace(/[\u{1F900}-\u{1F9FF}]/gu, '');
  t = t.replace(/[\u{1FA00}-\u{1FA6F}]/gu, '');
  t = t.replace(/[\u{1FA70}-\u{1FAFF}]/gu, '');
  t = t.replace(/[\u{200D}\u{20E3}\u{FE0F}]/gu, '');
  t = t.replace(/[\u{E0020}-\u{E007F}]/gu, '');
  // Decorative symbols that don't add meaning when read aloud
  t = t.replace(/[★☆✦✧✨✩✪✫✬✭✮✯✰⭐💡🔑📌📎🎯🎨💎⚡🔥❓❗❕❔✅❌⬆⬇⬅➡→←↑↓▲△▼▽◆◇○●◎■□▪▫☑☐•·※✓✗✘≈≠≤≥±÷×∞∴∵∈∉⊂⊃∩∪]+/gu, '');
  // HTML entities
  t = t.replace(/&[a-z]+;/gi, ' ');
  // Collapse extra whitespace
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function autoWrapThinkingContent(raw='', ctx={}){
  if(!raw) return '';
  let text = String(raw);
  
  // 已經有非空思考標籤就直接返回
  const existingThinkMatch = text.match(/<(think|thinking|thought)>([\s\S]*?)<\/\1>/i);
  if(existingThinkMatch && existingThinkMatch[2]?.trim()){
    return text;
  }
  
  // 移除空的思考標籤
  text = text.replace(/<(think|thinking|thought)>\s*<\/\1>/gi, '').trim();
  if(!text) return raw;
  
  const { model, modelProvider } = ctx;
  const thinkCap = getThinkingCapability(model, modelProvider);
  const thinkingActive = thinkCap === 'always_on' || thinkCap === 'toggleable';
  if(!thinkingActive){
    return text;
  }
  
  const clean = text.replace(/\r\n?/g,'\n');
  
  const firstCJK = clean.search(/[\u4e00-\u9fff]/);
  const firstEmoji = clean.search(/[\u{1F300}-\u{1FAFF}]/u);
  const firstJapanese = clean.search(/[\u3040-\u30ff]/);
  const firstKorean = clean.search(/[\uac00-\ud7af]/);
  
  let boundary = -1;
  for(const idx of [firstCJK, firstEmoji, firstJapanese, firstKorean]){
    if(idx >= 0){
      boundary = boundary === -1 ? idx : Math.min(boundary, idx);
    }
  }
  if(boundary <= 0){
    return text;
  }
  
  // 將分界點往前回溯到前一個換行，避免切半句
  const beforeBoundary = clean.slice(0, boundary);
  const lastNewline = beforeBoundary.lastIndexOf('\n');
  let splitIndex = boundary;
  if(lastNewline >= 0 && boundary - lastNewline <= 120){
    splitIndex = lastNewline;
  }
  
  const reasoningText = clean.slice(0, splitIndex).trim();
  const answerText = clean.slice(splitIndex).trim();
  
  if(!reasoningText || !answerText) return text;
  
  const asciiCount = reasoningText.replace(/[^\x00-\x7F]/g,'').length;
  const asciiRatio = reasoningText.length ? asciiCount / reasoningText.length : 0;
  const hasThinkingKeyword = /(思考|思路|推理|推論|分析|分析過程|解題思路)/.test(reasoningText.slice(0, 80));
  if(asciiRatio < 0.6 && !hasThinkingKeyword){
    return text;
  }
  
  if(reasoningText.length < 20){
    return text;
  }
  
  console.log('[autoWrapThinkingContent] Wrapped reasoning content', {
    model,
    reasoningPreview: reasoningText.slice(0, 120),
    answerPreview: answerText.slice(0, 120)
  });
  
  return `<think>${reasoningText}</think>\n${answerText}`;
}

function balanceThinkingTags(src=''){
  if(!src) return '';
  let output = String(src);
  const tagNames = ['think','thinking','thought'];
  for(const tag of tagNames){
    const openRe = new RegExp(`<${tag}>`, 'gi');
    const closeRe = new RegExp(`</${tag}>`, 'gi');
    const openCount = (output.match(openRe) || []).length;
    const closeCount = (output.match(closeRe) || []).length;
    if(openCount > closeCount){
      output += `</${tag}>`.repeat(openCount - closeCount);
    }
  }
  return output;
}

function _extractTextContent(content){
  if(!content) return '';
  if(typeof content === 'string') return content;
  if(Array.isArray(content)){
    return content
      .filter(p => p && p.type === 'text')
      .map(p => String(p.text ?? ''))
      .join('');
  }
  return String(content);
}

async function speakMessage(msg, btnEl){
  // 如果正在朗讀，則停止
  if(currentSpeech || (window.speechSynthesis && window.speechSynthesis.speaking)){
    window.speechSynthesis.cancel();
    currentSpeech = null;
    if(currentSpeakButton){
      currentSpeakButton.innerHTML = SPEAK_ICON;
      currentSpeakButton.title = sp_t('readAloud');
      currentSpeakButton.setAttribute('aria-label', sp_t('readAloud'));
    }
    currentSpeakButton = null;
    console.log('[speak] Stopped current speech');
    return;
  }

  if(!window.speechSynthesis){
    showAlert(sp_t('ttsNotSupported'));
    return;
  }

  const original = _extractTextContent(msg.content);
  const zhPref = (awaitGetZhVariant.cached) ?? _defaultLang();
  const stripped = sanitizeSpeakText(original);
  const text = (typeof window.__zhConvert==='function' && zhPref)
    ? __zhConvert(stripped, zhPref)
    : stripped;
  if(!text.trim()){
    console.warn('[speak] No content to speak');
    return;
  }

  await _ensureVoices();

  const ttsSettings = await new Promise(r =>
    chrome.storage.sync.get(['ttsVoice','ttsRate','ttsPitch'], d => r(d))
  );

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = parseFloat(ttsSettings.ttsRate) || 1.0;
  utterance.pitch = parseFloat(ttsSettings.ttsPitch) || 1.0;
  utterance.volume = 1.0;

  const voices = window.speechSynthesis.getVoices();
  let selectedVoice = null;
  if(ttsSettings.ttsVoice){
    selectedVoice = voices.find(v => v.voiceURI === ttsSettings.ttsVoice);
  }
  if(!selectedVoice){
    selectedVoice = voices.find(voice =>
      voice.lang.includes('zh') ||
      voice.lang.includes('CN') ||
      voice.lang.includes('TW') ||
      voice.lang.includes('HK')
    );
  }
  if(selectedVoice){
    utterance.voice = selectedVoice;
    console.log('[speak] Using voice:', selectedVoice.name);
  }

  utterance.onstart = () => {
    console.log('[speak] Started speaking');
    if(btnEl){
      btnEl.innerHTML = STOP_ICON;
      btnEl.title = sp_t('stopReading');
      btnEl.setAttribute('aria-label', sp_t('stopReading'));
      currentSpeakButton = btnEl;
    }
  };

  utterance.onend = () => {
    console.log('[speak] Finished speaking');
    currentSpeech = null;
    if(currentSpeakButton){
      currentSpeakButton.innerHTML = SPEAK_ICON;
      currentSpeakButton.title = sp_t('readAloud');
      currentSpeakButton.setAttribute('aria-label', sp_t('readAloud'));
    }
    currentSpeakButton = null;
  };

  utterance.onerror = (event) => {
    console.error('[speak] Speech error:', event.error);
    currentSpeech = null;
    if(currentSpeakButton){
      currentSpeakButton.innerHTML = SPEAK_ICON;
      currentSpeakButton.title = sp_t('readAloud');
      currentSpeakButton.setAttribute('aria-label', sp_t('readAloud'));
    }
    currentSpeakButton = null;
  };

  currentSpeech = utterance;
  window.speechSynthesis.speak(utterance);
  console.log('[speak] Speaking:', text.slice(0, 50) + '...');
}

// 顯示頁面內容查看模態框
function showPageContextModal(msgOrMsgs){
  // 支持單個消息或消息數組
  const messages = Array.isArray(msgOrMsgs) ? msgOrMsgs : [msgOrMsgs];
  
  // 數字轉英文
  const numberToEnglish = (num) => {
    const english = ['one', 'two', 'three', 'four', 'five'];
    return english[num - 1] || num.toString();
  };
  
  // 合併所有頁面內容，添加清晰的頁面標識
  const allContent = messages.map((m, index) => {
    const pageNum = numberToEnglish(index + 1);
    const title = m.pageTitle || sp_t('untitledPage');
    const url = m.pageUrl || '';
    const domain = url ? new URL(url).hostname : '';
    const length = (m.content || '').length;
    
    const header = `\n${'═'.repeat(60)}\n` +
                   `📄 Page ${pageNum}: ${title}\n` +
                   `🔗 ${domain}\n` +
                   `📊 ${(length / 1000).toFixed(1)}k characters\n` +
                   `${'═'.repeat(60)}\n\n`;
    
    return header + (m.content || '');
  }).join('\n\n');
  
  const totalLength = allContent.length;
  const tokens = estimateTokens(allContent);
  
  // 檢查是否有警告
  const hasWarning = messages.some(m => m.bodyTruncated || m.isLikelyIncomplete);
  
  const warningHtml = hasWarning ? `
    <div class="page-context-warning">${sp_t('virtualScrollWarning')}</div>
  ` : '';
  
  // 構建頁面來源信息
  let sourceHtml = '';
  if(messages.length === 1){
    const msg = messages[0];
    sourceHtml = msg.pageUrl ? `<span>Source: ${msg.pageTitle || new URL(msg.pageUrl).hostname}</span>` : '';
  } else {
    sourceHtml = `<span>Source: ${messages.length} pages</span>`;
  }
  
  // 創建模態框
  const modal=document.createElement('div');
  modal.className='page-context-modal';
  modal.innerHTML=`
    <div class="page-context-modal-overlay"></div>
    <div class="page-context-modal-content">
      <div class="page-context-modal-header">
        <h3>${sp_t('capturedPageContent')}</h3>
        <button class="page-context-modal-close" type="button" aria-label="${sp_t('close')}">✕</button>
      </div>
      <div class="page-context-modal-body">
        ${warningHtml}
        <div class="page-context-stats">
          <span>Characters: ${totalLength}</span>
          <span>Tokens: ~${tokens}</span>
          ${sourceHtml}
        </div>
        <pre class="page-context-raw">${escapeHtml(allContent)}</pre>
      </div>
      <div class="page-context-modal-footer">
        <button class="btn-copy-context" type="button">${sp_t('copyContent')}</button>
        <button class="btn-close-modal" type="button">${sp_t('close')}</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // 事件處理
  const closeModal=()=>modal.remove();
  modal.querySelector('.page-context-modal-overlay').addEventListener('click', closeModal);
  modal.querySelector('.page-context-modal-close').addEventListener('click', closeModal);
  modal.querySelector('.btn-close-modal').addEventListener('click', closeModal);
  modal.querySelector('.btn-copy-context').addEventListener('click', ()=>{
    navigator.clipboard.writeText(allContent);
    const btn=modal.querySelector('.btn-copy-context');
    btn.textContent=sp_t('copied');
    setTimeout(()=>btn.textContent=sp_t('copyContent'), 1500);
  });
  
  // ESC 鍵關閉
  const handleEsc=(e)=>{
    if(e.key==='Escape'){
      closeModal();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);
}

// 顯示搜尋結果來源模態框
function showWebSearchModal(results, query){
  if(!results || !results.length) return;

  const modal = document.createElement('div');
  modal.className = 'page-context-modal'; // reuse same modal style

  const resultCards = results.map((r, i) => {
    const domain = r.url ? (() => { try { return new URL(r.url).hostname; } catch { return ''; } })() : '';
    return `
      <div class="web-search-result-card">
        <div class="web-search-result-num">${i + 1}</div>
        <div class="web-search-result-body">
          <div class="web-search-result-title">${escapeHtml(r.title)}</div>
          ${domain ? `<a class="web-search-result-url" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>` : ''}
          ${r.snippet ? `<div class="web-search-result-snippet">${escapeHtml(r.snippet)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  modal.innerHTML = `
    <div class="page-context-modal-overlay"></div>
    <div class="page-context-modal-content">
      <div class="page-context-modal-header">
        <h3>🔍 ${sp_t('searchSources') || '搜尋來源'}</h3>
        <button class="page-context-modal-close" type="button" aria-label="${sp_t('close')}">✕</button>
      </div>
      <div class="page-context-modal-body">
        <div class="page-context-stats">
          <span>${sp_t('searchQuery') || '搜尋'}: ${escapeHtml(query || '')}</span>
          <span>${results.length} ${sp_t('webSearchResultCount') || '筆結果'}</span>
        </div>
        <div class="web-search-results-list">
          ${resultCards}
        </div>
      </div>
      <div class="page-context-modal-footer">
        <button class="btn-close-modal" type="button">${sp_t('close')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  modal.querySelector('.page-context-modal-overlay').addEventListener('click', closeModal);
  modal.querySelector('.page-context-modal-close').addEventListener('click', closeModal);
  modal.querySelector('.btn-close-modal').addEventListener('click', closeModal);

  // Click on URL opens in new tab
  modal.querySelectorAll('.web-search-result-url').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: a.href });
    });
  });

  const handleEsc = (e) => {
    if(e.key === 'Escape'){
      closeModal();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);
}

function appendMessage(msg){
  const session=getCurrentSession(); if(!session)return;
  
  // 調試：記錄添加的訊息
  console.log('[appendMessage] Adding message:', {
    role: msg.role,
    contentLength: (msg.content||'').length,
    ts: msg.ts,
    streaming: msg._streaming
  });
  
  session.messages.push(msg); persistSessions();
  if(msg.role==='system' && !SHOW_SYSTEM_PROMPT_BUBBLE && !msg._pageContext) return;
  els.chatMessages.appendChild(renderMessage(msg));
  
  // 更新歡迎區和卡通的顯示狀態（通過添加/移除 chatting 類和滾動）
  updateWelcomeVisibility();
  
  // 對於後續消息（已經有對話），正常滾動到底部
  const hasOtherMessages = session.messages.some(m => 
    m !== msg && (m.role === 'user' || m.role === 'assistant') && !m._pageContext
  );
  
  if (!hasOtherMessages && (msg.role === 'user' || msg.role === 'assistant') && !msg._pageContext) {
    // 這是第一條消息，標記並禁用自動滾動
    isFirstMessage = true;
    autoFollow = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (els.chatRegion) {
          els.chatRegion.scrollTop = 0;
        }
      });
    });
  } else {
    isFirstMessage = false;
    if(msg.role === 'assistant' && msg._streaming) {
      currentStreamingMessageTs = msg.ts;
      autoFollow = true;
      const scroller = getScrollContainer();
      if(scroller) lastScrollPosition = scroller.scrollTop;
    }
  }
  // 新訊息加入後立即更新按鈕顯示狀態
  requestAnimationFrame(()=> updateScrollBtnVisibility());
}

function purgeOldPageContextMessages(){
  // 此函數已不再自動刪除舊的頁面上下文
  // 現在只在用戶主動移除時才會刪除
  // 數量限制在 handlePageContextToggle 中檢查
}

/* ================= Image Upload ================= */
// 處理剪貼板粘貼（支持圖片）
async function handlePaste(e){
  const items = e.clipboardData?.items;
  if(!items) return;

  let hasImage = false;
  for(const item of items){
    if(item.type.startsWith('image/')){
      hasImage = true;
      e.preventDefault(); // 防止粘貼圖片的默認行為
      
      const file = item.getAsFile();
      if(!file) continue;

      // 檢查文件大小（靜默跳過）
      if(file.size > 5 * 1024 * 1024){
        console.warn('[paste] Image too large, skipped:', file.size);
        continue;
      }

      try{
        const base64 = await fileToBase64(file);
        uploadedImages.push({
          data: base64,
          type: file.type,
          name: `pasted-image-${Date.now()}.${file.type.split('/')[1]}`
        });
      }catch(err){
        console.error('圖片轉換失敗:', err);
        showAlert(sp_t('pasteFailed'));
      }
    }
  }

  if(hasImage){
    renderImagePreviews();
    updateTextareaLayout();
    updateSendButtonState(); // 更新發送按鈕狀態
  }
}

// 支持視覺功能的模型列表
function isVisionModel(modelName){
  if(!modelName) return false;
  const model = modelName.toLowerCase();
  
  // GPT-4 Vision 系列
  if(model.includes('gpt-4') && (model.includes('vision') || model.includes('gpt-4o') || model.includes('gpt-4-turbo'))){
    return true;
  }
  // GPT-4o 系列
  if(model.includes('gpt-4o')){
    return true;
  }
  // Gemini 2.0+ 系列（都支持視覺）
  if(model.includes('gemini-2') || model.includes('gemini-1.5')){
    return true;
  }
  // Claude 3 系列
  if(model.includes('claude-3')){
    return true;
  }
  // Qwen VL 系列
  if(model.includes('qwen') && model.includes('vl')){
    return true;
  }
  
  return false;
}

async function handleImageUpload(e){
  const files = Array.from(e.target.files || []);
  if(!files.length) return;

  // 檢查當前模型是否支持視覺
  const currentModel = els.modelSelector?.value;
  if(currentModel && !isVisionModel(currentModel)){
    const confirmUpload = await showConfirm(
      `⚠️ 當前模型「${currentModel}」可能不支持圖片輸入。\n\n建議切換到支持視覺的模型：\n• GPT-4o / GPT-4o-mini\n• Gemini 2.5 Pro / Flash\n• Claude 3 系列\n\n是否仍要上傳圖片？`
    );
    if(!confirmUpload){
      e.target.value = '';
      return;
    }
  }

  for(const file of files){
    if(!file.type.startsWith('image/')){
      showAlert(sp_t('selectImageFile'));
      continue;
    }

    // 限制文件大小（例如 5MB）
    if(file.size > 5 * 1024 * 1024){
      showAlert(sp_tpl('imageUploadTooLarge',{name:file.name}));
      continue;
    }

    try{
      const base64 = await fileToBase64(file);
      uploadedImages.push({
        data: base64,
        type: file.type,
        name: file.name
      });
    }catch(err){
      console.error('圖片轉換失敗:', err);
      showAlert(sp_tpl('imageUploadFailed',{name:file.name}));
    }
  }

  // 清空 input 以允許重複選擇同一文件
  e.target.value = '';
  
  renderImagePreviews();
  updateTextareaLayout();
  updateSendButtonState(); // 更新發送按鈕狀態，允許直接發送圖片
}

function fileToBase64(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result.split(',')[1]); // 只保留 base64 部分
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderImagePreviews(){
  if(!uploadedImages.length){
    els.imagePreviewContainer.style.display = 'none';
    els.imagePreviewContainer.innerHTML = '';
    return;
  }

  els.imagePreviewContainer.style.display = 'flex';
  els.imagePreviewContainer.innerHTML = '';

  uploadedImages.forEach((img, index)=>{
    const item = document.createElement('div');
    item.className = 'image-preview-item';
    
    const imgEl = document.createElement('img');
    imgEl.src = `data:${img.type};base64,${img.data}`;
    imgEl.alt = img.name;
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-preview-remove';
    removeBtn.textContent = '×';
    removeBtn.onclick = ()=> removeImage(index);
    
    item.appendChild(imgEl);
    item.appendChild(removeBtn);
    els.imagePreviewContainer.appendChild(item);
  });
}

function removeImage(index){
  uploadedImages.splice(index, 1);
  renderImagePreviews();
  updateTextareaLayout();
  updateSendButtonState(); // 更新發送按鈕狀態
}

function updateTextareaLayout(){
  // 不需要額外處理，padding 已經固定
}

function clearUploadedImages(){
  // 檢查是否在編輯模式下（通過查找編輯中的消息）
  const editingMessage = els.chatMessages?.querySelector('.message.editing');
  if (editingMessage) {
    console.log('[SP] clearUploadedImages - skip because editing mode');
    return; // 編輯模式下不清空
  }
  uploadedImages = [];
  renderImagePreviews();
}

/* ================= Send / Stream ================= */
async function onSend(){
  console.log('[SP] onSend() called');
  if(streaming) {
    console.log('[SP] Already streaming, return');
    return;
  }
  const text=els.messageInput.value.trim();
  console.log('[SP] Input text:', text);
  
  // 檢查是否有內容可發送（文字、圖片或頁面內容）
  const session=getCurrentSession();
  // 只檢查等待使用的頁面內容（而不是所有歷史頁面內容）
  const hasPendingPageContent = session ? session.messages.some(m => m._pendingPageContext) : false;
  
  if(!text && !uploadedImages.length && !hasPendingPageContent) {
    console.log('[SP] Empty text, no images, and no pending page content, return');
    return;
  }
  
  if(!session){
    console.log('[SP] No session, return');
    return;
  }
  console.log('[SP] Session OK, proceeding...');

  // 設定會話標題
  if(session.title==='新對話'){
    if(text){
      session.title = text.slice(0,16);
    } else if(uploadedImages.length > 0){
      session.title = '圖片'; // sentinel translated at render time
    } else if(hasPendingPageContent){
      session.title = '頁面內容'; // sentinel translated at render time
    } else {
      session.title = '新對話'; // sentinel translated at render time
    }
  }
  
  // 構建用戶消息：支持純文本或文本+圖片
  const userMessage = {
    role:'user',
    ts:Date.now()
  };
  
  // 只有在有等待使用的頁面內容時，才標記此訊息
  if(hasPendingPageContent){
    userMessage._hasPageContext = true;
    
    // 將所有等待中的頁面內容標記為已使用
    session.messages.forEach(m => {
      if(m._pendingPageContext){
        delete m._pendingPageContext; // 移除等待標記
      }
    });
    persistSessions(); // 保存更改
  }

  // 當沒有輸入文字時，用戶訊息保持空白（只顯示標籤）
  // 頁面內容會保留為 system 消息，在 API 調用時一起發送
  let finalText = text;

  // 如果有圖片，使用多模態格式
  if(uploadedImages.length > 0){
    const content = [];
    if(finalText){
      content.push({ type: 'text', text: finalText });
    }
    uploadedImages.forEach(img=>{
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.type};base64,${img.data}`
        }
      });
    });
    userMessage.content = content;
    userMessage.images = uploadedImages.map(img => ({
      data: img.data,
      type: img.type,
      name: img.name
    }));
  } else {
    // 純文本消息（可能是空的）
    userMessage.content = finalText || '';
  }

  appendMessage(userMessage);

  jumpToComposer();

  els.messageInput.value='';
  clearUploadedImages(); // 清空上傳的圖片
  
  hidePageContentPreview(); // 隱藏頁面內容預覽卡片
  autoGrow(els.messageInput,{force:true});
  updateSendButtonState();
  setInputEngagedState();
  updateCharCount();

  const ts=Date.now();
  appendMessage({ role:'assistant', content:'', ts, _streaming:true });
  streaming=true; setSendButtonState(); renderSuggestionsIfNeeded().catch(err => console.warn('[SP] renderSuggestionsIfNeeded failed:', err));
  startStreamingScroll();
  console.log('[SP] Starting stream...');
  try{
    await streamChatCompletion(ts);
  }catch(e){
    console.error('[SP] Stream error:', e);
    replaceMessageContent(ts,'（錯誤）'+formatErrorMessage(e));
  }finally{
    stopStreamingScroll();
    streaming=false; finalizeStreamingMessage(ts); setSendButtonState();
    resetComposerIfEmpty();
  }
}

function updateSendButtonState(){
  const hasText = !!els.messageInput.value.trim();
  const hasImages = uploadedImages.length > 0;
  
  // 檢查當前會話是否有頁面內容
  const session = getCurrentSession();
  const hasPageContent = session ? session.messages.some(m => m._pageContext) : false;
  
  // 有文字、圖片或頁面內容其中之一，就可以發送
  const canSend = hasText || hasImages || hasPageContent;
  
  els.sendButton.disabled = !canSend && !streaming;
  els.sendButton.classList.toggle('enabled', canSend || streaming);
}

// 估算 token 數
function estimateTokens(text){
  if(!text) return 0;
  // 簡單估算：中文字符 ~1.5 token，英文單詞 ~1.3 token，數字/符號 ~1 token
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.3);
}

function updateCharCount(){
  if(!els.charCount) return;
  const text = els.messageInput.value || '';
  const tokens = estimateTokens(text);
  
  if(tokens === 0){
    els.charCount.textContent = '';
    els.charCount.classList.remove('warning');
  }else{
    els.charCount.textContent = `~${tokens} tokens`;
    // 當 token 數超過 15000 時顯示警告
    els.charCount.classList.toggle('warning', tokens > 15000);
  }
}
function setSendButtonState(){
  if(streaming){
    els.sendButton.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
    setButtonTooltip(els.sendButton,sp_t('stopGenerate'));
    els.sendButton.setAttribute('aria-label',sp_t('stopGenerate'));
    els.sendButton.disabled=false;
    els.sendButton.classList.add('enabled');
  }else{
    els.sendButton.innerHTML=`<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
    setButtonTooltip(els.sendButton,sp_t('send'));
    els.sendButton.setAttribute('aria-label',sp_t('send'));
    updateSendButtonState();
  }
}
function stopStreaming(){
  if(streamAbortController) streamAbortController.abort();
  streaming=false;
  setSendButtonState();
  resetComposerIfEmpty();
}

/* buildChatCompletionsUrl now in js/utils.js */

/* Host Permission (optional) */
async function guardHostPermission(apiEndpoint){
  if(!ENFORCE_HOST_PERMISSION) return true;
  if(!apiEndpoint) return true;
  try{
    const u=new URL(apiEndpoint.replace(/\/$/,''));
    if(/api\.openai\.com$/i.test(u.hostname)) return true;
    if(!chrome.permissions) return true;
    const pattern=`${u.protocol}//${u.host}/*`;
    const granted=await new Promise(r=>chrome.permissions.contains({ origins:[pattern] }, r));
    return granted;
  }catch{ return true; }
}

/* Streaming */
async function streamChatCompletion(assistantTs){
  console.log('[SP] streamChatCompletion() called');
  
  // Get current model and find its provider
  const model = els.modelSelector.value || 'gpt-3.5-turbo';
  const { customModels, providerConfigs } = await chrome.storage.local.get(['customModels', 'providerConfigs']);
  
  // Find which provider this model belongs to
  let modelProvider = null;
  let modelThinkingParams = undefined;
  let modelPrefixPrompt = '';
  if(Array.isArray(customModels)){
    const modelData = customModels.find(m => m.name === model);
    modelProvider = modelData?.provider;
    modelThinkingParams = modelData?.thinkingParams;
    modelPrefixPrompt = modelData?.prefixPrompt || '';
  }

  // ── OpenClaw：走 WebSocket 而非 HTTP ──
  if(modelProvider && providerConfigs?.[modelProvider]?.isOpenClaw){
    console.log('[SP] OpenClaw detected, routing to WebSocket chat');
    return streamOpenClawChat(assistantTs);
  }
  
  // Get API config for this provider
  let apiKey = '';
  let apiEndpoint = '';
  if(modelProvider && providerConfigs && providerConfigs[modelProvider]){
    apiKey = providerConfigs[modelProvider].apiKey || '';
    apiEndpoint = providerConfigs[modelProvider].baseUrl || '';
  } else {
    // Fallback to legacy storage
    const legacy = await chrome.storage.local.get(['apiKey','apiEndpoint']);
    apiKey = legacy.apiKey || '';
    apiEndpoint = legacy.apiEndpoint || '';
  }
  
  if(!apiKey) console.warn('[SP] No API key for provider:', modelProvider);
  
  streamingContexts.set(assistantTs, {
    model,
    modelProvider,
    modelThinkingParams,
    reasoningBuffer: '',
    contentBuffer: '',
    manualThinkInserted: false,
    nativeThinkDetected: false
  });

  /* 其他模型：等待回覆時僅顯示三點動效，不顯示文字 */
  showThinkingDots(assistantTs, '');

  const hasPerm=await guardHostPermission(apiEndpoint);
  if(!hasPerm) throw new Error('尚未取得 Proxy 主機權限，請在設定頁授權。');

  const session=getCurrentSession();
  
  // 過濾掉當前正在流式輸出的空 assistant 消息（避免發送到 API）
  const messages=session.messages
    .filter(m => !(m.ts === assistantTs && m._streaming && !m.content))
    .map(m => ({ role: m.role, content: m.content }));

  // ── 聯網搜尋 ──
  let userQuery = '';
  let lastUserIdx = -1;
  for(let i = messages.length - 1; i >= 0; i--){
    if(messages[i].role === 'user'){
      lastUserIdx = i;
      const c = messages[i].content;
      userQuery = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join(' ') : '');
      break;
    }
  }
  const searchCheck = shouldSearch(userQuery);
  const autoTrigger = !webSearchEnabled && searchCheck.needed && searchCheck.reason === 'explicit-search';
  const doSearch = webSearchEnabled || autoTrigger;
  const searchNeeded = doSearch && userQuery && lastUserIdx >= 0 && (webSearchEnabled || searchCheck.needed);
  const isOpenRouter = modelProvider === 'openrouter';
  // OpenRouter: use server-side :online suffix instead of client-side search
  const useOpenRouterOnline = searchNeeded && isOpenRouter;
  const useClientSearch = searchNeeded && !isOpenRouter;
  console.log('[SP] webSearchEnabled =', webSearchEnabled, '| autoTrigger =', autoTrigger,
    '| shouldSearch:', searchCheck.needed, searchCheck.reason,
    '| openrouter:', useOpenRouterOnline, '| query:', userQuery?.slice(0,60));
  if(useClientSearch){
    updateThinkingStatus(assistantTs, sp_t('webSearching'));
    try {
      const searchData = await performWebSearch(userQuery);
      console.log('[SP] Web search result:', searchData ? searchData.text.length + ' chars' : 'null');
      if(searchData){
        const today = new Date().toISOString().slice(0,10);
        // Page Assist style: override system prompt with search-focused prompt
        // Preserve original system prompt rules as secondary context
        let originalSystemPrompt = '';
        if(messages.length > 0 && messages[0].role === 'system'){
          originalSystemPrompt = typeof messages[0].content === 'string' ? messages[0].content : '';
        }
        const searchSystemContent =
          `You are a helpful AI assistant with real-time web search capability. ` +
          `Answer the user's query based on the provided search results. ` +
          `The current date is ${today}.\n\n` +
          `<search-results>\n${searchData.text}\n</search-results>\n\n` +
          `Cite sources using markdown links, e.g. [domain.com](URL). ` +
          `If the search results are insufficient, say so honestly, but never claim you cannot access the internet.` +
          (originalSystemPrompt ? `\n\n<additional-instructions>\n${originalSystemPrompt}\n</additional-instructions>` : '');
        if(messages.length > 0 && messages[0].role === 'system'){
          messages[0] = { role: 'system', content: searchSystemContent };
        } else {
          messages.unshift({ role: 'system', content: searchSystemContent });
        }
        const assistantMsg = session.messages.find(m => m.ts === assistantTs);
        if(assistantMsg){
          assistantMsg._webSearchResults = searchData.results;
          assistantMsg._webSearchQuery = searchData.query;
        }
        console.log('[SP] Web search prompt overrode system prompt | chars:', searchData.text.length);
      }
    } catch(searchErr) {
      console.error('[SP] Web search error in streamChatCompletion:', searchErr);
    }
  }

  // 若有 prefix prompt，貼在最後一條 user 訊息最前面
  if(modelPrefixPrompt){
    for(let i = messages.length - 1; i >= 0; i--){
      if(messages[i].role === 'user'){
        messages[i] = { ...messages[i], content: modelPrefixPrompt + '\n' + messages[i].content };
        break;
      }
    }
  }
  // OpenRouter :online — append suffix to model name for server-side web search
  let effectiveModel = model;
  if(useOpenRouterOnline && !model.includes(':online')){
    effectiveModel = model + ':online';
    console.log('[SP] OpenRouter online search enabled → model:', effectiveModel);
  }
  console.log('[SP] stream → msgs:', messages.length, 'model:', effectiveModel, 'provider:', modelProvider || '?');
  
  const base=(apiEndpoint?.trim()||'https://api.openai.com/v1').replace(/\/+$/,'');
  const url=buildChatCompletionsUrl(base);
  const requestBody = {
    model: effectiveModel,
    messages,
    temperature:STREAM_TEMPERATURE,
    stream:true,
    // DeepSeek reasoner: force text format
    ...(model.toLowerCase().includes('reasoner') ? { response_format: { type: 'text' } } : {}),
  };

  if(modelThinkingParams){
    // 用戶填了自定義參數 → 直接 merge（例如 {"enable_thinking": false} 關閉思考）
    try{
      Object.assign(requestBody, JSON.parse(modelThinkingParams));
    }catch(e){
      console.warn('[SP] invalid thinkingParams JSON, ignored:', modelThinkingParams);
    }
  } else {
    // 用戶沒填 → 自動開啟思考（針對支援的模型）
    const m = model.toLowerCase();
    if(/qwen/.test(m) && !/reasoner/.test(m)){
      requestBody.enable_thinking = true;
    } else if(/gemini-2\.5/.test(m)){
      requestBody.thinkingConfig = { thinkingBudget: 8000 };
    } else if(/claude/.test(m)){
      requestBody.thinking = { type: 'enabled', budget_tokens: 10000 };
      requestBody.temperature = 1;
    } else if(/kimi|moonshot/.test(m)){
      requestBody.thinking = { type: 'enabled' };
    }
    // deepseek-reasoner / o1 / o3：內建思考，不需帶參數
  }

  streamAbortController=new AbortController();
  let resp;
  try{
    resp=await fetch(url,{
      method:'POST',
      headers: Object.assign({
        'Content-Type':'application/json'
      }, apiKey?{ 'Authorization':'Bearer '+apiKey }:null),
      body:JSON.stringify(requestBody),
      signal:streamAbortController.signal
    });
    console.log('[SP] Fetch response status:', resp.status);
  }catch(e){
    console.error('[SP] Fetch error:', e);
    hideThinkingDots(assistantTs);
    throw new Error('連線失敗：'+e.message);
  }

  if(!resp.ok){
    const t=await resp.text();
    console.error('[SP] HTTP error:', resp.status, t.slice(0,200));
    hideThinkingDots(assistantTs);
    throw new Error(`HTTP ${resp.status} ${t.slice(0,200)}`);
  }

  console.log('[SP] Starting to read stream...');
  const reader=resp.body.getReader();
  const decoder=new TextDecoder('utf-8');
  let buffer='', full='';
  let manualThinkOpened=false;
  let manualThinkClosed=false;
  let chunkCount = 0;
  let hasReasoningContent = false;
  let thinkingDotsHidden = false;
  let lastLogTime = Date.now();
  const LOG_INTERVAL = 5000; // 每 5 秒記錄一次進度
  const orAnnotations = []; // OpenRouter web search annotations
  while(true){
    const {done,value}=await reader.read();
    if(done) {
      console.log('[SP] Stream completed, total chunks:', chunkCount);
      break;
    }
    chunkCount++;
    const decoded = decoder.decode(value,{stream:true});
    // 只每 50 個 chunk 記錄一次進度，減少日誌量
    if(chunkCount % 50 === 0){
      const now = Date.now();
      if(now - lastLogTime >= LOG_INTERVAL){
        console.log(`[SP] Processing chunk ${chunkCount}...`);
        lastLogTime = now;
      }
    }
    buffer+=decoded;
    let lines=buffer.split('\n');
    buffer=lines.pop();
    for(const line of lines){
      const trimmed=line.trim();
      if(!trimmed) continue;
      if(trimmed==='data: [DONE]'){
        console.log('[SP] Received [DONE] signal');
        hideThinkingDots(assistantTs);
        if(manualThinkOpened && !manualThinkClosed){
          full+=`</think>`;
          manualThinkClosed = true;
        }
        // Store OpenRouter web search annotations for UI display
        if(orAnnotations.length > 0){
          const session = getCurrentSession();
          const assistantMsg = session?.messages?.find(m => m.ts === assistantTs);
          if(assistantMsg){
            assistantMsg._webSearchResults = orAnnotations;
            assistantMsg._webSearchQuery = userQuery || '';
            console.log('[SP] OpenRouter annotations stored:', orAnnotations.length);
          }
        }
        finalizeStreamingMessage(assistantTs);
        finalizeAssistantMessageContent(assistantTs, full);
        return;
      }
      if(!trimmed.startsWith('data:')) continue;
      try{
        const jsonStr = trimmed.slice(5).trim();
        const data=JSON.parse(jsonStr);
        const delta=data.choices?.[0]?.delta;
        
        // 處理 DeepSeek / Qwen reasoning_content 欄位
        if(delta?.reasoning_content){
          if(!thinkingDotsHidden){ hideThinkingDots(assistantTs); thinkingDotsHidden = true; }
          hasReasoningContent = true;
          const reasoningChunk = delta.reasoning_content;
          const ctx = streamingContexts.get(assistantTs);
          if(ctx){
            ctx.reasoningBuffer = (ctx.reasoningBuffer || '') + reasoningChunk;
          }
          const chunkHasThinkTag = /<\/?(think|thinking|thought)\b/i.test(reasoningChunk);
          if(chunkHasThinkTag){
            const chunkStartsWithClosing = /^\s*<\/(think|thinking|thought)\b/i.test(reasoningChunk);
            if(manualThinkOpened && !manualThinkClosed){
              if(!chunkStartsWithClosing){
                full+='</think>';
              }
              manualThinkClosed = true;
            }
            manualThinkOpened = false;
            manualThinkClosed = false;
            if(ctx){
              ctx.nativeThinkDetected = true;
            }
            full+=reasoningChunk;
          }else{
            if(!manualThinkOpened){
              console.log('[SP] ✅ Detected reasoning content stream');
              full+='<think>';
              manualThinkOpened = true;
              manualThinkClosed = false;
              if(ctx){
                ctx.manualThinkInserted = true;
              }
            }
            full+=reasoningChunk;
          }
        }
        
        // 處理普通 content
        if(delta?.content){
          if(!thinkingDotsHidden){ hideThinkingDots(assistantTs); thinkingDotsHidden = true; }
          console.log('[SP] 🔤 delta.content:', delta.content);
          const contentChunk = delta.content;
          const ctx = streamingContexts.get(assistantTs);
          if(ctx){
            ctx.contentBuffer = (ctx.contentBuffer || '') + contentChunk;
            if(/<\/?(think|thinking|thought)\b/i.test(contentChunk)){
              ctx.nativeThinkDetected = true;
            }
          }
          if(manualThinkOpened && !manualThinkClosed){
            if(/^\s*<\/(think|thinking|thought)\b/i.test(contentChunk)){
              manualThinkClosed = true;
            }else{
              full+='</think>';
              manualThinkClosed = true;
            }
          }
          full+=contentChunk;
          updateStreamingMessage(assistantTs, full);
        } else if(delta?.reasoning_content){
          if(!thinkingDotsHidden){ hideThinkingDots(assistantTs); thinkingDotsHidden = true; }
          updateStreamingMessage(assistantTs, full);
        }
        // OpenRouter web search annotations
        const annots = delta?.annotations || data.choices?.[0]?.message?.annotations;
        if(Array.isArray(annots)){
          for(const a of annots){
            if(a.type === 'url_citation' && a.url_citation){
              orAnnotations.push({
                title: a.url_citation.title || '',
                url: a.url_citation.url || '',
                snippet: (a.url_citation.content || '').slice(0, 300)
              });
            }
          }
        }
      }catch(e){
        console.error('[SP] Error parsing SSE:', e, 'Line:', trimmed);
      }
    }
  }
  
  // 如果是 reasoner 模型但沒有收到 reasoning_content，給出提示
  if(model.includes('reasoner') && !hasReasoningContent){
    console.warn('[SP] ⚠️ 使用了 reasoner 模型但未收到 reasoning_content！');
    console.warn('[SP] 可能原因：1) 使用了不支援的代理 API  2) API Key 無效  3) API 端點錯誤');
    console.warn('[SP] 建議使用官方端點：https://api.deepseek.com');
  }
  
  // 在大量文字情況下，延遲 0ms 讓瀏覽器先處理佈局，再插入完整內容
  hideThinkingDots(assistantTs);
  setTimeout(()=>{
  if(manualThinkOpened && !manualThinkClosed){
    full+=`</think>`;
    manualThinkClosed = true;
  }
  finalizeStreamingMessage(assistantTs);
  finalizeAssistantMessageContent(assistantTs, full);
  console.log('[SP] ✅ Final assistant content:', full);
  }, 0);
}
function finalizeStreamingMessage(ts){
  // 移除消息對象的 _streaming 標記
  const session = getCurrentSession();
  if(session){
    const msg = session.messages.find(m => m.ts === ts);
    if(msg){
      delete msg._streaming;
    }
  }
  
  const messageEl = els.chatMessages.querySelector(`.message[data-ts="${ts}"]`);
  if(messageEl){
    messageEl.classList.remove('streaming');
    
    // 移除思考過程的串流效果
    const thinkingBlock = messageEl.querySelector('.reasoning-block.streaming');
    if(thinkingBlock){
      thinkingBlock.classList.remove('streaming');
    }
    
    // 添加 token 計數（如果還沒有的話）
    const actionsBar = messageEl.querySelector('.message-actions');
    if(actionsBar && !actionsBar.querySelector('.message-token-count')){
      const session = getCurrentSession();
      if(session){
        const msg = session.messages.find(m => m.ts === ts);
        if(msg && msg.content){
          const tokens = estimateTokens(msg.content);
          const tokenSpan = document.createElement('span');
          tokenSpan.className = 'message-token-count';
          tokenSpan.textContent = `~${tokens}`;
          tokenSpan.title = sp_tpl('estimatedTokens',{n:tokens});
          // 添加到最後（最右邊）
          actionsBar.appendChild(tokenSpan);
        }
      }
    }
    
    // AI 回覆完成後，隱藏上方的頁面內容預覽卡片
    // 因為操作欄中已經有 📄 按鈕可以查看引用內容了
    if(messageEl.classList.contains('assistant-message')){
      const session = getCurrentSession();
      const hasPageContext = session?.messages?.some(m => m._pageContext && m.role === 'system');
      if(hasPageContext){
        // 隱藏頁面內容預覽卡片
        hidePageContentPreview();
        console.log('[finalizeStreamingMessage] AI 回覆完成，已隱藏頁面內容預覽卡片');
      }
    }
  }
}
function formatErrorMessage(e){
  const msg=e && e.message ? e.message : String(e);
  if(/尚未設定 API Key/.test(msg)) return '尚未設定 API Key。';
  if(/權限/.test(msg)) return msg;
  if(/Failed to fetch|連線失敗/.test(msg)) return msg+'\n可能：Proxy 不可達 / CORS / 網路中斷。';
  if(/401/.test(msg)) return msg+'\nAPI Key 無效或 Proxy 尚未正確轉發 Authorization Header。';
  return msg;
}

/* ================= Quick Scroll ================= */
function getScrollContainer(){
  return els.chatRegion || els.chatMessages;
}
function setupScrollButton(){
  if(!els.scrollToBottomBtn) return;
  if(!els.scrollToBottomBtn.firstElementChild){
    els.scrollToBottomBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 4v14"></path><path d="M5 13l7 7 7-7"></path>
      </svg>`;
  }
  els.scrollToBottomBtn.setAttribute('aria-label',sp_t('scrollToBottom'));
  positionScrollButton();
  window.addEventListener('resize', positionScrollButton);
}
function observeScroll(){
  const scroller=getScrollContainer();
  if(!scroller) return;
  let previousScrollTop = scroller.scrollTop;
  
  scroller.addEventListener('scroll',(e)=>{
    const currentScrollTop = scroller.scrollTop;
    const diff=scroller.scrollHeight - currentScrollTop - scroller.clientHeight;
    
    if(_programmaticScroll){
      previousScrollTop = currentScrollTop;
      lastScrollPosition = currentScrollTop;
    } else if(e.isTrusted){
      const isScrollingUp = currentScrollTop < previousScrollTop - 3;
      const isScrollingDown = currentScrollTop > previousScrollTop + 3;
      previousScrollTop = currentScrollTop;
      lastScrollPosition = currentScrollTop;
      
      if(isScrollingDown && diff <= AUTO_FOLLOW_REARM_OFFSET){
        autoFollow = true;
      } else if(isScrollingUp) {
        autoFollow = false;
      }
    } else {
      previousScrollTop = currentScrollTop;
      lastScrollPosition = currentScrollTop;
    }
    
    // 更新滾動按鈕的顯示狀態
    updateScrollBtnVisibility(diff);
  });
}
function updateScrollBtnVisibility(diff){
  if(diff === undefined){
    const scroller = getScrollContainer();
    if(!scroller) return;
    diff = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  }
  if(diff <= AUTO_FOLLOW_BREAK_OFFSET){
    els.scrollToBottomBtn?.classList.remove('show');
    els.scrollToBottomBtn?.classList.remove('autofollow-active');
  } else {
    if(diff > SHOW_SCROLL_BTN_THRESHOLD){
      els.scrollToBottomBtn?.classList.add('show');
      els.scrollToBottomBtn?.classList.remove('autofollow-active');
    } else {
      els.scrollToBottomBtn?.classList.remove('show');
    }
  }
}
function scrollToBottom(force=false){
  const scroller=getScrollContainer();
  if(!scroller) return;
  
  _programmaticScroll = true;
  if(force) {
    scroller.scrollTop = scroller.scrollHeight;
  } else {
    requestAnimationFrame(()=>{
      _programmaticScroll = true;
      scroller.scrollTop = scroller.scrollHeight;
      setTimeout(()=>{ _programmaticScroll = false; }, 50);
    });
  }
  setTimeout(()=>{ _programmaticScroll = false; }, 50);
  
  autoFollow = !!streaming;
  els.scrollToBottomBtn?.classList.remove('show');
  els.scrollToBottomBtn?.classList.remove('autofollow-active');
}

function jumpToComposer(){
  const scroller = getScrollContainer();
  if(!scroller) return;

  autoFollow = true;

  const scrollToUserMessage = () => {
    const liveScroller = getScrollContainer();
    if(!liveScroller) return;

    const maxScroll = liveScroller.scrollHeight - liveScroller.clientHeight;
    if(maxScroll < 0) return;

    _programmaticScroll = true;
    liveScroller.scrollTop = maxScroll;
    lastScrollPosition = liveScroller.scrollTop;
    setTimeout(()=>{ _programmaticScroll = false; }, 50);
  };

  scrollToUserMessage();
  setTimeout(scrollToUserMessage, 50);
  setTimeout(scrollToUserMessage, 150);
}
function positionScrollButton(){
  // position is handled by CSS (fixed bottom-right)
}
function autoSizeEditTextarea(el){
  if(!el) return;
  const MIN=48;
  const MAX=620;
  el.style.height='0px';
  const next=Math.min(Math.max(el.scrollHeight, MIN), MAX);
  el.style.height=next+'px';
}

/* ================= Composer Height / State ================= */
function autoGrow(el,{force=false}={}){
  if(!el) return;
  
  // 保存輸入框的滾動位置
  const savedScrollTop = el.scrollTop;
  
  const raw=el.value;
  if(!raw.length || force){
    el.style.height=COMPOSER_BASE_HEIGHT+'px';
    if(!raw.length){
      if(el===els.messageInput) lastComposerHeight = COMPOSER_BASE_HEIGHT;
      positionScrollButton();
      return;
    }
  }
  el.style.height=COMPOSER_BASE_HEIGHT+'px';
  let h=el.scrollHeight;
  if(h<COMPOSER_BASE_HEIGHT) h=COMPOSER_BASE_HEIGHT;
  if(h>COMPOSER_MAX_HEIGHT) h=COMPOSER_MAX_HEIGHT;
  el.style.height=h+'px';
  
  // 恢復輸入框的滾動位置，避免在編輯頂部文字時跳動
  el.scrollTop = savedScrollTop;
  
  if(el===els.messageInput){
    if(h > lastComposerHeight && h > COMPOSER_BASE_HEIGHT + 20){
      // 輸入框高度增加時，只在用戶本來就在底部附近時才滾動對話窗口
      const scroller = getScrollContainer();
      if(scroller) {
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        const currentScroll = scroller.scrollTop;
        // 只有當用戶在接近底部（距離底部 100px 以內）時才自動滾動
        if(maxScroll - currentScroll <= 100) {
          setTimeout(() => {
            _programmaticScroll = true;
            scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
            setTimeout(()=>{ _programmaticScroll = false; }, 50);
          }, 0);
        }
      }
    }
    lastComposerHeight = h;
  }
  positionScrollButton();
}
function setInputEngagedState(){
  if(!els.textareaWrapper || !els.messageInput) return;
  const el=els.messageInput;
  const has=!!el.value.trim();
  const focused=document.activeElement===el;
  const tall=parseInt(el.style.height||COMPOSER_BASE_HEIGHT,10) > (COMPOSER_BASE_HEIGHT+8);
  if(has || focused || tall){
    els.textareaWrapper.classList.add('is-engaged');
  }else{
    els.textareaWrapper.classList.remove('is-engaged');
  }
}
function resetComposerIfEmpty(){
  if(!els.messageInput) return;
  if(!els.messageInput.value.trim()){
    autoGrow(els.messageInput,{force:true});
    setInputEngagedState();
  }
}
function preventBrowserRestoreAndResetComposer(){
  if(!els.messageInput) return;
  const t=els.messageInput;
  t.setAttribute('autocomplete','off');
  t.setAttribute('autocorrect','off');
  t.setAttribute('autocapitalize','off');
  t.setAttribute('spellcheck','false');
  t.value='';
  t.style.height=COMPOSER_BASE_HEIGHT+'px';
  setInputEngagedState();
}

/* ================= Settings Page Link ================= */
function openSettingsSafe(){
  try{
    if(chrome.runtime.openOptionsPage){
      chrome.runtime.openOptionsPage();
      return;
    }
  }catch(e){}
  window.open(chrome.runtime.getURL('options.html'),'_blank','noopener');
}

/* ── Markdown renderer now in js/markdown.js ── */

/* Streaming inline update */
function updateStreamingMessage(ts, text){
  const session=getCurrentSession(); if(!session)return;
  const target=session.messages.find(m=>m.ts===ts);
  if(target){
    // 確保 role 始終是 assistant
    if(!target.role || target.role !== 'assistant'){
      console.error('[updateStreamingMessage] ⚠️ Role mismatch! Expected assistant, got:', target.role, '| ts:', ts);
      target.role = 'assistant'; // 強制修正
    }
    target.content=text;
    target._streaming=true;
  }
  const node=els.chatMessages.querySelector(`.message[data-ts="${ts}"] .message-content`);
  if(node){
    // 節流：合併高頻更新，根据内容长度动态调整更新间隔
    const state = streamUpdateTimers.get(ts) || {};
    state.latest = text;
    state.isMarkdown = !!preferMarkdown;
    if(!state.timer){
      // 根据内容长度选择更新间隔（三级梯度）
      let renderInterval = STREAM_RENDER_INTERVAL_MS;
      if(text && text.length > STREAM_RENDER_VERY_LONG_LENGTH){
        renderInterval = STREAM_RENDER_VERY_LONG_INTERVAL_MS; // 超长：800ms
        if(!state.longContentWarned){
          console.log('[SP] 检测到超长内容，降低渲染频率以保持流畅:', text.length, '字符');
          state.longContentWarned = true;
        }
      } else if(text && text.length > STREAM_RENDER_MAX_LENGTH){
        renderInterval = STREAM_RENDER_LONG_INTERVAL_MS; // 长：300ms
      }
      
      state.timer = setTimeout(()=>{
        const latest = state.latest;
        const isMd = state.isMarkdown;
        streamUpdateTimers.delete(ts);
        if(isMd){
          const existingThinking = node.querySelector('.reasoning-block');
          if(existingThinking && /<think>[\s\S]*$/i.test(latest)){
            const thinkMatch = latest.match(/<think>([\s\S]*)$/i);
            if(thinkMatch){
              const thinkContent = thinkMatch[1];
              const thinkingBody = existingThinking.querySelector('.reasoning-body');
              if(thinkingBody){
                thinkingBody.innerHTML = renderMarkdownBlocksCore(thinkContent);
              }
            }
          } else {
            node.innerHTML=renderStreamingMarkdown(latest);
          }
    }else{
          const zh=(awaitGetZhVariant.cached)||_defaultLang();
          const converted=(typeof window.__zhConvert==='function' && zh)?__zhConvert(String(latest), zh):String(latest);
          node.textContent=converted;
    }
        scheduleAutoFollow();
        updateScrollBtnVisibility();
      }, renderInterval);
  }
    streamUpdateTimers.set(ts, state);
  }
}
function finalizeAssistantMessageContent(ts, content){
  const session = getCurrentSession();
  if(session){
    const msg = session.messages.find(m => m.ts === ts);
    console.log('[finalizeAssistantMessageContent] Message before finalize:', {
      ts,
      role: msg?.role,
      hasContent: !!msg?.content,
      isStreaming: msg?._streaming
    });
  }
  const ctx = streamingContexts.get(ts) || {};
  streamingContexts.delete(ts);
  const processed = autoWrapThinkingContent(content, ctx);
  const balanced = balanceThinkingTags(processed);
  replaceMessageContent(ts, balanced, false);
}
function replaceMessageContent(ts,newContent,streamingFlag=false){
  const session=getCurrentSession(); if(!session)return;
  const target=session.messages.find(m=>m.ts===ts);
  if(target){
    target.content=newContent;
    if(!streamingFlag) delete target._streaming;
    persistSessions();
  }
  if(target && target.role==='system' && !SHOW_SYSTEM_PROMPT_BUBBLE && !target._pageContext) return;
  const wrap=els.chatMessages.querySelector(`.message[data-ts="${ts}"]`);
  const node=wrap?.querySelector('.message-content');
  if(!node) return;
  
  // 確保 CSS 類別與訊息角色匹配
  if(target){
    const correctClass = target.role==='user'?'user-message':'assistant-message';
    const currentClass = wrap.className.includes('user-message') ? 'user-message' : 'assistant-message';
    if(correctClass !== currentClass){
      console.warn('[replaceMessageContent] Role mismatch detected:', {
        targetRole: target.role,
        correctClass,
        currentClass,
        timestamp: ts
      });
      wrap.className = `message ${correctClass}${target._streaming?' streaming':''}`;
      wrap.dataset.role = target.role; // 更新數據屬性
    }
  }
  
  if(streamingFlag){
    if(preferMarkdown){
      node.innerHTML=renderStreamingMarkdown(newContent);
    }else{
      const zh=(awaitGetZhVariant.cached)||_defaultLang();
      const converted=(typeof window.__zhConvert==='function' && zh)?__zhConvert(String(newContent), zh):String(newContent);
      node.textContent=converted;
    }
  } else if (preferMarkdown && target.role!=='system'){
    console.log('[replaceMessageContent] preferMarkdown render', { preferMarkdown, role: target.role, preview: String(newContent).slice(0,120) });
    const zh=(awaitGetZhVariant.cached)||_defaultLang();
    const converted=(typeof window.__zhConvert==='function' && zh)?__zhConvert(String(newContent), zh):String(newContent);
    console.log('[replaceMessageContent] converted preview', converted.slice(0,120));
    node.innerHTML=renderMarkdownBlocks(converted);
    wrap?.classList.remove('streaming');
    // *** 移除自動滾動 - 讓用戶自己控制滾動 ***
  } else {
    const zh=(awaitGetZhVariant.cached)||_defaultLang();
    const converted=(typeof window.__zhConvert==='function' && zh)?__zhConvert(String(newContent), zh):String(newContent);
    node.textContent=converted;
    // *** 移除自動滾動 - 讓用戶自己控制滾動 ***
  }
}

/* ================= Debug Helper ================= */
window.__spDump = async function(){
  const [l,s] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.storage.sync.get(null)
  ]);
  console.log('[DUMP local]', l);
  console.log('[DUMP sync]', s);
};

// 調試訊息角色問題
window.__debugMessages = function(){
  const session = getCurrentSession();
  if(!session) {
    console.log('No current session');
    return;
  }
  
  console.log('=== Message Debug Info ===');
  console.log('Session messages:', session.messages);
  
  const messageElements = els.chatMessages.querySelectorAll('.message');
  messageElements.forEach((el, index) => {
    const ts = el.dataset.ts;
    const domRole = el.dataset.role;
    const cssClass = el.className.includes('user-message') ? 'user-message' : 'assistant-message';
    const message = session.messages.find(m => m.ts == ts);
    
    console.log(`Message ${index}:`, {
      timestamp: ts,
      messageRole: message?.role,
      domRole: domRole,
      cssClass: cssClass,
      isMatch: message?.role === (cssClass === 'user-message' ? 'user' : 'assistant')
    });
  });
};

/* ================= Error Hooks ================= */
window.addEventListener('error', e=>{
  console.error('[SP][window error]', e.message, e.filename, e.lineno, e.colno, e.error);
});
window.addEventListener('unhandledrejection', e=>{
  console.error('[SP][unhandledrejection]', e.reason);
});
