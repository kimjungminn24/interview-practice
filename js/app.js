import { load, subscribe, saveAll, status, ghConfig } from './store.js';
import { toast, closeModal } from './ui.js';
import * as experiences from './views/experiences.js';
import * as questions from './views/questions.js';
import * as mock from './views/mock.js';
import * as history from './views/history.js';
import * as settings from './views/settings.js';

const routes = { experiences, questions, mock, history, settings };
const app = document.getElementById('app');
let currentRoute = null;

function route() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0] || 'experiences';
  const view = routes[name] || experiences;
  if (currentRoute && currentRoute !== view) currentRoute.leave?.();
  currentRoute = view;
  closeModal();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  // 이벤트 핸들러가 쌓이지 않도록 화면마다 새 컨테이너 사용
  const el = document.createElement('div');
  app.replaceChildren(el);
  view.render(el);
  window.scrollTo(0, 0);
}

function renderSync() {
  const el = document.getElementById('sync');
  const gh = !!ghConfig();
  let label;
  let cls = '';
  if (status.saving) label = '저장 중…';
  else if (status.error) {
    label = '⚠️ 저장 오류';
    cls = 'err';
  } else if (status.dirty) {
    label = gh ? '변경사항 있음' : '로컬에만 저장됨';
    cls = 'dirty';
  } else label = gh ? '✓ GitHub 동기화됨' : '로컬 모드';
  el.innerHTML = `
    <span class="sync-label ${cls}" title="${status.error ? status.error.replace(/"/g, '&quot;') : ''}">${label}</span>
    ${gh ? `<button class="btn sm" id="save-btn" ${status.saving || !status.dirty ? 'disabled' : ''}>저장</button>` : `<a class="btn sm" href="#/settings">GitHub 연결</a>`}`;
  el.querySelector('#save-btn')?.addEventListener('click', async () => {
    const ok = await saveAll();
    toast(ok ? 'GitHub에 저장했어요.' : status.error || '저장 실패', ok ? 'success' : 'error', 5000);
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
  if (restored) toast('저장되지 않았던 변경사항을 복원했어요.', 'info', 4000);
  route();
})();
