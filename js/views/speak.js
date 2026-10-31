// 말하기 연습: #/speak (오늘 말할 질문 + 연결 멘트), #/speak/<qid> (녹음 무대)
import { state, byId, upsert, addSession, addPhrase, removePhrase, setPhraseHidden, getSettings, saveSettings } from '../store.js';
import { esc, toast, feedbackHtml, withLoading, icon, fmtSec } from '../ui.js';
import * as ai from '../ai.js';
import {
  KIND_LABEL,
  KINDS,
  BEATS,
  inferKind,
  extractCues,
  LEVEL_LABEL,
  CONF_LABEL,
  CONF_KEYS,
  rateDrill,
  dueQueue,
  SITUATIONS,
  allPhrases,
  allPhrasesFlat,
  hiddenDefaults,
  buildHint,
  hintFromAi,
  hintStepHtml,
  conclusionTeaser,
} from '../coach.js';
import { analyze, verdicts, firstSyllables, splitSentences, estimateSeconds } from '../speech-metrics.js';
import { canRecord, canDictate, getMicStream, primeAudio, releaseMic, createRecorder, createMeter, dictation, tts } from '../media.js';
import { openPractice } from './questions.js';

const PENDING_KEY = 'ip.speak.pending';
const TARGETS = [30, 60, 90];
const LEVEL_SEG = ['원고', '첫 글자', '키워드', '질문만'];
const NO_KEY_TITLE = '설정에서 API 키를 입력하면 쓸 수 있습니다';
const CONSENT_MSG = '녹음을 OpenAI로 보내 받아쓰기합니다. 저장소에는 올라가지 않습니다. 계속할까요?';

let root = null;
let drill = null; // 무대 상태 (#/speak/<qid>)
let gen = 0; // leave()마다 올려서 늦게 끝난 비동기 작업을 무시한다
let pagehideBound = false;

// 녹음 중 자원
let recorder = null;
let meter = null;
let recStart = 0;
let thinkTimer = null;
let elapsedTimer = null;
let ledgerTimer = null;
let estTimer = null;
let dict = null;
let readingScript = false;
let phraseOpen = false;
let phraseEdit = false; // 멘트 목록의 숨기기, 삭제 버튼은 '편집'을 눌렀을 때만 보인다

const qhref = (id) => `#/speak/${encodeURIComponent(id)}`;
const Q = () => (drill ? byId('questions', drill.qid) : null);
const expsOf = (q) => (q?.experienceIds || []).map((i) => byId('experiences', i)).filter(Boolean);
const kindOf = (q) => (KINDS.includes(q?.prep?.kind) ? q.prep.kind : inferKind(q || {}));
const normTarget = (n) => (TARGETS.includes(Number(n)) ? Number(n) : 60);
const $ = (sel) => root?.querySelector(sel);

// =====================================================================
// 라우트 진입점
// =====================================================================
export function render(el, qid) {
  root = el;
  bindPagehide();
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('toggle', onToggle, true);
  if (qid) startStage(qid);
  else renderQueue();
}

/** 다른 화면으로 갈 때(같은 화면 사이 이동 포함) 정리하고, 저장 안 한 시도는 기록에 남긴다 */
export function leave() {
  gen++;
  clearInterval(thinkTimer);
  clearInterval(elapsedTimer);
  clearTimeout(ledgerTimer);
  clearTimeout(estTimer);
  thinkTimer = elapsedTimer = ledgerTimer = estTimer = null;
  document.removeEventListener('visibilitychange', onVisibility);
  tts.cancel();
  readingScript = false;
  stopDictation();
  if (drill) {
    if (drill.phase === 'rec' || drill.phase === 'stopping') hardStopRecording();
    if (!drill.saved) {
      finalize();
      if (drill.attempts.length) save();
    }
    for (const u of drill.blobUrls) URL.revokeObjectURL(u);
  }
  recorder = null;
  meter = null;
  releaseMic();
  document.body.classList.remove('is-interviewing');
  drill = null;
}

/** 앱 시작 때 지난번에 저장하지 못한 말하기 시도를 기록에 넣는다 */
export function flushPending() {
  let p = null;
  try {
    p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
  } catch {}
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {}
  if (!p?.qid || !p.attempts?.length) return false;
  const q = byId('questions', p.qid);
  if (q && (p.qdrill || typeof p.answer === 'string')) {
    upsert('questions', { id: q.id, ...(p.qdrill ? { drill: p.qdrill } : {}), ...(typeof p.answer === 'string' ? { answer: p.answer } : {}) });
  }
  const text = q?.text || p.question || '';
  addSession({
    mode: 'speak',
    startedAt: p.startedAt || new Date().toISOString(),
    items: [
      {
        questionId: p.qid,
        question: text,
        type: q?.type || p.type || 'job',
        turns: [{ q: text, a: p.lastText || '' }],
        feedback: p.feedback || null,
        attempts: p.attempts,
      },
    ],
  });
  toast('지난 말하기 기록을 저장했습니다');
  return true;
}

// =====================================================================
// #/speak : 오늘 말할 질문 + 멘트
// =====================================================================
function queueRow(q) {
  const l = Math.min(3, Math.max(0, q.drill?.level || 0));
  const last = CONF_LABEL[q.drill?.last] || '없음';
  return `
    <a class="queue-row" href="${qhref(q.id)}">
      <span class="badge">${KIND_LABEL[kindOf(q)]}</span>
      <span class="q-text">${esc(q.text)}</span>
      <span class="muted small">${l + 1}/4단계, 최근 ${last}, 뼈대 ${q.prep ? '있음' : '없음'}</span>
    </a>`;
}

