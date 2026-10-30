// 앱 상태 + 저장 (GitHub 저장소의 data/*.json 또는 브라우저 로컬 캐시)
import * as gh from './github.js';
import { uid } from './ui.js';

const SETTINGS_KEY = 'ip.settings';
const CACHE_KEY = 'ip.cache';
const KEYS = ['experiences', 'questions', 'sessions'];
const KEY_LABEL = { experiences: '경험 카드', questions: '질문', sessions: '연습 기록' };

export const state = { experiences: [], questions: [], sessions: [] };
export const status = { mode: 'local', saving: false, dirty: false, error: null, lastSaved: null };

const shas = {};
const dirty = new Set();
const listeners = new Set();
let saveTimer = null;
let saving = false;
let saveAgain = false;

// ---------- settings ----------
const DEFAULTS = {
  ghOwner: '',
  ghRepo: '',
  ghBranch: 'main',
  ghToken: '',
  dataDir: 'data',
  autoSave: true,
  aiKey: '',
  aiModel: 'gpt-4o-mini',
  aiBaseUrl: 'https://api.openai.com/v1',
  targetRole: '',
  jobDescription: '',
};

function guessRepo() {
  const { hostname, pathname } = location;
  if (!hostname.endsWith('.github.io')) return {};
  // 앱이 올라간 저장소는 public이므로 owner만 채우고, 데이터 저장소는 직접 지정하게 한다
  return { ghOwner: hostname.split('.')[0] };
}

export function getSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {}
  return { ...DEFAULTS, ...guessRepo(), ...saved };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function ghConfig() {
  const s = getSettings();
  if (!s.ghToken || !s.ghOwner || !s.ghRepo) return null;
  return { owner: s.ghOwner.trim(), repo: s.ghRepo.trim(), branch: (s.ghBranch || 'main').trim(), token: s.ghToken.trim() };
}

const filePath = (k) => `${(getSettings().dataDir || 'data').replace(/\/+$/, '')}/${k}.json`;

// ---------- events ----------
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  status.dirty = dirty.size > 0;
  status.saving = saving;
  listeners.forEach((fn) => fn(status));
}

// ---------- local cache (저장 전 변경분 보호) ----------
function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ state, dirty: [...dirty], at: new Date().toISOString() }));
  } catch (e) {
    console.warn('로컬 캐시 저장 실패', e);
  }
}

// ---------- load ----------
export async function load() {
  const cfg = ghConfig();
  const cache = readCache();
  status.mode = cfg ? 'github' : 'local';
  status.error = null;

  await Promise.all(
    KEYS.map(async (k) => {
      let data = null;
      try {
        if (cfg) {
          const r = await gh.getFile(cfg, filePath(k));
          data = r?.json ?? [];
          shas[k] = r?.sha;
        } else {
          const res = await fetch(`./${filePath(k)}`, { cache: 'no-store' });
          data = res.ok ? await res.json() : [];
        }
      } catch (e) {
        console.error(e);
        status.error = e.message;
        data = cache?.state?.[k] ?? [];
      }
      state[k] = Array.isArray(data) ? data : [];
    })
  );

  // 아직 저장되지 않은 변경분 복원
  let restored = false;
  for (const k of cache?.dirty || []) {
    if (Array.isArray(cache.state?.[k])) {
      state[k] = cache.state[k];
      dirty.add(k);
      restored = true;
    }
  }
  writeCache();
  emit();
  if (restored && cfg && getSettings().autoSave) scheduleSave();
  return { restored };
}

// ---------- save ----------
export function markDirty(...keys) {
  keys.forEach((k) => dirty.add(k));
  writeCache();
  emit();
  if (ghConfig() && getSettings().autoSave) scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAll(), 4000);
}

export async function saveAll() {
  clearTimeout(saveTimer);
  const cfg = ghConfig();
  if (!cfg) {
    status.error = '설정에서 GitHub 토큰/저장소를 입력하면 저장소에 기록됩니다.';
    emit();
    return false;
  }
  if (saving) {
    saveAgain = true;
    return false;
  }
  if (!dirty.size) return true;

  saving = true;
  status.error = null;
  emit();
  let ok = true;
  for (const k of [...dirty]) {
    const text = JSON.stringify(state[k], null, 2) + '\n';
    const path = filePath(k);
    const message = `data: ${KEY_LABEL[k]} 업데이트`;
    dirty.delete(k);
    try {
      try {
        shas[k] = await gh.putFile(cfg, path, text, shas[k], message);
      } catch (e) {
        // sha 불일치(다른 기기에서 수정 등) → 최신 sha로 한 번 재시도
        if (e.status !== 409 && e.status !== 422) throw e;
        const latest = await gh.getFile(cfg, path);
        shas[k] = await gh.putFile(cfg, path, text, latest?.sha, message);
      }
    } catch (e) {
      console.error(e);
      dirty.add(k);
      status.error = e.message;
      ok = false;
    }
  }
  saving = false;
  if (ok) status.lastSaved = new Date().toISOString();
  writeCache();
  emit();
  if (saveAgain) {
    saveAgain = false;
    if (dirty.size) return saveAll();
  }
  return ok;
}

// ---------- CRUD ----------
export const list = (k) => state[k];
export const byId = (k, id) => state[k].find((x) => x.id === id);

export function upsert(k, item) {
  const now = new Date().toISOString();
  const arr = state[k];
  const i = item.id ? arr.findIndex((x) => x.id === item.id) : -1;
  let saved;
  if (i >= 0) {
    saved = arr[i] = { ...arr[i], ...item, updatedAt: now };
  } else {
    saved = { ...item, id: item.id || uid(), createdAt: now, updatedAt: now };
    arr.push(saved);
  }
  markDirty(k);
  return saved;
}

export function removeExperience(id) {
  state.experiences = state.experiences.filter((e) => e.id !== id);
  let touched = false;
  for (const q of state.questions) {
    if (q.experienceIds?.includes(id)) {
      q.experienceIds = q.experienceIds.filter((x) => x !== id);
      touched = true;
    }
  }
  markDirty('experiences', ...(touched ? ['questions'] : []));
}

export function removeQuestion(id) {
  state.questions = state.questions.filter((q) => q.id !== id);
  for (const q of state.questions) if (q.parentId === id) q.parentId = null;
  markDirty('questions');
}

export function removeSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  markDirty('sessions');
}

export function addSession(session) {
  const s = { id: uid(), startedAt: new Date().toISOString(), ...session, endedAt: new Date().toISOString() };
  state.sessions.push(s);
  markDirty('sessions');
  return s;
}

/** 질문별 연습 기록 (최신순) */
export function historyOf(questionId) {
  return state.sessions
    .flatMap((s) => (s.items || []).filter((i) => i.questionId === questionId).map((i) => ({ ...i, date: s.startedAt, mode: s.mode })))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function practiceCounts() {
  const m = {};
  for (const s of state.sessions) for (const i of s.items || []) if (i.questionId) m[i.questionId] = (m[i.questionId] || 0) + 1;
  return m;
}

// ---------- import / export ----------
export function exportAll() {
  return { exportedAt: new Date().toISOString(), experiences: state.experiences, questions: state.questions, sessions: state.sessions };
}

export function importAll(data) {
  for (const k of KEYS) if (Array.isArray(data[k])) state[k] = data[k];
  markDirty(...KEYS);
}

export function clearCache() {
  localStorage.removeItem(CACHE_KEY);
  dirty.clear();
  emit();
}
