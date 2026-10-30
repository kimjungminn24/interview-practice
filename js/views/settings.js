import { getSettings, saveSettings, ghConfig, load, saveAll, exportAll, importAll, clearCache, status } from '../store.js';
import { esc, toast, withLoading } from '../ui.js';
import { testConnection } from '../github.js';

export function render(el) {
  const s = getSettings();
  el.innerHTML = `
    <div class="page-head">
      <h2>설정</h2>
      <p class="muted">토큰과 API 키는 <b>이 브라우저의 localStorage에만</b> 저장되고, 저장소에는 절대 커밋되지 않아요.</p>
    </div>

    <form class="card pad form" id="s-gh">
      <h3>GitHub 저장소 (데이터 기록)</h3>
      <p class="muted small">서버 없이 GitHub API로 <code>${esc(s.dataDir)}/*.json</code> 파일에 직접 커밋합니다.
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained 토큰</a>을 만들고
        이 저장소만 선택한 뒤 <b>Contents: Read and write</b> 권한을 주세요.</p>
      <div class="grid2">
        <label>Owner<input name="ghOwner" value="${esc(s.ghOwner)}" placeholder="kimjungminn24"></label>
        <label>Repository<input name="ghRepo" value="${esc(s.ghRepo)}" placeholder="interview-practice"></label>
        <label>Branch<input name="ghBranch" value="${esc(s.ghBranch)}" placeholder="main"></label>
        <label>데이터 폴더<input name="dataDir" value="${esc(s.dataDir)}" placeholder="data"></label>
      </div>
      <label>Personal Access Token<input name="ghToken" type="password" value="${esc(s.ghToken)}" placeholder="github_pat_..." autocomplete="off"></label>
      <label class="chk"><input type="checkbox" name="autoSave" ${s.autoSave ? 'checked' : ''}> 변경 시 자동 저장 (끄면 상단 "저장" 버튼으로 커밋)</label>
      <div class="actions">
        <button type="button" class="btn" data-s="test">연결 테스트</button>
        <button class="btn primary">저장 후 다시 불러오기</button>
      </div>
    </form>

    <form class="card pad form" id="s-ai">
      <h3>OpenAI (꼬리질문 · 피드백)</h3>
      <p class="muted small">브라우저에서 OpenAI API를 직접 호출해요. 사용량만큼 본인 계정에 과금됩니다.</p>
      <label>API Key<input name="aiKey" type="password" value="${esc(s.aiKey)}" placeholder="sk-..." autocomplete="off"></label>
      <div class="grid2">
        <label>모델<input name="aiModel" value="${esc(s.aiModel)}" placeholder="gpt-4o-mini"></label>
        <label>API Base URL<input name="aiBaseUrl" value="${esc(s.aiBaseUrl)}"></label>
      </div>
      <label>목표 직무<input name="targetRole" value="${esc(s.targetRole)}" placeholder="예) 신입 백엔드 개발자 (Java/Spring)"></label>
      <label>채용공고 / JD (선택)<textarea name="jobDescription" rows="4" placeholder="지원하는 회사의 자격요건·우대사항을 붙여넣으면 질문이 더 맞춤형이 돼요.">${esc(s.jobDescription)}</textarea></label>
      <div class="actions"><button class="btn primary">저장</button></div>
    </form>

    <div class="card pad form">
      <h3>데이터 백업</h3>
      <div class="row">
        <button class="btn" data-s="export">JSON 내보내기</button>
        <label class="btn">JSON 가져오기<input type="file" accept=".json,application/json" id="s-import" hidden></label>
        <button class="btn ghost danger" data-s="clear">로컬 캐시 비우기</button>
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
      if (!confirm('저장되지 않은 변경사항이 있어요. 그래도 다시 불러올까요?')) return;
    }
    saveSettings(readGh());
    await withLoading(ghForm.querySelector('button.primary'), async () => {
      await load();
      toast(status.error ? status.error : '설정을 저장하고 데이터를 불러왔어요.', status.error ? 'error' : 'success');
    }, '불러오는 중…');
  };

  el.querySelector('#s-ai').onsubmit = (ev) => {
    ev.preventDefault();
    saveSettings(Object.fromEntries(new FormData(ev.target)));
    toast('AI 설정을 저장했어요.', 'success');
  };

  el.onclick = async (ev) => {
    const b = ev.target.closest('[data-s]');
    if (!b) return;
    switch (b.dataset.s) {
      case 'test': {
        const v = readGh();
        const cfg = { owner: v.ghOwner.trim(), repo: v.ghRepo.trim(), branch: v.ghBranch.trim() || 'main', token: v.ghToken.trim() };
        if (!cfg.owner || !cfg.repo || !cfg.token) return toast('Owner, Repository, Token을 입력하세요.', 'error');
        const r = await withLoading(b, () => testConnection(cfg), '확인 중…');
        if (r) toast(r.canPush ? `✅ ${r.fullName} (${cfg.branch}) 쓰기 가능` : `⚠️ ${r.fullName} 읽기만 가능 — 토큰 권한을 확인하세요.`, r.canPush ? 'success' : 'error', 5000);
        return;
      }
      case 'export': {
        const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `interview-practice-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        return URL.revokeObjectURL(a.href);
      }
      case 'clear':
        if (confirm('저장되지 않은 로컬 변경사항이 사라질 수 있어요. 비울까요?')) {
          clearCache();
          await load();
          toast('로컬 캐시를 비우고 다시 불러왔어요.');
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
      toast('데이터를 가져왔어요.', 'success');
    } catch (e) {
      toast(`가져오기 실패: ${e.message}`, 'error');
    }
  };
}
