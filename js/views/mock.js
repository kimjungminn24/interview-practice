// 모의면접: (생각 시간) → 답변 → 꼬리질문 → … → 질문별 체감 난이도 → 전체 첨삭 → 기록 저장
import { state, byId, upsert, addSession, markDirty, getSettings } from '../store.js';
import { esc, nl2br, toast, typeLabel, shuffle, feedbackHtml, fmtDate, withLoading, icon, fmtSec } from '../ui.js';
import * as ai from '../ai.js';
import {
  KIND_LABEL,
  KINDS,
  inferKind,
  CONF_LABEL,
  CONF_KEYS,
  rateDrill,
  dueQueue,
  weakFirst,
  easyFirst,
  allPhrasesFlat,
  buildHint,
  hintFromAi,
  hintStepHtml,
} from '../coach.js';
import { isTouch, canDictate, dictation, tts } from '../media.js';

const MOCK_KEY = 'ip.mock';
const RESUME_PHASES = ['think', 'answer', 'loading', 'confirm'];
const THINK_OPTIONS = [0, 5, 10, 15, 30];

const PRESETS = {
  warmup: { label: '워밍업', timer: 0, depth: 0, thinkSec: 15, order: 'easy', autoHint: true, gentle: true },
  basic: { label: '기본', timer: 90, depth: 2, thinkSec: 10, order: 'random', autoHint: false, gentle: false },
  real: { label: '실전', timer: 60, depth: 3, thinkSec: 5, order: 'weak', autoHint: false, gentle: false },
};

const ORDER_LABEL = { random: '무작위', review: '복습할 질문 먼저', weak: '어려웠던 질문만', easy: '쉬운 질문 먼저' };

const config = {
  preset: 'basic',
  type: 'all',
  count: 5,
  depth: 2,
  onlyLinked: false,
  timer: 90,
  thinkSec: 10,
  order: 'random',
  answerMode: 'text',
  tts: false,
  hideScore: null, // null: 시작할 때 설정의 '점수 숨기기'를 따른다 (워밍업, 실전 프리셋만 고정값)
  autoHint: false,
  gentle: false,
};

let mock = null; // 진행 중인 면접 (ip.mock에도 저장)
let root;
let tickId = null;
let dict = null;
let dictStartedAt = 0;
let phraseOpen = false;

const isWeak = (q) => q?.drill?.last === 'hard' || q?.drill?.last === 'fair';
const kindOf = (q) => (KINDS.includes(q?.prep?.kind) ? q.prep.kind : inferKind(q || {}));
/** 모의면접 화면이 지금 붙어 있는가. 비동기 응답이 늦게 오면 상태만 갱신하고 그리지 않는다. */
const mounted = () => !!root?.isConnected;

/** 프리셋에 고정값이 없으면(기본, 직접 설정) 시작 시점의 설정값을 쓴다 */
function resolveHideScore(cfg) {
  if (cfg.preset === 'warmup') return true;
  if (cfg.preset === 'real') return false;
  return !!getSettings().hideScore;
}

function newMock(cfg, queue) {
  return {
    config: { ...cfg, hideScore: resolveHideScore(cfg) },
    queue,
    idx: 0,
    items: [],
    startedAt: new Date().toISOString(),
    phase: 'answer',
    hints: [],
    autoHinted: false,
  };
}

// ---------- 저장 (새로고침해도 이어서 하기) ----------
function persistMock() {
  if (!mock || mock.phase === 'done' || mock.phase === 'review') return;
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify({ ...mock, savedAt: Date.now() }));
  } catch {}
}

function clearPersisted() {
  try {
    localStorage.removeItem(MOCK_KEY);
  } catch {}
}

function readPersisted() {
  try {
    const m = JSON.parse(localStorage.getItem(MOCK_KEY) || 'null');
    if (!m || !RESUME_PHASES.includes(m.phase) || !Array.isArray(m.queue) || !m.queue.length) return null;
    if (!m.savedAt || Date.now() - m.savedAt > 24 * 3600 * 1000) return null;
    return m;
  } catch {
    return null;
  }
}

