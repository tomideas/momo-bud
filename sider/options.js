/* options.js (System Prompts edit panel version - no export) 2025-10-02 */
'use strict';

const VERSION = 'ui-design-system-2026-04-05';

// ⚠️ Default prompts now live in prompt-defaults.js

/* CAPTURE_PRESETS & PROVIDER_DEFAULTS now in js/utils.js */

let currentProvider = 'qwen';
let providersData = {};
function _defaultLang() {
  return (typeof window.__detectBrowserLanguage === 'function') ? window.__detectBrowserLanguage() : 'en';
}
let currentLang = _defaultLang();

/* i18n helper: t(key) returns translated string; tpl(key, vars) replaces {{var}} */
function t(key){ return (typeof window.__t === 'function') ? window.__t(key, currentLang) : key; }
function tpl(key, vars){
  let s = t(key);
  if(vars) Object.keys(vars).forEach(k=>{ s = s.replace(new RegExp('\\{\\{'+k+'\\}\\}','g'), vars[k]); });
  return s;
}

let captureSettings = { mode:'full', include:'', exclude:'' };
let customCaptureDraft = { include:'', exclude:'' };


/* ---------- Custom Select (replaces native <select> for dark-mode support) ---------- */
function initCustomSelect(sel){
  if(!sel || sel.dataset.csel) return;
  sel.dataset.csel = '1';

  const wrap = document.createElement('div');
  wrap.className = 'csel-wrap';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const display = document.createElement('div');
  display.className = 'csel-display';
  display.setAttribute('tabindex', '0');
  display.setAttribute('role', 'combobox');
  wrap.appendChild(display);

  const dropdown = document.createElement('div');
  dropdown.className = 'csel-dropdown';
  dropdown.setAttribute('role', 'listbox');
  wrap.appendChild(dropdown);

  function build(){
    dropdown.innerHTML = '';
    for(const opt of sel.options){
      const item = document.createElement('div');
      if(opt.disabled){
        item.className = 'csel-group';
        item.textContent = opt.textContent.replace(/^──\s*|\s*──$/g,'').trim() || opt.textContent;
      } else {
        item.className = 'csel-option';
        item.dataset.value = opt.value;
        item.textContent = opt.textContent;
        if(opt.selected) item.classList.add('selected');
        item.addEventListener('click', e=>{
          e.stopPropagation();
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', {bubbles:true}));
          sync();
          close();
        });
      }
      dropdown.appendChild(item);
    }
  }

  function sync(){
    const cur = sel.options[sel.selectedIndex];
    display.textContent = cur ? cur.textContent.trim() : '';
    dropdown.querySelectorAll('.csel-option').forEach(o=>{
      o.classList.toggle('selected', o.dataset.value === sel.value);
    });
  }

  function open(){
    document.querySelectorAll('.csel-wrap.open').forEach(w=>{ if(w!==wrap) w.classList.remove('open'); });
    wrap.classList.add('open');
    const hit = dropdown.querySelector('.csel-option.selected');
    if(hit) hit.scrollIntoView({block:'nearest'});
  }
  function close(){ wrap.classList.remove('open'); }
  function toggle(){ wrap.classList.contains('open') ? close() : open(); }

  display.addEventListener('click', e=>{ e.stopPropagation(); toggle(); });
  document.addEventListener('click', e=>{ if(!wrap.contains(e.target)) close(); });

  display.addEventListener('keydown', e=>{
    if(e.key==='Escape'){ close(); return; }
    if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); return; }
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();
      let idx = sel.selectedIndex;
      const dir = e.key==='ArrowDown'?1:-1;
      for(let i=idx+dir; i>=0 && i<sel.options.length; i+=dir){
        if(!sel.options[i].disabled){ sel.selectedIndex=i; break; }
      }
      if(sel.selectedIndex!==idx){
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        sync();
      }
    }
  });

  build(); sync();

  const observer = new MutationObserver(()=>{ build(); sync(); });
  observer.observe(sel, {childList:true, subtree:true, characterData:true});

  sel._cselRefresh = ()=>{ build(); sync(); };
  return wrap;
}

