import { state, byId, upsert, removeQuestion, addSession, historyOf, practiceCounts, getSettings } from '../store.js';
import { esc, nl2br, openModal, closeModal, toast, typeLabel, fmtDate, uid, withLoading, feedbackHtml, icon, fmtSec, modeLabel } from '../ui.js';
import * as ai from '../ai.js';
import { KIND_LABEL, KINDS, BEATS, BEAT_PLACEHOLDER, CONF_LABEL, inferKind, relabelBeats, defaultPrep, isDue } from '../coach.js';
import { estimateSeconds, countSyllables, firstSentence, longSentenceCount } from '../speech-metrics.js';
import { tts } from '../media.js';
import { openQuestionForm, openLinkedView, openLinkEditor, categoryOptions, experienceDetailHtml } from './components.js';

const f = { type: 'all', cat: '', q: '', unlinked: false, due: false, noprep: false };
let root;
let filtersOpen = false; // 휴대폰에서 필터(카테고리, 체크박스) 펼침 여부

const MAX_CUES = 5;
const CUE_MAX_LEN = 10;
const kindOfQ = (q) => (KINDS.includes(q?.prep?.kind) ? q.prep.kind : inferKind(q || {}));

const speakHref = (id) => `#/speak/${encodeURIComponent(id)}`;

// ---------- 더보기 메뉴: 하나만 열리고, 바깥을 누르면 닫힌다 ----------
let menuBound = false;
function bindMenus() {
  if (menuBound) return;
  menuBound = true;
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('menu') || !d.open) return;
      document.querySelectorAll('details.menu[open]').forEach((m) => m !== d && m.removeAttribute('open'));
    },
    true
  );
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((m) => {
      if (!m.contains(e.target)) m.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('details.menu[open]').forEach((m) => m.removeAttribute('open'));
  });
}

