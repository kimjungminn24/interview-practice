import { state, removeSession } from '../store.js';
import { esc, nl2br, typeLabel, fmtDate, feedbackHtml } from '../ui.js';

let root;
let filter = 'all';

export function render(el) {
  root = el;
  const sessions = [...state.sessions]
    .filter((s) => filter === 'all' || s.mode === filter)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const scored = state.sessions.flatMap((s) => (s.items || []).map((i) => i.feedback?.score)).filter((x) => typeof x === 'number');
  const avg = scored.length ? (scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(1) : '-';

  el.innerHTML = `
    <div class="page-head">
      <h2>연습 기록</h2>
      <p class="muted">모든 기록은 저장소의 <code>data/sessions.json</code>에 남아요.</p>
    </div>
    <div class="stats">
      <div class="stat"><b>${state.sessions.filter((s) => s.mode === 'mock').length}</b><span>모의면접</span></div>
      <div class="stat"><b>${state.sessions.filter((s) => s.mode === 'single').length}</b><span>개별 연습</span></div>
      <div class="stat"><b>${avg}</b><span>평균 점수</span></div>
    </div>
    <div class="toolbar">
      <div class="seg">${[
        ['all', '전체'],
        ['mock', '모의면접'],
        ['single', '개별 연습'],
      ]
        .map(([v, l]) => `<button data-h="filter" data-v="${v}" class="${filter === v ? 'on' : ''}">${l}</button>`)
        .join('')}</div>
    </div>
    ${
      sessions.length
        ? sessions
            .map(
              (s) => `
      <details class="card pad session" data-id="${s.id}">
        <summary>
          <span><b>${s.mode === 'mock' ? '🎤 모의면접' : '✏️ 개별 연습'}</b> · ${fmtDate(s.startedAt)} · ${s.items?.length || 0}문항
          ${s.overall?.score != null ? ` · <b>${esc(s.overall.score)}점</b>` : s.items?.[0]?.feedback?.score != null && s.mode === 'single' ? ` · <b>${esc(s.items[0].feedback.score)}점</b>` : ''}</span>
          <span class="muted small clamp1">${esc(s.items?.[0]?.question || '')}</span>
        </summary>
        ${s.overall ? `<div class="box"><h4>총평</h4>${feedbackHtml(s.overall)}</div>` : ''}
        ${(s.items || [])
          .map(
            (it, i) => `
          <div class="box">
            <div class="q-meta"><span class="badge ${it.type}">${typeLabel(it.type)}</span> <b>질문 ${i + 1}</b></div>
            ${(it.turns || []).map((t, j) => `<div class="turn"><div class="tq">${j ? '↳ ' : 'Q. '}${esc(t.q)}</div><div class="ta">${nl2br(t.a || '(무응답)')}</div></div>`).join('')}
            ${feedbackHtml(it.feedback)}
          </div>`
          )
          .join('')}
        <div class="actions"><button class="btn sm ghost danger" data-h="del">기록 삭제</button></div>
      </details>`
            )
            .join('')
        : '<p class="empty">아직 연습 기록이 없어요.</p>'
    }`;

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
