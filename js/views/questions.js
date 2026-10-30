import { state, byId, upsert, removeQuestion, addSession, historyOf, practiceCounts } from '../store.js';
import { esc, nl2br, openModal, toast, typeLabel, fmtDate, uid, withLoading, feedbackHtml } from '../ui.js';
import * as ai from '../ai.js';
import { openQuestionForm, openLinkedView, openLinkEditor, categoryOptions, experienceDetailHtml } from './components.js';

const f = { type: 'all', cat: '', q: '', unlinked: false };
let root;

export function render(el) {
  root = el;
  const count = (t) => state.questions.filter((q) => t === 'all' || q.type === t).length;
  el.innerHTML = `
    <div class="page-head">
      <h2>질문 리스트</h2>
      <p class="muted">"보기"를 누르면 질문에 연결된 경험 카드가 나와요. "연습"에서 답변을 쓰고 꼬리질문·피드백을 받아보세요.</p>
    </div>
    <div class="toolbar">
      <div class="seg">${['all', 'job', 'personality']
        .map((t) => `<button data-action="type" data-v="${t}" class="${f.type === t ? 'on' : ''}">${t === 'all' ? '전체' : typeLabel(t)} <span class="cnt">${count(t)}</span></button>`)
        .join('')}</div>
      <select id="q-cat"><option value="">모든 카테고리</option>${categoryOptions(f.type === 'all' ? null : f.type)
        .map((c) => `<option ${f.cat === c ? 'selected' : ''}>${esc(c)}</option>`)
        .join('')}</select>
      <input type="search" id="q-search" placeholder="질문 검색" value="${esc(f.q)}">
      <label class="chk"><input type="checkbox" id="q-unlinked" ${f.unlinked ? 'checked' : ''}> 경험 미연결만</label>
      <button class="btn primary" data-action="new">+ 질문 추가</button>
    </div>
    <div class="q-list" id="q-list"></div>`;
  renderList();

  el.querySelector('#q-search').oninput = (e) => {
    f.q = e.target.value;
    renderList();
  };
  el.querySelector('#q-cat').onchange = (e) => {
    f.cat = e.target.value;
    renderList();
  };
  el.querySelector('#q-unlinked').onchange = (e) => {
    f.unlinked = e.target.checked;
    renderList();
  };
  el.onclick = (ev) => {
    const b = ev.target.closest('[data-action]');
    if (!b) return;
    const id = b.closest('[data-id]')?.dataset.id;
    const rerender = () => render(root);
    switch (b.dataset.action) {
      case 'type':
        f.type = b.dataset.v;
        f.cat = '';
        return rerender();
      case 'new':
        return openQuestionForm({ type: f.type === 'all' ? 'job' : f.type, category: f.cat }, rerender);
      case 'view':
        return openLinkedView(id, renderList);
      case 'practice':
        return openPractice(id, renderList);
      case 'edit':
        return openQuestionForm(byId('questions', id), rerender);
      case 'del':
        if (confirm('이 질문을 삭제할까요?')) {
          removeQuestion(id);
          rerender();
        }
    }
  };
}

function filtered() {
  const kw = f.q.trim().toLowerCase();
  return state.questions.filter(
    (q) =>
      (f.type === 'all' || q.type === f.type) &&
      (!f.cat || q.category === f.cat) &&
      (!f.unlinked || !q.experienceIds?.length) &&
      (!kw || `${q.text} ${q.category} ${q.answer}`.toLowerCase().includes(kw))
  );
}

// 꼬리질문 카드(parentId)는 부모 바로 아래에 들여쓰기로 보여준다
function ordered(items) {
  const ids = new Set(items.map((q) => q.id));
  const children = {};
  for (const q of items) if (q.parentId && ids.has(q.parentId)) (children[q.parentId] ||= []).push(q);
  const out = [];
  const walk = (q, depth) => {
    out.push([q, depth]);
    (children[q.id] || []).forEach((c) => walk(c, depth + 1));
  };
  items
    .filter((q) => !q.parentId || !ids.has(q.parentId))
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'job' ? -1 : 1))
    .forEach((q) => walk(q, 0));
  return out;
}

