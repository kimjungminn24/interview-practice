// 브라우저 미디어 API 래퍼: 마이크, 녹음, 음량 측정, 받아쓰기(Web Speech), 읽어 주기(TTS)
// DOM은 건드리지 않는다. iPhone Safari 규칙: getUserMedia / AudioContext / speak / MediaRecorder.start는 탭 핸들러 안에서 호출.
import { getSettings } from './store.js';

const W = typeof window !== 'undefined' ? window : {};

export const isTouch = () => !!W.matchMedia?.('(pointer:coarse)').matches;
export const canRecord = () => !!(W.navigator?.mediaDevices?.getUserMedia && W.MediaRecorder);
export const canDictate = () => !!(W.webkitSpeechRecognition || W.SpeechRecognition);

// ---------- 마이크 ----------
let streamPromise = null;
let stream = null;
let audioCtx = null;
let micGen = 0; // releaseMic()마다 올린다. 그 전에 시작한 getUserMedia가 늦게 끝나면 트랙을 바로 끈다.

const stopTracks = (s) => {
  try {
    s?.getTracks().forEach((t) => t.stop());
  } catch {}
};

/** 다시 쓸 수 있는 스트림인가: 살아 있고, (전화·Siri 등으로) 음소거되지 않은 오디오 트랙이 있어야 한다 */
const usable = (s) => !!s && s.getAudioTracks().some((t) => t.readyState === 'live' && !t.muted && t.enabled !== false);

/** 마이크 스트림 (한 번 받아 재사용). 받는 도중 releaseMic()이 불리면 트랙을 끄고 실패로 끝난다. */
export async function getMicStream() {
  if (usable(stream)) return stream;
  if (stream) {
    // 끝났거나 음소거된 스트림: 버리고 새로 받는다 (탭 핸들러 안에서 불리므로 권한 요청이 가능하다)
    stopTracks(stream);
    stream = null;
  }
  if (!streamPromise) {
    const md = W.navigator.mediaDevices;
    const my = micGen;
    const p = md
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } })
      .catch((e) => {
        if (e?.name === 'OverconstrainedError' || e?.name === 'ConstraintNotSatisfiedError') return md.getUserMedia({ audio: true });
        throw e;
      })
      .then((s) => {
        if (my !== micGen) {
          // 기다리는 사이 화면을 떠났다: 캐시하지 않고 바로 끈다 (마이크 표시등이 남지 않게)
          stopTracks(s);
          const err = new Error('released');
          err.name = 'AbortError';
          throw err;
        }
        stream = s;
        return s;
      })
      .finally(() => {
        if (streamPromise === p) streamPromise = null;
      });
    streamPromise = p;
  }
  return streamPromise;
}

/**
 * 공유 AudioContext를 만들거나 깨운다. 탭 핸들러에서 await 전에 동기 호출할 것.
 * WebKit은 'suspended' 말고도 'interrupted'(권한 창·전화·백그라운드 뒤) 상태가 있어, running이 아니면 모두 깨운다.
 * 없으면 null.
 */
export function primeAudio() {
  const AC = W.AudioContext || W.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx || audioCtx.state === 'closed') {
    try {
      audioCtx = new AC();
    } catch {
      audioCtx = null;
      return null;
    }
  }
  if (audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
    try {
      audioCtx.resume().catch(() => {});
    } catch {}
  }
  return audioCtx;
}

/** 트랙 정지, 캐시 비우기, AudioContext 닫기 (마이크 표시등 끄기). 진행 중인 getMicStream도 무효로 만든다. */
export function releaseMic() {
  micGen++;
  stopTracks(stream);
  stream = null;
  streamPromise = null;
  if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
  audioCtx = null;
}

// ---------- 녹음 ----------
export function pickMime() {
  const MR = W.MediaRecorder;
  if (!MR?.isTypeSupported) return '';
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MR.isTypeSupported(m)) || '';
}