export function render(el) {
  root = el;
  bindMenus();
  const count = (t) => state.questions.filter((q) => t === 'all' || q.type === t).length;
  const dueN = state.questions.filter(isDue).length;
  el.innerHTML = `
    <div class="page-head">
      <h2>질문 <span class="muted">${state.questions.length}</span></h2>
    </div>
    <div class="toolbar q-toolbar">
      <div class="seg">${['all', 'job', 'personality']
        .map((t) => `<button data-action="type" data-v="${t}" class="${f.type === t ? 'on' : ''}">${t === 'all' ? '전체' : typeLabel(t)} <span class="cnt">${count(t)}</span></button>`)
        .join('')}</div>
      <input type="search" id="q-search" placeholder="질문 검색" aria-label="질문 검색" value="${esc(f.q)}">
      <button type="button" class="btn filter-toggle" data-action="filters" aria-expanded="${filtersOpen}" aria-controls="q-filters">필터${
        activeFilters() ? ` <span class="cnt">${activeFilters()}</span>` : ''
      }</button>
      <div class="q-filters ${filtersOpen ? 'open' : ''}" id="q-filters">
        <select id="q-cat" aria-label="카테고리"><option value="">모든 카테고리</option>${categoryOptions(f.type === 'all' ? null : f.type)
          .map((c) => `<option ${f.cat === c ? 'selected' : ''}>${esc(c)}</option>`)
          .join('')}</select>
        <label class="chk"><input type="checkbox" id="q-unlinked" ${f.unlinked ? 'checked' : ''}> 경험 미연결만</label>
        <label class="chk"><input type="checkbox" id="q-due" ${f.due ? 'checked' : ''}> 복습할 질문 <span class="cnt">${dueN}</span></label>
        <label class="chk"><input type="checkbox" id="q-noprep" ${f.noprep ? 'checked' : ''}> 뼈대 없음</label>
      </div>
      <button class="btn primary" data-action="new">질문 추가</button>
    </div>
    <div class="q-list" id="q-list"></div>`;
  renderList();

  el.querySelector('#q-search').oninput = (e) => {
    f.q = e.target.value;
    renderList();
  };
  const updateFilterCount = () => {
    const b = el.querySelector('.filter-toggle');
    const n = activeFilters();
    if (b) b.innerHTML = `필터${n ? ` <span class="cnt">${n}</span>` : ''}`;
  };
  el.querySelector('#q-cat').onchange = (e) => {
    f.cat = e.target.value;
    updateFilterCount();
    renderList();
  };
  for (const [sel, key] of [
    ['#q-unlinked', 'unlinked'],
    ['#q-due', 'due'],
    ['#q-noprep', 'noprep'],
  ]) {
    el.querySelector(sel).onchange = (e) => {
      f[key] = e.target.checked;
      updateFilterCount();
      renderList();
    };
  }
  el.onclick = (ev) => {
    const b = ev.target.closest('[data-action]');
    if (!b) return;
    const id = b.closest('[data-id]')?.dataset.id;
    b.closest('details.menu')?.removeAttribute('open');
    const rerender = () => render(root);
    switch (b.dataset.action) {
      case 'type':
        f.type = b.dataset.v;
        f.cat = '';
        return rerender();
      case 'filters': {
        filtersOpen = !filtersOpen;
        el.querySelector('#q-filters')?.classList.toggle('open', filtersOpen);
        b.setAttribute('aria-expanded', String(filtersOpen));
        return;
      }
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

function activeFilters() {
  return (f.cat ? 1 : 0) + (f.unlinked ? 1 : 0) + (f.due ? 1 : 0) + (f.noprep ? 1 : 0);
}

function filtered() {
  const kw = f.q.trim().toLowerCase();
  return state.questions.filter(
    (q) =>
      (f.type === 'all' || q.type === f.type) &&
      (!f.cat || q.category === f.cat) &&
      (!f.unlinked || !q.experienceIds?.length) &&
      (!f.due || isDue(q)) &&
      (!f.noprep || !q.prep) &&
      (!kw || `${q.text} ${q.category || ''} ${q.answer || ''}`.toLowerCase().includes(kw))
  );
}

// 꼬리질문(parentId)은 부모 바로 아래에 들여쓰기로 보여준다
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

function metaLine(q, practiced) {
  const n = q.experienceIds?.length || 0;
  const fu = q.followUps?.length || 0;
  const segs = [];
  if (n) segs.push(`경험 ${n}`);
  if (fu) segs.push(`꼬리 ${fu}`);
  if (practiced) segs.push(`연습 ${practiced}`);
  if (q.prep) segs.push('뼈대');
  if (q.drill) segs.push(`${Math.min(3, Math.max(0, q.drill.level || 0)) + 1}/4단계`);
  const last = q.drill?.last;
  const dot = CONF_LABEL[last] ? `<span class="dot ${last}" title="최근: ${CONF_LABEL[last]}" role="img" aria-label="최근: ${CONF_LABEL[last]}"></span>` : '';
  const warn = n ? '' : '<span class="warn-text">경험 없음</span>';
  const parts = [segs.length ? `<span>${segs.join(', ')}</span>` : '', dot, warn].filter(Boolean);
  return parts.length ? `<div class="q-sub muted small">${parts.join(' ')}</div>` : '';
}

function renderList() {
  const counts = practiceCounts();
  const rows = ordered(filtered());
  root.querySelector('#q-list').innerHTML = rows.length
    ? rows
        .map(
          ([q, depth]) => `
      <div class="q-row ${depth ? 'child' : ''} ${q.type}" style="--depth:${Math.min(depth, 4)}" data-id="${esc(q.id)}">
        <div class="q-main" data-action="practice">
          <div class="q-meta">
            <span class="badge ${q.type}">${typeLabel(q.type)}</span>
            ${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}
            ${q.parentId ? '<span class="tag">꼬리질문</span>' : ''}
          </div>
          <div class="q-text">${depth ? icon('follow', { size: 16 }) + ' ' : ''}${esc(q.text)}</div>
          ${metaLine(q, counts[q.id] || 0)}
        </div>
        <div class="q-actions">
          <button class="btn sm primary" data-action="practice">연습</button>
          <a class="btn sm speak-link" href="${speakHref(q.id)}">${icon('mic', { size: 16 })} 말하기</a>
          <details class="menu"><summary aria-label="더보기">${icon('more')}</summary><div class="menu-pop"><button type="button" data-action="view">보기</button><button type="button" data-action="edit">수정</button><button type="button" data-action="del" class="danger">삭제</button></div></details>
        </div>
      </div>`
        )
        .join('')
    : state.questions.length
      ? '<p class="empty">조건에 맞는 질문이 없습니다.</p>'
      : '<div class="empty"><p>질문이 없습니다.</p><button class="btn ghost" data-action="new">질문 추가</button></div>';
}

// ---------- 연습 모달 ----------
const NO_KEY_TITLE = '설정에서 API 키를 입력하면 쓸 수 있습니다';

export function openPractice(id, onChange) {
  let q = byId('questions', id);
  if (!q) return;
  q.followUps ||= [];
  let lastFeedback = null;
  let scriptsOpen = false;
  let reading = false;
  let estTimer = null;

  const body = openModal({
    title: '연습',
    wide: true,
    onClose: () => {
      stopReading();
      persistIfChanged();
      onChange?.();
    },
  });

  const exps = () => (q.experienceIds || []).map((i) => byId('experiences', i)).filter(Boolean);
  const targetSec = () => Number(getSettings().targetSec) || 60;

  // ----- 화면 → q -----
  const collectPrep = () => {
    const p = q.prep;
    if (!p || !body.querySelector('#prep-conclusion')) return;
    const val = (sel) => body.querySelector(sel)?.value ?? '';
    p.conclusion = val('#prep-conclusion').replace(/\s*\n\s*/g, ' ');
    p.opener = val('#prep-opener');
    if (body.querySelector('#prep-spoken')) p.spoken = val('#prep-spoken');
    if (body.querySelector('#prep-short30')) p.short30 = val('#prep-short30');
    p.beats = [...body.querySelectorAll('#prep .beat')].map((el) => ({
      label: el.querySelector('[data-beat-label]').value.trim(),
      text: el.querySelector('[data-beat-text]').value,
    }));
    const det = body.querySelector('#prep-scripts');
    if (det) scriptsOpen = det.open;
  };
  const collect = () => {
    const a = body.querySelector('#p-answer');
    if (a) q.answer = a.value;
    body.querySelectorAll('[data-fu-answer]').forEach((t) => {
      const fu = q.followUps.find((x) => x.id === t.dataset.fuAnswer);
      if (fu) fu.answer = t.value;
    });
    collectPrep();
  };
  const snapshot = () => JSON.stringify([q.answer || '', q.prep || null, q.followUps.map((x) => x.answer || '')]);
  let saved = snapshot();
  // fresh: q가 화면보다 새로울 때(생성 결과를 막 넣었을 때) 화면 값을 다시 읽지 않는다
  const persist = ({ fresh = false } = {}) => {
    if (!fresh) collect();
    if (q.prep && snapshot() !== saved) q.prep.updatedAt = new Date().toISOString();
    q = upsert('questions', q);
    saved = snapshot();
  };
  // 모달이 닫힌 뒤에도 body는 떼어진 채로 남아 있어 값을 읽을 수 있다
  const persistIfChanged = () => {
    collect();
    if (snapshot() !== saved) persist();
  };
  const markManual = () => {
    if (q.prep) q.prep.source = 'manual';
  };

  // ----- 답변 분량 -----
  const answerEstimate = (text) => {
    if (!String(text || '').trim()) return '';
    const est = estimateSeconds(text);
    const target = targetSec();
    const diff = est - target;
    const parts = [`약 ${fmtSec(est)} 분량`, `목표 ${fmtSec(target)} 대비 ${diff < 0 ? '-' : '+'}${fmtSec(Math.abs(diff))}`];
    const long = longSentenceCount(text);
    if (long) parts.push(`긴 문장 ${long}`);
    const fsSyl = countSyllables(firstSentence(text));
    if (fsSyl > 60) parts.push(`첫 문장 ${fsSyl}음절(깁니다)`);
    return parts.join(', ');
  };
  const scriptEstimate = (text) => (String(text || '').trim() ? `약 ${fmtSec(estimateSeconds(text))}` : '');
  const conclCounter = (text) => {
    const n = String(text || '').length;
    return { cls: n >= 40 ? 'warn-text' : 'muted', label: `${n}자${n >= 40 ? ', 조금 깁니다' : ''}` };
  };

  // ----- 뼈대 편집 -----
  const prepHtml = () => {
    const p = q.prep;
    const ready = ai.aiReady();
    const genAttrs = ready ? '' : `disabled title="${NO_KEY_TITLE}"`;
    if (!p) {
      return `
        <h4 class="sec-title">답변 뼈대</h4>
        <p class="muted">결론 한 문장과 말할 순서 3~4개만 정해 두면 외우지 않아도 말이 이어집니다.</p>
        <div class="row">
          <button class="btn" data-p="prep-gen" ${genAttrs}>뼈대 만들기</button>
          <button class="btn" data-p="prep-template">빈 틀</button>
        </div>
        ${ready ? '' : '<p class="muted small">API 키가 없으면 빈 틀을 직접 채워 주세요.</p>'}`;
    }
    const kind = kindOfQ(q);
    const cc = conclCounter(p.conclusion);
    const beats = p.beats || [];
    const cues = p.cues || [];
    return `
      <h4 class="sec-title">답변 뼈대</h4>
      <div class="form">
        <label>유형
          <select id="prep-kind">${KINDS.map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
        </label>
        <label>결론 한 문장
          <textarea id="prep-conclusion" class="prep-conclusion" rows="2" enterkeyhint="done" placeholder="무엇을 했고 어떻게 됐는지 한 문장">${esc(p.conclusion)}</textarea>
        </label>
        <p class="small ${cc.cls}" id="prep-conclusion-cnt">${cc.label}</p>
      </div>
      <div class="beats">
        ${beats
          .map(
            (b, i) => `
          <div class="beat" data-i="${i}">
            <div class="row">
              <input class="beat-label" data-beat-label value="${esc(b.label)}" aria-label="항목 이름" placeholder="항목">
              <span class="beat-tools">
                <button type="button" class="icon-btn beat-up" data-p="beat-up" aria-label="위로" title="위로" ${i ? '' : 'disabled'}>${icon('chevron')}</button>
                <button type="button" class="icon-btn" data-p="beat-down" aria-label="아래로" title="아래로" ${i < beats.length - 1 ? '' : 'disabled'}>${icon('chevron')}</button>
                <button type="button" class="icon-btn beat-del" data-p="beat-del" aria-label="삭제" title="삭제">${icon('close')}</button>
              </span>
            </div>
            <textarea data-beat-text rows="2" aria-label="${esc(b.label || '항목')} 내용" placeholder="${esc(BEAT_PLACEHOLDER[b.label] || '')}">${esc(b.text)}</textarea>
          </div>`
          )
          .join('')}
        <button type="button" class="btn ghost sm" data-p="beat-add">${icon('plus', { size: 16 })} 항목 추가</button>
      </div>
      <div class="form">
        <label for="prep-cue-input">키워드</label>
        <div class="cue-chips">
          ${cues
            .map((c, i) => {
              const long = [...String(c)].length > CUE_MAX_LEN;
              return `<span class="chip${long ? ' is-long warn-text' : ''}"${long ? ' title="10자를 넘습니다"' : ''}>${esc(c)}<button type="button" class="icon-btn" data-p="cue-del" data-i="${i}" aria-label="${esc(c)} 빼기">${icon('close', { size: 14 })}</button></span>`;
            })
            .join('')}
          <input id="prep-cue-input" placeholder="${cues.length >= MAX_CUES ? '5개까지입니다' : cues.length ? '추가' : '예) N+1, 70%'}" enterkeyhint="done">
        </div>
        ${
          cues.some((c) => [...String(c)].length > CUE_MAX_LEN)
            ? '<p class="small warn-text" id="prep-cue-note">10자가 넘는 키워드가 있습니다. 짧을수록 말하면서 보기 편합니다.</p>'
            : '<p class="muted small" id="prep-cue-note">3~5개, 각 10자 이내. Enter나 쉼표로 추가합니다.</p>'
        }
        <label>첫 문장
          <input id="prep-opener" value="${esc(p.opener)}" placeholder="결론부터 말씀드리면, ~">
        </label>
      </div>
      ${
        p.gaps?.length
          ? `<div class="muted small"><span class="lbl-sm">확인할 것</span><ul>${p.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>`
          : ''
      }
      <details class="box" id="prep-scripts" ${scriptsOpen || p.spoken || p.short30 ? 'open' : ''}>
        <summary>말하기용 원고</summary>
        <label class="lbl" for="prep-spoken">1분</label>
        <textarea id="prep-spoken" rows="7" placeholder="한 줄에 한 문장씩 적어 주세요.">${esc(p.spoken)}</textarea>
        <p class="estimate" data-est="prep-spoken">${scriptEstimate(p.spoken)}</p>
        <label class="lbl" for="prep-short30">30초</label>
        <textarea id="prep-short30" rows="4" placeholder="한 줄에 한 문장씩 적어 주세요.">${esc(p.short30)}</textarea>
        <p class="estimate" data-est="prep-short30">${scriptEstimate(p.short30)}</p>
      </details>
      <div class="row">
        <button class="btn" data-p="prep-save">저장</button>
        <button class="btn" data-p="prep-regen" ${genAttrs}>다시 만들기</button>
        <a class="btn" href="${speakHref(q.id)}" data-p="go-speak">말하기 연습</a>
      </div>`;
  };
  // 결론 칸 높이: field-sizing을 지원하지 않는 브라우저(iOS Safari 등)는 내용에 맞춰 직접 늘린다
  const fitConclusion = () => {
    const ta = body.querySelector('#prep-conclusion');
    if (!ta || CSS.supports?.('field-sizing', 'content')) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  const drawPrep = () => {
    const sec = body.querySelector('#prep');
    if (sec) sec.innerHTML = prepHtml();
    fitConclusion();
  };
  const editPrep = (fn) => {
    collect();
    if (!q.prep) return;
    fn(q.prep);
    markManual();
    drawPrep();
  };
  const addCues = (raw) => {
    const parts = String(raw || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length || !q.prep) return;
    collect();
    const cur = (q.prep.cues ||= []);
    const have = new Set(cur.map((c) => c.toLowerCase().replace(/\s+/g, '')));
    let over = 0;
    for (const c of parts) {
      const k = c.toLowerCase().replace(/\s+/g, '');
      if (have.has(k)) continue;
      if (cur.length >= MAX_CUES) {
        over++;
        continue;
      }
      cur.push(c);
      have.add(k);
    }
    if (over) toast('키워드는 5개까지입니다.');
    markManual();
    drawPrep();
    const inp = body.querySelector('#prep-cue-input');
    inp?.focus();
  };

  const generatePrep = async (b) => {
    collect();
    const r = await withLoading(
      b,
      () =>
        ai.buildPrep({
          question: q,
          kind: q.prep?.kind || inferKind(q),
          experiences: exps(),
          answer: q.answer,
          targetSec: targetSec(),
        }),
      '만드는 중'
    );
    if (!r) return;
    collect();
    if (!r.beats?.length) r.beats = q.prep?.beats?.length ? q.prep.beats : (BEATS[r.kind] || BEATS.experience).map((label) => ({ label, text: '' }));
    q.prep = { ...(q.prep || {}), ...r };
    scriptsOpen = !!(r.spoken || r.short30);
    persist({ fresh: true });
    drawPrep();
  };

  // ----- 읽어 듣기 -----
  const stopReading = () => {
    if (!reading) return;
    reading = false;
    tts.cancel();
    const b = body.querySelector('[data-p="read"]');
    if (b) b.innerHTML = `${icon('listen', { size: 16 })} 읽어 듣기`;
  };

  // ----- 전체 그리기 -----
  const draw = () => {
    const ex = exps();
    const hist = historyOf(q.id);
    const hideScore = !!getSettings().hideScore;
    body.innerHTML = `
      <p class="stage-q">${esc(q.text)}</p>
      <div class="q-meta">
        <span class="badge ${q.type}">${typeLabel(q.type)}</span>
        <span class="tag" id="p-kind" title="답변 유형">${KIND_LABEL[kindOfQ(q)]}</span>
        ${q.category ? `<span class="tag">${esc(q.category)}</span>` : ''}
        ${q.intent ? `<span class="muted small">질문 의도: ${esc(q.intent)}</span>` : ''}
      </div>

      <details class="box" ${ex.length ? '' : 'open'}>
        <summary>참고할 경험 ${ex.length}</summary>
        ${ex.length ? `<div class="stack">${ex.map(experienceDetailHtml).join('')}</div>` : '<p class="empty">연결된 경험이 없습니다.</p>'}
        <button class="btn sm" data-p="links">연결 바꾸기</button>
      </details>

      <section class="prep-editor" id="prep">${prepHtml()}</section>

      <label class="lbl" for="p-answer">내 답변</label>
      <textarea id="p-answer" rows="7" placeholder="결론부터 쓰고, 근거와 결과 수치를 이어서 적어 주세요.">${esc(q.answer)}</textarea>
      <p class="estimate" id="p-estimate">${answerEstimate(q.answer)}</p>
      <div class="row">
        <button class="btn" data-p="save">저장</button>
        <button class="btn" data-p="gen">꼬리질문 받기</button>
        <button class="btn primary" data-p="feedback">첨삭 받기</button>
        ${tts.available ? `<button class="btn ghost" data-p="read">${icon('listen', { size: 16 })} 읽어 듣기</button>` : ''}
      </div>
      <div id="p-feedback">${lastFeedback ? feedbackHtml(lastFeedback) : ''}</div>

      <h4 class="sec-title">꼬리질문 ${q.followUps.length}</h4>
      <div class="stack">
        ${q.followUps
          .map(
            (fu) => `
          <div class="fu" data-fu="${esc(fu.id)}">
            <div class="fu-head">
              <div><b>Q.</b> ${esc(fu.text)}${fu.intent ? `<div class="muted small">질문 의도: ${esc(fu.intent)}</div>` : ''}</div>
              <div class="fu-actions">
                <button class="btn sm ghost" data-p="to-card" title="질문 리스트에 추가">질문으로 추가</button>
                <button class="btn sm ghost danger" data-p="fu-del">삭제</button>
              </div>
            </div>
            <textarea rows="2" data-fu-answer="${esc(fu.id)}" placeholder="답변 (선택)" aria-label="꼬리질문 답변">${esc(fu.answer)}</textarea>
          </div>`
          )
          .join('')}
        <form class="row" id="fu-add"><input name="text" placeholder="꼬리질문 직접 적기" aria-label="꼬리질문 직접 적기" style="flex:1"><button class="btn sm">추가</button></form>
      </div>

      <h4 class="sec-title">지난 기록 ${hist.length}</h4>
      ${
        hist.length
          ? hist
              .map(
                (h) => `
          <details class="box">
            <summary>${fmtDate(h.date)} ${esc(modeLabel(h.mode))}${h.feedback?.score != null && !hideScore ? `, ${esc(h.feedback.score)}점` : ''}</summary>
            ${(h.turns || [])
              .map((t, i) => `<div class="turn"><div class="tq">${i ? icon('follow', { size: 14 }) + ' ' : 'Q. '}${esc(t.q)}</div><div class="ta">${nl2br(t.a || '(무응답)')}</div></div>`)
              .join('')}
            ${feedbackHtml(h.feedback)}
          </details>`
              )
              .join('')
          : '<p class="empty">기록이 없습니다.</p>'
      }`;
    fitConclusion();
  };

  // ----- 이벤트 -----
  body.onclick = async (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b || b.disabled) return;
    const fuId = b.closest('[data-fu]')?.dataset.fu;
    const beatI = Number(b.closest('.beat')?.dataset.i);
    switch (b.dataset.p) {
      case 'links':
        persist();
        return openLinkEditor(q.id, () => openPractice(q.id, onChange));
      case 'save':
        persist();
        return toast('저장했습니다.');
      case 'prep-template':
        collect();
        q.prep = defaultPrep(q, exps());
        persist({ fresh: true });
        drawPrep();
        return body.querySelector('#prep-conclusion')?.scrollIntoView({ block: 'nearest' });
      case 'prep-gen':
        return generatePrep(b);
      case 'prep-regen':
        collect();
        if (q.prep?.source === 'manual' && !confirm('직접 고친 뼈대를 새로 만든 내용으로 덮어씁니다. 계속할까요?')) return;
        return generatePrep(b);
      case 'prep-save':
        persist();
        return toast('저장했습니다.');
      case 'go-speak': {
        // 링크 이동은 그대로 두고, 이동 전에 저장만 한다
        stopReading();
        persistIfChanged();
        // 말하기 화면에서 연 경우: 이미 그 주소라 hashchange가 없다. 직접 닫고 화면을 다시 그리게 한다.
        const same = (h) => {
          try {
            return decodeURIComponent(h);
          } catch {
            return h;
          }
        };
        if (same(location.hash) === same(b.getAttribute('href') || '')) {
          ev.preventDefault();
          closeModal();
          onChange?.();
        }
        return;
      }
      case 'beat-up':
        return editPrep((p) => {
          if (beatI > 0) [p.beats[beatI - 1], p.beats[beatI]] = [p.beats[beatI], p.beats[beatI - 1]];
        });
      case 'beat-down':
        return editPrep((p) => {
          if (beatI < p.beats.length - 1) [p.beats[beatI + 1], p.beats[beatI]] = [p.beats[beatI], p.beats[beatI + 1]];
        });
      case 'beat-del':
        if (q.prep?.beats?.[beatI]?.text?.trim() && !confirm('이 항목을 삭제할까요?')) return;
        return editPrep((p) => p.beats.splice(beatI, 1));
      case 'beat-add':
        editPrep((p) => (p.beats ||= []).push({ label: '', text: '' }));
        return body.querySelectorAll('#prep [data-beat-label]')[q.prep.beats.length - 1]?.focus();
      case 'cue-del': {
        const i = Number(b.dataset.i);
        return editPrep((p) => p.cues.splice(i, 1));
      }
      case 'read': {
        if (reading) return stopReading();
        collect();
        if (!q.answer?.trim()) return toast('읽을 답변이 없습니다.');
        reading = true;
        b.innerHTML = `${icon('stop', { size: 16 })} 멈추기`;
        await tts.speak(q.answer, { rate: Number(getSettings().ttsRate) || 1 });
        if (reading) stopReading();
        return;
      }
      case 'gen': {
        collect();
        const list = await withLoading(b, () => ai.generateFollowUps({ question: q, answer: q.answer, experiences: exps() }));
        if (!list || !body.isConnected) return;
        q.followUps.push(...list.map((x) => ({ id: uid(), text: x.text, intent: x.intent, answer: '' })));
        persist();
        draw();
        return toast(`꼬리질문 ${list.length}개 추가`);
      }
      case 'feedback': {
        collect();
        if (!q.answer?.trim()) return toast('답변을 먼저 적어야 첨삭할 수 있습니다.', 'error');
        const turns = [{ q: q.text, a: q.answer }, ...q.followUps.filter((x) => x.answer?.trim()).map((x) => ({ q: x.text, a: x.answer }))];
        const fb = await withLoading(b, () => ai.getFeedback({ question: q, turns, experiences: exps() }), '첨삭 중');
        if (!fb || !body.isConnected) return;
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
        if (!fu) return;
        if (state.questions.some((x) => x.text.trim() === fu.text.trim())) return toast('이미 같은 질문이 있습니다.', 'error');
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
        return toast('질문 리스트에 추가했습니다.');
      }
    }
  };

  body.oninput = (ev) => {
    const t = ev.target;
    if (t.id === 'p-answer') {
      clearTimeout(estTimer);
      estTimer = setTimeout(() => {
        const est = body.querySelector('#p-estimate');
        if (est) est.textContent = answerEstimate(t.value);
      }, 150);
      return;
    }
    if (!t.closest('#prep') || !q.prep) return;
    if (t.id === 'prep-cue-input') {
      // 쉼표를 치면 그 앞까지를 키워드로 추가
      if (/[,，]/.test(t.value)) {
        const parts = t.value.split(/[,，]/);
        const rest = parts.pop();
        addCues(parts.join(','));
        const inp = body.querySelector('#prep-cue-input');
        if (inp) inp.value = rest.trimStart();
      }
      return;
    }
    markManual();
    if (t.id === 'prep-conclusion') {
      fitConclusion();
      const cc = conclCounter(t.value);
      const el = body.querySelector('#prep-conclusion-cnt');
      if (el) {
        el.className = `small ${cc.cls}`;
        el.textContent = cc.label;
      }
    } else if (t.id === 'prep-spoken' || t.id === 'prep-short30') {
      const el = body.querySelector(`[data-est="${t.id}"]`);
      if (el) el.textContent = scriptEstimate(t.value);
    } else if (t.hasAttribute('data-beat-label')) {
      const ta = t.closest('.beat')?.querySelector('[data-beat-text]');
      if (ta) ta.placeholder = BEAT_PLACEHOLDER[t.value.trim()] || '';
    }
  };

  body.onchange = (ev) => {
    if (ev.target.id !== 'prep-kind' || !q.prep) return;
    const kind = ev.target.value;
    editPrep((p) => {
      p.kind = kind;
      p.beats = relabelBeats(p.beats, kind);
    });
    const tag = body.querySelector('#p-kind');
    if (tag) tag.textContent = KIND_LABEL[kindOfQ(q)];
  };

  body.onkeydown = (ev) => {
    // 결론은 한 문장: Enter로 줄을 바꾸지 않는다
    if (ev.target.id === 'prep-conclusion' && ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      return;
    }
    if (ev.target.id !== 'prep-cue-input' || ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    const v = ev.target.value;
    if (v.trim()) addCues(v);
  };

  // 입력칸을 벗어나면 조용히 저장 (토스트 없음)
  body.addEventListener('focusout', (ev) => {
    const t = ev.target;
    if (t.matches?.('#p-answer, [data-fu-answer], #prep input, #prep textarea')) persistIfChanged();
  });

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