function phraseBankHtml() {
  const groups = allPhrases(state.phrases);
  const hidden = hiddenDefaults(state.phrases);
  const phraseHtml = (p) =>
    tts.available
      ? `<button type="button" class="phrase phrase-play" data-a="ph-listen" title="듣기">${icon('listen', { size: 16 })}<span>${esc(p.text)}</span></button>`
      : `<span class="phrase">${esc(p.text)}</span>`;
  return `
    <div class="sec-head">
      <h3>연결 멘트</h3>
      <button type="button" class="btn sm ghost" data-a="ph-edit" aria-pressed="${phraseEdit}">${phraseEdit ? '완료' : '편집'}</button>
    </div>
    ${tts.available ? '<p class="muted small">누르면 읽어 줍니다.</p>' : ''}
    ${groups
      .map(
        (g) => `
      <div class="phrase-group">
        <h4>${esc(g.situation)}</h4>
        ${g.items
          .map(
            (p) => `
          <div class="phrase-row" data-id="${esc(p.id)}">
            ${phraseHtml(p)}
            ${
              phraseEdit
                ? `<span class="phrase-actions">${
                    p.isDefault
                      ? `<button type="button" class="btn sm ghost" data-a="ph-hide">숨기기</button>`
                      : `<button type="button" class="btn sm ghost danger" data-a="ph-del">삭제</button>`
                  }</span>`
                : ''
            }
          </div>`
          )
          .join('')}
      </div>`
      )
      .join('')}
    <form class="phrase-form" id="phrase-form">
      <select name="situation" aria-label="상황">${SITUATIONS.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
      <input name="text" placeholder="내가 자주 쓸 말" aria-label="멘트" autocomplete="off">
      <button class="btn sm" type="submit">추가</button>
    </form>
    ${
      hidden.length
        ? `<details class="box hidden-phrases"><summary>숨긴 기본 멘트 ${hidden.length}</summary>
        ${hidden
          .map(
            (p) => `<div class="phrase-row" data-id="${esc(p.id)}"><span class="phrase">${esc(p.text)}</span>
              <button type="button" class="btn sm ghost" data-a="ph-show">다시 보기</button></div>`
          )
          .join('')}</details>`
        : ''
    }`;
}

function renderQueue() {
  const due = dueQueue(state.questions);
  const unready = state.questions.filter((q) => !q.prep && !q.answer?.trim()).slice(0, 5);
  root.innerHTML = `
    <div class="page-head">
      <h2>말하기 연습</h2>
      <p class="muted">준비한 답변을 원고 없이 말할 수 있을 때까지 단계를 낮춥니다.</p>
    </div>
    <section id="speak-queue" class="speak-sec">
      <h3>오늘 말할 질문 <span class="cnt">${due.length}</span></h3>
      ${
        due.length
          ? `<div class="queue-list">${due.slice(0, 10).map(queueRow).join('')}</div>`
          : `<div class="empty"><p>오늘 복습할 질문이 없습니다.</p>${
              state.questions.length ? '<button type="button" class="btn ghost" data-a="random">아무 질문 하나</button>' : ''
            }</div>`
      }
    </section>
    ${
      unready.length
        ? `<section class="speak-sec"><h3>준비가 덜 된 질문</h3><div class="queue-list">${unready.map(queueRow).join('')}</div></section>`
        : ''
    }
    <section id="phrase-bank" class="speak-sec">${phraseBankHtml()}</section>`;
}

function redrawPhraseBank() {
  const el = $('#phrase-bank');
  if (el) el.innerHTML = phraseBankHtml();
}

function pickRandom() {
  const ready = state.questions.filter((q) => q.prep || q.answer?.trim());
  const pool = ready.length ? ready : state.questions;
  if (!pool.length) return;
  location.hash = qhref(pool[Math.floor(Math.random() * pool.length)].id);
}

// =====================================================================
// #/speak/<qid> : 무대
// =====================================================================
function newCur() {
  return {
    inputMode: drill.mode,
    level: drill.level,
    blob: null,
    blobUrl: null,
    mime: '',
    meterSummary: null,
    durMs: null,
    text: '',
    transcribed: null,
    hintsUsed: 0,
    hints: [],
    confidence: null,
    feedback: null,
    startedAt: null,
  };
}

function startStage(qid) {
  const q = byId('questions', qid);
  if (!q) {
    root.innerHTML = `<div class="stage"><div class="empty"><p>질문을 찾을 수 없습니다.</p><a class="btn ghost" href="#/speak">목록으로</a></div></div>`;
    return;
  }
  const s = getSettings();
  drill = {
    qid,
    level: Math.min(3, Math.max(0, q.drill?.level ?? (q.prep?.spoken || q.answer?.trim() ? 0 : 2))),
    target: normTarget(s.targetSec),
    mode: canRecord() ? 'voice' : 'text',
    phase: 'ready',
    attempts: [],
    saved: false,
    cur: null,
    feedback: null,
    lastText: '',
    startedAt: new Date().toISOString(),
    blobUrls: [],
    rated: false,
    useAnswer: false,
    levelPinned: false,
  };
  drill.cur = newCur();
  phraseOpen = false;
  document.addEventListener('visibilitychange', onVisibility);
  draw();
}

const canChange = () => drill && (drill.phase === 'ready' || drill.phase === 'review');
const curHasData = (c = drill?.cur) => !!c && (!!c.text.trim() || c.durMs != null);

// ---------- 그리기 ----------
function scriptOf(q) {
  const p = q.prep || {};
  if (drill.target === 30) return p.short30 || p.spoken || q.answer || '';
  return p.spoken || q.answer || '';
}

function scriptLines(q) {
  return splitSentences(scriptOf(q));
}

