// 여러 화면에서 같이 쓰는 카드/모달
import { state, byId, upsert } from '../store.js';
import { esc, nl2br, openModal, closeModal, toast, typeLabel, splitTags, CATEGORIES, withLoading, icon } from '../ui.js';
import * as ai from '../ai.js';

// ---------- 경험 카드 ----------
export function experienceDetailHtml(e) {
  const row = (label, v) => {
    if (!v) return '';
    const m = /^([A-Z]) (.+)$/.exec(label);
    const [k, name] = m ? [m[1], m[2]] : ['', label];
    return `<div class="star"><span class="star-k" aria-hidden="true">${k}</span><div><span class="lbl-sm">${name}</span>${nl2br(v)}</div></div>`;
  };
  return `
    <article class="exp-detail">
      <header>
        <h4>${esc(e.title)}</h4>
        <div class="muted small">${[e.period, e.role].filter(Boolean).map(esc).join(', ')}</div>
        ${tagsHtml(e.tags)}
      </header>
      ${row('S 상황', e.situation)}
      ${row('T 과제', e.task)}
      ${row('A 행동', e.action)}
      ${row('R 결과', e.result)}
      ${row('배운 점', e.learned)}
    </article>`;
}

export const tagsHtml = (tags) => (tags?.length ? `<div class="tags">${tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '');

export function openExperienceForm(exp, onSaved) {
  const e = exp || {};
  const body = openModal({
    title: exp ? '경험 수정' : '경험 추가',
    wide: true,
    body: `
      <form class="form" id="exp-form">
        <label>제목 *<input name="title" required value="${esc(e.title)}" placeholder="예) 주문 API 응답속도 70% 개선"></label>
        <div class="grid2">
          <label>기간<input name="period" value="${esc(e.period)}" placeholder="2025.03 ~ 2025.06"></label>
          <label>역할/소속<input name="role" value="${esc(e.role)}" placeholder="백엔드 개발 (4인 팀 프로젝트)"></label>
        </div>
        <label>키워드 (쉼표로 구분)<input name="tags" value="${esc((e.tags || []).join(', '))}" placeholder="Spring, Redis, 캐싱, 협업"></label>
        <label>상황 (S)<textarea name="situation" rows="3" placeholder="언제, 어떤 상황이었는지">${esc(e.situation)}</textarea></label>
        <label>과제 (T)<textarea name="task" rows="2" placeholder="해결해야 했던 문제나 목표">${esc(e.task)}</textarea></label>
        <label>행동 (A)<textarea name="action" rows="4" placeholder="내가 직접 한 일과 그렇게 한 이유">${esc(e.action)}</textarea></label>
        <label>결과 (R)<textarea name="result" rows="3" placeholder="숫자로 보여 줄 수 있는 결과">${esc(e.result)}</textarea></label>
        <label>배운 점<textarea name="learned" rows="2">${esc(e.learned)}</textarea></label>
        <div class="actions"><button type="button" class="btn ghost" data-cancel>취소</button><button class="btn primary">저장</button></div>
      </form>`,
  });
  body.querySelector('[data-cancel]').onclick = closeModal;
  body.querySelector('#exp-form').onsubmit = (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(ev.target));
    const saved = upsert('experiences', { ...e, ...fd, title: fd.title.trim(), tags: splitTags(fd.tags) });
    closeModal();
    toast('저장했습니다.');
    onSaved?.(saved);
  };
}

// ---------- 질문 ----------
export function categoryOptions(type) {
  const base = type ? CATEGORIES[type] : [...CATEGORIES.job, ...CATEGORIES.personality];
  const used = state.questions.filter((q) => !type || q.type === type).map((q) => q.category).filter(Boolean);
  return [...new Set([...base, ...used])];
}

export function openQuestionForm(question, onSaved) {
  const q = question || { type: 'job' };
  const body = openModal({
    title: question?.id ? '질문 수정' : '질문 추가',
    body: `
      <form class="form" id="q-form">
        <label>질문 *<textarea name="text" rows="3" required>${esc(q.text)}</textarea></label>
        <div class="grid2">
          <label>유형
            <select name="type">
              <option value="job" ${q.type === 'job' ? 'selected' : ''}>직무</option>
              <option value="personality" ${q.type === 'personality' ? 'selected' : ''}>인성</option>
            </select>
          </label>
          <label>카테고리<input name="category" list="cat-list" value="${esc(q.category)}" placeholder="선택 또는 직접 입력"></label>
        </div>
        <datalist id="cat-list"></datalist>
        <div class="actions"><button type="button" class="btn ghost" data-cancel>취소</button><button class="btn primary">저장</button></div>
      </form>`,
  });
  const form = body.querySelector('#q-form');
  const fillCats = () => {
    body.querySelector('#cat-list').innerHTML = categoryOptions(form.type.value).map((c) => `<option value="${esc(c)}">`).join('');
  };
  form.type.onchange = fillCats;
  fillCats();
  body.querySelector('[data-cancel]').onclick = closeModal;
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const saved = upsert('questions', {
      experienceIds: [],
      followUps: [],
      answer: '',
      source: 'manual',
      ...q,
      text: fd.text.trim(),
      type: fd.type,
      category: fd.category.trim(),
    });
    closeModal();
    toast('저장했습니다.');
    onSaved?.(saved);
  };
}

// 질문과 경험의 키워드 겹침으로 추천 점수 계산
function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[\s,./()?!·:;"'\[\]{}~\-]+/)
    .map((t) => t.replace(/(은|는|이|가|을|를|에|에서|의|로|으로|과|와|했던|했나요|인가요|있나요|무엇|어떻게)$/, ''))
    .filter((t) => t.length >= 2);
}

export function relevance(question, exp) {
  const hay = [exp.title, exp.situation, exp.task, exp.action, exp.result, exp.learned].join(' ').toLowerCase();
  const tags = (exp.tags || []).map((t) => t.toLowerCase());
  let score = 0;
  for (const t of new Set(tokens(`${question.text} ${question.category || ''}`))) {
    if (tags.some((tag) => tag.includes(t) || t.includes(tag))) score += 3;
    else if (hay.includes(t)) score += 1;
  }
  return score;
}

/** "보기": 질문에 연결된 경험 보여주기 */
export function openLinkedView(questionId, onChange) {
  const q = byId('questions', questionId);
  if (!q) return;
  const exps = (q.experienceIds || []).map((id) => byId('experiences', id)).filter(Boolean);
  const suggestions = state.experiences
    .filter((e) => !q.experienceIds?.includes(e.id))
    .map((e) => ({ e, s: relevance(q, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);

  const body = openModal({
    title: q.text,
    wide: true,
    body: `
      <div class="q-meta"><span class="badge ${q.type}">${typeLabel(q.type)}</span>${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}</div>
      <h4 class="sec-title">연결된 경험 ${exps.length}</h4>
      ${exps.length ? `<div class="stack">${exps.map(experienceDetailHtml).join('')}</div>` : `<div class="empty"><p>연결된 경험이 없습니다.</p>${state.experiences.length ? '<button class="btn ghost" data-edit-links>경험 연결</button>' : ''}</div>`}
      ${
        suggestions.length
          ? `<h4 class="sec-title">추천</h4><div class="suggest">${suggestions
              .map((x) => `<button class="chip" data-link="${x.e.id}">${icon('plus', { size: 14 })} ${esc(x.e.title)}</button>`)
              .join('')}</div>`
          : ''
      }
      <div class="actions"><button class="btn" data-edit-links>연결 바꾸기</button></div>`,
  });
  body.querySelectorAll('[data-link]').forEach((b) => {
    b.onclick = () => {
      q.experienceIds = [...new Set([...(q.experienceIds || []), b.dataset.link])];
      upsert('questions', q);
      onChange?.();
      openLinkedView(questionId, onChange);
    };
  });
  body.querySelectorAll('[data-edit-links]').forEach((b) => {
    b.onclick = () =>
      openLinkEditor(questionId, () => {
        onChange?.();
        openLinkedView(questionId, onChange);
      });
  });
}

/** 질문 ↔ 경험 연결 편집 */
export function openLinkEditor(questionId, onDone) {
  const q = byId('questions', questionId);
  const linked = new Set(q.experienceIds || []);
  const items = state.experiences.map((e) => ({ e, s: relevance(q, e) })).sort((a, b) => Number(linked.has(b.e.id)) - Number(linked.has(a.e.id)) || b.s - a.s);
  const body = openModal({
    title: '경험 연결',
    body: `
      <p class="muted small">${esc(q.text)}</p>
      ${
        items.length
          ? `<div class="check-list">${items
              .map(
                ({ e, s }) => `
            <label class="check-item">
              <input type="checkbox" value="${e.id}" ${linked.has(e.id) ? 'checked' : ''}>
              <span><b>${esc(e.title)}</b>${s > 0 ? ' <span class="tag">추천</span>' : ''}<br><span class="muted small">${esc((e.tags || []).map((t) => '#' + t).join(' '))}</span></span>
            </label>`
              )
              .join('')}</div>`
          : '<p class="empty">경험이 없습니다. 먼저 경험을 추가해 주세요.</p>'
      }
      <div class="actions"><button class="btn ghost" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
  });
  body.querySelector('[data-cancel]').onclick = closeModal;
  body.querySelector('[data-save]').onclick = () => {
    q.experienceIds = [...body.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    upsert('questions', q);
    closeModal();
    onDone?.();
  };
}

