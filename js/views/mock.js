// 모의면접: 질문 → 답변 → (AI) 꼬리질문 → … → 전체 피드백 → 기록 저장
import { state, byId, addSession } from '../store.js';
import { esc, nl2br, toast, typeLabel, shuffle, feedbackHtml } from '../ui.js';
import * as ai from '../ai.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const config = { type: 'all', count: 5, depth: 2, onlyLinked: false, timer: 90, tts: false };
let mock = null; // 진행 중인 면접
let root;
let timerId = null;
let recog = null;

export function render(el) {
  root = el;
  stopTimer();
  stopRecog();
  if (!mock) return renderSetup();
  if (mock.phase === 'done') return renderDone();
  if (mock.phase === 'review') {
    root.innerHTML = `<div class="card pad center"><span class="spinner"></span> 면접관이 전체 답변을 평가하고 있어요…</div>`;
    return;
  }
  return renderInterview();
}

// 다른 탭으로 이동할 때 정리
export function leave() {
  stopTimer();
  stopRecog();
  window.speechSynthesis?.cancel();
}

function pool() {
  return state.questions.filter((q) => (config.type === 'all' || q.type === config.type) && (!config.onlyLinked || q.experienceIds?.length));
}

function renderSetup() {
  const n = pool().length;
  root.innerHTML = `
    <div class="page-head">
      <h2>모의면접</h2>
      <p class="muted">질문 리스트에서 무작위로 질문을 뽑아 실전처럼 연습해요. 답변하면 AI 면접관이 경험 카드를 참고해 꼬리질문을 이어갑니다.</p>
    </div>
    <div class="card pad">
      <form class="form" id="m-setup">
        <div class="grid2">
          <label>질문 유형
            <select name="type">
              <option value="all" ${config.type === 'all' ? 'selected' : ''}>직무 + 인성</option>
              <option value="job" ${config.type === 'job' ? 'selected' : ''}>직무만</option>
              <option value="personality" ${config.type === 'personality' ? 'selected' : ''}>인성만</option>
            </select>
          </label>
          <label>질문 수<input name="count" type="number" min="1" max="30" value="${config.count}"></label>
          <label>질문당 꼬리질문 수<input name="depth" type="number" min="0" max="5" value="${config.depth}"></label>
          <label>답변 제한 시간(초, 0=없음)<input name="timer" type="number" min="0" max="600" step="10" value="${config.timer}"></label>
        </div>
        <label class="chk"><input type="checkbox" name="onlyLinked" ${config.onlyLinked ? 'checked' : ''}> 경험이 연결된 질문만</label>
        <label class="chk"><input type="checkbox" name="tts" ${config.tts ? 'checked' : ''}> 질문을 음성으로 읽어주기</label>
        <p class="muted small" id="m-pool">출제 가능한 질문 ${n}개</p>
        ${ai.aiReady() ? '' : '<p class="notice">OpenAI 키가 없으면 AI 꼬리질문/피드백 대신, 질문에 저장해둔 꼬리질문을 사용하고 피드백은 생략돼요.</p>'}
        <div class="actions"><button class="btn primary lg">면접 시작</button></div>
      </form>
    </div>`;
  const form = root.querySelector('#m-setup');
  const read = () => {
    config.type = form.type.value;
    config.count = Math.max(1, Number(form.count.value) || 5);
    config.depth = Math.max(0, Math.min(5, Number(form.depth.value) || 0));
    config.timer = Math.max(0, Number(form.timer.value) || 0);
    config.onlyLinked = form.onlyLinked.checked;
    config.tts = form.tts.checked;
    root.querySelector('#m-pool').textContent = `출제 가능한 질문 ${pool().length}개`;
  };
  form.onchange = read;
  form.onsubmit = (ev) => {
    ev.preventDefault();
    read();
    const picked = shuffle(pool()).slice(0, config.count);
    if (!picked.length) return toast('출제할 질문이 없어요. 질문 리스트를 먼저 채워주세요.', 'error');
    mock = { config: { ...config }, queue: picked.map((q) => q.id), idx: 0, items: [], startedAt: new Date().toISOString(), phase: 'answer' };
    startQuestion();
  };
}

function current() {
  return mock.items[mock.idx];
}

