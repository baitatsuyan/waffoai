// リアルタイム音声クライアント（ブラウザ）。
// - 1対1：マイク → キャラの Realtime セッション（speech-to-speech、割り込みはモデルの VAD）
// - グループ：マイク → 「耳」セッション（聞き取りのみ）。聞き取った文字を、答えるキャラの「声」セッションに渡して順番に話させる。
//   ユーザが話し始めたら、話しているキャラを止める（割り込み）。
// - 通訳：マイク → 翻訳セッション。「自分が話す／相手が話す」で訳す方向を切り替える。
// API キーはサーバだけが持つ。SDP はサーバ経由で OpenAI に渡し、課金はハートビートでサーバが行う。

import { pickResponders, stripCall } from './talk-logic.js';

const HEARTBEAT_MS = 20_000;

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// 音量（0〜1）を測る。話しているキャラの光り方や、マイクの反応に使う。
function levelMeter(ctx, stream) {
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  return () => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  };
}

// Realtime への1本の接続（WebRTC＋イベント用データチャネル）
class Link {
  constructor({ onEvent, mic = null, receiveAudio = true }) {
    this.pc = new RTCPeerConnection();
    this.dc = this.pc.createDataChannel('oai-events');
    this.dc.addEventListener('message', (e) => onEvent(JSON.parse(e.data)));
    this.opened = new Promise((resolve) => this.dc.addEventListener('open', resolve, { once: true }));
    if (mic) this.pc.addTrack(mic.getAudioTracks()[0], mic);
    else this.pc.addTransceiver('audio', { direction: 'recvonly' });
    this.remote = new Promise((resolve) => {
      this.pc.ontrack = (e) => resolve(e.streams[0]);
    });
    if (receiveAudio) {
      this.audio = new Audio();
      this.audio.autoplay = true;
      this.remote.then((s) => { this.audio.srcObject = s; });
    }
  }

  async connect(exchange) {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const answer = await exchange(offer.sdp);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await this.opened;
  }

  send(event) {
    if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  close() {
    try { this.dc.close(); } catch {}
    try { this.pc.close(); } catch {}
    if (this.audio) this.audio.srcObject = null;
  }
}

export class VoiceTalk {
  /**
   * @param {object} opts
   * @param {'direct'|'group'|'interpret'} opts.mode
   * @param {{id:number,name:string}[]} opts.members
   * @param {(e: object) => void} opts.onUpdate  画面更新用のイベント
   */
  constructor({ mode, members, onUpdate }) {
    this.mode = mode;
    this.members = members;
    this.emit = onUpdate;
    this.links = new Map(); // characterId | 'ear' | 'translate' -> Link
    this.meters = new Map(); // characterId | 'me' -> () => level
    this.speaking = null; // 話しているキャラの id
    this.lastSpeaker = null;
    this.queue = [];
    this.turn = 0;
    this.ended = false;
    this.captions = new Map(); // response/item -> 途中の字幕
    this.direction = 'out'; // 通訳：out = 自分が話す（相手の言語へ）, in = 相手が話す（日本語へ）
    this.language = 'en';
  }

  async start() {
    const s = await postJson('/api/voice/sessions', { mode: this.mode, characterIds: this.members.map((m) => m.id) });
    this.sessionId = s.sessionId;
    this.emit({ type: 'notice', kind: 'info', message: s.notice });
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.ctx = new AudioContext();
    this.meters.set('me', levelMeter(this.ctx, this.mic));

    if (this.mode === 'direct') await this.connectDirect();
    else if (this.mode === 'group') await this.connectGroup();
    else await this.connectTranslation();

    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.emit({ type: 'status', status: 'live' });
  }