/** 경험 → 면접 질문 뽑기 */
export function openCardGenerator(expId, onDone) {
  const exp = byId('experiences', expId);
  const body = openModal({
    title: `질문 뽑기: ${exp.title}`,
    wide: true,
    body: `
      <div class="form inline">
        <label>유형
          <select id="g-type">
            <option value="job">직무 (기술 꼬리 질문)</option>
            <option value="personality">인성</option>
            <option value="both">직무 + 인성</option>
          </select>
        </label>
        <label>개수<input id="g-count" type="number" min="1" max="15" value="6"></label>
        <button class="btn primary" id="g-run">뽑기</button>
      </div>
      <div id="g-result"></div>`,
  });
  body.querySelector('#g-run').onclick = async (ev) => {
    const type = body.querySelector('#g-type').value;
    const count = Math.min(15, Math.max(1, Number(body.querySelector('#g-count').value) || 5));
    const cards = await withLoading(ev.currentTarget, () => ai.generateCards({ experience: exp, type, count }));
    if (!cards) return;
    const exists = new Set(state.questions.map((q) => q.text.trim()));
    const res = body.querySelector('#g-result');
    res.innerHTML = `
      <div class="check-list">${cards
        .map(
          (c, i) => `
        <label class="check-item">
          <input type="checkbox" data-i="${i}" ${exists.has(c.text.trim()) ? '' : 'checked'}>
          <span><span class="badge ${c.type}">${typeLabel(c.type)}</span> <span class="tag">${esc(c.category)}</span>${exists.has(c.text.trim()) ? ' <span class="tag">이미 있음</span>' : ''}<br>
          <b>${esc(c.text)}</b><br><span class="muted small">질문 의도: ${esc(c.intent)}</span></span>
        </label>`
        )
        .join('')}</div>
      <div class="actions"><button class="btn primary" id="g-add"></button></div>`;
    const addBtn = res.querySelector('#g-add');
    const syncCount = () => {
      const n = res.querySelectorAll('input:checked').length;
      addBtn.textContent = `고른 질문 추가 (${n})`;
      addBtn.disabled = !n;
    };
    res.onchange = syncCount;
    syncCount();
    addBtn.onclick = () => {
      const picked = [...res.querySelectorAll('input:checked')].map((i) => cards[i.dataset.i]);
      picked.forEach((c) =>
        upsert('questions', { text: c.text, type: c.type, category: c.category, intent: c.intent, experienceIds: [expId], followUps: [], answer: '', source: 'ai' })
      );
      closeModal();
      toast(`질문 ${picked.length}개 추가`);
      onDone?.();
    };
  };
}