function startQuestion() {
  const q = byId('questions', mock.queue[mock.idx]);
  mock.items[mock.idx] = { questionId: q.id, question: q.text, type: q.type, turns: [{ q: q.text, a: '' }] };
  mock.phase = 'answer';
  render(root);
  speak(q.text);
}

function experiencesOf(questionId) {
  const q = byId('questions', questionId);
  return (q?.experienceIds || []).map((id) => byId('experiences', id)).filter(Boolean);
}

function renderInterview() {
  const item = current();
  const turn = item.turns[item.turns.length - 1];
  const isFollow = item.turns.length > 1;
  const loading = mock.phase === 'loading';
  root.innerHTML = `
    <div class="mock">
      <div class="mock-top">
        <div class="progress"><div style="width:${(mock.idx / mock.queue.length) * 100}%"></div></div>
        <div class="muted small">질문 ${mock.idx + 1} / ${mock.queue.length} · <span class="badge ${item.type}">${typeLabel(item.type)}</span>
          ${isFollow ? ` · 꼬리질문 ${item.turns.length - 1}/${mock.config.depth}` : ''}</div>
      </div>

      ${
        item.turns.length > 1
          ? `<div class="transcript">${item.turns
              .slice(0, -1)
              .map((t, i) => `<div class="turn"><div class="tq">${i ? '↳ ' : 'Q. '}${esc(t.q)}</div><div class="ta">${nl2br(t.a || '(무응답)')}</div></div>`)
              .join('')}</div>`
          : ''
      }

      <div class="interviewer">
          <div class="avatar">🧑‍💼</div>
          <div class="bubble">${loading ? '<span class="spinner"></span> 꼬리질문을 생각하는 중…' : `${isFollow ? '<span class="muted small">꼬리질문</span><br>' : ''}${esc(turn.q)}`}</div>
        </div>
        <div class="answer-box">
          <textarea id="m-answer" rows="6" placeholder="실제로 말하듯이 답변해 보세요." ${loading ? 'disabled' : ''}>${esc(turn.a)}</textarea>
          <div class="row between">
            <div class="row">
              ${SR ? `<button class="btn sm" data-m="mic" ${loading ? 'disabled' : ''}>🎙 음성 입력</button>` : ''}
              <button class="btn sm ghost" data-m="speak" ${loading ? 'disabled' : ''}>🔊 다시 듣기</button>
              ${mock.config.timer ? `<span class="timer" id="m-timer">${mock.config.timer}s</span>` : ''}
            </div>
            <div class="row">
              <button class="btn ghost danger sm" data-m="quit">면접 종료</button>
              <button class="btn ghost sm" data-m="next" ${loading ? 'disabled' : ''}>다음 질문으로</button>
              <button class="btn primary" data-m="submit" ${loading ? 'disabled' : ''}>답변 제출</button>
            </div>
          </div>
        </div>
    </div>`;

  if (!loading) {
    startTimer();
    const ta = root.querySelector('#m-answer');
    ta.focus();
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) root.querySelector('[data-m=submit]').click();
    };
  }

  root.onclick = async (ev) => {
    const b = ev.target.closest('[data-m]');
    if (!b) return;
    const ta = root.querySelector('#m-answer');
    if (ta) turn.a = ta.value;
    switch (b.dataset.m) {
      case 'mic':
        return toggleRecog(b, ta);
      case 'speak':
        return speak(turn.q, true);
      case 'submit':
        if (!turn.a.trim() && !confirm('답변이 비어 있어요. 그대로 넘어갈까요?')) return;
        return advance();
      case 'next':
        return finishQuestion();
      case 'quit':
        if (confirm('면접을 종료하고 지금까지의 답변으로 평가받을까요?')) {
          if (!turn.a.trim() && item.turns.length > 1) item.turns.pop();
          return finishInterview();
        }
    }
  };
}

