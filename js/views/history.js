import { state, removeSession, getSettings } from '../store.js';
import { esc, nl2br, typeLabel, fmtDate, feedbackHtml, MODE_LABEL, modeLabel, icon, fmtSec } from '../ui.js';
import { LEVEL_LABEL, CONF_LABEL } from '../coach.js';

let root;
let filter = 'all';

const FILTERS = [['all', '전체'], ...Object.entries(MODE_LABEL)];

/** 세션의 대표 점수: 모의면접은 총평, 개별 연습/말하기는 문항 점수 */
function sessionScores(s) {
  if (s.mode === 'mock') return typeof s.overall?.score === 'number' ? [s.overall.score] : [];
  return (s.items || []).map((i) => i.feedback?.score).filter((x) => typeof x === 'number');
}

function summaryLine(hideScore) {
  const count = (m) => state.sessions.filter((s) => s.mode === m).length;
  const parts = Object.entries(MODE_LABEL).map(([m, l]) => `${l} <b>${count(m)}</b>`);
  if (!hideScore) {
    const recent = [...state.sessions]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .flatMap(sessionScores)
      .slice(0, 10);
    if (recent.length) parts.push(`최근 ${recent.length}회 평균 <b>${(recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(1)}</b> / 10`);
  }
  return parts.join(' · ');
}

function attemptRow(a, i) {
  const parts = [`${i + 1}회`];
  if (a.level != null && LEVEL_LABEL[a.level]) parts.push(LEVEL_LABEL[a.level]);
  if (a.inputMode) parts.push(a.inputMode === 'voice' ? '말로' : '글로');
  if (a.durMs != null) parts.push(`길이 ${fmtSec(a.durMs / 1000)}`);
  else if (a.estSec != null) parts.push(`길이 약 ${fmtSec(a.estSec)}`);
  if (a.firstSpeechMs != null) parts.push(`첫마디 ${(a.firstSpeechMs / 1000).toFixed(1)}초`);
  if (a.pauses != null) parts.push(`멈춤 ${a.pauses}`);
  if (a.spm != null) parts.push(`${a.spm}음절/분`);
  if (a.hintsUsed) parts.push(`힌트 ${a.hintsUsed}`);
  if (a.confidence && CONF_LABEL[a.confidence]) parts.push(CONF_LABEL[a.confidence]);
  return `<li>${esc(parts.join(' · '))}</li>`;
}

function turnsHtml(turns) {
  return (turns || [])
    .map(
      (t, j) =>
        `<div class="turn"><div class="tq">${j ? icon('follow', { size: 14 }) : 'Q.'} ${esc(t.q)}</div><div class="ta">${nl2br(t.a || '(무응답)')}</div></div>`
    )
    .join('');
}

function itemHtml(s, it, i) {
  const attempts = Array.isArray(it.attempts) ? it.attempts : [];
  return `
    <div class="box">
      <div class="q-meta"><span class="badge ${esc(it.type)}">${typeLabel(it.type)}</span> <b>질문 ${i + 1}</b>
        ${it.confidence && CONF_LABEL[it.confidence] ? ` · <span class="tag">${CONF_LABEL[it.confidence]}</span>` : ''}</div>
      ${turnsHtml(it.turns)}
      ${attempts.length ? `<div class="attempts"><span class="lbl-sm">시도 ${attempts.length}</span><ul class="attempt-list">${attempts.map(attemptRow).join('')}</ul></div>` : ''}
      ${feedbackHtml(it.feedback)}
    </div>`;
}

function headScore(s, hideScore) {
  if (hideScore) return '';
  const sc = s.mode === 'mock' ? s.overall?.score : s.items?.[0]?.feedback?.score;
  return sc != null && sc !== '' && typeof sc !== 'object' ? `<span class="sc">${esc(sc)} / 10</span>` : '';
}

function sessionHtml(s, hideScore) {
  const n = s.items?.length || 0;
  const tries = s.mode === 'speak' ? (s.items || []).reduce((a, it) => a + (it.attempts?.length || 0), 0) : 0;
  return `
    <details class="card pad session" data-id="${esc(s.id)}">
      <summary>
        <span class="sess-line"><span class="d">${esc(fmtDate(s.startedAt))}</span><b class="m">${esc(modeLabel(s.mode))}</b><span class="n">${
          s.mode === 'speak' ? `시도 ${tries}` : `${n}문항`
        }</span>${headScore(s, hideScore)}</span>
        <span class="muted small clamp1">${esc(s.items?.[0]?.question || '')}</span>
      </summary>
      ${s.overall ? `<div class="box"><h4>총평</h4>${feedbackHtml(s.overall)}</div>` : ''}
      ${(s.items || []).map((it, i) => itemHtml(s, it, i)).join('')}
      <div class="actions"><button type="button" class="btn sm ghost danger" data-h="del">삭제</button></div>
    </details>`;
}

export function render(el) {
  root = el;
  const hideScore = !!getSettings().hideScore;
  const sessions = [...state.sessions]
    .filter((s) => filter === 'all' || s.mode === filter)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  el.innerHTML = `
    <div class="page-head">
      <h2>기록</h2>
      <p class="summary-line">${summaryLine(hideScore)}</p>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="기록 종류">${FILTERS.map(
        ([v, l]) => `<button type="button" data-h="filter" data-v="${v}" class="${filter === v ? 'on' : ''}" aria-pressed="${filter === v}">${l}</button>`
      ).join('')}</div>
    </div>
    ${sessions.length ? sessions.map((s) => sessionHtml(s, hideScore)).join('') : '<p class="empty">기록이 없습니다.</p>'}`;

  el.onclick = (ev) => {
    const b = ev.target.closest('[data-h]');
    if (!b) return;
    if (b.dataset.h === 'filter') {
      filter = b.dataset.v;
      return render(root);
    }
    if (b.dataset.h === 'del' && confirm('이 기록을 삭제할까요?')) {
      removeSession(b.closest('[data-id]').dataset.id);
      render(root);
    }
  };
}