function renderList() {
  const counts = practiceCounts();
  const rows = ordered(filtered());
  root.querySelector('#q-list').innerHTML = rows.length
    ? rows
        .map(([q, depth]) => {
          const n = q.experienceIds?.length || 0;
          return `
      <div class="q-row ${depth ? 'child' : ''}" style="--depth:${Math.min(depth, 4)}" data-id="${q.id}">
        <div class="q-main">
          <div class="q-meta">
            <span class="badge ${q.type}">${typeLabel(q.type)}</span>
            ${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}
            ${q.source === 'ai' ? '<span class="tag ai">AI</span>' : ''}
            ${q.parentId ? '<span class="tag">꼬리질문</span>' : ''}
          </div>
          <div class="q-text">${depth ? '↳ ' : ''}${esc(q.text)}</div>
          <div class="muted small">경험 ${n}개 · 꼬리질문 ${q.followUps?.length || 0} · 연습 ${counts[q.id] || 0}회${q.answer ? ' · 답변 작성됨' : ''}</div>
        </div>
        <div class="q-actions">
          <button class="btn sm ${n ? '' : 'warn'}" data-action="view">보기${n ? ` (${n})` : ''}</button>
          <button class="btn sm primary" data-action="practice">연습</button>
          <button class="btn sm ghost" data-action="edit">수정</button>
          <button class="btn sm ghost danger" data-action="del">삭제</button>
        </div>
      </div>`;
        })
        .join('')
    : `<p class="empty">${state.questions.length ? '조건에 맞는 질문이 없어요.' : '질문을 추가하거나, 경험 카드에서 면접 카드를 생성해 보세요.'}</p>`;
}