function cueHtml(q) {
  const lv = drill.level;
  if (lv === 3) return '<p class="muted">원고 없이 질문만 보고 답해 보세요.</p>';
  if (lv === 2) {
    const cues = q.prep?.cues?.length ? q.prep.cues : extractCues(q.answer, expsOf(q));
    const labels = (q.prep?.beats || []).map((b) => b.label).filter(Boolean);
    const beats = labels.length ? labels : BEATS[kindOf(q)] || BEATS.experience;
    const teaser = conclusionTeaser(q.prep?.conclusion);
    return `
      <div class="cue-chips">${cues.length ? cues.map((c) => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="muted">준비된 키워드가 없습니다.</span>'}</div>
      <p class="cue-beats">${beats.map(esc).join(' → ')}</p>
      ${teaser ? `<p class="cue-teaser"><span class="lbl-sm">결론 첫마디</span>${esc(teaser)}</p>` : ''}`;
  }
  const lines = scriptLines(q);
  if (!lines.length) {
    const ok = ai.aiReady();
    return `
      <p class="muted">원고가 없습니다.</p>
      <div class="row-btns">
        <button type="button" class="btn sm" data-a="prep-gen" ${ok ? '' : `disabled title="${NO_KEY_TITLE}"`}>뼈대 만들기</button>
        <button type="button" class="btn sm ghost" data-a="open-practice">연습 화면에서 쓰기</button>
      </div>`;
  }
  if (lv === 1) return `<div class="mask">${lines.map((l, i) => `<p data-i="${i}">${esc(firstSyllables(l)).replace(/○+/g, (m) => `<span class="mask-dot">${m}</span>`)}</p>`).join('')}</div>`;
  const busy = drill.phase === 'rec' || drill.phase === 'think';
  return `
    <div class="cue-lines">${lines.map((l, i) => `<p data-i="${i}">${esc(l)}</p>`).join('')}</div>
    ${
      tts.available
        ? `<button type="button" class="btn sm ghost" data-a="read-script" ${busy ? 'disabled' : ''}>${icon(readingScript ? 'stop' : 'listen')} ${readingScript ? '멈추기' : '원고 듣기'}</button>`
        : ''
    }`;
}

function segHtml(id, items, current, attr, label) {
  const dis = canChange() ? '' : 'disabled';
  return `<div class="seg" id="${id}" role="group" aria-label="${label}">${items
    .map(([v, label]) => `<button type="button" data-${attr}="${v}" class="${String(v) === String(current) ? 'on' : ''}" aria-pressed="${String(v) === String(current)}" ${dis}>${label}</button>`)
    .join('')}</div>`;
}

function hintsHtml() {
  const c = drill.cur;
  const showBtn = drill.phase !== 'review';
  return `${c.hints.map(hintStepHtml).join('')}
    ${showBtn ? `<button type="button" class="btn sm" id="s-hard" ${c.hints.length >= 4 ? 'disabled' : ''}>힌트</button>` : ''}`;
}

function phraseBarHtml() {
  const items = allPhrasesFlat(state.phrases);
  const insertable = drill.mode === 'text' && (drill.phase === 'ready' || drill.phase === 'review');
  return `<details class="phrase-bar" ${phraseOpen ? 'open' : ''}><summary>연결 멘트</summary><div class="phrase-chips">${items
    .map((p) =>
      insertable
        ? `<button type="button" class="chip phrase" data-a="phrase" data-text="${esc(p.text)}">${esc(p.text)}</button>`
        : `<span class="chip phrase">${esc(p.text)}</span>`
    )
    .join('')}</div></details>`;
}

function waveHtml(c) {
  const env = c.meterSummary?.envelope || [];
  if (!env.length) return '';
  const n = env.length;
  const H = 40;
  const pauses = (c.meterSummary.pauseSpans || [])
    .map(([s, e]) => `<rect class="pause" x="${(s / 100).toFixed(1)}" y="0" width="${Math.max(0.5, (e - s) / 100).toFixed(1)}" height="${H}"></rect>`)
    .join('');
  const bars = env
    .map((v, i) => {
      const h = Math.max(1, v * (H - 2));
      return `<rect x="${i + 0.15}" y="${((H - h) / 2).toFixed(1)}" width="0.7" height="${h.toFixed(1)}"></rect>`;
    })
    .join('');
  return `<svg class="wave" viewBox="0 0 ${n} ${H}" preserveAspectRatio="none" width="100%" height="48" role="img" aria-label="녹음 파형, 누르면 그 위치로 이동">${pauses}${bars}</svg>`;
}

function metricsOf(c = drill.cur) {
  const q = Q();
  return analyze({ text: c.text, durMs: c.durMs, cues: q?.prep?.cues?.length ? q.prep.cues : null, meter: c.meterSummary });
}

function ledgerHtml() {
  const m = metricsOf();
  const rows = verdicts(m, drill.target);
  // 녹음했는데 음량 측정이 목소리를 못 잡았으면 첫마디 칸을 비워 둔 채로 보여 준다
  if (m.durMs != null && !rows.some((r) => r.key === 'first')) {
    const i = rows.findIndex((r) => r.key === 'len');
    rows.splice(i + 1, 0, { key: 'first', label: '첫마디', value: '없음', verdict: null, note: drill.cur?.meterSummary ? '목소리가 잡히지 않았습니다' : '측정하지 못했습니다' });
  }
  return rows
    .map(
      (r) => `<div class="ledger-row" data-key="${r.key}"><dt>${esc(r.label)}</dt><dd>${esc(r.value)}${
        r.verdict ? ` <span class="verdict ${r.verdict}">${r.verdict === 'ok' ? '양호' : '주의'}</span>` : ''
      }</dd>${r.note ? `<dd class="note">${esc(r.note)}</dd>` : ''}</div>`
    )
    .join('');
}

function estimateText(text) {
  const t = String(text || '').trim();
  return `약 ${fmtSec(estimateSeconds(t))} 분량, 목표 ${fmtSec(drill.target)}`;
}

function answerBox(label, placeholder) {
  const c = drill.cur;
  return `
    <label class="lbl" for="s-answer">${label}</label>
    <textarea id="s-answer" rows="${drill.mode === 'text' ? 8 : 5}" placeholder="${esc(placeholder)}">${esc(c.text)}</textarea>`;
}

function textToolsHtml() {
  const out = [];
  if (drill.mode === 'text' && !canRecord() && canDictate()) {
    out.push(`<button type="button" class="btn sm" data-a="dictate">${icon('mic')} ${dict?.active ? '받아쓰기 멈추기' : '말로 받아쓰기'}</button>`);
  }
  if (tts.available) out.push(`<button type="button" class="btn sm ghost" data-a="read-answer">${icon('listen')} 읽어 듣기</button>`);
  return out.join('');
}

