// 공통 UI 헬퍼
import { icon } from './icons.js';
import { getSettings } from './store.js';

export { icon } from './icons.js';
export { fmtSec } from './speech-metrics.js';
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).slice(0, 13);

export const TYPES = { job: '직무', personality: '인성' };
export const typeLabel = (t) => TYPES[t] || '기타';

export const CATEGORIES = {
  job: ['기술 기본기', 'CS', '프로젝트', '트러블슈팅', '설계/아키텍처', '성능/최적화', '협업/개발문화'],
  personality: ['자기소개/지원동기', '성격/가치관', '협업/갈등', '실패/극복', '성장/목표', '기타'],
};

export const MODE_LABEL = { mock: '모의면접', single: '개별 연습', speak: '말하기' };
export const modeLabel = (m) => MODE_LABEL[m] || '연습';

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function splitTags(s) {
  return String(s || '')
    .split(/[,#\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- toast ----------
// 화면 아래 가운데에 잠깐 뜨는 알림. type: 'info' | 'error' ('success'는 info와 같게 보인다)
export function toast(msg, type = 'info', ms = 3000) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const kind = type === 'error' ? 'error' : 'info';
  // 겹쳐 쌓이지 않게 오래된 것부터 정리 (최대 2개)
  const olds = root.querySelectorAll('.toast:not(.hide)');
  for (let i = 0; i < olds.length - 1; i++) olds[i].classList.add('hide');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  root.appendChild(el);
  if (kind === 'error' && ms < 5000) ms = 5000;
  setTimeout(() => el.classList.add('hide'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// ---------- modal ----------
let onEsc = null;

export function openModal({ title, body = '', wide = false, onClose } = {}) {
  closeModal();
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-btn" data-close aria-label="닫기">${icon('close', { size: 20 })}</button>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    </div>`;
  const backdrop = root.firstElementChild;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('.modal-head [data-close]')) {
      closeModal();
      onClose?.();
    }
  });
  onEsc = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      onClose?.();
    }
  };
  document.addEventListener('keydown', onEsc);
  document.body.classList.add('modal-open');
  return backdrop.querySelector('.modal-body');
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
  if (onEsc) document.removeEventListener('keydown', onEsc);
  onEsc = null;
  document.body.classList.remove('modal-open');
}

export function setModalTitle(title) {
  const h = document.querySelector('#modal-root .modal-head h3');
  if (h) h.textContent = title;
}

/** 버튼을 로딩 상태로 바꾸고 작업이 끝나면 복구 */
export async function withLoading(btn, fn, label = '처리 중') {
  const prev = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${esc(label)}`;
  }
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error', 5000);
    return undefined;
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.innerHTML = prev;
    }
  }
}

const STRUCT = [
  ['conclusion', '결론'],
  ['evidence', '근거'],
  ['result', '결과'],
  ['link', '연결'],
];

/** 목록 칸 읽기: 배열이 아니라 문자열 하나만 저장된 예전, 비정상 데이터도 목록으로 */
const asList = (x) =>
  (Array.isArray(x) ? x : x != null && x !== '' ? [x] : [])
    .map((v) => (v == null || typeof v === 'object' ? '' : String(v).trim()))
    .filter(Boolean);
const asText = (x) => (x == null || typeof x === 'object' ? '' : String(x).trim());

/** 첨삭 결과 렌더링. 예전 피드백 객체(score/summary/strengths/improvements/betterAnswer)도 그대로 그린다.
 *  모양이 어긋난 객체(문자열 목록, 숫자 summary 등)가 저장돼 있어도 화면 전체가 깨지지 않게 방어한다. */
export function feedbackHtml(fb, { hideScore } = {}) {
  if (!fb || typeof fb !== 'object') return '';
  if (hideScore === undefined) hideScore = !!getSettings().hideScore;
  const list = (arr) => (arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const score = asText(fb.score);
  const hasScore = score !== '' && !hideScore;
  const st = fb.structure && typeof fb.structure === 'object' ? fb.structure : null;
  const structHtml = st
    ? `<div class="fb-struct">${STRUCT.map(
        ([k, label]) => `<span class="${st[k] ? 'ok' : 'miss'}">${icon(st[k] ? 'check' : 'dash', { size: 14 })} ${label}</span>`
      ).join('')}${fb.firstSentenceIsConclusion === false ? '<span class="miss">첫 문장에 결론이 없습니다</span>' : ''}</div>`
    : '';
  const d = fb.delivery && typeof fb.delivery === 'object' ? fb.delivery : null;
  const top = asList(d?.top);
  const drill = asText(d?.drill);
  const strengths = asList(fb.strengths);
  const improvements = asList(fb.improvements);
  const oneFix = asText(fb.oneFix);
  const summary = asText(fb.summary);
  const opener = asText(fb.rewriteOpener);
  const better = asText(fb.betterAnswer);
  return `
    <div class="feedback">
      <div class="fb-head"><span>첨삭</span>${hasScore ? `<span class="fb-score">${esc(score)} / 10</span>` : ''}</div>
      ${oneFix ? `<p class="fb-one"><span class="lbl-sm">먼저 고칠 점</span>${esc(oneFix)}</p>` : ''}
      ${structHtml}
      ${summary ? `<p>${nl2br(summary)}</p>` : ''}
      ${
        top.length
          ? `<div class="fb-sec"><h5>말하기 습관</h5>${list(top)}${drill ? `<p class="fb-drill"><span class="lbl-sm">다음 시도</span>${esc(drill)}</p>` : ''}</div>`
          : ''
      }
      ${strengths.length ? `<div class="fb-sec good"><h5>좋았던 점</h5>${list(strengths)}</div>` : ''}
      ${improvements.length ? `<div class="fb-sec bad"><h5>아쉬운 점</h5>${list(improvements)}</div>` : ''}
      ${opener ? `<p><span class="lbl-sm">첫 문장 예시</span>${esc(opener)}</p>` : ''}
      ${better ? `<details class="fb-sec"><summary>다듬은 답변</summary><p>${nl2br(better)}</p></details>` : ''}
    </div>`;
}