  exchange(role, characterId) {
    return async (sdp) => {
      const res = await fetch(`/api/voice/sessions/${this.sessionId}/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, characterId, sdp }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '接続できませんでした');
      return res.text();
    };
  }

  // ---- 1対1 ----
  async connectDirect() {
    const m = this.members[0];
    const link = new Link({ mic: this.mic, onEvent: (e) => this.onCharacterEvent(m, e, { direct: true }) });
    this.links.set(m.id, link);
    link.remote.then((s) => this.meters.set(m.id, levelMeter(this.ctx, s)));
    await link.connect(this.exchange('direct'));
  }

  // ---- グループ ----
  async connectGroup() {
    const ear = new Link({ mic: this.mic, receiveAudio: false, onEvent: (e) => this.onEarEvent(e) });
    this.links.set('ear', ear);
    await ear.connect(this.exchange('ear'));
    await Promise.all(this.members.map(async (m) => {
      const link = new Link({ onEvent: (e) => this.onCharacterEvent(m, e, { direct: false }) });
      this.links.set(m.id, link);
      link.remote.then((s) => this.meters.set(m.id, levelMeter(this.ctx, s)));
      await link.connect(this.exchange('voice', m.id));
    }));
  }

  onEarEvent(e) {
    if (e.type === 'input_audio_buffer.speech_started') {
      this.interrupt();
      this.emit({ type: 'listening', on: true });
    } else if (e.type === 'input_audio_buffer.speech_stopped') {
      this.emit({ type: 'listening', on: false });
    } else if (e.type === 'conversation.item.input_audio_transcription.completed') {
      const text = (e.transcript ?? '').trim();
      if (text) this.userSaid(text);
    } else if (e.type === 'error') {
      this.emit({ type: 'notice', kind: 'error', message: e.error?.message ?? '音声の聞き取りでエラーが起きました' });
    }
  }

  // ユーザの発言（声でも文字でも）
  userSaid(text) {
    this.emit({ type: 'line', role: 'user', text });
    this.report({ role: 'user', text });
    if (this.mode === 'direct') return; // 1対1は音声ならモデルが自分で聞いている
    const turn = ++this.turn;
    const responders = pickResponders(text, this.members, this.lastSpeaker);
    // 全員に会話の流れを渡し、答えるキャラだけに話させる
    for (const m of this.members) {
      this.links.get(m.id)?.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: responders.includes(m) ? stripCall(text, m) : text }] },
      });
    }
    this.queue = responders.map((m) => ({ m, turn }));
    this.next();
  }

  next() {
    if (this.speaking || !this.queue.length) return;
    const { m, turn } = this.queue.shift();
    if (turn !== this.turn) return this.next();
    this.speaking = m.id;
    this.emit({ type: 'speaking', id: m.id });
    this.links.get(m.id).send({ type: 'response.create' });
    // 応答が返らないときの保険
    clearTimeout(this.stuck);
    this.stuck = setTimeout(() => this.finishSpeaking(m.id), 30_000);
  }

  finishSpeaking(id) {
    if (this.speaking !== id) return;
    clearTimeout(this.stuck);
    this.speaking = null;
    this.lastSpeaker = id;
    this.emit({ type: 'speaking', id: null });
    this.next();
  }

  // 割り込み：話しているキャラを止め、まだ話していないキャラの順番も取り消す
  interrupt() {
    this.queue = [];
    if (this.mode !== 'group' || !this.speaking) return;
    const link = this.links.get(this.speaking);
    link?.send({ type: 'response.cancel' });
    link?.send({ type: 'output_audio_buffer.clear' });
    this.finishSpeaking(this.speaking);
  }

  // ---- キャラのセッションからのイベント（1対1・グループ共通） ----
  async onCharacterEvent(m, e, { direct }) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        if (direct) this.emit({ type: 'listening', on: true });
        break;
      case 'input_audio_buffer.speech_stopped':
        if (direct) this.emit({ type: 'listening', on: false });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (direct && e.transcript?.trim()) this.userSaid(e.transcript.trim());
        break;
      case 'output_audio_buffer.started':
        if (direct) { this.speaking = m.id; this.emit({ type: 'speaking', id: m.id }); }
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (direct) { this.speaking = null; this.emit({ type: 'speaking', id: null }); } else this.finishSpeaking(m.id);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': {
        const key = `${m.id}:${e.response_id}`;
        const text = (this.captions.get(key) ?? '') + (e.delta ?? '');
        this.captions.set(key, text);
        this.emit({ type: 'caption', id: m.id, key, text });
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done': {
        const key = `${m.id}:${e.response_id}`;
        const text = (e.transcript ?? e.text ?? this.captions.get(key) ?? '').trim();
        this.captions.delete(key);
        if (!text) break;
        this.emit({ type: 'line', role: 'assistant', id: m.id, key, text });
        this.report({ role: 'assistant', characterId: m.id, text });
        // グループでは、他のキャラにも今の発言を聞かせる（返答はさせない）
        if (!direct) {
          for (const other of this.members) {
            if (other.id === m.id) continue;
            this.links.get(other.id)?.send({
              type: 'conversation.item.create',
              item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `（${m.name}の発言）${text}` }] },
            });
          }
        }
        break;
      }
      case 'response.done': {
        const calls = (e.response?.output ?? []).filter((o) => o.type === 'function_call');
        if (calls.length) await this.runTools(m, calls);
        else if (!direct && e.response?.status !== 'completed') this.finishSpeaking(m.id); // 取り消し・失敗
        break;
      }
      case 'error':
        // 取り消し済みの応答を取り消そうとしたなどの軽いエラーは無視する
        if (!/cancel|no active response/i.test(e.error?.message ?? '')) {
          this.emit({ type: 'notice', kind: 'error', message: e.error?.message ?? 'エラーが起きました' });
        }
        break;
      default:
        break;
    }
  }

  // キャラが道具を使った：サーバで実行して結果を返し、続きを話させる
  async runTools(m, calls) {
    const link = this.links.get(m.id);
    for (const call of calls) {
      let output;
      try {
        output = await postJson(`/api/voice/sessions/${this.sessionId}/tool`, { characterId: m.id, name: call.name, arguments: call.arguments });
      } catch (err) {
        output = { ok: false, error: err.message };
      }
      this.emit({ type: 'tool', id: m.id, name: call.name, ok: output.ok !== false });
      link.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } });
    }
    link.send({ type: 'response.create' });
  }

  // 文字で話しかける（音声と同じ会話に入る）
  sendText(text) {
    if (this.mode === 'direct') {
      const m = this.members[0];
      this.emit({ type: 'line', role: 'user', text });
      this.report({ role: 'user', text });
      const link = this.links.get(m.id);
      link.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      link.send({ type: 'response.create' });
    } else if (this.mode === 'group') {
      this.interrupt();
      this.userSaid(text);
    }
  }

  // ---- 同時通訳 ----
  async connectTranslation() {
    const m = this.members[0];
    const link = new Link({ mic: this.mic, onEvent: (e) => this.onTranslationEvent(m, e) });
    this.links.set('translate', link);
    link.remote.then((s) => this.meters.set(m.id, levelMeter(this.ctx, s)));
    await link.connect(async (sdp) => {
      const { value } = await postJson(`/api/voice/sessions/${this.sessionId}/translation`, { language: this.targetLanguage() });
      const res = await fetch('https://api.openai.com/v1/realtime/translations/calls', {
        method: 'POST', headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/sdp' }, body: sdp,
      });
      if (!res.ok) throw new Error('通訳サーバに接続できませんでした');
      return res.text();
    });
  }

  targetLanguage() {
    return this.direction === 'out' ? this.language : 'ja';
  }

  // 訳す方向・言語を切り替える（自分が話す ⇄ 相手が話す）
  setTranslation({ direction = this.direction, language = this.language }) {
    this.direction = direction;
    this.language = language;
    this.links.get('translate')?.send({ type: 'session.update', session: { audio: { output: { language: this.targetLanguage() } } } });
    this.emit({ type: 'direction', direction, language });
  }

  onTranslationEvent(m, e) {
    const key = `tr:${this.turnKey ?? 0}`;
    if (e.type === 'session.input_transcript.delta') {
      this.source = (this.source ?? '') + e.delta;
      this.emit({ type: 'caption', id: 'me', key: `${key}:in`, text: this.source });
    } else if (e.type === 'session.output_transcript.delta') {
      this.target = (this.target ?? '') + e.delta;
      this.emit({ type: 'caption', id: m.id, key: `${key}:out`, text: this.target });
      clearTimeout(this.flush);
      // 訳が途切れたら1つの発言として確定する
      this.flush = setTimeout(() => {
        if (this.source) this.emit({ type: 'line', role: 'user', text: this.source });
        if (this.target) this.emit({ type: 'line', role: 'assistant', id: m.id, text: this.target, lang: this.targetLanguage() });
        this.source = '';
        this.target = '';
        this.turnKey = (this.turnKey ?? 0) + 1;
      }, 1500);
    } else if (e.type === 'error') {
      this.emit({ type: 'notice', kind: 'error', message: e.error?.message ?? '通訳でエラーが起きました' });
    }
  }

  // ---- マイク・音量・課金・終了 ----
  setMicEnabled(on) {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = on;
    this.emit({ type: 'mic', on });
  }

  level(id) {
    return this.meters.get(id)?.() ?? 0;
  }

  report(line) {
    if (this.mode === 'interpret') return;
    postJson(`/api/voice/sessions/${this.sessionId}/transcript`, line)
      .then((r) => r.notices?.forEach((n) => this.emit({ type: 'notice', ...n })))
      .catch(() => {});
  }

  async heartbeat() {
    try {
      const r = await postJson(`/api/voice/sessions/${this.sessionId}/heartbeat`);
      if (r.ended) return this.stop(r.reason, { remote: true });
      this.emit({ type: 'usage', minutes: r.minutes, usage: r.usage, points: r.points });
      r.notices?.forEach((n) => this.emit({ type: 'notice', ...n }));
    } catch {
      // 一時的な失敗は次のハートビートで取り戻す（サーバは90秒無応答で切る）
    }
  }

  async stop(reason = 'user', { remote = false } = {}) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    clearTimeout(this.stuck);
    clearTimeout(this.flush);
    for (const link of this.links.values()) link.close();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.ctx?.close().catch(() => {});
    if (!remote && this.sessionId) await postJson(`/api/voice/sessions/${this.sessionId}/end`).catch(() => {});
    this.emit({ type: 'status', status: 'ended', reason });
  }
}