function voiceReadyHtml() {
  const sec = Number(getSettings().prepSec) || 0;
  return `
    <div class="rec-area">
      <button type="button" id="rec-btn" class="rec-btn" aria-label="녹음 시작">${icon('mic', { size: 28 })}</button>
      <span class="rec-label">시작</span>
      <p class="muted small">${sec > 0 && !drill.directNext ? `${sec}초 생각한 뒤 녹음이 시작됩니다` : '누르면 바로 녹음합니다'}</p>
    </div>`;
}

function thinkHtml() {
  return `
    <div class="rec-area">
      <div id="s-think" class="think">
        <span class="think-label">생각 정리 <b class="think-n">${Math.ceil(drill.thinkLeft || 0)}</b></span>
        <div class="think-bar"><i style="width:100%"></i></div>
        <button type="button" class="btn sm ghost" data-a="skip-think">바로 시작</button>
      </div>
    </div>`;
}

function recHtml() {
  return `
    <div class="rec-area">
      <button type="button" id="rec-btn" class="rec-btn is-rec" aria-label="녹음 끝" ${drill.phase === 'stopping' ? 'disabled' : ''}>${icon('stop', { size: 28 })}</button>
      <span class="rec-label">끝</span>
      <div class="meter" aria-hidden="true"><i style="width:0%"></i></div>
      <div class="elapsed" id="s-elapsed">0:00 / ${fmtSec(drill.target)}</div>
    </div>`;
}

function reviewHtml() {
  const c = drill.cur;
  const voice = c.inputMode === 'voice';
  const stt = ai.sttReady();
  const aiOk = ai.aiReady();
  return `
    <div class="review">
      ${
        voice && c.blobUrl
          ? `<audio id="s-audio" controls playsinline preload="metadata" src="${c.blobUrl}"></audio>
             <p class="muted small">녹음은 이 화면을 떠나면 사라집니다. 저장소에 올라가지 않습니다.</p>
             ${waveHtml(c)}`
          : ''
      }
      ${
        voice
          ? answerBox('받아쓴 답변', stt ? '받아쓰기를 누르거나 직접 적어 주세요.' : '받아쓰기는 설정에서 OpenAI 키를 넣으면 쓸 수 있습니다. 직접 적어도 됩니다.')
          : answerBox('내 답변', '말하듯이 적어 주세요. 키워드만 적어도 괜찮습니다.')
      }
      <div class="row-btns">
        ${voice && stt && c.blob ? '<button type="button" class="btn sm" id="s-transcribe">받아쓰기</button>' : ''}
        ${voice ? '' : textToolsHtml()}
      </div>
      <dl class="ledger" id="ledger">${ledgerHtml()}</dl>
      <div class="conf-row" id="s-conf" role="group" aria-label="이번 시도 난이도">
        <span>이번 시도는 어땠나요</span>
        ${CONF_KEYS.map((k) => `<button type="button" class="btn sm conf ${c.confidence === k ? 'on' : ''}" data-v="${k}" aria-pressed="${c.confidence === k}">${CONF_LABEL[k]}</button>`).join('')}
      </div>
      <div class="actions">
        <button type="button" class="btn" id="s-again">${icon('retry')} 다시</button>
        <button type="button" class="btn ghost" id="s-use">내 답변에 반영</button>
        <button type="button" class="btn primary" id="s-feedback" ${aiOk ? '' : `disabled title="${NO_KEY_TITLE}"`}>첨삭 받기</button>
      </div>
      <div id="s-fb">${c.feedback ? feedbackHtml(c.feedback) : ''}</div>
    </div>`;
}

function textReadyHtml() {
  return `
    <div class="text-sheet">
      ${answerBox('내 답변', '말하듯이 적어 주세요. 키워드만 적어도 괜찮습니다.')}
      <p class="estimate" id="s-est">${estimateText(drill.cur.text)}</p>
      <div class="actions">
        ${textToolsHtml()}
        <button type="button" class="btn primary" id="s-done">다 썼음</button>
      </div>
    </div>`;
}

function phaseHtml() {
  if (drill.phase === 'review') return reviewHtml();
  if (drill.mode === 'text') return textReadyHtml();
  if (drill.phase === 'think') return thinkHtml();
  if (drill.phase === 'rec' || drill.phase === 'stopping') return recHtml();
  return voiceReadyHtml();
}