async function advance() {
  stopTimer();
  stopRecog();
  const item = current();
  const follows = item.turns.length - 1;
  if (follows >= mock.config.depth) return finishQuestion();

  if (ai.aiReady()) {
    mock.phase = 'loading';
    render(root);
    try {
      const r = await ai.nextFollowUp({ question: byId('questions', item.questionId) || { text: item.question, type: item.type }, turns: item.turns, experiences: experiencesOf(item.questionId) });
      if (!mock) return;
      if (!r?.question) return finishQuestion();
      item.turns.push({ q: r.question, a: '', intent: r.intent });
    } catch (e) {
      toast(e.message, 'error', 5000);
      return finishQuestion();
    }
  } else {
    // AI 없이: 질문에 저장해 둔 꼬리질문 사용
    const saved = byId('questions', item.questionId)?.followUps || [];
    const next = saved[follows];
    if (!next) return finishQuestion();
    item.turns.push({ q: next.text, a: '' });
  }
  mock.phase = 'answer';
  render(root);
  speak(current().turns.at(-1).q);
}

function finishQuestion() {
  stopTimer();
  stopRecog();
  const item = current();
  if (item.turns.length > 1 && !item.turns.at(-1).a.trim()) item.turns.pop();
  mock.idx++;
  if (mock.idx < mock.queue.length) return startQuestion();
  return finishInterview();
}

async function finishInterview() {
  stopTimer();
  stopRecog();
  window.speechSynthesis?.cancel();
  const items = mock.items.filter((it) => it && it.turns.some((t) => t.a.trim()));
  if (!items.length) {
    toast('답변한 질문이 없어 기록하지 않았어요.');
    mock = null;
    return render(root);
  }
  let review = null;
  if (ai.aiReady()) {
    mock.phase = 'review';
    render(root);
    try {
      review = await ai.mockReview({ items });
    } catch (e) {
      toast(`피드백 생성 실패: ${e.message}`, 'error', 5000);
    }
    if (!mock) return;
  }
  items.forEach((it, i) => (it.feedback = review?.items?.[i] || null));
  const session = addSession({ mode: 'mock', startedAt: mock.startedAt, config: mock.config, items, overall: review?.overall || null });
  mock = { phase: 'done', session };
  render(root);
}

function renderDone() {
  const s = mock.session;
  root.innerHTML = `
    <div class="page-head">
      <h2>모의면접 결과</h2>
      <p class="muted">기록 탭과 각 질문의 "피드백 기록"에 저장됐어요.</p>
    </div>
    ${s.overall ? `<div class="card pad"><h3>총평</h3>${feedbackHtml(s.overall)}</div>` : '<p class="notice">AI 피드백 없이 답변만 기록했어요.</p>'}
    ${s.items
      .map(
        (it, i) => `
      <div class="card pad">
        <div class="q-meta"><span class="badge ${it.type}">${typeLabel(it.type)}</span> <b>질문 ${i + 1}</b></div>
        ${it.turns.map((t, j) => `<div class="turn"><div class="tq">${j ? '↳ ' : 'Q. '}${esc(t.q)}</div><div class="ta">${nl2br(t.a || '(무응답)')}</div></div>`).join('')}
        ${feedbackHtml(it.feedback)}
      </div>`
      )
      .join('')}
    <div class="actions"><button class="btn primary" id="m-again">다시 하기</button></div>`;
  root.querySelector('#m-again').onclick = () => {
    mock = null;
    render(root);
  };
}

// ---------- timer / speech ----------
function startTimer() {
  stopTimer();
  if (!mock.config.timer) return;
  let left = mock.config.timer;
  timerId = setInterval(() => {
    const el = document.getElementById('m-timer');
    if (!el) return stopTimer();
    left--;
    el.textContent = `${left}s`;
    el.classList.toggle('over', left <= 0);
    if (left <= 0) {
      el.textContent = `시간 초과 ${-left}s`;
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

function speak(text, force = false) {
  if (!window.speechSynthesis || (!mock?.config?.tts && !force)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  speechSynthesis.speak(u);
}

function toggleRecog(btn, ta) {
  if (recog) return stopRecog();
  recog = new SR();
  recog.lang = 'ko-KR';
  recog.continuous = true;
  recog.interimResults = true;
  const base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
  let finalText = '';
  recog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    ta.value = base + finalText + interim;
  };
  recog.onerror = (e) => toast(`음성 인식 오류: ${e.error}`, 'error');
  recog.onend = () => {
    recog = null;
    if (btn.isConnected) btn.classList.remove('rec');
  };
  recog.start();
  btn.classList.add('rec');
}

function stopRecog() {
  try {
    recog?.stop();
  } catch {}
  recog = null;
}
