import { getSettings, saveSettings, ghConfig, load, saveAll, exportAll, importAll, clearCache, status } from '../store.js';
import { esc, toast, withLoading } from '../ui.js';
import { testConnection } from '../github.js';

const THINK_OPTIONS = [0, 5, 10, 15, 30];
const TARGET_OPTIONS = [30, 60, 90];
const RATE_OPTIONS = [0.9, 1, 1.1];

const opt = (v, label, cur) => `<option value="${v}" ${Number(cur) === Number(v) || String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;

export function render(el) {
  const s = getSettings();
  el.innerHTML = `
    <div class="page-head">
      <h2>설정</h2>
      <p class="muted">토큰과 API 키는 이 브라우저(localStorage)에만 저장됩니다. 저장소에는 커밋되지 않습니다.</p>
      <p class="notice">iPhone에서는 홈 화면에 추가해 쓰는 것을 권장합니다. Safari 탭에서는 7일 동안 열지 않으면 토큰과 키가 지워질 수 있습니다.</p>
    </div>

    <form class="card pad form" id="s-gh">
      <h3>데이터 저장소 (GitHub)</h3>
      <p class="muted small">경험과 답변은 여기 지정한 저장소의 <code>${esc(s.dataDir)}/*.json</code>에 커밋됩니다.
        앱 저장소(공개)와 별개로 비공개 저장소를 하나 만들어 지정합니다. (예: <code>interview-data</code>, README로 초기화)<br>
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained 토큰</a>은
        그 데이터 저장소만 선택하고 <b>Contents: Read and write</b> 권한을 줍니다.</p>
      <div class="grid2">
        <label>Owner<input name="ghOwner" value="${esc(s.ghOwner)}" placeholder="kimjungminn24" autocapitalize="off" spellcheck="false"></label>
        <label>Repository<input name="ghRepo" value="${esc(s.ghRepo)}" placeholder="interview-data (비공개)" autocapitalize="off" spellcheck="false"></label>
        <label>Branch<input name="ghBranch" value="${esc(s.ghBranch)}" placeholder="main" autocapitalize="off" spellcheck="false"></label>
        <label>데이터 폴더<input name="dataDir" value="${esc(s.dataDir)}" placeholder="data" autocapitalize="off" spellcheck="false"></label>
      </div>
      <label>Personal Access Token<input name="ghToken" type="password" value="${esc(s.ghToken)}" placeholder="github_pat_..." autocomplete="off"></label>
      <label class="chk"><input type="checkbox" name="autoSave" ${s.autoSave ? 'checked' : ''}> 변경하면 자동으로 저장 (끄면 상단 저장 버튼으로 커밋합니다)</label>
      <div class="actions">
        <button type="button" class="btn" data-s="test">연결 테스트</button>
        <button class="btn primary">저장 후 다시 불러오기</button>
      </div>
    </form>

    <form class="card pad form" id="s-ai">
      <h3>OpenAI (꼬리질문 · 첨삭 · 받아쓰기)</h3>
      <p class="muted small">브라우저에서 OpenAI API를 직접 호출합니다. 사용량만큼 본인 계정에 과금됩니다.</p>
      <label>API Key<input name="aiKey" type="password" value="${esc(s.aiKey)}" placeholder="sk-..." autocomplete="off"></label>
      <div class="grid2">
        <label>모델<input name="aiModel" value="${esc(s.aiModel)}" placeholder="gpt-4o-mini" autocapitalize="off" spellcheck="false"></label>
        <label>API Base URL<input name="aiBaseUrl" value="${esc(s.aiBaseUrl)}" autocapitalize="off" spellcheck="false"></label>
      </div>
      <label>목표 직무<input name="targetRole" value="${esc(s.targetRole)}" placeholder="예) 신입 백엔드 개발자 (Java/Spring)"></label>
      <label>채용공고 / JD (선택)<textarea name="jobDescription" rows="4" placeholder="자격요건·우대사항을 붙여 넣으면 질문이 그 공고에 맞춰집니다.">${esc(s.jobDescription)}</textarea></label>
      <div class="actions"><button class="btn">저장</button></div>
    </form>

    <form class="card pad form" id="s-speak">
      <h3>말하기</h3>
      <div class="grid2">
        <label>생각 시간 기본값
          <select name="prepSec">${THINK_OPTIONS.map((v) => opt(v, v ? `${v}초` : '없음', s.prepSec)).join('')}</select>
        </label>
        <label>목표 길이
          <select name="targetSec">${TARGET_OPTIONS.map((v) => opt(v, v === 60 ? '1분' : `${v}초`, s.targetSec)).join('')}</select>
        </label>
        <label>받아쓰기
          <select name="sttMode">
            ${opt('openai', 'OpenAI로 받아쓰기', s.sttMode)}
            ${opt('off', '사용 안 함', s.sttMode)}
          </select>
        </label>
        <label>받아쓰기 모델<input name="sttModel" value="${esc(s.sttModel)}" placeholder="whisper-1" autocapitalize="off" spellcheck="false"></label>
        <label>읽기 속도
          <select name="ttsRate">${RATE_OPTIONS.map((v) => opt(v, `${v.toFixed(1)}배`, s.ttsRate)).join('')}</select>
        </label>
      </div>
      <label class="chk"><input type="checkbox" name="autoTranscribe" ${s.autoTranscribe ? 'checked' : ''}> 녹음 후 자동으로 받아쓰기</label>
      <label class="chk"><input type="checkbox" name="hideScore" ${s.hideScore ? 'checked' : ''}> 점수 숨기기</label>
      <p class="muted small">녹음은 이 기기의 메모리에만 있다가 화면을 떠나면 지워집니다. 저장소에는 커밋되지 않습니다. 받아쓰기를 켜면 녹음이 OpenAI로 전송됩니다.</p>
      <div class="actions"><button class="btn">저장</button></div>
    </form>

    <div class="card pad form">
      <h3>데이터 백업</h3>
      <div class="row">
        <button type="button" class="btn" data-s="export">JSON 내보내기</button>
        <label class="btn">JSON 가져오기<input type="file" accept=".json,application/json" id="s-import" hidden></label>
        <button type="button" class="btn ghost danger" data-s="clear">로컬 캐시 비우기</button>
      </div>
      <p class="muted small">현재 모드: <b>${status.mode === 'github' ? 'GitHub 저장소 연결됨' : '로컬 모드 (이 브라우저에만 저장)'}</b></p>
    </div>`;

  const ghForm = el.querySelector('#s-gh');
  const readGh = () => {
    const fd = Object.fromEntries(new FormData(ghForm));
    return { ...fd, autoSave: ghForm.autoSave.checked };
  };

  ghForm.onsubmit = async (ev) => {
    ev.preventDefault();
    if (status.dirty && ghConfig() && !(await saveAll())) {
      if (!confirm('저장 전인 변경이 있습니다. 그래도 다시 불러올까요?')) return;
    }
    const v = readGh();
    if (v.ghToken.trim() && v.ghOwner.trim() && v.ghRepo.trim()) {
      try {
        const r = await testConnection({ owner: v.ghOwner.trim(), repo: v.ghRepo.trim(), branch: v.ghBranch.trim() || 'main', token: v.ghToken.trim() });
        if (!r.private && !confirm(`${r.fullName}은 공개 저장소입니다. 경험과 답변이 누구에게나 보입니다. 그래도 쓸까요?`)) return;
      } catch (e) {
        toast(`저장소 확인 실패: ${e.message}`, 'error', 6000);
        return;
      }
    }
    saveSettings(v);
    await withLoading(
      ghForm.querySelector('button.primary'),
      async () => {
        await load();
        toast(status.error ? status.error : '저장하고 다시 불러왔습니다.', status.error ? 'error' : 'info');
      },
      '불러오는 중'
    );
  };

  el.querySelector('#s-ai').onsubmit = (ev) => {
    ev.preventDefault();
    saveSettings(Object.fromEntries(new FormData(ev.target)));
    toast('저장했습니다.');
  };

  el.querySelector('#s-speak').onsubmit = (ev) => {
    ev.preventDefault();
    const f = ev.target;
    saveSettings({
      prepSec: Number(f.prepSec.value) || 0,
      targetSec: Number(f.targetSec.value) || 60,
      sttMode: f.sttMode.value === 'off' ? 'off' : 'openai',
      sttModel: f.sttModel.value.trim() || 'whisper-1',
      ttsRate: Number(f.ttsRate.value) || 1,
      autoTranscribe: f.autoTranscribe.checked,
      hideScore: f.hideScore.checked,
    });
    toast('저장했습니다.');
  };

  el.onclick = async (ev) => {
    const b = ev.target.closest('[data-s]');
    if (!b) return;
    switch (b.dataset.s) {
      case 'test': {
        const v = readGh();
        const cfg = { owner: v.ghOwner.trim(), repo: v.ghRepo.trim(), branch: v.ghBranch.trim() || 'main', token: v.ghToken.trim() };
        if (!cfg.owner || !cfg.repo || !cfg.token) return toast('Owner, Repository, Token을 입력하세요.', 'error');
        const r = await withLoading(b, () => testConnection(cfg), '확인 중');
        if (!r) return;
        if (!r.private) return toast(`${r.fullName}은 공개 저장소입니다. 답변이 누구에게나 보이니 비공개 저장소를 지정하세요.`, 'error', 7000);
        if (r.canPush) toast(`연결 확인됨 · ${r.fullName} · 비공개 · ${cfg.branch}`, 'info', 5000);
        else toast(`${r.fullName} 읽기만 가능합니다. 토큰 권한을 확인하세요.`, 'error', 5000);
        return;
      }
      case 'export': {
        const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `interview-practice-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        return setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      case 'clear':
        if (confirm('저장 전인 변경이 사라질 수 있습니다. 비울까요?')) {
          clearCache();
          await load();
          toast('캐시를 비우고 다시 불러왔습니다.');
        }
    }
  };

  el.querySelector('#s-import').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('가져온 데이터로 현재 데이터를 덮어쓸까요?')) return;
      importAll(data);
      toast('가져왔습니다.');
    } catch (e) {
      toast(`가져오기 실패: ${e.message}`, 'error');
    } finally {
      ev.target.value = '';
    }
  };
}