// ---------- 연습 모달 ----------
export function openPractice(id, onChange) {
  const q = byId('questions', id);
  if (!q) return;
  q.followUps ||= [];
  let lastFeedback = null;

  const body = openModal({ title: q.text, wide: true, onClose: onChange });

  const exps = () => (q.experienceIds || []).map((i) => byId('experiences', i)).filter(Boolean);

  const collect = () => {
    const a = body.querySelector('#p-answer');
    if (a) q.answer = a.value;
    body.querySelectorAll('[data-fu-answer]').forEach((t) => {
      const fu = q.followUps.find((x) => x.id === t.dataset.fuAnswer);
      if (fu) fu.answer = t.value;
    });
  };
  const persist = () => {
    collect();
    upsert('questions', q);
  };

  const draw = () => {
    const ex = exps();
    const hist = historyOf(q.id);
    body.innerHTML = `
      <div class="q-meta">
        <span class="badge ${q.type}">${typeLabel(q.type)}</span>
        ${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}
        ${q.intent ? `<span class="muted small">의도: ${esc(q.intent)}</span>` : ''}
      </div>

      <details class="box" ${ex.length ? '' : 'open'}>
        <summary>📇 연결된 경험 (${ex.length})</summary>
        ${ex.length ? `<div class="stack">${ex.map(experienceDetailHtml).join('')}</div>` : '<p class="empty">연결된 경험이 없어요.</p>'}
        <button class="btn sm" data-p="links">🔗 연결 편집</button>
      </details>

      <label class="lbl">내 답변</label>
      <textarea id="p-answer" rows="7" placeholder="두괄식으로, 경험 카드의 수치와 근거를 넣어 답변해 보세요.">${esc(q.answer)}</textarea>
      <div class="row">
        <button class="btn" data-p="save">💾 답변 저장</button>
        <button class="btn primary" data-p="gen">🤖 꼬리질문 생성</button>
        <button class="btn primary" data-p="feedback">🤖 피드백 받기</button>
      </div>
      <div id="p-feedback">${lastFeedback ? feedbackHtml(lastFeedback) : ''}</div>

      <h4 class="sec-title">꼬리질문 (${q.followUps.length})</h4>
      <div class="stack">
        ${q.followUps
          .map(
            (fu) => `
          <div class="fu" data-fu="${fu.id}">
            <div class="fu-head">
              <div><b>Q.</b> ${esc(fu.text)}${fu.intent ? `<div class="muted small">의도: ${esc(fu.intent)}</div>` : ''}</div>
              <div class="fu-actions">
                <button class="btn sm ghost" data-p="to-card" title="질문 리스트에 카드로 추가">카드로 추가</button>
                <button class="btn sm ghost danger" data-p="fu-del">삭제</button>
              </div>
            </div>
            <textarea rows="2" data-fu-answer="${fu.id}" placeholder="꼬리질문 답변 (선택)">${esc(fu.answer)}</textarea>
          </div>`
          )
          .join('')}
        <form class="row" id="fu-add"><input name="text" placeholder="꼬리질문 직접 추가" style="flex:1"><button class="btn sm">추가</button></form>
      </div>

      <h4 class="sec-title">피드백 기록 (${hist.length})</h4>
      ${
        hist.length
          ? hist
              .map(
                (h) => `
          <details class="box">
            <summary>${fmtDate(h.date)} · ${h.mode === 'mock' ? '모의면접' : '개별 연습'}${h.feedback?.score != null ? ` · <b>${esc(h.feedback.score)}점</b>` : ''}</summary>
            ${(h.turns || []).map((t, i) => `<div class="turn"><div class="tq">${i ? '↳ ' : 'Q. '}${esc(t.q)}</div><div class="ta">${nl2br(t.a || '(무응답)')}</div></div>`).join('')}
            ${feedbackHtml(h.feedback)}
          </details>`
              )
              .join('')
          : '<p class="empty">아직 기록이 없어요.</p>'
      }`;
  };

  body.onclick = async (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    const fuId = b.closest('[data-fu]')?.dataset.fu;
    switch (b.dataset.p) {
      case 'links':
        persist();
        return openLinkEditor(q.id, () => openPractice(q.id, onChange));
      case 'save':
        persist();
        return toast('답변을 저장했어요.', 'success');
      case 'gen': {
        collect();
        const list = await withLoading(b, () => ai.generateFollowUps({ question: q, answer: q.answer, experiences: exps() }));
        if (!list) return;
        q.followUps.push(...list.map((x) => ({ id: uid(), text: x.text, intent: x.intent, answer: '' })));
        persist();
        draw();
        return toast(`꼬리질문 ${list.length}개를 추가했어요.`, 'success');
      }
      case 'feedback': {
        collect();
        if (!q.answer.trim()) return toast('먼저 답변을 작성하세요.', 'error');
        const turns = [{ q: q.text, a: q.answer }, ...q.followUps.filter((x) => x.answer?.trim()).map((x) => ({ q: x.text, a: x.answer }))];
        const fb = await withLoading(b, () => ai.getFeedback({ question: q, turns, experiences: exps() }), '평가 중…');
        if (!fb) return;
        lastFeedback = fb;
        persist();
        addSession({ mode: 'single', items: [{ questionId: q.id, question: q.text, type: q.type, turns, feedback: fb }] });
        draw();
        return body.querySelector('#p-feedback')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      case 'fu-del':
        collect();
        q.followUps = q.followUps.filter((x) => x.id !== fuId);
        persist();
        return draw();
      case 'to-card': {
        collect();
        const fu = q.followUps.find((x) => x.id === fuId);
        if (state.questions.some((x) => x.text.trim() === fu.text.trim())) return toast('이미 같은 질문 카드가 있어요.', 'error');
        upsert('questions', {
          text: fu.text,
          type: q.type,
          category: q.category,
          intent: fu.intent,
          parentId: q.id,
          experienceIds: [...(q.experienceIds || [])],
          followUps: [],
          answer: fu.answer || '',
          source: 'ai',
        });
        return toast('질문 리스트에 꼬리질문 카드를 추가했어요.', 'success');
      }
    }
  };

  body.onsubmit = (ev) => {
    if (ev.target.id !== 'fu-add') return;
    ev.preventDefault();
    const text = ev.target.text.value.trim();
    if (!text) return;
    collect();
    q.followUps.push({ id: uid(), text, answer: '' });
    persist();
    draw();
  };

  draw();
}

