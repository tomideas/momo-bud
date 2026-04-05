/* js/openclaw.js — OpenClaw WebSocket Gateway client
   Extracted from sidepanel.js. Depends on: js/utils.js (generateUUID) */

'use strict';

let openclawGateway = null;

/* ── OpenClaw Gateway Client (aligned with Copilot ug class) ── */
class OpenClawGateway {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.messageHandlers = [];
    this.closed = true;
    this.lastSeq = null;
    this.connectNonce = null;
    this.connectSent = false;
    this.connectTimer = null;
    this.backoffMs = 800;
    this.hello = null;
    this._config = null;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectTimeout = null;
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN && !!this.hello; }

  _uuid() { return generateUUID(); }

  /* Ensure connected */
  async ensureConnected(config) {
    if (this.connected) return;
    this.stop();
    this._config = config;
    this.closed = false;

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._connectTimeout = setTimeout(() => {
        reject(new Error('OpenClaw Gateway connection timeout (15s)'));
        this.stop();
      }, 15000);
      this._connect();
    });
  }

  /* Establish WebSocket connection */
  _connect() {
    if (this.closed) return;
    const config = this._config;
    try {
      this.ws = new WebSocket(config.url);
    } catch (e) {
      this._connectReject?.(new Error('Failed to create WebSocket: ' + e.message));
      return;
    }

    this.ws.addEventListener('open', () => {
      console.log('[OpenClaw] WS 已打開');
      this._queueConnect();
    });

    this.ws.addEventListener('message', (evt) => {
      this._handleMessage(String(evt.data || ''));
    });

    this.ws.addEventListener('close', (evt) => {
      const reason = String(evt.reason || '');
      console.log('[OpenClaw] WS 關閉:', evt.code, reason);
      this.ws = null;
      this._flushPending(new Error('gateway closed (' + evt.code + '): ' + reason));
      if (this._connectReject && !this.hello) {
        clearTimeout(this._connectTimeout);
        this._connectReject(new Error('Connection closed: ' + (reason || evt.code)));
        this._connectReject = null;
      }
    });

    this.ws.addEventListener('error', () => {});
  }

  _flushPending(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /* Queue connect (750ms delay, aligned with Copilot) */
  _queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => this._sendConnect(), 750);
  }

  /* Send connect RPC */
  async _sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }

    const config = this._config;
    const authObj = (config.token || config.password)
      ? { token: config.token || undefined, password: config.password || undefined }
      : undefined;

    const params = {
      minProtocol: 3, maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        version: '1.0.0',
        platform: navigator.platform || 'web',
        mode: 'webchat'
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
      caps: [],
      auth: authObj,
      userAgent: navigator.userAgent,
      locale: navigator.language || 'zh-TW'
    };

    try {
      const hello = await this.request('connect', params);
      console.log('[OpenClaw] ✓ hello-ok', JSON.stringify(hello).slice(0, 300));
      this.hello = hello;
      this.backoffMs = 800;
      clearTimeout(this._connectTimeout);
      this._connectResolve?.();
      this._connectResolve = null;
      this._connectReject = null;
    } catch (e) {
      console.error('[OpenClaw] connect 失敗:', e.message);
      clearTimeout(this._connectTimeout);
      this._connectReject?.(new Error('Connection rejected: ' + e.message));
      this._connectReject = null;
      this.ws?.close(4008, 'connect failed');
    }
  }

  /* Handle WebSocket messages */
  _handleMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    console.log('[OpenClaw] ←', data.type, data.event || '', JSON.stringify(data).slice(0, 400));

    /* event */
    if (data.type === 'event') {
      if (data.event === 'connect.challenge') {
        const nonce = data.payload?.nonce;
        if (typeof nonce === 'string') {
          this.connectNonce = nonce;
          this._sendConnect();
        }
        return;
      }
      const seq = typeof data.seq === 'number' ? data.seq : null;
      if (seq !== null) this.lastSeq = seq;
      try {
        for (const h of this.messageHandlers) h(data);
      } catch (e) { console.error('[OpenClaw] event handler error:', e); }
      return;
    }

    /* res */
    if (data.type === 'res') {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (p.timeoutId) clearTimeout(p.timeoutId);
      if (data.ok) p.resolve(data.payload);
      else p.reject(new Error(data.error?.message || 'request failed'));
      return;
    }
  }

  /* Send RPC request */
  request(method, params, { timeoutMs = 30000 } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('gateway not connected'));
    const id = this._uuid();
    const msg = { type: 'req', id, method, params };
    console.log('[OpenClaw] →', method, JSON.stringify(msg).slice(0, 300));
    const p = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timeout (' + (timeoutMs / 1000) + 's)'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
    });
    this.ws.send(JSON.stringify(msg));
    return p;
  }

  /* Register event listener */
  onEvent(handler) {
    this.messageHandlers.push(handler);
    return () => {
      const idx = this.messageHandlers.indexOf(handler);
      if (idx >= 0) this.messageHandlers.splice(idx, 1);
    };
  }

  stop() {
    this.closed = true;
    if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    this._flushPending(new Error('gateway stopped'));
    this.hello = null;
    this.connectSent = false;
    this.connectNonce = null;
    this.lastSeq = null;
  }

  disconnect() { this.stop(); this.messageHandlers = []; }
}

/* Extract text from OpenClaw message (aligned with Copilot Ou()) */
function extractOpenClawText(msg) {
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map(c => (c && c.type === 'text' && typeof c.text === 'string') ? c.text : null)
      .filter(t => typeof t === 'string');
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof msg.text === 'string') return msg.text;
  return null;
}