function draw() {
  const q = Q();
  if (!q || !root) return;
  const n = drill.attempts.length;
  const busy = drill.phase === 'rec' || drill.phase === 'think' || drill.phase === 'stopping';
  // 녹음 중에는 숨긴다: 끝내기 전에 '끝'으로 녹음을 마쳐야 이번 시도가 기록에 들어간다
  const showFinish = !busy && (n > 0 || (drill.phase === 'review' && curHasData()));
  // 말로 하는 준비, 생각, 녹음 단계의 조작부는 .stage 바로 아래에 둔다 (휴대폰에서 화면 아래에 붙는다)
  const voiceCtl = drill.mode === 'voice' && drill.phase !== 'review';
  root.innerHTML = `
    <div class="stage">
      <div class="stage-top">
        <a href="#/speak" class="back">${icon('back')} 목록</a>
        <span class="stage-top-right">
          ${n ? `<span class="muted small" id="s-count">시도 ${n}회</span>` : ''}
          ${showFinish ? '<button type="button" class="btn sm" id="s-finish">저장하고 끝내기</button>' : ''}
        </span>
      </div>
      <div class="q-meta">
        <span class="badge">${KIND_LABEL[kindOf(q)]}</span>
        ${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}
      </div>
      <p class="stage-q">${esc(q.text)}</p>
      ${tts.available ? `<button type="button" class="btn sm ghost" data-a="listen-q" ${busy ? 'disabled' : ''}>${icon('listen')} 질문 듣기</button>` : ''}

      <div class="stage-controls">
        <div class="ctl ctl-level"><span class="lbl-sm" aria-hidden="true">단계</span>${segHtml('s-level', LEVEL_SEG.map((l, i) => [i, l]), drill.level, 'level', '단계')}</div>
        <div class="ctl"><span class="lbl-sm" aria-hidden="true">길이</span>${segHtml('s-target', [[30, '30초'], [60, '1분'], [90, '90초']], drill.target, 'target', '길이')}</div>
        <div class="ctl"><span class="lbl-sm" aria-hidden="true">방식</span><div class="seg" id="s-mode" role="group" aria-label="방식">
          <button type="button" id="mode-voice" data-mode="voice" class="${drill.mode === 'voice' ? 'on' : ''}" aria-pressed="${drill.mode === 'voice'}" ${
            !canRecord() || !canChange() ? 'disabled' : ''
          }>말로</button>
          <button type="button" id="mode-text" data-mode="text" class="${drill.mode === 'text' ? 'on' : ''}" aria-pressed="${drill.mode === 'text'}" ${
            canChange() ? '' : 'disabled'
          }>글로</button>
        </div></div>
      </div>
      ${canRecord() ? '' : '<p class="muted small" id="s-mode-note">이 브라우저에서는 녹음을 쓸 수 없습니다. 글로 진행합니다.</p>'}

      <div class="cue-card" id="s-cue">${cueHtml(q)}</div>
      <section class="hint-panel" id="s-hints">${hintsHtml()}</section>
      ${phraseBarHtml()}

      ${voiceCtl ? phaseHtml() : `<div class="stage-body">${phaseHtml()}</div>`}
    </div>`;
}

const redrawCue = () => {
  const el = $('#s-cue');
  const q = Q();
  if (el && q) el.innerHTML = cueHtml(q);
};
const redrawHints = () => {
  const el = $('#s-hints');
  if (el) el.innerHTML = hintsHtml();
};
const redrawLedger = () => {
  const el = $('#ledger');
  if (el) el.innerHTML = ledgerHtml();
};

// ---------- 시도 정리와 저장 ----------
function buildAttempt(c) {
  const m = metricsOf(c);
  const voice = c.inputMode === 'voice';
  return {
    at: new Date().toISOString(),
    level: c.level,
    target: drill.target,
    inputMode: c.inputMode,
    transcribed: c.transcribed || (c.text.trim() ? 'typed' : null),
    durMs: voice ? m.durMs : null,
    speechMs: voice ? m.speechMs : null,
    firstSpeechMs: voice ? m.firstSpeechMs : null,
    pauses: voice ? m.pauses : null,
    longestPauseMs: voice ? m.longestPauseMs : null,
    syl: m.syl,
    spm: m.spm,
    estSec: m.estSec,
    fillersPerMin: m.fillersPerMin,
    fillers: m.fillers,
    hedges: m.hedges,
    restarts: m.restarts,
    longSent: m.longSent,
    cueHits: m.cueHits,
    cueTotal: m.cueTotal,
    hintsUsed: c.hintsUsed,
    confidence: c.confidence || null,
  };
}

/** 현재 시도를 attempts에 넣고 (난이도 평가가 있으면) drill을 메모리에서 갱신, pending에 기록 */
function finalize() {
  const c = drill?.cur;
  if (!curHasData(c)) return null;
  const att = buildAttempt(c);
  drill.attempts.push(att);
  if (c.text.trim()) drill.lastText = c.text.trim();
  if (c.feedback) drill.feedback = c.feedback;
  const q = Q();
  if (q && att.confidence) {
    const before = att.level;
    q.drill = rateDrill({ ...(q.drill || {}), level: before }, att.confidence, { hintsUsed: att.hintsUsed });
    drill.rated = true;
    if (drill.levelPinned) {
      // 복기 중에 직접 고른 단계를 따른다
      q.drill.level = drill.level;
    } else {
      drill.level = q.drill.level;
      if (q.drill.level > before) toast(`다음부터 ${LEVEL_LABEL[q.drill.level]} 단계로 연습합니다.`);
    }
  }
  drill.levelPinned = false;
  drill.cur = null;
  writePending();
  return att;
}

function pendingPayload(extra) {
  const q = Q();
  return {
    qid: drill.qid,
    question: q?.text || '',
    type: q?.type || '',
    attempts: extra ? [...drill.attempts, extra] : drill.attempts,
    lastText: drill.lastText,
    feedback: drill.feedback,
    startedAt: drill.startedAt,
    ...(drill.rated && q?.drill ? { qdrill: q.drill } : {}),
    ...(drill.useAnswer && q ? { answer: q.answer || '' } : {}),
  };
}

function writePending(extra) {
  if (!drill || drill.saved) return;
  const p = pendingPayload(extra);
  if (!p.attempts.length) return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {}
}

function save() {
  if (!drill || drill.saved || !drill.attempts.length) return false;
  const q = Q();
  if (q && (drill.rated || drill.useAnswer)) {
    upsert('questions', { id: q.id, ...(drill.rated && q.drill ? { drill: q.drill } : {}), ...(drill.useAnswer ? { answer: q.answer || '' } : {}) });
  }
  const text = q?.text || '';
  addSession({
    mode: 'speak',
    startedAt: drill.startedAt,
    items: [
      {
        questionId: drill.qid,
        question: text,
        type: q?.type || 'job',
        turns: [{ q: text, a: drill.lastText }],
        feedback: drill.feedback,
        attempts: drill.attempts,
      },
    ],
  });
  drill.saved = true;
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {}
  return true;
}

function bindPagehide() {
  if (pagehideBound) return;
  pagehideBound = true;
  window.addEventListener('pagehide', () => {
    if (!drill || drill.saved) return;
    const c = drill.cur;
    if (c && (drill.phase === 'rec' || drill.phase === 'stopping') && c.durMs == null) c.durMs = Math.round(performance.now() - recStart);
    writePending(curHasData(c) ? buildAttempt(c) : null);
  });
}

