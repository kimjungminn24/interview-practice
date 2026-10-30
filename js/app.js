import { load, subscribe, saveAll, status, ghConfig } from './store.js';
import { toast, closeModal, esc } from './ui.js';
import * as experiences from './views/experiences.js';
import * as questions from './views/questions.js';
import * as speak from './views/speak.js';
import * as mock from './views/mock.js';
import * as history from './views/history.js';
import * as settings from './views/settings.js';

const routes = { experiences, questions, speak, mock, history, settings };
const app = document.getElementById('app');
let currentRoute = null;

function route() {
  const [seg, param] = location.hash.replace(/^#\/?/, '').split('/');
  const name = routes[seg] ? seg : 'experiences';
  const view = routes[name];
  // 같은 화면 사이 이동(#/speak/a → #/speak/b)도 정리해야 하므로 항상 leave를 부른다
  try {
    currentRoute?.leave?.();
  } catch (e) {
    console.error(e);
  }
  currentRoute = view;
  closeModal();
  document.querySelectorAll('#nav a, #tabbar a, .top-link, [data-route-link]').forEach((a) => {
    const r = a.dataset.route ?? a.dataset.routeLink;
    a.classList.toggle('active', r === name);
    if (r === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // 이벤트 핸들러가 쌓이지 않도록 화면마다 새 컨테이너 사용
  const el = document.createElement('div');
  app.replaceChildren(el);
  let p;
  try {
    p = param ? decodeURIComponent(param) : undefined;
  } catch {
    p = param;
  }
  view.render(el, p);
  window.scrollTo(0, 0);
}

const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function renderSync() {
  const el = document.getElementById('sync');
  if (!el) return;
  const gh = !!ghConfig();
  let label;
  let cls = 'ok';
  if (status.saving) {
    label = '저장 중';
    cls = 'saving';
  } else if (status.error && gh) {
    label = '저장 실패';
    cls = 'err';
  } else if (status.dirty) {
    label = gh ? '저장 전' : '저장 전 (로컬)';
    cls = 'dirty';
  } else if (gh) {
    label = status.lastSaved ? `저장됨 ${hhmm(status.lastSaved)}` : '저장됨';
  } else {
    label = '로컬 모드';
    cls = 'local';
  }
  const mark = status.saving ? '<span class="spinner"></span>' : `<span class="sync-dot ${cls}"></span>`;
  el.innerHTML = `
    ${mark}<span class="sync-label ${cls}" title="${status.error ? esc(status.error) : ''}">${label}</span>
    ${
      gh
        ? status.dirty || status.error
          ? `<button class="btn sm" id="save-btn" ${status.saving ? 'disabled' : ''}>저장</button>`
          : ''
        : `<a class="btn sm ghost" href="#/settings">연결</a>`
    }`;
  el.querySelector('#save-btn')?.addEventListener('click', async () => {
    const ok = await saveAll();
    toast(ok ? '저장했습니다.' : status.error || '저장 실패', ok ? 'info' : 'error', 5000);
  });
}

window.addEventListener('beforeunload', (e) => {
  if (status.dirty && ghConfig()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

subscribe(renderSync);
window.addEventListener('hashchange', route);

(async () => {
  renderSync();
  const { restored } = await load();
  if (status.error) toast(`불러오기 실패: ${status.error}`, 'error', 6000);
  // 로컬 모드에서는 캐시가 곧 저장소라 매번 '되살렸다'고 알릴 필요가 없다
  if (restored && ghConfig()) toast('저장 전이던 내용을 되살렸습니다.', 'info', 4000);
  try {
    speak.flushPending();
  } catch (e) {
    console.error(e);
  }
  route();
})();