function setInterviewing(on) {
  // 다른 화면으로 떠난 뒤에는 body 상태를 건드리지 않는다 (탭 바가 숨겨진 채 남지 않게)
  if (on && !mounted()) return;
  document.body.classList.toggle('is-interviewing', !!on);
}

// ---------- 라우트 ----------
export function render(el) {
  root = el;
  stopTick();
  stopDictation();
  if (!mock) return renderSetup();
  if (mock.phase === 'done') return renderDone();
  if (mock.phase === 'review') {
    setInterviewing(false);
    root.innerHTML = `<div class="mock"><p class="stage-q loading">전체 답변을 검토하는 중입니다<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span></p></div>`;
    return;
  }
  return renderInterview();
}

// 다른 탭으로 이동할 때 정리 (진행 상태는 메모리와 ip.mock에 남는다)
export function leave() {
  stopTick();
  stopDictation();
  tts.cancel();
  setInterviewing(false);
  persistMock();
}

// ---------- 설정 ----------
function basePool() {
  return state.questions.filter((q) => (config.type === 'all' || q.type === config.type) && (!config.onlyLinked || q.experienceIds?.length));
}

function pool() {
  const qs = basePool();
  return config.order === 'weak' ? qs.filter(isWeak) : qs;
}

function pickQueue() {
  const qs = pool();
  let ordered;
  switch (config.order) {
    case 'review': {
      const due = dueQueue(qs);
      const dueIds = new Set(due.map((q) => q.id));
      ordered = [...due, ...shuffle(qs.filter((q) => !dueIds.has(q.id)))];
      break;
    }
    case 'weak':
      ordered = weakFirst(qs);
      break;
    case 'easy':
      ordered = easyFirst(qs);
      break;
    default:
      ordered = shuffle(qs);
  }
  return ordered.slice(0, config.count).map((q) => q.id);
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  Object.assign(config, { preset: key, timer: p.timer, depth: p.depth, thinkSec: p.thinkSec, order: p.order, hideScore: null, autoHint: p.autoHint, gentle: p.gentle });
}

function poolLine() {
  const n = pool().length;
  if (config.order === 'weak' && !n && basePool().length) return `어렵다고 표시한 질문이 아직 없습니다.`;
  return `출제 가능 ${n}`;
}