/* ---------- Custom dialog helpers (replaces native confirm/alert) ---------- */
function _optDialog(msg, isConfirm){
  return new Promise(resolve=>{
    const okText     = t('ok')     || '確定';
    const cancelText = t('cancel') || '取消';
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
function showConfirm(msg){return _optDialog(msg,true);}
function showAlert(msg){return _optDialog(msg,false);}

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
/* debounce now in js/utils.js */
function setStatus(msg,type){
  els.saveStatus.textContent=msg||'';
  els.saveStatus.className='status'+(type?(' '+type):'');
  if(msg) setTimeout(()=>{ if(els.saveStatus.textContent===msg) setStatus(); },4500);
}
function setTestStatus(msg,type){
  els.testStatus.textContent=msg||'';
  els.testStatus.className='inline-status'+(type?(' '+type):'');
  if(msg) setTimeout(()=>{ if(els.testStatus.textContent===msg) setTestStatus(); },6000);
}
/* normalizeEndpoint, buildChatCompletionsUrl, normalizeExcludeSelectors now in js/utils.js */
/* uuid → use shortId() from js/utils.js */
function uuid(){ return shortId(); }

function persistCaptureSettings(mode, opts={}){
  const preset=CAPTURE_PRESETS[mode];
  let include;
  let exclude;
  if(mode==='custom' || !preset){
    include=(opts.include ?? els.includeSelectorInput.value)?.trim() || '';
    exclude=normalizeExcludeSelectors(opts.exclude ?? els.excludeSelectorInput.value);
    customCaptureDraft={ include, exclude };
  }else{
    include=preset.include || '';
    exclude=normalizeExcludeSelectors(preset.exclude);
  }
  captureSettings={ mode, include, exclude };
  const payload={
    pageCaptureMode: mode,
    pageCaptureInclude: include,
    pageCaptureExclude: exclude
  };
  if(customCaptureDraft.include || customCaptureDraft.exclude || mode==='custom'){
    payload.pageCaptureCustomInclude=customCaptureDraft.include;
    payload.pageCaptureCustomExclude=customCaptureDraft.exclude;
  }
  chrome.storage.sync.set(payload, ()=>{
    if(!opts.silent) setStatus(t('updatedCaptureSettings'),'success');
  });
}

/* ---------- Provider Management ---------- */
function initProvidersData(){
  // Initialize providers data structure
  Object.keys(PROVIDER_DEFAULTS).forEach(id=>{
    if(!providersData[id]){
      const enabledSet = new Set(PROVIDER_DEFAULTS[id].enabledModels || []);
      const supportsThinking = !!PROVIDER_DEFAULTS[id].supportsThinking;
      providersData[id] = {
        ...PROVIDER_DEFAULTS[id],
        apiKey: PROVIDER_DEFAULTS[id].defaultApiKey || '',
        customBaseUrl: '',
        models: (PROVIDER_DEFAULTS[id].models || []).map(name=>({
          name,
          enabled: enabledSet.has(name)
        })),
        enableThinking: supportsThinking
          ? (PROVIDER_DEFAULTS[id].defaultEnableThinking ?? false)
          : false
      };
    }
  });
}

function toggleProviderDropdown(){
  if(!els.providerDropdown) return;
  const isHidden = els.providerDropdown.classList.contains('hidden');
  if(isHidden){
    els.providerDropdown.classList.remove('hidden');
    els.providerSelectButton.classList.add('open');
  }else{
    closeProviderDropdown();
  }
}

function closeProviderDropdown(){
  if(!els.providerDropdown) return;
  els.providerDropdown.classList.add('hidden');
  els.providerSelectButton?.classList.remove('open');
}

function updateProviderSelectButton(providerId){
  if(!els.providerSelectButton || !PROVIDER_DEFAULTS[providerId]) return;

  const provider = PROVIDER_DEFAULTS[providerId];
  const icon = els.providerSelectButton.querySelector('.provider-icon');
  const name = els.providerSelectButton.querySelector('.provider-name');

  if(icon){
    icon.src = PROVIDER_ICONS[providerId] || 'assets/icons/custom.svg';
    icon.alt = provider.name;
  }
  if(name) name.textContent = provider.name + (provider.isOpenClaw ? ' (beta)' : '');
}

const THINKING_HINTS_I18N = {
  hant: {
    qwen:       '💡 <strong>Custom</strong>：停止思考可填 <code>{"enable_thinking": false}</code>',
    google:     '💡 <strong>Custom</strong>：Gemini 2.5 Flash 停止思考可填 <code>{"thinkingConfig": {"thinkingBudget": 0}}</code>，Pro 版無法用此方法停止，可改用 Prefix。',
    moonshot:   '💡 <strong>Custom</strong>：停止 Kimi 思考可填 <code>{"thinking": {"type": "disabled"}}</code>',
    openrouter: '💡 <strong>Custom</strong>：停止 Claude 思考可填 <code>{"thinking": {"type": "disabled"}}</code>',
    deepseek:   '💡 <strong>Custom</strong>：Reasoner 思考無法停止，如需無思考版請改用 deepseek-chat 模型。',
    _default:   '💡 <strong>Custom</strong>：可填入 JSON 覆蓋 API 參數，不填則使用模型預設。',
    _prefix:    '　<strong>Prefix</strong>：每次發訊息時自動貼在最前面，例如 Gemini 2.5 Pro 無法用 API 停止思考，可填 <code>Direct answer only. No thinking.</code>',
  },
  hans: {
    qwen:       '💡 <strong>Custom</strong>：停止思考可填 <code>{"enable_thinking": false}</code>',
    google:     '💡 <strong>Custom</strong>：Gemini 2.5 Flash 停止思考可填 <code>{"thinkingConfig": {"thinkingBudget": 0}}</code>，Pro 版无法用此方法停止，可改用 Prefix。',
    moonshot:   '💡 <strong>Custom</strong>：停止 Kimi 思考可填 <code>{"thinking": {"type": "disabled"}}</code>',
    openrouter: '💡 <strong>Custom</strong>：停止 Claude 思考可填 <code>{"thinking": {"type": "disabled"}}</code>',
    deepseek:   '💡 <strong>Custom</strong>：Reasoner 思考无法停止，如需无思考版请改用 deepseek-chat 模型。',
    _default:   '💡 <strong>Custom</strong>：可填入 JSON 覆盖 API 参数，不填则使用模型预设。',
    _prefix:    '　<strong>Prefix</strong>：每次发消息时自动贴在最前面，例如 Gemini 2.5 Pro 无法用 API 停止思考，可填 <code>Direct answer only. No thinking.</code>',
  },
  en: {
    qwen:       '💡 <strong>Custom</strong>: To disable thinking, fill in <code>{"enable_thinking": false}</code>',
    google:     '💡 <strong>Custom</strong>: Gemini 2.5 Flash can disable thinking via <code>{"thinkingConfig": {"thinkingBudget": 0}}</code>. Pro cannot — use Prefix instead.',
    moonshot:   '💡 <strong>Custom</strong>: To disable Kimi thinking, fill in <code>{"thinking": {"type": "disabled"}}</code>',
    openrouter: '💡 <strong>Custom</strong>: To disable Claude thinking, fill in <code>{"thinking": {"type": "disabled"}}</code>',
    deepseek:   '💡 <strong>Custom</strong>: Reasoner cannot disable thinking. To use a non-thinking version, switch to the deepseek-chat model.',
    _default:   '💡 <strong>Custom</strong>: Fill in JSON to override API parameters. Leave empty to use model defaults.',
    _prefix:    '　<strong>Prefix</strong>: Automatically prepended to every message. e.g. Gemini 2.5 Pro cannot disable thinking via API — fill in <code>Direct answer only. No thinking.</code>',
  },
};
function updateThinkingHint(providerId){
  const el = document.getElementById('thinkingParamsHint');
  if(!el) return;
  const hints = THINKING_HINTS_I18N[currentLang] || THINKING_HINTS_I18N.en;
  const base = hints[providerId] || hints._default;
  el.innerHTML = base + hints._prefix;
}
function switchProvider(providerId){
  if(!PROVIDER_DEFAULTS[providerId]) return;
  
  // Save current provider config before switching (with sanitization)
  saveCurrentProviderConfig();
  
  // Immediately clear model list UI to prevent stale models from being visible
  if(els.modelList) els.modelList.innerHTML = '';
  
  // Update current provider
  currentProvider = providerId;
  
  console.log(`[OPT] Switching to provider: ${providerId}`);
  console.log(`[OPT] Provider data:`, providersData[providerId]);
  
  // Update UI
  updateProviderSelectButton(providerId);
  
  // Update selected state in dropdown
  els.providerOptions.forEach(option=>{
    option.classList.toggle('selected', option.dataset.provider === providerId);
  });
  
  // Load provider config (this will render the correct models)
  loadProviderConfig(providerId);
  updateThinkingHint(providerId);
  
  // Save active provider and update sidepanel data
  chrome.storage.sync.set({ activeProvider: providerId }, ()=>{
    setStatus(tpl('switchedTo',{name:PROVIDER_DEFAULTS[providerId].name}), 'success');
    // Update sidepanel with current provider's models and config
    updateMergedModels();
  });
}

function loadProviderConfig(providerId){
  const provider = providersData[providerId];
  if(!provider) return;
  
  const defaultUrl = PROVIDER_DEFAULTS[providerId].baseUrl;
  const customUrl = provider.customBaseUrl || '';
  
  // Update Base URL field
  if(els.providerBaseUrl){
    els.providerBaseUrl.value = customUrl;
    els.providerBaseUrl.placeholder = defaultUrl || t('useDefaultUrl');
  }
  
  // Update hint
  if(els.providerBaseUrlHint){
    const hintText = tpl('hintUseDefault',{url: defaultUrl || t('hintNone')});
    
    // 針對不同 Provider 添加 API Key 申請連結提示
    const apiKeyLinks = {
      google: 'https://aistudio.google.com/api-keys',
      openai: 'https://platform.openai.com/api-keys',
      deepseek: 'https://platform.deepseek.com/api_keys',
      qwen: 'https://dashscope.console.aliyun.com/apiKeys'
    };
    
    if(apiKeyLinks[providerId]){
      els.providerBaseUrlHint.innerHTML = `${hintText}<br>${t('apiKeyApplyHint')} <a href="${apiKeyLinks[providerId]}" target="_blank" style="color:var(--accent);text-decoration:underline;">${apiKeyLinks[providerId]}</a>`;
    } else {
      els.providerBaseUrlHint.textContent = hintText;
    }
  }
  
  // Update API Key field
  if(els.providerApiKey){
    els.providerApiKey.value = provider.apiKey || '';
  }

  // OpenClaw-specific: Tutorial button & Session Select field
  {
    const isOpenClaw = !!PROVIDER_DEFAULTS[providerId]?.isOpenClaw;
    if(els.openclawTutorialField) els.openclawTutorialField.classList.toggle('hidden', !isOpenClaw);
  }
  if(els.openclawSessionKeyField){
    const isOpenClaw = !!PROVIDER_DEFAULTS[providerId]?.isOpenClaw;
    els.openclawSessionKeyField.classList.toggle('hidden', !isOpenClaw);
    if(isOpenClaw && els.openclawSessionKey){
      const savedKey = provider.sessionKey || '';
      // Store saved key so loadOpenClawSessions can restore it after populating
      els.openclawSessionKey.dataset.savedKey = savedKey;
      // Auto-load sessions from gateway (URL already set above in this function)
      const wsUrl = (els.providerBaseUrl?.value.trim() || PROVIDER_DEFAULTS[providerId]?.baseUrl || '');
      if(wsUrl) loadOpenClawSessions();
    }
  }

  // OpenClaw-specific: update labels/hints
  if(PROVIDER_DEFAULTS[providerId]?.isOpenClaw){
    if(els.providerBaseUrl) els.providerBaseUrl.placeholder = t('openclawWsPlaceholder');
    if(els.providerBaseUrlHint) els.providerBaseUrlHint.innerHTML = tpl('openclawWsHint',{url:defaultUrl});
    // Rename API Key label hint for OpenClaw
    const apiKeyLabel = document.querySelector('label[for="providerApiKey"]');
    if(apiKeyLabel) apiKeyLabel.setAttribute('data-openclaw-original', apiKeyLabel.textContent);
    if(apiKeyLabel) apiKeyLabel.textContent = 'Gateway Token';
  } else {
    // Restore API Key label if switching away from OpenClaw
    const apiKeyLabel = document.querySelector('label[for="providerApiKey"]');
    if(apiKeyLabel && apiKeyLabel.hasAttribute('data-openclaw-original')){
      apiKeyLabel.textContent = apiKeyLabel.getAttribute('data-openclaw-original');
      apiKeyLabel.removeAttribute('data-openclaw-original');
    }
  }

  // Thinking mode is now per-model (in model row dropdown), no provider-level toggle needed
  
  // Load models for this provider
  loadModelsForProvider(providerId);
}

function enforceDefaultModelState(providerId){
  const defaults = PROVIDER_DEFAULTS[providerId];
  const provider = providersData[providerId];
  if(!defaults || !provider) return;
  if(!defaults.enforceDefaultEnabled) return;
  defaults.models.forEach(name=>{
    const target = provider.models.find(m=>m.name===name);
    if(target){
      if(target.enabled === false) target.enabled = true;
    }else{
      provider.models.push({ name, enabled:true });
    }
  });
  provider.models = provider.models.map(m=>{
    if(defaults.models.includes(m.name)){
      return { ...m, enabled:true };
    }
    return m;
  });
}

function saveCurrentProviderConfig(){
  if(!currentProvider || !providersData[currentProvider]) return;
  
  const provider = providersData[currentProvider];
  
  // Save to memory
  if(els.providerBaseUrl){
    provider.customBaseUrl = els.providerBaseUrl.value.trim();
  }
  if(els.providerApiKey){
    provider.apiKey = els.providerApiKey.value.trim();
  }
  // Thinking mode is now per-model, no provider-level enableThinking needed
  // OpenClaw: save session key
  if(PROVIDER_DEFAULTS[currentProvider]?.isOpenClaw && els.openclawSessionKey){
    provider.sessionKey = els.openclawSessionKey.value.trim();
  }
  
  // Collect current models from UI
  let currentModels = collectModels();
  // 嚴格清理：移除不屬於當前 provider 的模型（防止跨 provider 污染）
  currentModels = sanitizeModels(currentModels, currentProvider);
  provider.models = currentModels;
  
  console.log(`[OPT] Saving config for ${currentProvider}, models:`, currentModels);
  
  // Save to storage
  const storageKey = `provider_${currentProvider}`;
  const storagePayload = {
    apiKey: provider.apiKey,
    customBaseUrl: provider.customBaseUrl,
    // 確保寫入時也帶上 provider 欄位
    models: (currentModels||[]).map(m=>({ ...m, provider: currentProvider })),
    enableThinking: provider.enableThinking
  };
  // OpenClaw: persist session key
  if(PROVIDER_DEFAULTS[currentProvider]?.isOpenClaw){
    storagePayload.sessionKey = provider.sessionKey || '';
  }
  chrome.storage.sync.set({
    [storageKey]: storagePayload
  }, ()=>{
    setStatus(t('configSaved'), 'success');
  });
  
  // Update merged models list for sidepanel
  updateMergedModels();
  
  // Also update legacy storage for compatibility
  const effectiveBaseUrl = provider.customBaseUrl || PROVIDER_DEFAULTS[currentProvider].baseUrl;
  chrome.storage.local.set({
    apiKey: provider.apiKey,
    apiEndpoint: effectiveBaseUrl
  });
}

function loadModelsForProvider(providerId){
  const provider = providersData[providerId];
  if(!provider) return;
  
  // 先做一次就地清理，確保不混入跨供應商模型
  const beforeJson = JSON.stringify(provider.models||[]);
  let cleaned = sanitizeModels(normalizeModels(provider.models||[]), providerId).map(m=>({ ...m, provider:providerId }));
  const changed = beforeJson !== JSON.stringify(cleaned);
  if(changed){
    providersData[providerId].models = cleaned;
    const storageKey = `provider_${providerId}`;
    chrome.storage.sync.set({
      [storageKey]: {
        apiKey: providersData[providerId].apiKey || '',
        customBaseUrl: providersData[providerId].customBaseUrl || '',
        models: cleaned,
        enableThinking: providersData[providerId].enableThinking || false
      }
    });
    console.log(`[OPT] Auto-cleaned models for ${providerId}`);
  }
  
  console.log(`[OPT] Loading models for ${providerId}:`, providersData[providerId].models);
  
  // Render models
  renderModels(providersData[providerId].models || []);
}

function migrateOldProviderData(local){
  // Determine which provider based on endpoint
  let targetProvider = 'openai';
  const endpoint = local.apiEndpoint || '';
  
  if(endpoint.includes('dashscope.aliyuncs.com')) targetProvider = 'qwen';
  else if(endpoint.includes('deepseek')) targetProvider = 'deepseek';
  else if(endpoint.includes('google')) targetProvider = 'google';
  else if(endpoint.includes('localhost:11434')) targetProvider = 'ollama';
  else if(endpoint.includes('localhost:1234')) targetProvider = 'lmstudio';
  else if(endpoint && endpoint !== 'https://api.openai.com/v1') targetProvider = 'custom';
  
  // Migrate data
  if(!providersData[targetProvider]) return;
  
  providersData[targetProvider].apiKey = local.apiKey || '';
  if(targetProvider === 'custom' || endpoint !== PROVIDER_DEFAULTS[targetProvider]?.baseUrl){
    providersData[targetProvider].customBaseUrl = endpoint;
  }
  
  // Migrate models
  if(local.customModels){
    const models = normalizeModels(local.customModels);
    providersData[targetProvider].models = models;
  }
  
  // Set as active provider
  currentProvider = targetProvider;
  
  // Save migrated data
  const storageKey = `provider_${targetProvider}`;
  chrome.storage.sync.set({
    [storageKey]: {
      apiKey: providersData[targetProvider].apiKey,
      customBaseUrl: providersData[targetProvider].customBaseUrl,
      models: providersData[targetProvider].models,
      enableThinking: providersData[targetProvider].enableThinking
    },
    activeProvider: targetProvider
  });
  
  console.log('[OPT] Migrated old data to provider:', targetProvider);
}

function renderModels(models){
  if(!els.modelList) return;
  
  els.modelList.innerHTML = '';
  models.forEach(m=>addModelRow(m, false));
  updateModelCount();
}

/* ---------- DOM refs ---------- */
const els = {};
function cacheDom(){
  Object.assign(els,{
    providerSelectButton: $('#providerSelectButton'),
    providerDropdown: $('#providerDropdown'),
    providerOptions: document.querySelectorAll('.provider-option'),
    providerBaseUrl: $('#providerBaseUrl'),
    providerBaseUrlHint: $('#providerBaseUrlHint'),
    providerApiKey: $('#providerApiKey'),
    btnToggleProviderKey: $('#btnToggleProviderKey'),
    openclawSessionKeyField: $('#openclawSessionKeyField'),
    openclawSessionKey: $('#openclawSessionKey'),
    openclawSessionKeyHint: $('#openclawSessionKeyHint'),
    btnLoadSessions: $('#btnLoadSessions'),
    openclawProviderOption: $('#openclawProviderOption'),
    openclawTutorialField: $('#openclawTutorialField'),
    btnOpenClawTutorial: $('#btnOpenClawTutorial'),
    openclawTutorialModal: $('#openclawTutorialModal'),
    thinkingModeField: $('#thinkingModeField'),
    providerEnableThinking: $('#providerEnableThinking'),
    apiKey: $('#apiKey'),
    apiEndpoint: $('#apiEndpoint'),
    btnToggleKey: $('#btnToggleKey'),
    btnGrantHost: $('#btnGrantHost'),
    btnTestConnection: $('#btnTestConnection'),
    testStatus: $('#testStatus'),

    btnAddModel: $('#btnAddModel'),
    modelList: $('#modelList'),
    modelCount: $('#modelCount'),

    themeSegment: $('#themeSegment'),
    showFloatBall: $('#showFloatBall'),
    languageSegment: $('#languageSegment'),
    messageSizeSlider: $('#messageSizeSlider'),
    messageSizeValue: $('#messageSizeValue'),
    messageWeightSelect: $('#messageWeightSelect'),

    ttsVoiceSelect: $('#ttsVoiceSelect'),
    ttsRateSlider: $('#ttsRateSlider'),
    ttsRateValue: $('#ttsRateValue'),
    ttsPitchSlider: $('#ttsPitchSlider'),
    ttsPitchValue: $('#ttsPitchValue'),
    ttsPreviewBtn: $('#ttsPreviewBtn'),

    promptCardList: $('#promptCardList'),
    promptEditorMount: $('#promptEditorMount'),
    btnAddPrompt: $('#btnAddPrompt'),
    btnResetPrompts: $('#btnResetPrompts'),

    saveStatus: $('#saveStatus'),

    webSearchProviderSelect: $('#webSearchProviderSelect'),
    braveKeyFields: $('#braveKeyFields'),
    braveSearchApiKeyInput: $('#braveSearchApiKeyInput'),
    tavilyKeyFields: $('#tavilyKeyFields'),
    tavilyApiKeyInput: $('#tavilyApiKeyInput'),
    simpleInternetSearchToggle: $('#simpleInternetSearchToggle'),
    totalSearchResultsInput: $('#totalSearchResultsInput'),
    visitWebsiteInMessageToggle: $('#visitWebsiteInMessageToggle'),
    internetSearchOnByDefaultToggle: $('#internetSearchOnByDefaultToggle'),
    testWebSearchBtn: $('#testWebSearchBtn'),
    testWebSearchStatus: $('#testWebSearchStatus'),

    captureModeSelect: $('#captureModeSelect'),
    customCaptureFields: $('#customCaptureFields'),
    includeSelectorInput: $('#includeSelectorInput'),
    excludeSelectorInput: $('#excludeSelectorInput'),
    pageContextLimit: $('#pageContextLimit'),

    tplModelRow: $('#tplModelRow'),
    tplPromptCard: $('#tplPromptCard'),
    tplPromptEditor: $('#tplPromptEditor')
  });
}

/* ---------- Init ---------- */
document.addEventListener('DOMContentLoaded', init);

async function init(){
  cacheDom();
  bindEvents();
  await loadAll();
  applyThemeButtons();
  // 延遲執行語言轉換，確保所有 DOM 已渲染且 i18n.js 已載入
  setTimeout(()=>{
    applyLanguageConversion();
  }, 100);
  // 延遲初始化自訂 select（等 TTS voices 等動態選項載入）
  setTimeout(()=>{
    document.querySelectorAll('select.input').forEach(sel => initCustomSelect(sel));
  }, 300);
  console.log('[OPT] loaded', VERSION);
}

/* ---------- Events ---------- */
function bindEvents(){
  // Provider dropdown toggle
  if(els.providerSelectButton){
    els.providerSelectButton.addEventListener('click', (e)=>{
      e.stopPropagation();
      toggleProviderDropdown();
    });
  }
  
  // Provider option selection
  els.providerOptions.forEach(option=>{
    option.addEventListener('click', ()=>{
      const providerId = option.dataset.provider;
      switchProvider(providerId);
      closeProviderDropdown();
    });
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e)=>{
    if(!els.providerSelectButton?.contains(e.target) && !els.providerDropdown?.contains(e.target)){
      closeProviderDropdown();
    }
  });

  // Provider API Key 可視
  if(els.btnToggleProviderKey){
    els.btnToggleProviderKey.addEventListener('click',()=>{
      if(els.providerApiKey.type==='password'){
        els.providerApiKey.type='text'; els.btnToggleProviderKey.textContent=t('hideKey');
    } else {
        els.providerApiKey.type='password'; els.btnToggleProviderKey.textContent=t('showKey');
      }
    });
  }

  // 自動保存 Provider 配置
  const autoSaveProvider=debounce(()=>{
    saveCurrentProviderConfig();
  },650);
  if(els.providerBaseUrl) els.providerBaseUrl.addEventListener('input', autoSaveProvider);
  if(els.providerApiKey) els.providerApiKey.addEventListener('input', autoSaveProvider);
  // Provider-level thinking toggle removed; now per-model in model row

  const autoSaveCaptureSelectors=debounce(()=>{
    const include=els.includeSelectorInput.value.trim();
    const exclude=normalizeExcludeSelectors(els.excludeSelectorInput.value);
    if(els.captureModeSelect.value!=='custom'){
      els.captureModeSelect.value='custom';
      els.customCaptureFields?.classList.remove('hidden');
      els.includeSelectorInput.disabled=false;
      els.excludeSelectorInput.disabled=false;
    }
    persistCaptureSettings('custom', { include, exclude, silent:true });
  },650);
  els.includeSelectorInput.addEventListener('input', autoSaveCaptureSelectors);
  els.excludeSelectorInput.addEventListener('input', autoSaveCaptureSelectors);

  els.captureModeSelect?.addEventListener('change',()=>{
    const mode=els.captureModeSelect.value;
    applyCaptureModeUI(mode);
    persistCaptureSettings(mode);
  });

  // Web Search settings
  els.webSearchProviderSelect?.addEventListener('change', ()=>{
    const provider = els.webSearchProviderSelect.value;
    els.braveKeyFields?.classList.toggle('hidden', provider !== 'brave');
    els.tavilyKeyFields?.classList.toggle('hidden', provider !== 'tavily');
    saveWebSearchSettings();
  });
  const autoSaveSearchKey = debounce(()=> saveWebSearchSettings(), 650);
  els.braveSearchApiKeyInput?.addEventListener('input', autoSaveSearchKey);
  els.tavilyApiKeyInput?.addEventListener('input', autoSaveSearchKey);
  els.simpleInternetSearchToggle?.addEventListener('change', ()=> saveWebSearchSettings());
  els.totalSearchResultsInput?.addEventListener('change', ()=> saveWebSearchSettings());
  els.visitWebsiteInMessageToggle?.addEventListener('change', ()=> saveWebSearchSettings());
  els.internetSearchOnByDefaultToggle?.addEventListener('change', ()=> saveWebSearchSettings());
  els.testWebSearchBtn?.addEventListener('click', testWebSearch);

  // OpenClaw tutorial modal
  els.btnOpenClawTutorial?.addEventListener('click', ()=>{
    if(els.openclawTutorialModal) els.openclawTutorialModal.hidden = false;
  });
  document.querySelectorAll('.openclaw-tutorial-close').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(els.openclawTutorialModal) els.openclawTutorialModal.hidden = true;
    });
  });
  els.openclawTutorialModal?.querySelector('.prompt-modal-backdrop')?.addEventListener('click', ()=>{
    els.openclawTutorialModal.hidden = true;
  });

  // OpenClaw Session 載入與選擇自動保存
  els.btnLoadSessions?.addEventListener('click', loadOpenClawSessions);
  els.openclawSessionKey?.addEventListener('change', ()=>{ saveCurrentProviderConfig(); });

  // 測試
  els.btnTestConnection.addEventListener('click', testConnection);

  // 主題
  els.themeSegment.addEventListener('click',e=>{
    const btn=e.target.closest('.seg-btn'); if(!btn)return;
    const theme=btn.dataset.theme;
    chrome.storage.local.set({ theme },()=>{
      chrome.storage.sync.set({ theme });
      applyTheme(theme); applyThemeButtons();
      setStatus(tpl('themeSwitched',{theme}),'success');
    });
  });

  // 懸浮球
  if(els.showFloatBall){
    els.showFloatBall.addEventListener('change',()=>{
      const show = !!els.showFloatBall.checked;
      chrome.storage.sync.set({ showFloatBall: show }, ()=>{
        setStatus(t('floatBallUpdated'),'success');
      });
    });

    // 即時同步：當從網頁端關閉/開啟懸浮球時，設定頁的開關也跟著更新
    chrome.storage.onChanged.addListener((changes, area)=>{
      if(area==='sync' && changes.showFloatBall && els.showFloatBall){
        const next = !!changes.showFloatBall.newValue;
        if(els.showFloatBall.checked !== next){
          els.showFloatBall.checked = next;
          setStatus(tpl('floatBallSynced',{state:next?t('on'):t('off')}),'info');
        }
      }
    });
  }

  // Open shortcuts page button
  const btnOpenShortcutsPage = document.getElementById('btnOpenShortcutsPage');
  if (btnOpenShortcutsPage) {
    btnOpenShortcutsPage.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }
  
  // 頁面內容字符限制
  if(els.pageContextLimit){
    els.pageContextLimit.addEventListener('change',()=>{
      const limit = parseInt(els.pageContextLimit.value, 10);
      if(limit && limit >= 1000 && limit <= 200000){
        chrome.storage.sync.set({ pageContextLimit: limit }, ()=>{
          setStatus(t('pageLimitUpdated'),'success');
        });
      }else{
        showAlert(t('pageLimitAlert'));
        els.pageContextLimit.value = 20000;
      }
    });
  }

  // 語言設定（繁體/簡體/英文）
  if(els.languageSegment){
    els.languageSegment.addEventListener('click', e=>{
      const btn=e.target.closest('.seg-btn'); if(!btn) return;
      const lang=btn.dataset.lang; // hant | hans | en
      chrome.storage.local.set({ zhVariant: lang }, ()=>{
        chrome.storage.sync.set({ zhVariant: lang });
        currentLang = lang;
        [...els.languageSegment.querySelectorAll('.seg-btn')].forEach(b=>b.classList.toggle('active', b.dataset.lang===lang));
        applyLanguageConversion();
      });
    });
  }

  // 字號
  if(els.messageSizeSlider){
    els.messageSizeSlider.addEventListener('input',()=>{
      const size = String(els.messageSizeSlider.value||'14');
      chrome.storage.local.set({ messageSize: size });
      chrome.storage.sync.set({ messageSize: size }, ()=>{
        setStatus(t('fontSizeUpdated'),'success');
      });
    });
  }

  // 字體粗細
  if(els.messageWeightSelect){
    els.messageWeightSelect.addEventListener('change',()=>{
      const weight = String(els.messageWeightSelect.value||'500');
      chrome.storage.local.set({ messageWeight: weight });
      chrome.storage.sync.set({ messageWeight: weight }, ()=>{
        setStatus(t('fontWeightUpdated'),'success');
      });
    });
  }

  // TTS 設定
  bindTtsEvents();

  // 模型
  els.btnAddModel.addEventListener('click',()=>addModelRow({name:'',enabled:true},true));

  // Prompts
  els.btnAddPrompt.addEventListener('click', addPromptCard);
  els.btnResetPrompts.addEventListener('click', resetPrompts);
  els.promptCardList.addEventListener('click', promptCardClick);
}