export function extFor(mime) {
  const m = String(mime || '');
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

/** {start(), stop(): Promise<{blob, mime, durationMs}>, state} — start()는 timeslice 없이 */
export function createRecorder(stream) {
  const picked = pickMime();
  const mr = picked ? new W.MediaRecorder(stream, { mimeType: picked }) : new W.MediaRecorder(stream);
  const chunks = [];
  let t0 = 0;
  let done = null;
  mr.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  return {
    get state() {
      return mr.state;
    },
    start() {
      t0 = performance.now();
      mr.start();
    },
    stop() {
      if (done) return done;
      done = new Promise((resolve) => {
        const finish = () => {
          const mime = mr.mimeType || picked || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type: mime }), mime, durationMs: Math.round(performance.now() - t0) });
        };
        if (mr.state === 'inactive') return finish();
        mr.onstop = finish;
        mr.onerror = finish;
        try {
          mr.stop();
        } catch {
          finish();
        }
      });
      return done;
    },
  };
}

// ---------- 음량 측정 ----------
const TICK = 50;
const NOISE_MS = 500;
const MIN_VOICE = 120;
const HANGOVER = 250;
const PAUSE_MS = 1500;
const clamp = (x) => Math.max(0, Math.min(1, x));

function stubMeter() {
  return {
    stub: true,
    stop() {},
    summary: () => null,
  };
}

/**
 * 50ms마다 RMS(dB)를 재고 onLevel(0..1)을 부른다. 생성 즉시 측정 시작.
 * summary() → {firstSpeechMs, speechMs, pauses, longestPauseMs, envelope, pauseSpans:[[startMs,endMs]]}
 * AudioContext가 한 번도 running이 아니었으면(측정 못 함) summary()는 null — 침묵으로 오해하지 않게.
 */
export function createMeter(stream, onLevel = () => {}) {
  const ctx = primeAudio();
  if (!ctx || !stream) return stubMeter();
  let src, an;
  try {
    src = ctx.createMediaStreamSource(stream);
    an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
  } catch {
    return stubMeter();
  }
  const buf = new Float32Array(an.fftSize);
  const t0 = performance.now();
  const noise = [];
  let noiseDb = null;
  let candidate = null;
  let voiced = false;
  let segStart = 0;
  let lastRaw = 0;
  let lastT = 0;
  const segments = [];
  const envelope = [];
  let nextEnv = 0;
  let stopped = false;
  let measured = 0; // running 상태에서 잰 횟수

  const tick = () => {
    const t = performance.now() - t0;
    lastT = t;
    if (ctx.state !== 'running') {
      // 멈춘 컨텍스트는 0만 돌려준다: 침묵으로 세지 않는다
      onLevel(0);
      return;
    }
    measured++;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const level = clamp((db + 60) / 50);
    onLevel(level);
    if (t >= nextEnv) {
      envelope.push(Math.round(level * 100) / 100);
      nextEnv += 100;
    }
    let threshold;
    if (t < NOISE_MS) {
      noise.push(db);
      threshold = -45;
    } else {
      if (noiseDb == null) noiseDb = Math.min(-30, noise.reduce((a, b) => a + b, 0) / (noise.length || 1));
      threshold = Math.max(noiseDb + 12, -50);
    }
    const raw = db > threshold;
    if (raw) {
      if (candidate == null) candidate = t;
      lastRaw = t;
      if (!voiced && t - candidate >= MIN_VOICE) {
        voiced = true;
        segStart = candidate;
      }
    } else {
      candidate = null;
      if (voiced && t - lastRaw > HANGOVER) {
        voiced = false;
        segments.push([segStart, lastRaw]);
      }
    }
  };
  const timer = setInterval(tick, TICK);

  return {
    stub: false,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (voiced) {
        segments.push([segStart, lastRaw]);
        voiced = false;
      }
      try {
        src.disconnect();
        an.disconnect();
      } catch {}
    },
    summary() {
      if (!measured) return null;
      const segs = voiced ? [...segments, [segStart, lastRaw]] : segments;
      if (!segs.length) return { firstSpeechMs: null, speechMs: 0, pauses: 0, longestPauseMs: 0, envelope: [...envelope], pauseSpans: [], totalMs: Math.round(lastT) };
      const pauseSpans = [];
      for (let i = 1; i < segs.length; i++) {
        const gap = segs[i][0] - segs[i - 1][1];
        if (gap >= PAUSE_MS) pauseSpans.push([Math.round(segs[i - 1][1]), Math.round(segs[i][0])]);
      }
      return {
        firstSpeechMs: Math.round(segs[0][0]),
        speechMs: Math.round(segs.reduce((a, [s, e]) => a + (e - s), 0)),
        pauses: pauseSpans.length,
        longestPauseMs: pauseSpans.reduce((m, [s, e]) => Math.max(m, e - s), 0),
        envelope: [...envelope],
        pauseSpans,
        totalMs: Math.round(lastT),
      };
    },
  };
}