// ---------- 녹음 ----------
async function onRecTap() {
  if (!drill) return;
  if (drill.phase === 'rec') return stopRecording();
  if (drill.phase !== 'ready') return;
  if (!canRecord()) return fallbackToText();
  // iPhone: AudioContext는 await 전에 탭 안에서 만든다
  primeAudio();
  tts.cancel();
  const my = gen;
  const btn = $('#rec-btn');
  if (btn) btn.disabled = true;
  let stream;
  try {
    stream = await getMicStream();
  } catch (e) {
    console.warn(e);
    if (my !== gen) return;
    return fallbackToText();
  }
  if (my !== gen || !drill) return;
  drill.stream = stream;
  const sec = Number(getSettings().prepSec) || 0;
  if (sec > 0 && !drill.directNext) startThink(sec);
  else startRecording({ fromTap: true });
}

function fallbackToText() {
  toast('마이크 권한이 없어 글로 진행합니다.', 'error');
  drill.mode = 'text';
  drill.phase = 'ready';
  drill.cur.inputMode = 'text';
  document.body.classList.remove('is-interviewing');
  draw();
}

function startThink(sec) {
  drill.phase = 'think';
  drill.thinkLeft = sec;
  document.body.classList.add('is-interviewing');
  draw();
  const t0 = performance.now();
  clearInterval(thinkTimer);
  thinkTimer = setInterval(() => {
    const left = sec - (performance.now() - t0) / 1000;
    drill.thinkLeft = left;
    const n = $('#s-think .think-n');
    if (n) n.textContent = String(Math.max(0, Math.ceil(left)));
    const bar = $('#s-think .think-bar > i');
    if (bar) bar.style.width = `${Math.max(0, (left / sec) * 100)}%`;
    if (left <= 0) startRecording();
  }, 100);
}

/**
 * 녹음 시작. 생각 시간이 끝나 타이머에서 불리면(fromTap=false) 탭 밖이다(A.9.1 예외).
 * 그때 시작에 실패하면 글로 바꾸지 않고, 다음 탭에서 생각 시간 없이 바로 시작하게 한다.
 */
function startRecording({ fromTap = false } = {}) {
  clearInterval(thinkTimer);
  thinkTimer = null;
  if (!drill || (drill.phase !== 'ready' && drill.phase !== 'think')) return;
  const c = drill.cur;
  if (c.blobUrl) URL.revokeObjectURL(c.blobUrl);
  c.blobUrl = null;
  c.blob = null;
  c.inputMode = 'voice';
  c.level = drill.level;
  try {
    if (!drill.stream) throw new Error('no stream');
    recorder = createRecorder(drill.stream);
    recorder.start();
    if (recorder.state !== 'recording') throw new Error(`recorder ${recorder.state}`);
  } catch (e) {
    console.warn(e);
    try {
      recorder?.stop();
    } catch {}
    recorder = null;
    if (!fromTap && !drill.directNext) {
      drill.directNext = true;
      drill.phase = 'ready';
      document.body.classList.remove('is-interviewing');
      toast('녹음이 시작되지 않았습니다. 시작을 다시 누르면 바로 녹음합니다.', 'error');
      draw();
      return;
    }
    drill.directNext = false;
    toast('녹음을 시작하지 못해 글로 진행합니다.', 'error');
    drill.mode = 'text';
    drill.phase = 'ready';
    c.inputMode = 'text';
    document.body.classList.remove('is-interviewing');
    draw();
    return;
  }
  meter = createMeter(drill.stream, (lv) => {
    const i = $('.meter > i');
    if (i) i.style.width = `${Math.round(lv * 100)}%`;
  });
  drill.directNext = false;
  recStart = performance.now();
  c.startedAt = new Date().toISOString();
  drill.phase = 'rec';
  document.body.classList.add('is-interviewing');
  draw();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 250);
  tickElapsed();
}

function tickElapsed() {
  if (!drill || drill.phase !== 'rec') return;
  const sec = Math.floor((performance.now() - recStart) / 1000);
  const el = $('#s-elapsed');
  if (el) {
    const over = sec > drill.target;
    el.textContent = `${fmtSec(sec)} / ${fmtSec(drill.target)}${over ? ` +${fmtSec(sec - drill.target)}` : ''}`;
    el.classList.toggle('over', over);
  }
  if (sec >= drill.target * 3) stopRecording();
}

async function stopRecording() {
  if (!drill || drill.phase !== 'rec') return;
  const my = gen;
  drill.phase = 'stopping';
  clearInterval(elapsedTimer);
  elapsedTimer = null;
  const btn = $('#rec-btn');
  if (btn) btn.disabled = true;
  const c = drill.cur;
  meter?.stop();
  c.meterSummary = meter?.summary() || null;
  meter = null;
  let res = null;
  try {
    res = await recorder?.stop();
  } catch (e) {
    console.warn(e);
  }
  recorder = null;
  if (my !== gen || !drill) return;
  // 복기 중에는 마이크를 끈다: iOS는 마이크가 켜져 있으면 재생 소리가 작아지고 표시등도 남는다.
  // 다음 '시작' 탭에서 다시 받는다 (탭 안이므로 가능).
  drill.stream = null;
  releaseMic();
  c.durMs = res?.durationMs ?? Math.round(performance.now() - recStart);
  if (res?.blob?.size) {
    c.blob = res.blob;
    c.mime = res.mime;
    c.blobUrl = URL.createObjectURL(res.blob);
    drill.blobUrls.push(c.blobUrl);
  }
  document.body.classList.remove('is-interviewing');
  drill.phase = 'review';
  draw();
  const s = getSettings();
  if (c.blob && s.autoTranscribe && s.sttConsent && ai.sttReady()) runTranscribe();
}