/* ---------- Load All ---------- */
async function loadAll(){
  // Initialize providers data
  initProvidersData();
  
  // Get all provider keys
  const providerKeys = Object.keys(PROVIDER_DEFAULTS).map(id=>`provider_${id}`);
  
  const [local, sync] = await Promise.all([
    chrome.storage.local.get([
      'apiKey','apiEndpoint','customModels',
      'providerDataMigrated',
      'zhVariant','theme','messageSize','messageWeight','showFloatBall',
      'ttsVoice','ttsRate','ttsPitch', // TTS settings
      'pageCaptureMode','pageCaptureInclude','pageCaptureExclude',
      'pageCaptureCustomInclude','pageCaptureCustomExclude','pageContextLimit',
      'prompts','defaultPrompt','selectedPrompt', // 提示詞保存在本地
      ...providerKeys  // 本地備份，供遷移用
    ]),
    chrome.storage.sync.get([
      'theme','activeProvider','messageWeight','messageSize','showFloatBall',
      'ttsVoice','ttsRate','ttsPitch',
      'pageCaptureMode','pageCaptureInclude','pageCaptureExclude',
      'pageCaptureCustomInclude','pageCaptureCustomExclude',
      'pageContextLimit','zhVariant',
      'prompts','defaultPrompt','selectedPrompt',
      'promptsVersion','deletedDefaultPrompts',
      ...providerKeys
    ])
  ]);
  // Sync takes precedence for settings; local is fallback (migration)
  const merged = { ...local };
  Object.keys(sync).forEach(k => { if(sync[k] !== undefined) merged[k] = sync[k]; });
  
  // Load provider data
  let needsCleanup = false;
  const changedProviders = new Set();
  Object.keys(PROVIDER_DEFAULTS).forEach(id=>{
    const storageKey = `provider_${id}`;
    if(merged[storageKey]){
      const stored = merged[storageKey];
      const defaultModelNames = PROVIDER_DEFAULTS[id].models;
      
      // Filter models: only keep models that belong to this provider's default list OR are custom additions
      let models = Array.isArray(stored.models) ? stored.models : providersData[id].models;
      // 先做一次嚴格清理並補齊 provider 欄位
      models = sanitizeModels(normalizeModels(models), id).map(m=>({ ...m, provider:id }));
      const originalCount = models.length;
      
      // Validate: 僅在「命中其它供應商的預設清單」或「provider 欄位不符」時才過濾；
      // 其它情況（包含未啟用與自訂名稱）一律保留
      models = models.filter(m => {
        const modelName = m.name || '';
        for(const otherId of Object.keys(PROVIDER_DEFAULTS)){
          if(otherId !== id && PROVIDER_DEFAULTS[otherId].models.includes(modelName)){
            console.warn(`[OPT] Removing ${modelName} from ${id} (belongs to ${otherId})`);
            needsCleanup = true;
            changedProviders.add(id);
            return false;
          }
        }
        if(m.provider && m.provider!==id){
          needsCleanup = true; changedProviders.add(id); return false;
        }
        return true;
      });
      
      if(models.length !== originalCount){
        console.log(`[OPT] Cleaned ${id}: ${originalCount} -> ${models.length} models`);
      }
      const supportsThinking = !!PROVIDER_DEFAULTS[id].supportsThinking;
      const enableThinking = supportsThinking
        ? (typeof stored.enableThinking === 'boolean'
            ? stored.enableThinking
            : providersData[id].enableThinking)
        : false;
      
      providersData[id] = {
        ...providersData[id],
        apiKey: stored.apiKey || '',
        customBaseUrl: stored.customBaseUrl || '',
        models: models,
        enableThinking,
        // OpenClaw: restore session key
        ...(PROVIDER_DEFAULTS[id]?.isOpenClaw ? { sessionKey: stored.sessionKey || '' } : {})
      };
    }
  });
  
  // If we cleaned up any models, save the cleaned data back to storage
  if(needsCleanup && changedProviders.size>0){
    console.log('[OPT] Saving cleaned provider data...');
    const cleanedData = {};
    changedProviders.forEach(id => {
      cleanedData[`provider_${id}`] = {
        apiKey: providersData[id].apiKey || '',
        customBaseUrl: providersData[id].customBaseUrl || '',
        models: providersData[id].models,
        enableThinking: providersData[id].enableThinking
      };
    });
    chrome.storage.sync.set(cleanedData, () => {
      console.log('[OPT] Cleaned data saved');
    });
  }
  
  // Migrate old data if needed (only once)
  if((local.apiKey || local.apiEndpoint) && !local.providerDataMigrated){
    migrateOldProviderData(local);
    // Mark as migrated
    chrome.storage.local.set({ providerDataMigrated: true });
  }
  
  // Set active provider
  currentProvider = merged.activeProvider || 'qwen';
  if(!merged.activeProvider && !local.apiKey && !local.customModels){
    chrome.storage.sync.set({ activeProvider: currentProvider });
  }
  
  // Clean up any cross-provider model contamination in all providers
  cleanupAllProviderModels();
  
  // Update UI
  updateProviderSelectButton(currentProvider);
  els.providerOptions.forEach(option=>{
    option.classList.toggle('selected', option.dataset.provider === currentProvider);
  });
  
  // Load current provider config
  loadProviderConfig(currentProvider);
  updateThinkingHint(currentProvider);
  
  applyTheme(merged.theme||'auto');

  // 初始化懸浮球
  if(els.showFloatBall){
    els.showFloatBall.checked = !!merged.showFloatBall;
  }

  // 初始化語言顯示（默認繁體中文）
  const lang=merged.zhVariant||_defaultLang();
  currentLang=lang;
  if(els.languageSegment){
    [...els.languageSegment.querySelectorAll('.seg-btn')].forEach(b=>b.classList.toggle('active', b.dataset.lang===lang));
  }
  
  // 應用翻譯（同步等待，確保 t() 可用）
  if(typeof window.__applyTranslations === 'function'){
    try{ await window.__applyTranslations(lang); }catch(err){
      console.warn('[OPT] Failed to apply translations:', err);
    }
  }
  updateThinkingHint(currentProvider);

  // 初始化訊息字號
  const size = String(merged.messageSize || '14');
  if(els.messageSizeSlider){
    els.messageSizeSlider.value = size;
  }
  if(els.messageSizeValue){
    els.messageSizeValue.textContent = t('fontSizeDefault');
  }

  // 初始化訊息字重
  const weight = String(merged.messageWeight || '500');
  if(els.messageWeightSelect){
    els.messageWeightSelect.value = weight;
  }

  // 初始化 TTS 設定
  initTtsSettings(merged);

  let mode=merged.pageCaptureMode;
  const storedInclude=(merged.pageCaptureInclude||'').trim();
  const storedExclude=normalizeExcludeSelectors(merged.pageCaptureExclude||'');
  const customInclude=((merged.pageCaptureCustomInclude ?? storedInclude) || '').trim();
  const customExclude=normalizeExcludeSelectors((merged.pageCaptureCustomExclude ?? storedExclude) || '');

  if(!mode){
    if(storedInclude || storedExclude){
      mode='custom';
    }else{
      mode='reader';
    }
  }

  captureSettings={ mode, include: storedInclude, exclude: storedExclude };
  customCaptureDraft={ include: customInclude, exclude: customExclude };
  applyCaptureModeUI(mode, mode==='custom' ? customCaptureDraft : captureSettings);
  if(!merged.pageCaptureMode){
    persistCaptureSettings(mode, { include: storedInclude, exclude: storedExclude, silent:true });
  }

  // Load page context limit
  if(els.pageContextLimit){
    els.pageContextLimit.value = merged.pageContextLimit || 20000;
  }

  // Load web search settings
  loadWebSearchSettings();

  // models - already loaded by loadProviderConfig
  // normalizeModels(local.customModels).forEach(m=>addModelRow(m,false));
  // updateModelCount();

  // prompts - 只使用本地存儲，避免混用
  // 優先從本地存儲讀取
  let promptList = Array.isArray(local.prompts) ? local.prompts : null;
  let selectedPromptId = local.selectedPrompt || local.defaultPrompt || null;
  
  // 如果本地沒有，檢查同步存儲（遷移舊數據）
  if(!promptList && Array.isArray(sync.prompts) && sync.prompts.length > 0){
    console.log('[OPT] Found old data in sync storage, migrating to local...');
    promptList = sync.prompts;
    selectedPromptId = sync.selectedPrompt || sync.defaultPrompt || null;
    // 遷移到本地並清除同步
    await chrome.storage.local.set({ prompts: promptList, defaultPrompt: selectedPromptId });
    await chrome.storage.sync.remove(['prompts', 'defaultPrompt', 'selectedPrompt']);
  }
  const storedVersion = sync.promptsVersion || 1;
  const deletedDefaultIds = Array.isArray(sync.deletedDefaultPrompts) ? sync.deletedDefaultPrompts : [];
  
  // If prompts version is outdated, add any NEW default prompts
  if(storedVersion < PROMPTS_VERSION && promptList){
    console.log(`Updating prompts from version ${storedVersion} to ${PROMPTS_VERSION}`);
    
    // Get existing prompt IDs
    const existingIds = promptList.map(p => p.id);
    
    // Find NEW default prompts that:
    // 1. User doesn't have yet
    // 2. User hasn't deleted before
    const newDefaults = DEFAULT_PROMPTS.filter(p => 
      !existingIds.includes(p.id) && !deletedDefaultIds.includes(p.id)
    );
    
    // Add new defaults to the END (preserving all existing prompts)
    if(newDefaults.length > 0){
      promptList = [...promptList, ...newDefaults];
      console.log(`Added ${newDefaults.length} new default prompts`);
    }
    
    // Just update the version number
    // 強制使用本地存儲
    await chrome.storage.local.set({ prompts: promptList, defaultPrompt: selectedPromptId });
    await chrome.storage.sync.set({ promptsVersion: PROMPTS_VERSION });
  } else if(promptList){
    const migrated=migratePromptIds(promptList, selectedPromptId);
    promptList=migrated.prompts;
    selectedPromptId=migrated.selected || DEFAULT_PROMPT_ID;
    if(migrated.changed){
      // 強制使用本地存儲
      await chrome.storage.local.set({ prompts:promptList, defaultPrompt:selectedPromptId });
    }
  }
  
  if(!promptList || !promptList.length){
    promptList=cloneDefaultPrompts();
    selectedPromptId=DEFAULT_PROMPT_ID;
    // 強制使用本地存儲
    await chrome.storage.local.set({ prompts: promptList, defaultPrompt: selectedPromptId });
    await chrome.storage.sync.set({ promptsVersion: PROMPTS_VERSION });
  }
  renderPromptCards(promptList, selectedPromptId);
  
  // Update sidepanel with current provider's data
  updateMergedModels();
}

