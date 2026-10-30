import { state, byId, removeExperience } from '../store.js';
import { esc, openModal, typeLabel } from '../ui.js';
import { experienceDetailHtml, openExperienceForm, openCardGenerator, tagsHtml } from './components.js';

const f = { q: '', tag: '' };
let root;

export function render(el) {
  root = el;
  const tags = [...new Set(state.experiences.flatMap((e) => e.tags || []))].sort();
  el.innerHTML = `
    <div class="page-head">
      <h2>경험 카드 <span class="muted">${state.experiences.length}</span></h2>
      <p class="muted">면접에서 꺼내 쓸 경험을 STAR(상황·과제·행동·결과)로 정리하세요. 경험에서 직무/인성 면접 카드를 바로 만들 수 있어요.</p>
    </div>
    <div class="toolbar">
      <input type="search" id="e-search" placeholder="경험 검색" value="${esc(f.q)}">
      <button class="btn primary" data-action="new">+ 경험 추가</button>
    </div>
    ${
      tags.length
        ? `<div class="chips">${['', ...tags]
            .map((t) => `<button class="chip ${f.tag === t ? 'on' : ''}" data-action="tag" data-v="${esc(t)}">${t ? '#' + esc(t) : '전체'}</button>`)
            .join('')}</div>`
        : ''
    }
    <div class="cards" id="e-list"></div>`;
  renderList();

  el.querySelector('#e-search').oninput = (e) => {
    f.q = e.target.value;
    renderList();
  };
  el.onclick = (ev) => {
    const b = ev.target.closest('[data-action]');
    if (!b) return;
    const id = b.closest('[data-id]')?.dataset.id;
    const rerender = () => render(root);
    switch (b.dataset.action) {
      case 'new':
        return openExperienceForm(null, rerender);
      case 'tag':
        f.tag = b.dataset.v;
        return render(root);
      case 'detail':
        return openDetail(id);
      case 'edit':
        return openExperienceForm(byId('experiences', id), rerender);
      case 'gen':
        return openCardGenerator(id, rerender);
      case 'del':
        if (confirm('이 경험 카드를 삭제할까요? 연결된 질문에서도 연결이 해제됩니다.')) {
          removeExperience(id);
          rerender();
        }
    }
  };
}

function linkedQuestions(expId) {
  return state.questions.filter((q) => q.experienceIds?.includes(expId));
}

function renderList() {
  const kw = f.q.trim().toLowerCase();
  const items = state.experiences.filter(
    (e) =>
      (!f.tag || e.tags?.includes(f.tag)) &&
      (!kw || [e.title, e.situation, e.task, e.action, e.result, e.learned, ...(e.tags || [])].join(' ').toLowerCase().includes(kw))
  );
  root.querySelector('#e-list').innerHTML = items.length
    ? items
        .map((e) => {
          const qs = linkedQuestions(e.id);
          const job = qs.filter((q) => q.type === 'job').length;
          return `
      <div class="card exp-card" data-id="${e.id}">
        <div class="card-body" data-action="detail">
          <h3>${esc(e.title)}</h3>
          <div class="muted small">${[e.period, e.role].filter(Boolean).map(esc).join(' · ')}</div>
          ${tagsHtml(e.tags)}
          ${e.result ? `<p class="clamp"><b>결과</b> ${esc(e.result)}</p>` : ''}
          <div class="muted small">연결된 질문 ${qs.length} (직무 ${job} · 인성 ${qs.length - job})</div>
        </div>
        <div class="card-actions">
          <button class="btn sm primary" data-action="gen">🤖 면접 카드 생성</button>
          <button class="btn sm ghost" data-action="edit">수정</button>
          <button class="btn sm ghost danger" data-action="del">삭제</button>
        </div>
      </div>`;
        })
        .join('')
    : `<p class="empty">${state.experiences.length ? '조건에 맞는 경험이 없어요.' : '첫 경험 카드를 추가해 보세요!'}</p>`;
}

function openDetail(id) {
  const e = byId('experiences', id);
  const qs = linkedQuestions(id);
  openModal({
    title: '경험 카드',
    wide: true,
    body: `
      ${experienceDetailHtml(e)}
      <h4 class="sec-title">이 경험으로 답할 질문 (${qs.length})</h4>
      ${
        qs.length
          ? `<ul class="plain">${qs.map((q) => `<li><span class="badge ${q.type}">${typeLabel(q.type)}</span> ${esc(q.text)}</li>`).join('')}</ul>`
          : '<p class="empty">연결된 질문이 없어요. "면접 카드 생성"으로 질문을 만들어 보세요.</p>'
      }`,
  });
}