/** leave/pagehide용: 기다리지 않고 녹음을 끊고 시간과 지표만 남긴다 */
function hardStopRecording() {
  const c = drill.cur;
  if (meter) {
    meter.stop();
    c.meterSummary = meter.summary();
  }
  if (c.durMs == null) c.durMs = Math.round(performance.now() - recStart);
  try {
    recorder?.stop();
  } catch {}
  meter = null;
  recorder = null;
  drill.phase = 'review';
}

function onVisibility() {
  if (document.visibilityState === 'hidden' && drill?.phase === 'rec') stopRecording();
}

// ---------- 받아쓰기 ----------
async function runTranscribe(btn = $('#s-transcribe')) {
  const c = drill?.cur;
  if (!c?.blob) return;
  const s = getSettings();
  if (!s.sttConsent) {
    if (!confirm(CONSENT_MSG)) return;
    saveSettings({ sttConsent: true });
  }
  const my = gen;
  const text = await withLoading(btn, () => ai.transcribe(c.blob, c.mime), '받아쓰는 중');
  if (my !== gen || !drill || drill.cur !== c || typeof text !== 'string') return;
  if (!text) {
    toast('받아쓴 내용이 없습니다. 직접 적어도 됩니다.');
    return;
  }
  if (c.text.trim() && c.text.trim() !== text && !confirm('적어 둔 내용을 받아쓴 내용으로 바꿀까요?')) return;
  c.text = text;
  c.transcribed = 'openai';
  const ta = $('#s-answer');
  if (ta) ta.value = text;
  redrawLedger();
}

function stopDictation() {
  try {
    dict?.stop();
  } catch {}
  dict = null;
}

function toggleDictation(btn) {
  if (dict?.active) {
    stopDictation();
    if (btn) btn.innerHTML = `${icon('mic')} 말로 받아쓰기`;
    return;
  }
  const c = drill.cur;
  const ta = $('#s-answer');
  dict = dictation({
    base: ta?.value ? `${ta.value} ` : '',
    onText: (t) => {
      if (!drill || drill.cur !== c) return;
      c.text = t;
      c.transcribed = 'browser';
      if (!c.startedAt) c.startedAt = new Date().toISOString();
      const el = $('#s-answer');
      if (el) el.value = t;
      scheduleTextUpdates();
    },
    onState: (active, err) => {
      const b = root?.querySelector('[data-a="dictate"]');
      if (b) b.innerHTML = `${icon('mic')} ${active ? '받아쓰기 멈추기' : '말로 받아쓰기'}`;
      if (err) toast(err, 'error');
    },
  });
  dict.start();
}

// ---------- 힌트 ----------
async function onHint(btn) {
  const c = drill.cur;
  const step = c.hints.length + 1;
  if (step > 4) return;
  const q = Q();
  const exps = expsOf(q);
  c.hintsUsed = step;
  let h = buildHint(step, { q, exps, phrases: state.phrases });
  if (h.needsAi) {
    if (ai.aiReady()) {
      const my = gen;
      const r = await withLoading(btn, () => ai.hint({ question: q, turns: null, experiences: exps, step }), '찾는 중');
      if (my !== gen || !drill || drill.cur !== c) return;
      h = r ? hintFromAi(step, r) : { step, title: h.title, html: h.fallbackHtml };
    } else h = { step, title: h.title, html: h.fallbackHtml };
  }
  if (c.hints.length >= step) return;
  c.hints.push(h);
  redrawHints();
}

// ---------- 텍스트 ----------
function scheduleTextUpdates() {
  clearTimeout(ledgerTimer);
  ledgerTimer = setTimeout(redrawLedger, 300);
  clearTimeout(estTimer);
  estTimer = setTimeout(() => {
    const el = $('#s-est');
    if (el && drill) el.textContent = estimateText(drill.cur?.text);
  }, 150);
}