/* ---------- Theme ---------- */
function applyTheme(t){ 
  let resolved = t;
  if(t==='auto'){
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = document.getElementById('metaColorScheme');
  if(meta) meta.content = resolved === 'dark' ? 'dark' : 'light';
}
(function(){
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
    chrome.storage.local.get('theme', r=>{
      if((r.theme||'auto')==='auto') applyTheme('auto');
    });
  });
})();
function applyThemeButtons(){
  Promise.all([
    chrome.storage.sync.get('theme'),
    chrome.storage.local.get('theme')
  ]).then(([s,l])=>{
    const cur=s.theme||l.theme||'auto';
    [...els.themeSegment.querySelectorAll('.seg-btn')].forEach(b=>b.classList.toggle('active', b.dataset.theme===cur));
  });
}

/* ---------- TTS ---------- */
function initTtsSettings(merged){
  if(!els.ttsVoiceSelect) return;
  const savedVoice = merged.ttsVoice || '';
  const savedRate = parseFloat(merged.ttsRate) || 1.0;
  const savedPitch = parseFloat(merged.ttsPitch) || 1.0;

  function populateVoices(){
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    els.ttsVoiceSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = t('ttsVoiceAuto') || '自動（系統預設）';
    els.ttsVoiceSelect.appendChild(auto);

    const langOrder = ['zh','ja','ko','en','fr','de','es','pt','it','ru'];
    function langPriority(lang){
      const l = (lang||'').toLowerCase();
      for(let i=0;i<langOrder.length;i++){
        if(l.startsWith(langOrder[i])) return i;
      }
      return langOrder.length;
    }
    function langLabel(lang){
      const l = (lang||'').toLowerCase();
      if(l.startsWith('zh')) return '中文';
      if(l.startsWith('ja')) return '日本語';
      if(l.startsWith('ko')) return '한국어';
      if(l.startsWith('en')) return 'English';
      if(l.startsWith('fr')) return 'Français';
      if(l.startsWith('de')) return 'Deutsch';
      if(l.startsWith('es')) return 'Español';
      if(l.startsWith('pt')) return 'Português';
      if(l.startsWith('it')) return 'Italiano';
      if(l.startsWith('ru')) return 'Русский';
      return lang || 'Other';
    }

    const sorted = [...voices].sort((a,b) => {
      const pa = langPriority(a.lang), pb = langPriority(b.lang);
      if(pa !== pb) return pa - pb;
      if(a.lang !== b.lang) return a.lang.localeCompare(b.lang);
      return a.name.localeCompare(b.name);
    });

    let lastGroup = '';
    sorted.forEach(v => {
      const prefix = (v.lang||'').split(/[-_]/)[0].toLowerCase();
      if(prefix !== lastGroup){
        lastGroup = prefix;
        const grp = document.createElement('option');
        grp.disabled = true;
        grp.textContent = `── ${langLabel(v.lang)} ──`;
        grp.className = 'tts-voice-group';
        els.ttsVoiceSelect.appendChild(grp);
      }
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = `  ${v.name} (${v.lang})`;
      if(v.voiceURI === savedVoice) opt.selected = true;
      els.ttsVoiceSelect.appendChild(opt);
    });
  }

  populateVoices();
  if(window.speechSynthesis){
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }

  if(els.ttsRateSlider){
    els.ttsRateSlider.value = savedRate;
    if(els.ttsRateValue) els.ttsRateValue.textContent = savedRate.toFixed(1) + 'x';
  }
  if(els.ttsPitchSlider){
    els.ttsPitchSlider.value = savedPitch;
    if(els.ttsPitchValue) els.ttsPitchValue.textContent = savedPitch.toFixed(1);
  }
}

