// 공통 UI 헬퍼
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
export function toast(msg, type = 'info', ms = 3000) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
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
          <button class="icon-btn" data-close aria-label="닫기">✕</button>
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
export async function withLoading(btn, fn, label = '생성 중…') {
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

export function feedbackHtml(fb) {
  if (!fb) return '';
  const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  return `
    <div class="feedback">
      ${fb.score != null ? `<div class="score">점수 <b>${esc(fb.score)}</b><span>/10</span></div>` : ''}
      ${fb.summary ? `<p>${nl2br(fb.summary)}</p>` : ''}
      ${fb.strengths?.length ? `<div class="fb-sec good"><h5>👍 좋은 점</h5>${list(fb.strengths)}</div>` : ''}
      ${fb.improvements?.length ? `<div class="fb-sec bad"><h5>🛠 보완할 점</h5>${list(fb.improvements)}</div>` : ''}
      ${fb.betterAnswer ? `<details class="fb-sec"><summary>✍️ 개선된 답변 예시</summary><p>${nl2br(fb.betterAnswer)}</p></details>` : ''}
    </div>`;
}