function insertAtCursor(text) {
  const ta = $('#s-answer');
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  const pos = s + text.length;
  try {
    ta.setSelectionRange(pos, pos);
  } catch {}
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------- 이벤트 ----------
function onInput(e) {
  if (e.target.id !== 's-answer' || !drill?.cur) return;
  const c = drill.cur;
  c.text = e.target.value;
  if (!c.transcribed && c.text.trim()) c.transcribed = 'typed';
  if (!c.startedAt && c.text.trim()) c.startedAt = new Date().toISOString();
  scheduleTextUpdates();
}

function onToggle(e) {
  if (e.target.classList?.contains('phrase-bar')) phraseOpen = e.target.open;
}

function onSubmit(e) {
  if (e.target.id !== 'phrase-form') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const item = addPhrase({ situation: fd.get('situation'), text: fd.get('text') });
  if (!item) {
    toast('멘트를 먼저 적어 주세요.');
    return;
  }
  redrawPhraseBank();
  toast('추가했습니다.');
}

function onClick(e) {
  const t = e.target.closest('button, [data-a], svg.wave');
  if (!t || !root.contains(t)) return;
  if (t.disabled) return;

  // ----- 목록 화면 -----
  const a = t.dataset?.a;
  if (a === 'random') return pickRandom();
  if (a === 'ph-edit') {
    phraseEdit = !phraseEdit;
    redrawPhraseBank();
    return;
  }
  if (a === 'ph-listen') {
    const text = t.closest('.phrase-row')?.querySelector('.phrase')?.textContent;
    if (text) tts.speak(text);
    return;
  }
  if (a === 'ph-hide' || a === 'ph-show' || a === 'ph-del') {
    const id = t.closest('.phrase-row')?.dataset.id;
    if (!id) return;
    if (a === 'ph-del') {
      if (!confirm('이 멘트를 삭제할까요?')) return;
      removePhrase(id);
    } else setPhraseHidden(id, a === 'ph-hide');
    redrawPhraseBank();
    return;
  }

  if (!drill) return;
  const c = drill.cur;

  // ----- 무대 -----
  if (t.matches('svg.wave')) return seekWave(e, t);
  if (t.id === 'rec-btn') return onRecTap();
  if (a === 'skip-think') {
    primeAudio();
    return startRecording({ fromTap: true });
  }
  if (t.id === 's-hard') return onHint(t);
  if (a === 'listen-q') {
    tts.speak(Q()?.text || '');
    return;
  }
  if (a === 'read-script') return toggleReadScript();
  if (a === 'read-answer') {
    const text = $('#s-answer')?.value || '';
    if (text.trim()) tts.speak(text);
    return;
  }
  if (a === 'dictate') return toggleDictation(t);
  if (a === 'phrase') return insertAtCursor(t.dataset.text || '');
  if (a === 'prep-gen') return genPrep(t);
  if (a === 'open-practice') {
    openPractice(drill.qid, () => {
      if (drill && canChange()) draw();
    });
    return;
  }

  if (t.dataset.level != null && t.closest('#s-level')) return setLevel(Number(t.dataset.level));
  if (t.dataset.target != null && t.closest('#s-target')) return setTarget(Number(t.dataset.target));
  if (t.dataset.mode && t.closest('#s-mode')) return setMode(t.dataset.mode);

  if (t.classList.contains('conf') && t.closest('#s-conf')) {
    c.confidence = c.confidence === t.dataset.v ? null : t.dataset.v;
    root.querySelectorAll('#s-conf .conf').forEach((b) => {
      const on = b.dataset.v === c.confidence;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    return;
  }
  if (t.id === 's-done') {
    if (!c.text.trim()) {
      toast('답변을 먼저 적어야 합니다.');
      return;
    }
    stopDictation();
    c.inputMode = 'text';
    c.level = drill.level;
    c.durMs = null;
    drill.phase = 'review';
    draw();
    return;
  }
  if (t.id === 's-transcribe') return runTranscribe(t);
  if (t.id === 's-again') return again();
  if (t.id === 's-feedback') return getFeedback(t);
  if (t.id === 's-use') return useAnswer();
  if (t.id === 's-finish') return finish();
}

function setLevel(n) {
  if (!canChange() || n === drill.level) return;
  tts.cancel();
  readingScript = false;
  drill.level = n;
  if (drill.phase === 'ready') drill.cur.level = n;
  else drill.levelPinned = true;
  root.querySelectorAll('#s-level button').forEach((b) => {
    const on = Number(b.dataset.level) === n;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  redrawCue();
}

function setTarget(n) {
  if (!canChange() || n === drill.target) return;
  drill.target = normTarget(n);
  draw();
}

function setMode(m) {
  if (!canChange() || m === drill.mode) return;
  if (m === 'voice' && !canRecord()) return;
  stopDictation();
  if (drill.phase === 'review') {
    finalize();
    drill.cur = null;
  }
  drill.mode = m;
  drill.phase = 'ready';
  if (!drill.cur) drill.cur = newCur();
  drill.cur.inputMode = m;
  draw();
}

function again() {
  stopDictation();
  tts.cancel();
  readingScript = false;
  finalize();
  drill.cur = newCur();
  drill.phase = 'ready';
  draw();
}

function finish() {
  stopDictation();
  tts.cancel();
  finalize();
  if (!drill.attempts.length) {
    location.hash = '#/speak';
    return;
  }
  save();
  toast('기록에 저장했습니다.');
  location.hash = '#/speak';
}

function useAnswer() {
  const c = drill.cur;
  const text = (c?.text || '').trim();
  const q = Q();
  if (!text || !q) {
    toast('반영할 답변이 없습니다.');
    return;
  }
  if (q.answer?.trim() && q.answer.trim() !== text && !confirm('저장해 둔 답변을 방금 답변으로 바꿀까요?')) return;
  q.answer = text;
  drill.useAnswer = true;
  toast('내 답변에 반영했습니다.');
}

async function getFeedback(btn) {
  const c = drill.cur;
  if (!c.text.trim()) {
    toast('답변이 있어야 첨삭할 수 있습니다.');
    return;
  }
  const q = Q();
  const my = gen;
  const fb = await withLoading(
    btn,
    () =>
      ai.speakFeedback({
        question: q,
        transcript: c.text,
        metrics: metricsOf(c),
        prep: q.prep,
        experiences: expsOf(q),
        level: c.level,
        inputMode: c.inputMode,
        targetSec: drill.target,
      }),
    '첨삭 중'
  );
  if (!fb || my !== gen || !drill || drill.cur !== c) return;
  c.feedback = fb;
  drill.feedback = fb;
  const el = $('#s-fb');
  if (el) el.innerHTML = feedbackHtml(fb);
}

async function genPrep(btn) {
  const q = Q();
  if (!q || !ai.aiReady()) return;
  const my = gen;
  const p = await withLoading(
    btn,
    () => ai.buildPrep({ question: q, kind: kindOf(q), experiences: expsOf(q), answer: q.answer, targetSec: drill.target }),
    '만드는 중'
  );
  if (!p || my !== gen || !drill) return;
  upsert('questions', { id: q.id, prep: { ...(q.prep || {}), ...p } });
  if (canChange()) draw();
  else redrawCue();
}

function toggleReadScript() {
  if (readingScript) {
    tts.cancel();
    readingScript = false;
    redrawCue();
    return;
  }
  const q = Q();
  const lines = scriptLines(q);
  if (!lines.length) return;
  readingScript = true;
  redrawCue();
  const my = gen;
  tts.speakLines(lines, {
    rate: Number(getSettings().ttsRate) || 1,
    onLine: (i) => {
      if (my !== gen) return;
      root?.querySelectorAll('#s-cue p[data-i]').forEach((p) => p.classList.toggle('is-reading', Number(p.dataset.i) === i));
      if (i === -1 && readingScript) {
        readingScript = false;
        redrawCue();
      }
    },
  });
}

function seekWave(e, svg) {
  const audio = $('#s-audio');
  const c = drill.cur;
  if (!audio || !c?.durMs) return;
  const r = svg.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  try {
    audio.currentTime = (frac * c.durMs) / 1000;
  } catch {}
}