function bindTtsEvents(){
  if(els.ttsVoiceSelect){
    els.ttsVoiceSelect.addEventListener('change', ()=>{
      const val = els.ttsVoiceSelect.value;
      chrome.storage.local.set({ ttsVoice: val });
      chrome.storage.sync.set({ ttsVoice: val }, ()=> setStatus(t('ttsSaved'),'success'));
    });
  }
  if(els.ttsRateSlider){
    els.ttsRateSlider.addEventListener('input', ()=>{
      const val = els.ttsRateSlider.value;
      if(els.ttsRateValue) els.ttsRateValue.textContent = parseFloat(val).toFixed(1) + 'x';
      chrome.storage.local.set({ ttsRate: val });
      chrome.storage.sync.set({ ttsRate: val });
    });
  }
  if(els.ttsPitchSlider){
    els.ttsPitchSlider.addEventListener('input', ()=>{
      const val = els.ttsPitchSlider.value;
      if(els.ttsPitchValue) els.ttsPitchValue.textContent = parseFloat(val).toFixed(1);
      chrome.storage.local.set({ ttsPitch: val });
      chrome.storage.sync.set({ ttsPitch: val });
    });
  }
  if(els.ttsPreviewBtn){
    els.ttsPreviewBtn.addEventListener('click', ()=>{
      if(!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const sampleText = t('ttsPreviewText') || '你好，這是語音預覽測試。';
      const utterance = new SpeechSynthesisUtterance(sampleText);
      utterance.rate = parseFloat(els.ttsRateSlider?.value) || 1.0;
      utterance.pitch = parseFloat(els.ttsPitchSlider?.value) || 1.0;
      utterance.volume = 1.0;
      const voiceURI = els.ttsVoiceSelect?.value;
      if(voiceURI){
        const voice = window.speechSynthesis.getVoices().find(v => v.voiceURI === voiceURI);
        if(voice) utterance.voice = voice;
      }
      utterance.lang = 'zh-CN';
      window.speechSynthesis.speak(utterance);
    });
  }
}

function applyCaptureModeUI(mode, values){
  if(!els.captureModeSelect || !els.includeSelectorInput || !els.excludeSelectorInput || !els.customCaptureFields) return;
  const hasPreset=Boolean(CAPTURE_PRESETS[mode]);
  const isCustom=mode==='custom' || !hasPreset;
  const effectiveMode=isCustom && !hasPreset ? 'custom' : mode;
  els.captureModeSelect.value=effectiveMode;
  els.customCaptureFields.classList.toggle('hidden', !isCustom);
  els.includeSelectorInput.disabled=!isCustom;
  els.excludeSelectorInput.disabled=!isCustom;

  if(isCustom){
    const src=values ?? customCaptureDraft;
    els.includeSelectorInput.value=src?.include || '';
    els.excludeSelectorInput.value=src?.exclude || '';
  }else{
    const preset=CAPTURE_PRESETS[effectiveMode] || CAPTURE_PRESETS.full;
    els.includeSelectorInput.value=preset.include;
    els.excludeSelectorInput.value=preset.exclude;
  }
}

/* ---------- OpenClaw Session Loader ---------- */
async function loadOpenClawSessions(){
  const wsUrl = (els.providerBaseUrl?.value.trim() || PROVIDER_DEFAULTS.openclaw?.baseUrl || '').replace(/\/+$/,'');
  const token = els.providerApiKey?.value.trim() || '';
  const btn = els.btnLoadSessions;
  const select = els.openclawSessionKey;
  if(!btn || !select) return;
  if(!wsUrl){ setTestStatus(t('gatewayUrlNotSet') || 'Gateway URL 未設定', 'error'); return; }

  const savedKey = select.dataset.savedKey || select.value || '';
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '載入中…';

  // Notify background to update Origin rules (same as testConnection)
  try{ chrome.runtime.sendMessage({ type:'openclaw_update_origin', wsUrl }); }catch(e){}
  await new Promise(r=>setTimeout(r, 300));

  let ws, timer;
  try{
    const sessions = await new Promise((resolve, reject)=>{
      timer = setTimeout(()=>reject(new Error(t('connectionTimeout') || '連線逾時')), 10000);
      let connectReqId = 'sess_' + Date.now();
      let listReqId = null;

      try{ ws = new WebSocket(wsUrl); }catch(e){ reject(new Error('無法建立 WebSocket: ' + e.message)); return; }

      ws.onerror = ()=>reject(new Error(t('wsConnectionFailed') || 'WebSocket 連線失敗'));
      ws.onclose = (evt)=>{
        if(listReqId === null) reject(new Error('連線關閉: ' + (evt.reason || evt.code)));
      };
      ws.onmessage = (evt)=>{
        let data;
        try{ data = JSON.parse(evt.data); }catch(e){ return; }

        // Step 1: challenge → send connect
        if(data.type === 'event' && data.event === 'connect.challenge'){
          const authObj = token ? { token } : {};
          ws.send(JSON.stringify({
            type:'req', id: connectReqId, method:'connect',
            params:{
              minProtocol:3, maxProtocol:3,
              client:{ id:'openclaw-control-ui', version:'1.0.0', platform:navigator.platform||'web', mode:'webchat' },
              role:'operator', scopes:['operator.admin','operator.approvals','operator.pairing'],
              caps:[], auth: authObj,
              userAgent: navigator.userAgent,
              locale: navigator.language || 'zh-TW'
            }
          }));
          return;
        }

        // Step 2: hello-ok → request sessions.list
        if(data.type === 'res' && data.id === connectReqId){
          if(!data.ok){ reject(new Error(data.error?.message || '認證失敗')); return; }
          listReqId = 'list_' + Date.now();
          ws.send(JSON.stringify({ type:'req', id: listReqId, method:'sessions.list', params:{} }));
          return;
        }

        // Step 3: sessions.list response
        if(data.type === 'res' && data.id === listReqId){
          clearTimeout(timer);
          if(data.ok) resolve(data.payload?.sessions || []);
          else reject(new Error(data.error?.message || 'sessions.list 失敗'));
        }
      };
    });

    // Populate select options
    select.innerHTML = '';
    if(sessions.length === 0){
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(無可用 Session)';
      select.appendChild(opt);
    } else {
      sessions.forEach(s=>{
        const opt = document.createElement('option');
        opt.value = s.key || '';
        const name = s.displayName || s.name || s.key || '';
        const kind = s.kind ? ` [${s.kind}]` : '';
        opt.textContent = name + kind;
        select.appendChild(opt);
      });
      // Restore previously saved selection
      if(savedKey){
        select.value = savedKey;
      }
      // If saved key not found in list, pick first
      if(!select.value){
        select.value = sessions[0]?.key || '';
      }
    }
    // Persist the selection
    saveCurrentProviderConfig();

  }catch(e){
    console.error('[LoadSessions]', e);
    select.innerHTML = '';
    const errOpt = document.createElement('option');
    errOpt.value = '';
    errOpt.textContent = t('loadFailed') + ': ' + e.message;
    select.appendChild(errOpt);
  }finally{
    clearTimeout(timer);
    try{ ws?.close(); }catch(e){}
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/* ---------- Host Permission & Test ---------- */
async function ensureHostPermission(ep){
  if(!ep) return {granted:true};
  try{
    const url=new URL(normalizeEndpoint(ep));
    if(/api\.openai\.com$/i.test(url.hostname)) return {granted:true};
    if(!chrome.permissions) return {granted:true};
    const pattern=`${url.protocol}//${url.host}/*`;
    const has=await new Promise(r=>chrome.permissions.contains({origins:[pattern]},r));
    if(has) return {granted:true, pattern};
    const granted=await new Promise(r=>chrome.permissions.request({origins:[pattern]},r));
    return { granted, pattern };
  }catch(e){ return {granted:false, error:e}; }
}

async function testConnection(){
  // Get current provider config
  const provider = providersData[currentProvider];
  if(!provider){
    setTestStatus(t('providerConfigError'),'error');
    return;
  }

  const btn=els.btnTestConnection; const orig=btn.textContent;
  if(!btn.dataset.defaultLabel){
    btn.dataset.defaultLabel = orig || t('startTest');
  }

  /* ── OpenClaw：WebSocket 握手測試 ── */
  if(PROVIDER_DEFAULTS[currentProvider]?.isOpenClaw){
    const wsUrl = (els.providerBaseUrl?.value.trim() || PROVIDER_DEFAULTS[currentProvider]?.baseUrl || '').replace(/\/+$/,'');
    const token = els.providerApiKey?.value.trim() || '';
    if(!wsUrl){ setTestStatus(t('gatewayUrlNotSet'),'error'); return; }
    // 通知 background 更新 Origin 規則
    try{ chrome.runtime.sendMessage({ type:'openclaw_update_origin', wsUrl }); }catch(e){}
    btn.disabled=true; btn.textContent=t('testing'); setTestStatus(t('connecting'));
    // 等待規則生效
    await new Promise(r=>setTimeout(r, 300));
    let ws, timer;
    try{
      await new Promise((resolve, reject)=>{
        timer = setTimeout(()=>reject(new Error(t('connectionTimeout'))), 8000);
        ws = new WebSocket(wsUrl);
        let connectReqId = 'test_' + Date.now();
        ws.onopen = ()=>{ console.log('[OpenClaw Test] WS opened'); };
        ws.onerror = ()=>reject(new Error(t('wsConnectionFailed')));
        ws.onclose = (evt)=>{
          if(evt.code !== 1000) reject(new Error(tpl('connectionClosed',{reason: evt.reason || evt.code})));
        };
        ws.onmessage = (evt)=>{
          let data;
          try{ data = JSON.parse(evt.data); }catch(e){ return; }
          console.log('[OpenClaw Test] ←', JSON.stringify(data).slice(0,300));
          // 收到 challenge，發送 connect
          if(data.type === 'event' && data.event === 'connect.challenge'){
            const authObj = token ? { token } : {};
            const msg = {
              type:'req', id: connectReqId, method:'connect',
              params:{
                minProtocol:3, maxProtocol:3,
                client:{ id:'openclaw-control-ui', version:'1.0.0', platform:navigator.platform||'web', mode:'webchat' },
                role:'operator',
                scopes:['operator.admin','operator.approvals','operator.pairing'],
                caps:[], auth: authObj,
                userAgent: navigator.userAgent,
                locale: navigator.language || 'zh-TW'
              }
            };
            ws.send(JSON.stringify(msg));
            return;
          }
          // 收到握手回應
          if(data.type === 'res' && data.id === connectReqId){
            clearTimeout(timer);
            if(data.ok){
              resolve();
            } else {
              reject(new Error(data.error?.message || JSON.stringify(data.error)));
            }
          }
        };
      });
      setTestStatus(t('wsSuccess'),'success'); btn.textContent=t('successLabel');
    }catch(e){
      setTestStatus(tpl('failedPrefix',{msg:e.message}),'error'); btn.textContent=t('failedLabel');
    }finally{
      clearTimeout(timer);
      try{ ws?.close(); }catch(e){}
      const defaultLabel=btn.dataset.defaultLabel||orig||t('startTest');
      setTimeout(()=>{ btn.textContent=defaultLabel; btn.disabled=false; },1700);
    }
    return;
  }

  /* ── 其他 Provider：HTTP 測試（原有邏輯） ── */
  const apiKey = els.providerApiKey?.value.trim() || '';
  const customUrl = els.providerBaseUrl?.value.trim() || '';
  const defaultUrl = PROVIDER_DEFAULTS[currentProvider]?.baseUrl || '';
  const endpoint = normalizeEndpoint(customUrl || defaultUrl);
  
  if(!endpoint){
    setTestStatus(t('baseUrlNotSet'),'error');
    return;
  }
  
  if(!apiKey && PROVIDER_DEFAULTS[currentProvider]?.id !== 'ollama' && PROVIDER_DEFAULTS[currentProvider]?.id !== 'lmstudio'){
    setTestStatus(t('noApiKeyWarning'),'warning');
  }
  
  // Save current config before testing
  await new Promise(r=>chrome.storage.local.set({ apiKey, apiEndpoint:endpoint },r));
  const perm=await ensureHostPermission(endpoint);
  if(!perm.granted){ setTestStatus(t('unauthorized'),'error'); return; }

  btn.disabled=true; btn.textContent=t('testing'); setTestStatus(t('testing'));

  try{
    let ok=false;
    if(apiKey){
      const headers={ 'Authorization':'Bearer '+apiKey };
      let modelsBase=endpoint.replace(/\/models\/?$/,'').replace(/\/+$/,'');
      if(modelsBase && !/\/v1$/.test(modelsBase)) modelsBase=modelsBase+'/v1';
      const modelsUrl=(modelsBase||'https://api.openai.com/v1')+'/models';
      const r=await fetch(modelsUrl,{ headers });
      if(r.ok){
        setTestStatus(t('successModels'),'success'); btn.textContent=t('successLabel'); ok=true;
      }
    }
    if(!ok){
      const headers={ 'Content-Type':'application/json' };
      if(apiKey) headers.Authorization='Bearer '+apiKey;
      const chatUrl=buildChatCompletionsUrl(endpoint);
      const r2=await fetch(chatUrl,{
        method:'POST',
        headers,
        body:JSON.stringify({ model:'gpt-3.5-turbo', messages:[{role:'system',content:'ping'},{role:'user',content:'hello'}], max_tokens:5 })
      });
      if(!r2.ok){
        const t=await r2.text(); throw new Error('HTTP '+r2.status+' '+t.slice(0,120));
      }
      setTestStatus(apiKey?t('successChat'):t('successChatNoKey'),'success'); btn.textContent=t('successLabel');
    }
  }catch(e){
    const m=e.message||String(e);
    if(/Failed to fetch/i.test(m)) setTestStatus(t('cannotConnect'),'error');
    else if(/401/.test(m)) setTestStatus(apiKey?t('authKeyFailed'):t('proxyAuthFailed'),'error');
    else setTestStatus(tpl('failedPrefix',{msg:m}),'error');
    btn.textContent=t('failedLabel');
  }finally{
    const defaultLabel=btn.dataset.defaultLabel||orig||t('startTest');
    setTimeout(()=>{ btn.textContent=defaultLabel; btn.disabled=false; },1700);
  }
}


/* ---------- Models ---------- */
function normalizeModels(raw){
  let list=raw;
  if(typeof list==='string'){ try{ list=JSON.parse(list);}catch{ list=[]; } }
  if(!Array.isArray(list)) list=[];
  return list.map(m=>({
    name:m.name||m.id||m.model||'',
    enabled:!!(m.enabled||m.active||m.on),
    provider:m.provider||m.vendor||m.source||null,
    ...(m.thinkingParams ? { thinkingParams: m.thinkingParams } : {}),
    ...(m.prefixPrompt ? { prefixPrompt: m.prefixPrompt } : {})
  }));
}
// 判斷模型預設歸屬的 provider（若不在任何預設名單，回傳 null，視為自定義）
function getModelOwner(modelName){
  if(!modelName) return null;
  for(const pid of Object.keys(PROVIDER_DEFAULTS)){
    if((PROVIDER_DEFAULTS[pid].models||[]).includes(modelName)) return pid;
  }
  return null;
}
// 清理模型清單：
// 1) 去除空名
// 2) 去重（以名稱為 key）
// 3) 過濾掉屬於其他 provider 的預設模型
function sanitizeModels(models, currentProviderId){
  const seen=new Set();
  const out=[];
  (Array.isArray(models)?models:[]).forEach(m=>{
    const name=(m?.name||'').trim(); if(!name) return;
    const owner=getModelOwner(name);
    // 若此名稱明確屬於其它 provider 的預設模型，則不保留
    if(owner && owner!==currentProviderId) return;
    // 若模型有 provider 欄位但與當前供應商不同，也不保留
    if(m?.provider && m.provider!==currentProviderId) return;
    if(seen.has(name)) return; seen.add(name);
    out.push({ name, enabled: !!m.enabled, provider: currentProviderId, ...(m.thinkingParams ? { thinkingParams: m.thinkingParams } : {}), ...(m.prefixPrompt ? { prefixPrompt: m.prefixPrompt } : {}) });
  });
  return out;
}
// 清理所有 provider 的模型，移除跨 provider 的重複模型
function cleanupAllProviderModels(){
  let hasChanges = false;
  const cleanedData = {};
  
  Object.keys(providersData).forEach(providerId => {
    const provider = providersData[providerId];
    if(!provider || !Array.isArray(provider.models)) return;
    
    const originalModels = provider.models;
    // 嚴格清理：移除屬於其他 provider 的預設模型
    let cleaned = sanitizeModels(originalModels, providerId);

    // 檢查是否有變化
    if(JSON.stringify(cleaned) !== JSON.stringify(originalModels)){
      hasChanges = true;
      providersData[providerId].models = cleaned;
      cleanedData[`provider_${providerId}`] = {
        apiKey: provider.apiKey || '',
        customBaseUrl: provider.customBaseUrl || '',
        models: cleaned.map(m => ({ ...m, provider: providerId })),
        enableThinking: provider.enableThinking || false
      };
      console.log(`[OPT] Cleaned models for ${providerId}:`, cleaned.length, 'models');
    }
  });
  
  // 如果有變化，保存清理後的數據
  if(hasChanges && Object.keys(cleanedData).length > 0){
    chrome.storage.sync.set(cleanedData, () => {
      console.log('[OPT] Cleaned and saved all provider models');
    });
  }
}
// 確保預設模型存在（不可刪除），若缺失則自動補回且預設啟用狀態遵循 PROVIDER_DEFAULTS
function ensureDefaultModels(models, providerId){
  const out = Array.isArray(models) ? models.slice() : [];
  const defaults = PROVIDER_DEFAULTS[providerId]?.models || [];
  if(!defaults.length) return out;
  const enabledSet = new Set(PROVIDER_DEFAULTS[providerId]?.enabledModels || []);
  const byName = new Map(out.map(m=>[m?.name, m]));
  defaults.forEach(name=>{
    if(!byName.has(name)){
      out.push({ name, enabled: enabledSet.has(name), provider: providerId });
    }
  });
  return out;
}
function addModelRow(data={}, focus){
  const node=els.tplModelRow.content.firstElementChild.cloneNode(true);
  const name=node.querySelector('.model-name-input');
  const enabled=node.querySelector('.model-enabled');
  const thinkingInput=node.querySelector('.model-thinking-params');
  const prefixInput=node.querySelector('.model-prefix-prompt');
  const del=node.querySelector('.delete-model');
  name.value=data.name||''; enabled.checked=data.enabled!==false;
  if(thinkingInput){
    thinkingInput.value = data.thinkingParams||'';
    thinkingInput.addEventListener('input', ()=>{
      const v = thinkingInput.value.trim();
      thinkingInput.classList.remove('invalid');
      if(v){ try{ JSON.parse(v); } catch(e){ thinkingInput.classList.add('invalid'); return; } }
      persistModels();
    });
  }
  if(prefixInput){
    prefixInput.value = data.prefixPrompt||'';
    prefixInput.addEventListener('input', debounce(persistModels, 400));
  }
  name.addEventListener('input', debounce(persistModels, 400));
  enabled.addEventListener('change',persistModels);
  if(del){ del.addEventListener('click',()=>{ node.remove(); persistModels(); }); }
  els.modelList.appendChild(node);
  if(focus) name.focus();
  persistModels();
}
function collectModels(){
  return [...els.modelList.querySelectorAll('.model-row')].map(r=>{
    const thinkingInput = r.querySelector('.model-thinking-params');
    const thinkingParams = thinkingInput?.value.trim() || '';
    const prefixInput = r.querySelector('.model-prefix-prompt');
    const prefixPrompt = prefixInput?.value.trim() || '';
    return {
      name:r.querySelector('.model-name-input').value.trim(),
      enabled:r.querySelector('.model-enabled').checked,
      provider: currentProvider,
      ...(thinkingParams ? { thinkingParams } : {}),
      ...(prefixPrompt ? { prefixPrompt } : {})
    };
  }).filter(m=>m.name);
}
function updateMergedModels(){
  // Collect ALL enabled models from ALL providers for sidepanel
  const allEnabledModels = [];
  const modelNames = new Set(); // 用來去重
  
  Object.keys(providersData).forEach(providerId => {
    const provider = providersData[providerId];
    if(provider && provider.models){
      provider.models.forEach(model => {
        if(model.enabled && model.name && !modelNames.has(model.name)){
          allEnabledModels.push({
            name: model.name,
            enabled: true,
            provider: providerId,
            ...(model.thinkingParams ? { thinkingParams: model.thinkingParams } : {}),
            ...(model.prefixPrompt ? { prefixPrompt: model.prefixPrompt } : {})
          });
          modelNames.add(model.name);
        }
      });
    }
  });
  
  console.log('[OPT] All unique enabled models across providers:', allEnabledModels);
  
  // Also save provider configs for sidepanel to use
  const providerConfigs = {};
  Object.keys(providersData).forEach(providerId => {
    const provider = providersData[providerId];
    providerConfigs[providerId] = {
      apiKey: provider.apiKey || '',
      baseUrl: provider.customBaseUrl || provider.baseUrl || '',
      ...(PROVIDER_DEFAULTS[providerId]?.isOpenClaw ? { sessionKey: provider.sessionKey || '', isOpenClaw: true } : {})
    };
  });
  
  // Save merged list and provider configs to sidepanel
  chrome.storage.local.set({ 
    customModels: allEnabledModels,
    providerConfigs: providerConfigs
  });
}

function persistModels(){
  // 收集並先行清理，避免把其它供應商的預設模型寫進當前供應商
  const collected=collectModels();
  let ms=sanitizeModels(collected, currentProvider);
  els.modelCount.textContent=`(${ms.length})`;
  
  // Save to current provider
  if(currentProvider && providersData[currentProvider]){
    providersData[currentProvider].models = ms;
    const storageKey = `provider_${currentProvider}`;
    chrome.storage.sync.set({
      [storageKey]: {
        apiKey: providersData[currentProvider].apiKey,
        customBaseUrl: providersData[currentProvider].customBaseUrl,
        // 寫入時保證每筆模型都標記 provider
        models: ms.map(m=>({ ...m, provider: currentProvider }))
      }
    });
  }
  
  // Update merged models list
  updateMergedModels();
}
function updateModelCount(){ els.modelCount.textContent=`(${collectModels().length})`; }
/* ---------- System Prompts Cards + Panel ---------- */
function renderPromptCards(list, selectedId){
  const effectiveSelected=selectedId || DEFAULT_PROMPT_ID;
  els.promptCardList.innerHTML='';
  list.forEach(p=>appendPromptCard(p, effectiveSelected));
  // Don't auto-save on render to avoid duplicate badge issues
}

function appendPromptCard(p, selectedId){
  const card=els.tplPromptCard.content.firstElementChild.cloneNode(true);
  card.dataset.id=p.id;
  card.dataset.content=p.prompt;
  const title=card.querySelector('.sp-title');
  
  // 清空並重新構建標題結構
  title.innerHTML='';
  const nameSpan=document.createElement('span');
  nameSpan.textContent=p.name;
  nameSpan.title=p.name;
  title.appendChild(nameSpan);
  
  const radio=card.querySelector('.sp-radio');
  radio.checked=(p.id===selectedId);
  if(radio.checked) card.classList.add('active');
  
  // 顯示/隱藏開關
  const visibleToggle=card.querySelector('.sp-visible');
  const isVisible=p.visible !== false;
  if(visibleToggle){
    visibleToggle.checked=isVisible;
    if(!isVisible) card.classList.add('sp-hidden');
    visibleToggle.addEventListener('change',()=>{
      card.classList.toggle('sp-hidden', !visibleToggle.checked);
      persistPrompts();
    });
  }
  
  // 添加或移除「預設」標籤
  updateDefaultBadge(card, radio.checked);
  
  radio.addEventListener('change',()=>{
    [...els.promptCardList.querySelectorAll('.sp-card')].forEach(c=>{
      c.classList.remove('active');
      updateDefaultBadge(c, false);
    });
    if(radio.checked){
      card.classList.add('active');
      updateDefaultBadge(card, true);
    }
    persistPrompts();
  });
  els.promptCardList.appendChild(card);
}

function updateDefaultBadge(card, isDefault){
  const title=card.querySelector('.sp-title');
  if(!title) return;
  
  // 移除現有的標籤
  const existingBadge=title.querySelector('.default-badge');
  if(existingBadge) existingBadge.remove();
  
  // 如果是預設，添加標籤
  if(isDefault){
    const badge=document.createElement('span');
    badge.className='default-badge';
    badge.textContent=t('defaultBadge');
    title.appendChild(badge);
  }
}

function promptCardClick(e){
  const card=e.target.closest('.sp-card');
  if(!card) return;
  if(e.target.closest('.sp-edit')){
    openEditor(card);
    return;
  }
  if(e.target.closest('.sp-delete')){
    // 直接刪除，不顯示確認彈窗
    const wasActive=card.classList.contains('active');
    const deletedId = card.dataset.id;
    const deletedName = card.querySelector('.sp-title')?.querySelector('span:not(.default-badge)')?.textContent || card.dataset.id;
    
    console.log('[OPT] Deleting prompt:', { id: deletedId, name: deletedName });
    
    // Track if this is a default prompt being deleted
    const defaultIds = DEFAULT_PROMPTS.map(p => p.id);
    if(defaultIds.includes(deletedId)){
      chrome.storage.sync.get('deletedDefaultPrompts', ({deletedDefaultPrompts})=>{
        const deleted = Array.isArray(deletedDefaultPrompts) ? deletedDefaultPrompts : [];
        if(!deleted.includes(deletedId)){
          deleted.push(deletedId);
          chrome.storage.sync.set({ deletedDefaultPrompts: deleted });
          console.log(`[OPT] Tracked deletion of default prompt: ${deletedId}`);
        }
      });
    }
    
    // 移除卡片
    card.remove();
    console.log('[OPT] Card removed from DOM');
    
    // 如果刪除的是當前選中的，選擇第一個卡片
    if(wasActive){
      const first=els.promptCardList.querySelector('.sp-card');
      if(first){
        first.querySelector('.sp-radio').checked=true;
        first.classList.add('active');
        updateDefaultBadge(first, true);
        console.log('[OPT] Activated first card after deletion:', first.dataset.id);
      }
    }
    
    closeEditor();
    
    // 保存更新後的列表（這會觸發 storage 事件）
    persistPrompts();
    console.log('[OPT] persistPrompts() called after deletion');
    
    setStatus(tpl('deletedPrompt',{name:deletedName}), 'success');
    return;
  }
}

function addPromptCard(){
  const id=uuid();
  // 獲取當前選中的提示詞 ID，保持不變
  const currentSelected=els.promptCardList.querySelector('.sp-card.active')?.dataset.id;
  appendPromptCard({ id, name:t('newPromptName'), prompt:'' }, currentSelected);
  persistPrompts();
  setStatus(t('addedPrompt'),'success');
  // 直接進入編輯
  const card=els.promptCardList.querySelector(`.sp-card[data-id="${id}"]`);
  openEditor(card);
}

async function resetPrompts(){
  if(!await showConfirm(t('confirmReset'))) return;
  
  console.log('[OPT] Resetting to defaults...');
  
  // 1. Clear deletion tracking
  await chrome.storage.sync.set({ deletedDefaultPrompts: [] });
  console.log('[OPT] Cleared deletedDefaultPrompts');
  
  // 2. Clear old prompts from both storages
  await chrome.storage.local.remove(['prompts', 'defaultPrompt', 'selectedPrompt']);
  await chrome.storage.sync.remove(['prompts', 'defaultPrompt', 'selectedPrompt']);
  console.log('[OPT] Cleared old prompts from both storages');
  
  // 3. Reset prompts — always write to local so sidepanel storage listener fires correctly
  const defaultPrompts = cloneDefaultPrompts();
  const dataStr = JSON.stringify(defaultPrompts);
  const dataSize = new Blob([dataStr]).size;
  if(dataSize > 7000){
    await chrome.storage.local.set({ prompts: defaultPrompts, defaultPrompt: DEFAULT_PROMPT_ID, selectedPrompt: DEFAULT_PROMPT_ID });
    await chrome.storage.sync.set({ promptsVersion: PROMPTS_VERSION });
  } else {
    await chrome.storage.sync.set({ promptsVersion: PROMPTS_VERSION });
    await chrome.storage.local.set({ prompts: defaultPrompts, defaultPrompt: DEFAULT_PROMPT_ID, selectedPrompt: DEFAULT_PROMPT_ID });
  }
  console.log('[OPT] Reset prompts:', defaultPrompts.length);
  
  // 3. Reset all providers' models to defaults (disabled)
  const providerUpdates = {};
  Object.keys(PROVIDER_DEFAULTS).forEach(id => {
    const enabledSet = new Set(PROVIDER_DEFAULTS[id]?.enabledModels || []);
    const defaultModels = PROVIDER_DEFAULTS[id].models.map(name => ({
      name,
      // 根據各 provider 的 enabledModels 設定來決定是否啟用
      enabled: enabledSet.has(name)
    }));
    
    // Update in memory
    if(providersData[id]) {
      providersData[id].models = defaultModels;
      // 將 Provider 的 API 設定恢復為默認值
      providersData[id].apiKey = PROVIDER_DEFAULTS[id]?.defaultApiKey || '';
      providersData[id].customBaseUrl = '';
      providersData[id].enableThinking = !!PROVIDER_DEFAULTS[id]?.defaultEnableThinking;
    }
    
    // Prepare for storage
    providerUpdates[`provider_${id}`] = {
      // 使用默認 API 參數；Base URL 留空代表沿用默認 baseUrl
      apiKey: PROVIDER_DEFAULTS[id]?.defaultApiKey || '',
      customBaseUrl: '',
      models: defaultModels,
      enableThinking: !!PROVIDER_DEFAULTS[id]?.defaultEnableThinking
    };
  });
  
  // Save all provider data to sync; clear merged local models
  await Promise.all([
    chrome.storage.sync.set(providerUpdates),
    chrome.storage.local.set({ customModels: [] })
  ]);
  console.log('[OPT] Reset all provider models');
  
  // 4. Reload current provider config and models in UI
  if(currentProvider) {
    // 先載入 Provider 配置（Base URL、API Key、思考模式）
    loadProviderConfig(currentProvider);
    // 再刷新模型清單
    loadModelsForProvider(currentProvider);
  }
  
  // 5. Render prompts UI
  renderPromptCards(defaultPrompts, DEFAULT_PROMPT_ID);
  closeEditor();
  
  setStatus(tpl('resetComplete',{count:defaultPrompts.length}),'success');
}

let currentEditorPromptId=null;

function openEditor(card){
  const pid=card.dataset.id;
  if(currentEditorPromptId===pid){ closeEditor(); return; }
  closeEditor();

  const modal=document.getElementById('promptModal');
  const nameInput=modal.querySelector('.sp-edit-name');
  const textArea=modal.querySelector('.sp-edit-text');

  // 填入現有值
  const titleEl=card.querySelector('.sp-title');
  const nameSpan=titleEl.querySelector('span:not(.default-badge)');
  nameInput.value=nameSpan ? nameSpan.textContent.trim() : titleEl.textContent.trim().replace(new RegExp(t('defaultBadge')+'$'), '').trim();
  textArea.value=card.dataset.content||'';

  const saveChanges = () => {
    const newName=nameInput.value.trim()||t('unnamed');
    const newContent=textArea.value;
    const titleEl=card.querySelector('.sp-title');
    if(!titleEl) return;
    const existingBadge=titleEl.querySelector('.default-badge');
    const badgeText=existingBadge ? existingBadge.textContent : '';
    const nameSpan=titleEl.querySelector('span:not(.default-badge)');
    if(nameSpan){
      nameSpan.textContent=newName;
      nameSpan.title=newName;
    }else{
      titleEl.innerHTML='';
      const newSpan=document.createElement('span');
      newSpan.textContent=newName; newSpan.title=newName;
      titleEl.appendChild(newSpan);
      if(badgeText){
        const badge=document.createElement('span');
        badge.className='default-badge'; badge.textContent=badgeText;
        titleEl.appendChild(badge);
      }
    }
    card.dataset.content=newContent;
    persistPrompts();
  };

  // 移除舊的 listener（換新的 card）
  const newCloseBtn=modal.querySelector('.prompt-modal-close');
  const newSaveBtn=modal.querySelector('.sp-update');
  const newBackdrop=modal.querySelector('.prompt-modal-backdrop');
  const closeClone=newCloseBtn.cloneNode(true);
  const saveClone=newSaveBtn.cloneNode(true);
  newCloseBtn.replaceWith(closeClone);
  newSaveBtn.replaceWith(saveClone);

  closeClone.addEventListener('click', ()=>closeEditor());
  saveClone.addEventListener('click', ()=>{
    saveChanges();
    setStatus(t('updated'),'success');
    closeEditor();
  });
  newBackdrop.onclick = ()=>closeEditor();

  // Esc 關閉
  modal._escHandler = (e)=>{ if(e.key==='Escape') closeEditor(); };
  document.addEventListener('keydown', modal._escHandler);

  modal.removeAttribute('hidden');
  currentEditorPromptId=pid;
  if(typeof window.__applyTranslations === 'function'){
    window.__applyTranslations(currentLang).catch(()=>{});
  }
  nameInput.focus();
}

function closeEditor(){
  const modal=document.getElementById('promptModal');
  if(modal){
    modal.setAttribute('hidden','');
    if(modal._escHandler){
      document.removeEventListener('keydown', modal._escHandler);
      modal._escHandler=null;
    }
  }
  currentEditorPromptId=null;
}

function collectPromptsFromUI(){
  const items=[...els.promptCardList.querySelectorAll('.sp-card')];
  console.log('[OPT] collectPromptsFromUI - Found', items.length, 'cards');
  
  const prompts=items.map(c=>{
    const titleEl=c.querySelector('.sp-title');
    if(!titleEl){
      console.warn('[OPT] collectPromptsFromUI - No title element found for card:', c.dataset.id);
      return {
        id:c.dataset.id,
        name:t('unnamed'),
        prompt:c.dataset.content||''
      };
    }
    
    // 優先從 span 讀取（排除 default-badge）
    const nameSpan=titleEl.querySelector('span:not(.default-badge)');
    let name = '';
    if(nameSpan){
      name = nameSpan.textContent.trim();
      console.log('[OPT] collectPromptsFromUI - Card', c.dataset.id, 'name from span:', name);
    } else {
      // 備用：從 titleEl 的 textContent 讀取，但要移除 "預設" 標籤
      name = titleEl.textContent.trim().replace(new RegExp(t('defaultBadge')+'$','g'), '').trim();
      console.log('[OPT] collectPromptsFromUI - Card', c.dataset.id, 'name from textContent:', name);
    }
    
    const visibleToggle=c.querySelector('.sp-visible');
    const promptData = {
      id:c.dataset.id,
      name:name||t('unnamed'),
      prompt:c.dataset.content||'',
      visible: visibleToggle ? visibleToggle.checked : true
    };
    
    console.log('[OPT] collectPromptsFromUI - Collected:', promptData.id, '=', promptData.name, '(content length:', promptData.prompt.length, ')');
    return promptData;
  });
  
  const selected=items.find(c=>c.querySelector('.sp-radio').checked);
  const selectedId = selected?selected.dataset.id:null;
  console.log('[OPT] collectPromptsFromUI - Selected prompt ID:', selectedId);
  
  return { prompts, selectedPrompt: selectedId };
}

function persistPrompts(){
  const { prompts, selectedPrompt } = collectPromptsFromUI();
  const finalSelected=selectedPrompt || prompts[0]?.id || DEFAULT_PROMPT_ID;
  
  console.log('[OPT] persistPrompts - Collected prompts:', prompts.map(p => ({ id: p.id, name: p.name })));
  console.log('[OPT] persistPrompts - Selected:', finalSelected);
  
  // 驗證收集到的數據
  if(!Array.isArray(prompts) || prompts.length === 0){
    console.error('[OPT] persistPrompts - No prompts collected or invalid data!');
    setStatus(t('saveFailed')+': '+t('noPromptData'),'error');
    return;
  }
  
  // 計算數據大小（僅用於日誌）
  const dataStr = JSON.stringify(prompts);
  const dataSize = new Blob([dataStr]).size;
  
  console.log('[OPT] persistPrompts - Data size:', dataSize, 'bytes');
  console.log('[OPT] persistPrompts - Using LOCAL storage only (to avoid confusion)');
  
  // 強制使用本地存儲，避免同步和本地混用造成的問題
  // 同時清除同步存儲中的舊數據，避免混用
  chrome.storage.local.set({ prompts, defaultPrompt: finalSelected }, ()=>{
    if(chrome.runtime.lastError){
      console.error('[OPT] Failed to save to local storage:', chrome.runtime.lastError);
      setStatus(tpl('saveFailedMsg',{msg:chrome.runtime.lastError.message}),'error');
    } else {
      console.log('[OPT] Successfully saved to local storage');
      // 清除同步存儲中的舊數據，避免混用
      chrome.storage.sync.remove(['prompts', 'defaultPrompt', 'selectedPrompt'], () => {
        console.log('[OPT] Cleared sync storage to avoid confusion');
      });
      setStatus(t('promptsSaved'),'success');
    }
  });
}
function persistPromptsSilently(){
  const { prompts, selectedPrompt } = collectPromptsFromUI();
  const finalSelected=selectedPrompt || prompts[0]?.id || DEFAULT_PROMPT_ID;
  
  // 強制使用本地存儲
  chrome.storage.local.set({ prompts, defaultPrompt: finalSelected });
}

/* ---------- Utilities ---------- */
// Debug helper: check storage
window.__debugPrompts = async function(){
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(['prompts','defaultPrompt']),
    chrome.storage.sync.get(['prompts','defaultPrompt'])
  ]);
  console.log('[DEBUG] Local storage prompts:', local.prompts?.length || 0, 'items');
  console.log('[DEBUG] Sync storage prompts:', sync.prompts?.length || 0, 'items');
  if(local.prompts){
    const dataStr = JSON.stringify(local.prompts);
    const dataSize = new Blob([dataStr]).size;
    console.log('[DEBUG] Local prompts data size:', dataSize, 'bytes');
  }
  if(sync.prompts){
    const dataStr = JSON.stringify(sync.prompts);
    const dataSize = new Blob([dataStr]).size;
    console.log('[DEBUG] Sync prompts data size:', dataSize, 'bytes');
  }
  return { local, sync };
};

async function applyLanguageConversion(){
  chrome.storage.local.get('zhVariant', async ({zhVariant})=>{
    const lang = zhVariant || _defaultLang();
    console.log('[OPT] Applying language:', lang);

    function walkTextNodes(node, variant){
      if(node.nodeType === Node.TEXT_NODE){
        const text = node.textContent;
        if(text && text.trim()){
          node.textContent = __zhConvert(text, variant);
        }
      } else if(node.nodeType === Node.ELEMENT_NODE){
        if(node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'CODE') return;
        if(node.hasAttribute('data-i18n') || node.hasAttribute('data-i18n-title') || 
           node.hasAttribute('data-i18n-placeholder') || node.hasAttribute('data-i18n-tooltip') ||
           node.hasAttribute('data-i18n-aria-label')) return;
        if(node.tagName === 'OPTION' && node.hasAttribute('data-i18n')) return;
        if(node.placeholder && !node.hasAttribute('data-i18n-placeholder')) {
          node.placeholder = __zhConvert(node.placeholder, variant);
        }
        if(node.title && !node.hasAttribute('data-i18n-title')) {
          node.title = __zhConvert(node.title, variant);
        }
        if(node.getAttribute('data-tooltip') && !node.hasAttribute('data-i18n-tooltip')) {
          node.setAttribute('data-tooltip', __zhConvert(node.getAttribute('data-tooltip'), variant));
        }
        for(let child of node.childNodes){
          walkTextNodes(child, variant);
        }
      }
    }
    
    if(lang === 'en'){
      if(typeof window.__applyTranslations === 'function'){
        await window.__applyTranslations('en');
      }
      if(typeof window.__zhConvert === 'function'){
        walkTextNodes(document.body, 'hant');
      }
      console.log('[OPT] Applied English translations');
      return;
    }
    
    if(typeof window.__zhConvert !== 'function') {
      console.warn('[OPT] __zhConvert not loaded yet, retrying...');
      setTimeout(applyLanguageConversion, 50);
      return;
    }
    
    if(lang === 'hant') {
      if(typeof window.__applyTranslations === 'function'){
        await window.__applyTranslations('hant');
      }
      walkTextNodes(document.body, 'hant');
      console.log('[OPT] Applied traditional Chinese');
      return;
    }
    
    if(typeof window.__applyTranslations === 'function'){
      await window.__applyTranslations('hans');
    }
    walkTextNodes(document.body, 'hans');
    console.log('[OPT] Applied simplified Chinese');
  });
}

/* ---------- Web Search Settings ---------- */
async function loadWebSearchSettings(){
  try{
    const keys = [
      'webSearchProvider', 'braveSearchApiKey', 'tavilyApiKey',
      'simpleInternetSearch', 'totalSearchResults', 'visitWebsiteInMessage',
      'webSearchEnabled'
    ];
    const data = await chrome.storage.local.get(keys);
    let provider = data.webSearchProvider || 'duckduckgo';
    if(els.webSearchProviderSelect){
      els.webSearchProviderSelect.value = provider;
    }
    if(els.braveSearchApiKeyInput){
      els.braveSearchApiKeyInput.value = data.braveSearchApiKey || '';
    }
    if(els.tavilyApiKeyInput){
      els.tavilyApiKeyInput.value = data.tavilyApiKey || '';
    }
    if(els.simpleInternetSearchToggle){
      els.simpleInternetSearchToggle.checked = data.simpleInternetSearch !== false;
    }
    if(els.totalSearchResultsInput){
      els.totalSearchResultsInput.value = data.totalSearchResults || 5;
    }
    if(els.visitWebsiteInMessageToggle){
      els.visitWebsiteInMessageToggle.checked = data.visitWebsiteInMessage !== false;
    }
    if(els.internetSearchOnByDefaultToggle){
      els.internetSearchOnByDefaultToggle.checked = !!data.webSearchEnabled;
    }
    els.braveKeyFields?.classList.toggle('hidden', provider !== 'brave');
    els.tavilyKeyFields?.classList.toggle('hidden', provider !== 'tavily');
  }catch(e){
    console.warn('[OPT] loadWebSearchSettings error:', e);
  }
}

async function saveWebSearchSettings(){
  try{
    const provider = els.webSearchProviderSelect?.value || 'duckduckgo';
    const braveKey = els.braveSearchApiKeyInput?.value?.trim() || '';
    const tavilyKey = els.tavilyApiKeyInput?.value?.trim() || '';
    const simpleMode = els.simpleInternetSearchToggle?.checked !== false;
    const totalResults = parseInt(els.totalSearchResultsInput?.value) || 5;
    const visitWebsite = els.visitWebsiteInMessageToggle?.checked !== false;
    const searchOnByDefault = !!els.internetSearchOnByDefaultToggle?.checked;
    await chrome.storage.local.set({
      webSearchProvider: provider,
      braveSearchApiKey: braveKey,
      tavilyApiKey: tavilyKey,
      simpleInternetSearch: simpleMode,
      totalSearchResults: Math.max(1, Math.min(20, totalResults)),
      visitWebsiteInMessage: visitWebsite,
      webSearchEnabled: searchOnByDefault
    });
    setStatus(t('webSearchSaved'),'success');
  }catch(e){
    console.warn('[OPT] saveWebSearchSettings error:', e);
  }
}

async function testWebSearch(){
  const btn = els.testWebSearchBtn;
  const status = els.testWebSearchStatus;
  if(!btn) return;

  await saveWebSearchSettings();

  btn.disabled = true;
  status.textContent = t('testing');
  status.style.color = '';

  const testQuery = 'latest news today';
  const provider = els.webSearchProviderSelect?.value || 'duckduckgo';

  try{
    console.log('[OPT] Testing web search, provider:', provider);
    const startTime = Date.now();
    const results = await WebSearch.search(testQuery);
    const elapsed = Date.now() - startTime;

    if(results && results.length > 0){
      status.textContent = `✓ ${t('successLabel')} (${results.length} ${t('webSearchResultCount')}, ${elapsed}ms)`;
      status.style.color = '#22c55e';
    } else {
      status.textContent = `✗ ${t('webSearchNoResults')} (${elapsed}ms)`;
      status.style.color = '#ef4444';
    }
  }catch(e){
    console.error('[OPT] Web search test error:', e);
    status.textContent = `✗ ${t('failedLabel')}: ${e.message}`;
    status.style.color = '#ef4444';
  }finally{
    btn.disabled = false;
  }
}

window.__optDump = async ()=>{
  const [l,s]=await Promise.all([
    chrome.storage.local.get(null),
    chrome.storage.sync.get(null)
  ]);
  console.log('LOCAL=', l);
  console.log('SYNC=', s);
};