function renderSetup() {
  setInterviewing(false);
  const saved = readPersisted();
  const dictOk = canDictate();
  if (!dictOk && config.answerMode === 'voice') config.answerMode = 'text';
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
  const orders = ['random', 'review', 'weak', ...(config.order === 'easy' ? ['easy'] : [])];
  root.innerHTML = `
    <div class="page-head">
      <h2>모의면접</h2>
      <p class="muted">질문을 뽑아 하나씩 묻습니다. 답하면 경험 카드를 바탕으로 꼬리질문이 이어집니다.</p>
    </div>
    ${
      saved
        ? `<div class="card pad" id="m-resume">
        <p>진행 중이던 모의면접 ${Math.min(saved.idx + 1, saved.queue.length)}/${saved.queue.length}</p>
        <div class="actions">
          <button type="button" class="btn ghost" data-r="discard">버리기</button>
          <button type="button" class="btn primary" data-r="resume">이어서</button>
        </div>
      </div>`
        : ''
    }
    <div class="card pad">
      <form class="form" id="m-setup">
        <div class="seg" id="m-preset" role="group" aria-label="프리셋">
          ${Object.entries(PRESETS)
            .map(([k, p]) => `<button type="button" data-preset="${k}" class="${config.preset === k ? 'on' : ''}" aria-pressed="${config.preset === k}">${p.label}</button>`)
            .join('')}
        </div>
        <div class="grid2">
          <label>질문 유형
            <select name="type">
              ${opt('all', '직무 + 인성', config.type)}
              ${opt('job', '직무만', config.type)}
              ${opt('personality', '인성만', config.type)}
            </select>
          </label>
          <label>질문 수<input name="count" type="number" inputmode="numeric" min="1" max="30" value="${config.count}"></label>
          <label>질문당 꼬리질문 수<input name="depth" type="number" inputmode="numeric" min="0" max="5" value="${config.depth}"></label>
          <label>답변 시간(초, 0이면 없음)<input name="timer" type="number" inputmode="numeric" min="0" max="600" step="10" value="${config.timer}"></label>
          <label>생각 시간
            <select name="thinkSec">${THINK_OPTIONS.map((v) => opt(v, v ? `${v}초` : '없음', config.thinkSec)).join('')}</select>
          </label>
          <label>출제 순서
            <select name="order">${orders.map((v) => opt(v, ORDER_LABEL[v], config.order)).join('')}</select>
          </label>
        </div>
        <div class="field">
          <span class="lbl-sm">답변 방식</span>
          <div class="seg" id="m-answer-mode" role="group" aria-label="답변 방식">
            <button type="button" data-amode="text" class="${config.answerMode === 'text' ? 'on' : ''}" aria-pressed="${config.answerMode === 'text'}">글로</button>
            <button type="button" data-amode="voice" class="${config.answerMode === 'voice' ? 'on' : ''}" aria-pressed="${config.answerMode === 'voice'}" ${dictOk ? '' : 'disabled'}>말로</button>
          </div>
          ${dictOk ? '' : '<p class="muted small">이 브라우저는 받아쓰기를 지원하지 않습니다.</p>'}
        </div>
        <label class="chk"><input type="checkbox" name="onlyLinked" ${config.onlyLinked ? 'checked' : ''}> 경험이 연결된 질문만</label>
        ${tts.available ? `<label class="chk"><input type="checkbox" name="tts" ${config.tts ? 'checked' : ''}> 질문을 소리 내어 읽어 주기</label>` : ''}
        <p class="muted small" id="m-pool">${esc(poolLine())}</p>
        ${ai.aiReady() ? '' : '<p class="notice">API 키가 없어 저장해 둔 꼬리질문만 쓰고 첨삭은 하지 않습니다.</p>'}
        <div class="actions"><button class="btn primary" id="m-start">면접 시작</button></div>
      </form>
    </div>`;

  const form = root.querySelector('#m-setup');
  const markCustom = () => {
    config.preset = 'custom';
    form.querySelectorAll('#m-preset button').forEach((b) => {
      b.classList.remove('on');
      b.setAttribute('aria-pressed', 'false');
    });
  };
  const read = () => {
    config.type = form.type.value;
    config.count = Math.max(1, Math.min(30, Number(form.count.value) || 5));
    config.depth = Math.max(0, Math.min(5, Number(form.depth.value) || 0));
    config.timer = Math.max(0, Number(form.timer.value) || 0);
    config.thinkSec = Number(form.thinkSec.value) || 0;
    config.order = form.order.value;
    config.onlyLinked = form.onlyLinked.checked;
    if (form.tts) config.tts = form.tts.checked;
    root.querySelector('#m-pool').textContent = poolLine();
  };
  form.onchange = () => {
    read();
    markCustom();
  };
  form.onclick = (ev) => {
    const p = ev.target.closest('[data-preset]');
    if (p) {
      applyPreset(p.dataset.preset);
      return renderSetup();
    }
    const m = ev.target.closest('[data-amode]');
    if (m && !m.disabled) {
      config.answerMode = m.dataset.amode;
      form.querySelectorAll('[data-amode]').forEach((b) => {
        const on = b.dataset.amode === config.answerMode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      markCustom();
    }
  };
  form.onsubmit = (ev) => {
    ev.preventDefault();
    read();
    const queue = pickQueue();
    if (!queue.length) return toast('조건에 맞는 질문이 없습니다. 질문을 먼저 추가하세요.', 'error');
    clearPersisted();
    mock = newMock(config, queue);
    startQuestion();
  };

  const resume = root.querySelector('#m-resume');
  if (resume) {
    resume.onclick = (ev) => {
      const b = ev.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === 'discard') {
        clearPersisted();
        return renderSetup();
      }
      const m = readPersisted();
      if (!m) {
        clearPersisted();
        return renderSetup();
      }
      delete m.savedAt;
      if (m.phase === 'loading') m.phase = 'answer';
      if (m.config && typeof m.config.hideScore !== 'boolean') m.config.hideScore = resolveHideScore(m.config);
      m.hints = m.hints || [];
      if (m.phase === 'answer') m.answerStartedAt = Date.now();
      if (!m.items[m.idx]) {
        mock = m;
        return startQuestion();
      }
      mock = m;
      persistMock();
      render(root);
      scrollTop();
    };
  }
}

// ---------- 진행 ----------
const current = () => mock.items[mock.idx];
const curTurn = () => current().turns[current().turns.length - 1];

function experiencesOf(questionId) {
  const q = byId('questions', questionId);
  return (q?.experienceIds || []).map((id) => byId('experiences', id)).filter(Boolean);
}

function questionOf(item) {
  return byId('questions', item.questionId) || { id: item.questionId, text: item.question, type: item.type };
}

/** 힌트에 쓸 질문 객체: 꼬리질문이면 그 질문 기준으로 (본 질문의 첫 문장, 답변은 쓰지 않는다) */
function hintQuestion(item, turn) {
  const q = questionOf(item);
  if (item.turns.length <= 1) return q;
  return { ...q, text: turn.q, intent: turn.intent || '', prep: q.prep?.kind ? { kind: q.prep.kind } : null, answer: '' };
}

function resetTurnState() {
  mock.hints = [];
  mock.autoHinted = false;
  mock.shownAt = Date.now();
}

function startQuestion() {
  const q = byId('questions', mock.queue[mock.idx]);
  if (!q) {
    // 진행 중에 질문이 삭제된 경우
    mock.idx++;
    if (mock.idx < mock.queue.length) return startQuestion();
    return finishInterview();
  }
  mock.items[mock.idx] = { questionId: q.id, question: q.text, type: q.type, turns: [{ q: q.text, a: '', hintsUsed: 0 }] };
  resetTurnState();
  if (mock.config.thinkSec > 0) {
    mock.phase = 'think';
    mock.thinkLeft = mock.config.thinkSec;
    if (mock.config.autoHint) addAutoHint();
  } else {
    enterAnswerState();
  }
  persistMock();
  if (!mounted()) return;
  render(root);
  scrollTop();
  speakQuestion(q.text);
}

/** 새 질문이 나오면 맨 위(그만하기, 진행 막대)부터 보이게 */
function scrollTop() {
  if (mounted()) window.scrollTo(0, 0);
}

function enterAnswerState() {
  mock.phase = 'answer';
  mock.answerStartedAt = Date.now();
}

function enterAnswer() {
  enterAnswerState();
  persistMock();
  if (mounted()) render(root);
}

function addAutoHint() {
  const item = current();
  const turn = curTurn();
  const h = buildHint(1, { q: hintQuestion(item, turn), turn, exps: experiencesOf(item.questionId), phrases: state.phrases });
  mock.hints = [{ step: 1, title: h.title, html: h.html ?? h.fallbackHtml ?? '' }];
  mock.autoHinted = true;
}

function speakQuestion(text, force = false) {
  if (!tts.available || (!mock?.config?.tts && !force) || !mounted()) return;
  tts.speak(text);
}

function noteThink() {
  const turn = curTurn();
  if (turn && turn.thinkMs == null && mock.shownAt) {
    turn.thinkMs = Date.now() - mock.shownAt;
  }
}

// ---------- 면접 화면 ----------
function hintsHtml() {
  const full = mock.hints.length >= 4;
  return `${mock.hints.map(hintStepHtml).join('')}
    <button type="button" class="btn sm" data-m="hard" ${full || mock.phase === 'loading' ? 'disabled' : ''}>힌트</button>`;
}

function phraseBarHtml(insertable) {
  const items = allPhrasesFlat(state.phrases);
  return `<details class="phrase-bar" ${phraseOpen ? 'open' : ''}><summary>연결 멘트</summary><div class="phrase-chips">${items
    .map((p) =>
      insertable
        ? `<button type="button" class="chip phrase" data-m="phrase" data-text="${esc(p.text)}">${esc(p.text)}</button>`
        : `<span class="chip phrase">${esc(p.text)}</span>`
    )
    .join('')}</div></details>`;
}

function turnsHtml(turns) {
  return turns
    .map(
      (t, j) =>
        `<div class="turn"><div class="tq">${j ? icon('follow', { size: 14 }) : 'Q.'} ${esc(t.q)}</div><div class="ta">${nl2br(t.a || '(무응답)')}</div></div>`
    )
    .join('');
}

function timerText() {
  const sec = Math.floor((Date.now() - (mock.answerStartedAt || Date.now())) / 1000);
  const limit = mock.config.timer;
  if (!limit) return { text: fmtSec(sec), over: false };
  const over = sec > limit;
  return { text: `${fmtSec(sec)} / ${fmtSec(limit)}${over ? ` +${fmtSec(sec - limit)}` : ''}`, over };
}

function micLabel(active) {
  if (active) return `${icon('stop')} 멈추기 ${fmtSec(Math.floor((Date.now() - dictStartedAt) / 1000))}`;
  return `${icon('mic')} 말로<span class="mic-more"> 답하기</span>`;
}

function renderInterview() {
  const item = current();
  const turn = curTurn();
  const q = questionOf(item);
  const follows = item.turns.length - 1;
  const { phase } = mock;
  const loading = phase === 'loading';
  const thinking = phase === 'think';
  const confirming = phase === 'confirm';
  const n = mock.queue.length;
  setInterviewing(true);

  const prev = item.turns.slice(0, confirming ? item.turns.length : -1);
  const showMic = canDictate();
  const t = timerText();

  let stage;
  if (confirming) {
    stage = `
      <p class="stage-q">${esc(item.question)}</p>
      <div class="conf-row" role="group" aria-label="이 질문은">
        <span>이 질문은</span>
        ${CONF_KEYS.map((k) => `<button type="button" class="btn conf ${item.confidence === k ? 'on' : ''}" data-m="conf" data-v="${k}">${CONF_LABEL[k]}</button>`).join('')}
        <button type="button" class="btn ghost text" data-m="conf-skip">건너뛰기</button>
      </div>`;
  } else if (loading) {
    stage = `<p class="stage-q loading">다음 질문을 준비하는 중<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span></p>`;
  } else {
    stage = `
      <div class="who">면접관</div>
      <p class="stage-q">${esc(turn.q)}</p>
      ${tts.available ? `<button type="button" class="btn sm ghost" data-m="speak">${icon('listen')} 질문 다시 듣기</button>` : ''}
      ${
        thinking
          ? `<div id="m-think" class="think">
          <span class="think-label">생각 정리 <b class="think-n">${Math.ceil(mock.thinkLeft || 0)}</b></span>
          <div class="think-bar"><i style="width:${Math.max(0, Math.min(100, ((mock.thinkLeft || 0) / (mock.config.thinkSec || 1)) * 100))}%"></i></div>
          <button type="button" class="btn sm" data-m="skip-think">바로 답하기</button>
        </div>`
          : ''
      }
      <section class="hint-panel" id="m-hints">${hintsHtml()}</section>
      ${phraseBarHtml(phase === 'answer')}
      ${
        phase === 'answer'
          ? `<div class="answer-sheet">
          <textarea id="m-answer" rows="7" placeholder="말하듯이 적어 주세요. 키워드만 적어도 괜찮습니다.">${esc(turn.a)}</textarea>
        </div>`
          : ''
      }`;
  }

  root.innerHTML = `
    <div class="mock stage">
      <div class="mock-top">
        <div class="row between">
          <button type="button" class="btn ghost text" data-m="quit">그만하기</button>
          <span class="cnt">${mock.idx + 1} / ${n}</span>
        </div>
        <div class="ticks" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i class="${i < mock.idx || (i === mock.idx && confirming) ? 'done' : ''}"></i>`).join('')}</div>
      </div>
      <div class="q-meta muted small">
        <span class="badge">${esc(KIND_LABEL[kindOf(q)] || typeLabel(item.type))}</span>
        ${q.category ? `, ${esc(q.category)}` : ''}
        ${mock.config.depth ? `, 꼬리질문 ${follows}/${mock.config.depth}` : ''}
      </div>
      ${prev.length && !confirming ? `<details class="prev"><summary>앞선 문답 ${prev.length}</summary>${turnsHtml(prev)}</details>` : ''}
      ${stage}
      ${
        phase === 'answer' || thinking || loading
          ? `<div class="action-bar">
        ${phase === 'answer' ? `<span class="elapsed timer ${t.over ? 'over' : ''}" id="m-timer">${t.text}</span>` : ''}
        ${showMic && phase === 'answer' ? `<button type="button" class="btn" data-m="mic" aria-label="말로 답하기" title="말로 답하기">${micLabel(false)}</button>` : ''}
        <button type="button" class="btn ghost text" data-m="next" ${loading ? 'disabled' : ''}>건너뛰기</button>
        <button type="button" class="btn primary" data-m="submit" ${phase === 'answer' ? '' : 'disabled'}>답변 완료</button>
      </div>`
          : ''
      }
    </div>`;

  if (phase === 'answer') {
    const ta = root.querySelector('#m-answer');
    if (!isTouch()) ta.focus();
    ta.oninput = () => {
      noteThink();
      turn.a = ta.value;
      persistMock();
    };
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) root.querySelector('[data-m=submit]')?.click();
    };
    startTick();
  } else if (thinking) {
    startTick();
  }

  root.querySelector('.phrase-bar')?.addEventListener('toggle', (e) => (phraseOpen = e.target.open));
  root.onclick = onClick;
}

function insertAtCursor(text) {
  const ta = root.querySelector('#m-answer');
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

async function onClick(ev) {
  const b = ev.target.closest('[data-m]');
  if (!b || b.disabled || !mock) return;
  const item = current();
  const turn = curTurn();
  const ta = root.querySelector('#m-answer');
  if (ta) turn.a = ta.value;
  switch (b.dataset.m) {
    case 'skip-think':
      return enterAnswer();
    case 'mic':
      return toggleDictation(b, ta);
    case 'speak':
      return speakQuestion(turn.q, true);
    case 'phrase':
      return insertAtCursor(b.dataset.text || '');
    case 'hard':
      return addHint(b);
    case 'submit':
      if (!turn.a.trim() && !confirm('답하지 않고 넘어갈까요?')) return;
      return advance();
    case 'next':
      return finishQuestion();
    case 'conf':
      item.confidence = b.dataset.v;
      return moveOn();
    case 'conf-skip':
      return moveOn();
    case 'quit':
      if (confirm('여기서 마칠까요? 지금까지 답한 내용으로 첨삭합니다.')) {
        if (item && item.turns.length > 1 && !turn.a.trim()) item.turns.pop();
        return finishInterview();
      }
  }
}

async function addHint(btn) {
  const item = current();
  const turn = curTurn();
  const step = mock.hints.length + 1;
  if (step > 4) return;
  const exps = experiencesOf(item.questionId);
  const hq = hintQuestion(item, turn);
  let h = buildHint(step, { q: hq, turn, exps, phrases: state.phrases });
  if (h.needsAi) {
    let got = null;
    if (ai.aiReady()) {
      const my = mock;
      const r = await withLoading(btn, () => ai.hint({ question: hq, turns: item.turns, experiences: exps, step }), '찾는 중');
      if (mock !== my || current() !== item || curTurn() !== turn) return;
      if (r) got = hintFromAi(step, r);
    }
    h = got || { step, title: h.title, html: h.fallbackHtml };
  }
  mock.hints.push({ step, title: h.title, html: h.html ?? h.fallbackHtml ?? '' });
  turn.hintsUsed = mock.hints.length - (mock.autoHinted ? 1 : 0);
  persistMock();
  const panel = mounted() ? root.querySelector('#m-hints') : null;
  if (panel) panel.innerHTML = hintsHtml();
}

async function advance() {
  stopTick();
  stopDictation();
  const item = current();
  const follows = item.turns.length - 1;
  if (follows >= mock.config.depth) return finishQuestion();

  if (ai.aiReady()) {
    mock.phase = 'loading';
    persistMock();
    if (mounted()) render(root);
    const my = mock;
    try {
      const r = await ai.nextFollowUp({ question: questionOf(item), turns: item.turns, experiences: experiencesOf(item.questionId) });
      if (mock !== my || my.phase !== 'loading') return;
      if (!r?.question) return finishQuestion();
      item.turns.push({ q: r.question, a: '', intent: r.intent || '', cues: r.cues || [], hintsUsed: 0 });
    } catch (e) {
      if (mock !== my || my.phase !== 'loading') return;
      if (mounted()) toast(e.message, 'error', 5000);
      return finishQuestion();
    }
  } else {
    // API 키 없이: 질문에 저장해 둔 꼬리질문 사용
    const saved = byId('questions', item.questionId)?.followUps || [];
    const next = saved[follows];
    if (!next) return finishQuestion();
    item.turns.push({ q: next.text, a: '', hintsUsed: 0 });
  }
  resetTurnState();
  enterAnswerState();
  persistMock();
  // 기다리는 사이 다른 화면으로 갔으면 상태만 저장해 두고, 돌아왔을 때 render()가 지금 단계를 그린다
  if (!mounted()) return;
  render(root);
  scrollTop();
  speakQuestion(curTurn().q);
}

function finishQuestion() {
  stopTick();
  stopDictation();
  const item = current();
  if (item.turns.length > 1 && !item.turns.at(-1).a.trim()) item.turns.pop();
  if (item.turns.some((t) => t.a.trim())) {
    mock.phase = 'confirm';
    persistMock();
    if (mounted()) render(root);
    return;
  }
  return moveOn();
}

function moveOn() {
  mock.idx++;
  if (mock.idx < mock.queue.length) return startQuestion();
  return finishInterview();
}

async function finishInterview() {
  stopTick();
  stopDictation();
  tts.cancel();
  const items = mock.items.filter((it) => it && it.turns.some((t) => t.a.trim()));
  if (!items.length) {
    toast('답한 질문이 없어 기록하지 않았습니다.');
    mock = null;
    clearPersisted();
    if (mounted()) render(root);
    return;
  }
  // 질문별 체감 난이도 → 복습 일정 (단계는 바꾸지 않는다)
  for (const it of items) {
    if (!it.confidence) continue;
    const q = byId('questions', it.questionId);
    if (!q) continue;
    const hintsUsed = Math.max(0, ...it.turns.map((t) => t.hintsUsed || 0));
    upsert('questions', { id: q.id, drill: rateDrill(q.drill, it.confidence, { hintsUsed, adjustLevel: false }) });
  }
  const cfg = mock.config;
  const queue = mock.queue;
  // 첨삭을 기다리기 전에 답변부터 기록한다: 검토 중에 새로고침하거나 탭이 닫혀도 답변은 남는다
  items.forEach((it) => (it.feedback = null));
  const session = addSession({ mode: 'mock', startedAt: mock.startedAt, config: cfg, items, overall: null });
  clearPersisted();
  if (ai.aiReady()) {
    const my = (mock = { phase: 'review', session, queue, config: cfg });
    if (mounted()) render(root);
    let review = null;
    try {
      review = await ai.mockReview({ items, gentle: cfg.preset === 'warmup' || !!cfg.gentle });
    } catch (e) {
      toast(`첨삭 실패: ${e.message}`, 'error', 5000);
    }
    if (review) {
      // 사용자가 그 사이 기록을 지웠으면 되살리지 않는다
      session.items.forEach((it, i) => (it.feedback = review.items?.[i] || null));
      session.overall = review.overall || null;
      if (state.sessions.includes(session)) markDirty('sessions');
    }
    if (mock !== my) return;
  }
  mock = { phase: 'done', session, queue, config: cfg };
  if (mounted()) render(root);
}

// ---------- 결과 ----------
function renderDone() {
  setInterviewing(false);
  const s = mock.session;
  const hideScore = typeof mock.config?.hideScore === 'boolean' ? mock.config.hideScore : !!getSettings().hideScore;
  const ov = s.overall;
  root.innerHTML = `
    <div class="page-head">
      <h2>모의면접 결과</h2>
      <p class="muted">${esc(fmtDate(s.startedAt))} 기록에 저장했습니다.</p>
    </div>
    ${ov?.oneFix ? `<p class="fb-one"><span class="lbl-sm">이번에 먼저 고칠 점</span>${esc(ov.oneFix)}</p>` : ''}
    ${ov ? `<div class="card pad"><h3>총평</h3>${feedbackHtml({ ...ov, oneFix: '' }, { hideScore })}</div>` : '<p class="notice">첨삭 없이 답변만 기록했습니다.</p>'}
    ${s.items
      .map((it, i) => {
        const parts = [`질문 ${i + 1}`, esc(it.question || '')];
        if (!hideScore && it.feedback?.score != null) parts.push(`${esc(it.feedback.score)} / 10`);
        if (it.confidence) parts.push(CONF_LABEL[it.confidence] || '');
        return `
      <details class="card pad">
        <summary><span class="clamp1">${parts.join(', ')}</span></summary>
        <div class="q-meta"><span class="badge ${esc(it.type)}">${typeLabel(it.type)}</span></div>
        ${turnsHtml(it.turns)}
        ${feedbackHtml(it.feedback, { hideScore })}
      </details>`;
      })
      .join('')}
    <div class="actions">
      <button type="button" class="btn" id="m-again">같은 질문으로 다시</button>
      <button type="button" class="btn primary" id="m-new">새로 뽑기</button>
    </div>`;
  root.querySelector('#m-again').onclick = () => {
    const queue = (mock.queue || []).filter((id) => byId('questions', id));
    const cfg = mock.config || { ...config };
    if (!queue.length) {
      mock = null;
      return render(root);
    }
    mock = newMock(cfg, queue);
    startQuestion();
  };
  root.querySelector('#m-new').onclick = () => {
    mock = null;
    render(root);
  };
}

// ---------- 타이머 (생각 시간 카운트다운 + 답변 경과 시간) ----------
function startTick() {
  stopTick();
  let last = Date.now();
  tickId = setInterval(() => {
    if (!mock || !root?.isConnected) return stopTick();
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    if (mock.phase === 'think') {
      mock.thinkLeft = Math.max(0, (mock.thinkLeft || 0) - dt);
      const nEl = root.querySelector('#m-think .think-n');
      const bar = root.querySelector('#m-think .think-bar > i');
      if (nEl) nEl.textContent = String(Math.ceil(mock.thinkLeft));
      if (bar) bar.style.width = `${(mock.thinkLeft / (mock.config.thinkSec || 1)) * 100}%`;
      if (mock.thinkLeft <= 0) {
        stopTick();
        enterAnswer();
      }
      return;
    }
    if (mock.phase === 'answer') {
      const el = root.querySelector('#m-timer');
      if (el) {
        const t = timerText();
        el.textContent = t.text;
        el.classList.toggle('over', t.over);
      }
      if (dict?.active) {
        const mic = root.querySelector('[data-m=mic]');
        if (mic) mic.innerHTML = micLabel(true);
      }
    }
  }, 250);
}

function stopTick() {
  clearInterval(tickId);
  tickId = null;
}

// ---------- 받아쓰기 ----------
function toggleDictation(btn, ta) {
  if (dict?.active) return stopDictation();
  if (!ta) return;
  const turn = curTurn();
  const base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
  noteThink();
  dict = dictation({
    base,
    onText: (text) => {
      if (!ta.isConnected) return;
      ta.value = text;
      turn.a = text;
      persistMock();
    },
    onState: (active, err) => {
      const b = root?.querySelector('[data-m=mic]');
      if (b) {
        b.classList.toggle('is-rec', active);
        b.innerHTML = micLabel(active);
      }
      if (err) toast(err, 'error');
    },
  });
  dictStartedAt = Date.now();
  dict.start();
}

function stopDictation() {
  try {
    dict?.stop();
  } catch {}
  dict = null;
}