// ---------- 받아쓰기 (Web Speech) ----------
export const DICTATION_DENIED = '음성 인식을 쓸 수 없습니다. iPhone은 설정 > Siri 및 검색에서 받아쓰기를 켜야 합니다.';

/** {start(), stop(), active} — onText(base + final + interim), onState(active, errorMessage?) */
export function dictation({ onText = () => {}, onState = () => {}, base = '' } = {}) {
  const SR = W.webkitSpeechRecognition || W.SpeechRecognition;
  let rec = null;
  let userStopped = false;
  let restarts = 0;
  let active = false;
  let committed = base; // 재시작 때 이전 세션 결과를 이어 붙인다
  let lastText = base;

  const join = (a, b) => (a && b && !/\s$/.test(a) && !/^\s/.test(b) ? `${a} ${b}` : a + b);

  function setup() {
    rec = new SR();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let fin = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      lastText = join(committed, fin + interim);
      onText(lastText);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        userStopped = true;
        active = false;
        onState(false, DICTATION_DENIED);
      }
    };
    rec.onend = () => {
      committed = lastText;
      if (!userStopped && restarts < 5) {
        restarts++;
        try {
          setup();
          rec.start();
          return;
        } catch {}
      }
      if (active) {
        active = false;
        onState(false);
      }
    };
  }

  return {
    get active() {
      return active;
    },
    start() {
      if (!SR) {
        onState(false, DICTATION_DENIED);
        return;
      }
      userStopped = false;
      restarts = 0;
      try {
        setup();
        rec.start();
        active = true;
        onState(true);
      } catch (e) {
        active = false;
        onState(false, DICTATION_DENIED);
      }
    },
    stop() {
      userStopped = true;
      try {
        rec?.stop();
      } catch {}
      if (active) {
        active = false;
        onState(false);
      }
    },
  };
}

// ---------- 읽어 주기 (TTS) ----------
const synth = W.speechSynthesis;

function voicesReady() {
  const v = synth.getVoices();
  if (v.length) return Promise.resolve(v);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener?.('voiceschanged', done);
      resolve(synth.getVoices());
    };
    synth.addEventListener?.('voiceschanged', done);
    setTimeout(done, 1000);
  });
}

function pickVoice(voices) {
  const ko = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('ko'));
  return ko.find((v) => v.localService) || ko[0] || null;
}

let token = 0; // cancel()이나 새 speak가 올리면 진행 중인 읽기가 멈춘다

function speakOne(text, rate, my) {
  if (!synth || !String(text || '').trim() || my !== token) return Promise.resolve();
  synth.cancel();
  // 첫 speak는 탭 안에서 동기로 시작되어야 한다(iOS). 목소리 목록이 아직 없으면 기다리지 않고
  // lang만 지정해 바로 읽고, 목록은 다음 호출을 위해 미리 불러 둔다.
  const voices = synth.getVoices();
  if (!voices.length) voicesReady();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'ko-KR';
    const v = pickVoice(voices);
    if (v) u.voice = v;
    u.rate = Number(rate ?? getSettings().ttsRate) || 1;
    let settled = false;
    const end = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(end, String(text).length * 250 + 3000);
    u.onend = end;
    u.onerror = end;
    synth.speak(u);
  });
}

export const tts = {
  available: !!synth,
  /** 글 하나를 읽고, 끝나거나 오류가 나면 resolve */
  speak(text, { rate } = {}) {
    return speakOne(text, rate, ++token);
  },
  /** 줄을 차례로 읽는다. onLine(i)는 각 줄을 읽기 시작할 때, 다 읽거나 멈추면 onLine(-1) */
  async speakLines(lines, { rate, onLine = () => {} } = {}) {
    const list = (lines || []).filter((l) => String(l).trim());
    const my = ++token;
    for (let i = 0; i < list.length && my === token; i++) {
      onLine(i);
      await speakOne(list[i], rate, my);
    }
    onLine(-1);
  },
  cancel() {
    token++;
    try {
      synth?.cancel();
    } catch {}
  },
};
