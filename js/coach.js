// 말하기 연습 로직과 상수 (순수 함수, DOM/저장소 접근 없음)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 답변 유형과 박자 ----------
export const KIND_LABEL = { experience: '경험형', knowledge: '지식형', opinion: '의견형', intro: '자기소개' };
export const KINDS = Object.keys(KIND_LABEL);

export const BEATS = {
  experience: ['결론', '상황', '행동', '결과', '연결'],
  knowledge: ['정의', '핵심', '예시', '한계'],
  opinion: ['주장', '이유', '사례', '마무리'],
  intro: ['한 줄 소개', '근거 1', '근거 2', '지원 동기'],
};

/** 박자 입력칸 placeholder */
export const BEAT_PLACEHOLDER = {
  결론: '무엇을 했고 어떻게 됐는지 한 문장',
  상황: '언제, 어떤 문제가 있었는지',
  행동: '내가 직접 한 일',
  결과: '바뀐 점, 수치',
  연결: '이 경험이 지원 직무에 닿는 지점',
  정의: '한 문장으로 정의',
  핵심: '동작 원리나 핵심 차이',
  예시: '써 본 사례나 예',
  한계: '단점, 주의할 점',
  주장: '내 생각 한 문장',
  이유: '그렇게 생각하는 까닭',
  사례: '뒷받침하는 경험',
  마무리: '다시 한 번 정리',
  '한 줄 소개': '어떤 개발자인지 한 문장',
  '근거 1': '그렇게 말할 수 있는 경험',
  '근거 2': '다른 경험이나 강점',
  '지원 동기': '왜 이 회사, 이 직무인지',
};

export function inferKind(q) {
  const cat = q?.category || '';
  if (q?.type === 'personality') {
    if (cat === '자기소개/지원동기') return 'intro';
    if (cat === '성격/가치관' || cat === '성장/목표') return 'opinion';
    return 'experience';
  }
  if (cat === 'CS' || cat === '기술 기본기') return 'knowledge';
  return 'experience';
}

/** 유형을 바꿀 때 박자 이름만 템플릿으로 바꾸고 내용은 순서대로 유지 */
export function relabelBeats(beats, kind) {
  const labels = BEATS[kind] || BEATS.experience;
  const old = beats || [];
  const n = Math.max(labels.length, old.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const text = old[i]?.text || '';
    if (i < labels.length) out.push({ label: labels[i], text });
    else if (text) out.push({ label: old[i].label || '', text });
  }
  return out;
}

const NUM_UNIT = /\d+(?:\.\d+)?\s?(?:%|ms|s|초|분|배|명|건|개|만|천|x)/g;
const LATIN = /[A-Za-z][A-Za-z0-9+#.\-]*[A-Za-z0-9+#]/g;
const STOP_LATIN = new Set(['the', 'and', 'for', 'to', 'of', 'in', 'on', 'is', 'it']);

/** 답변과 경험(result/action)에서 키워드 후보: 수치+단위, 영문 용어, 경험 태그. 최대 5개 */
export function extractCues(text, exps = []) {
  const sources = [String(text || ''), ...(exps || []).flatMap((e) => [e?.result || '', e?.action || ''])];
  const all = sources.join('\n');
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const v = String(c || '').trim().replace(/\.$/, '');
    const k = v.toLowerCase().replace(/\s+/g, '');
    if (!v || v.length > 10 || seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const s of sources) for (const m of s.match(NUM_UNIT) || []) push(m.replace(/\s+/g, ''));
  for (const s of sources)
    for (const m of s.matchAll(LATIN)) {
      // 300ms의 ms처럼 숫자 바로 뒤의 단위는 건너뛴다
      if (/\d\s?$/.test(s.slice(Math.max(0, m.index - 2), m.index))) continue;
      if (m[0].length >= 2 && !STOP_LATIN.has(m[0].toLowerCase())) push(m[0]);
    }
  const low = all.toLowerCase();
  for (const e of exps || []) for (const t of e?.tags || []) if (t && low.includes(String(t).toLowerCase())) push(t);
  return out.slice(0, 5);
}

export function defaultPrep(q, exps = []) {
  const kind = inferKind(q);
  return {
    kind,
    conclusion: '',
    beats: BEATS[kind].map((label) => ({ label, text: '' })),
    cues: extractCues(q?.answer, exps),
    opener: '',
    spoken: '',
    short30: '',
    gaps: [],
    source: 'template',
  };
}

// ---------- 원고 단계와 체감 난이도 ----------
export const LEVEL_LABEL = ['원고', '첫 글자', '키워드', '질문만'];
export const CONF_LABEL = { hard: '어려움', fair: '보통', easy: '수월' };
export const CONF_KEYS = ['hard', 'fair', 'easy'];

// ---------- 간격 반복 ----------
export const INTERVALS = [0, 1, 3, 7, 14];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 로컬 날짜 YYYY-MM-DD */
export function today() {
  return ymd(new Date());
}

export function addDays(n, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n);
  return ymd(d);
}

/** 체감 난이도 평가를 반영한 새 drill 객체 */
export function rateDrill(drill = {}, conf, { hintsUsed = 0, adjustLevel = true } = {}) {
  const d = {
    level: 0,
    streak: 0,
    reps: 0,
    box: 0,
    ...(drill || {}),
  };
  d.reps = (d.reps || 0) + 1;
  d.last = conf;
  d.ratedAt = new Date().toISOString();
  let c = conf;
  if (c === 'easy' && hintsUsed >= 3) c = 'fair';
  if (c === 'easy') {
    d.box = Math.min(4, (d.box || 0) + 1);
    d.streak = (d.streak || 0) + 1;
    if (adjustLevel && d.streak >= 2 && d.level < 3) {
      d.level += 1;
      d.streak = 0;
    }
    d.due = addDays(INTERVALS[d.box]);
  } else if (c === 'fair') {
    d.streak = 0;
    d.due = addDays(1);
  } else if (c === 'hard') {
    d.box = 0;
    d.streak = 0;
    if (adjustLevel) d.level = Math.max(0, (d.level || 0) - 1);
    d.due = today();
  }
  return d;
}

export function isDue(q) {
  return q?.drill?.due ? q.drill.due <= today() : !!(q?.prep || q?.answer?.trim());
}

const LAST_RANK = { hard: 0, fair: 1, easy: 2 };
const lastRank = (q) => LAST_RANK[q?.drill?.last] ?? 3;

export function dueQueue(questions = []) {
  return questions
    .filter(isDue)
    .sort(
      (a, b) =>
        lastRank(a) - lastRank(b) ||
        (a.drill?.due || '').localeCompare(b.drill?.due || '') ||
        (a.drill?.box || 0) - (b.drill?.box || 0)
    );
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isWeak = (q) => q?.drill?.last === 'hard' || q?.drill?.last === 'fair';

/** 어려움/보통 질문 먼저, 나머지는 무작위 */
export function weakFirst(questions = []) {
  return [...shuffle(questions.filter(isWeak)).sort((a, b) => lastRank(a) - lastRank(b)), ...shuffle(questions.filter((q) => !isWeak(q)))];
}

/** 수월 → 뼈대 있음 → 자기소개 → 나머지 */
export function easyFirst(questions = []) {
  const rank = (q) => (q?.drill?.last === 'easy' ? 0 : q?.prep ? 1 : inferKind(q) === 'intro' ? 2 : 3);
  return shuffle(questions).sort((a, b) => rank(a) - rank(b));
}

// ---------- 연결 멘트 ----------
export const SITUATIONS = ['시작', '생각 정리', '질문 확인', '연결', '모를 때', '정리', '정정'];

export const DEFAULT_PHRASES = [
  { id: 'p-open-1', situation: '시작', text: '결론부터 말씀드리면, ~입니다.' },
  { id: 'p-open-2', situation: '시작', text: '두 가지로 나눠 말씀드리겠습니다. 첫째는 ~' },
  { id: 'p-think-1', situation: '생각 정리', text: '잠시 생각을 정리하고 말씀드려도 될까요?' },
  { id: 'p-think-2', situation: '생각 정리', text: '좋은 질문입니다. 10초만 정리하겠습니다.' },
  { id: 'p-clar-1', situation: '질문 확인', text: '질문을 제가 이해한 대로 말씀드리면 ~라는 말씀이 맞을까요?' },
  { id: 'p-clar-2', situation: '질문 확인', text: '~ 관점에서 답변드려도 될까요?' },
  { id: 'p-bridge-1', situation: '연결', text: '그 이유는 ~ 때문입니다.' },
  { id: 'p-bridge-2', situation: '연결', text: '구체적인 예를 들면, ~' },
  { id: 'p-bridge-3', situation: '연결', text: '그 결과 ~' },
  { id: 'p-idk-1', situation: '모를 때', text: '정확히는 모르지만, 제가 아는 ~를 바탕으로 추론해 보면 ~' },
  { id: 'p-idk-2', situation: '모를 때', text: '그 부분은 직접 경험해 보지 못했습니다. 다만 비슷한 상황에서는 ~' },
  { id: 'p-idk-3', situation: '모를 때', text: '정확한 수치는 기억나지 않지만, 대략 ~ 정도였습니다.' },
  { id: 'p-wrap-1', situation: '정리', text: '정리하면, 핵심은 ~입니다.' },
  { id: 'p-wrap-2', situation: '정리', text: '이상입니다.' },
  { id: 'p-fix-1', situation: '정정', text: '방금 말씀드린 부분을 정정하겠습니다.' },
];

const DEFAULT_IDS = new Set(DEFAULT_PHRASES.map((p) => p.id));

/** 숨긴 기본 멘트 목록 */
export function hiddenDefaults(userPhrases = []) {
  const hidden = new Set((userPhrases || []).filter((p) => p?.hidden && DEFAULT_IDS.has(p.id)).map((p) => p.id));
  return DEFAULT_PHRASES.filter((p) => hidden.has(p.id));
}

/** 보이는 멘트 평면 목록: 기본(숨김 제외, isDefault:true) + 사용자 멘트 */
export function allPhrasesFlat(userPhrases = []) {
  const hidden = new Set(hiddenDefaults(userPhrases).map((p) => p.id));
  const users = (userPhrases || []).filter((p) => p && !DEFAULT_IDS.has(p.id) && !p.hidden && p.text);
  return [...DEFAULT_PHRASES.filter((p) => !hidden.has(p.id)).map((p) => ({ ...p, isDefault: true })), ...users.map((p) => ({ ...p, isDefault: false }))];
}

/** 상황별로 묶은 멘트: [{situation, items:[{id,situation,text,isDefault}]}] (SITUATIONS 순서, 그 밖의 상황은 뒤에) */
export function allPhrases(userPhrases = []) {
  const flat = allPhrasesFlat(userPhrases);
  const order = [...SITUATIONS];
  for (const p of flat) if (!order.includes(p.situation || '기타')) order.push(p.situation || '기타');
  return order
    .map((situation) => ({ situation, items: flat.filter((p) => (p.situation || '기타') === situation) }))
    .filter((g) => g.items.length);
}

// ---------- 힌트 ----------
export const HINT_TITLES = { 1: '생각 정리', 2: '구조', 3: '키워드', 4: '첫 문장' };

const chipsHtml = (cues) => `<div class="cue-chips">${cues.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>`;

/**
 * 힌트 단계(1~4)를 로컬 자료만으로 만든다.
 * 반환: {step, title, html} 또는 자료가 없으면 {step, title, needsAi:true, fallbackHtml}
 */
export function buildHint(step, { q, turn, exps = [], phrases = [] } = {}) {
  const title = HINT_TITLES[step] || '';
  if (step === 1) {
    const think = allPhrasesFlat(phrases).filter((p) => p.situation === '생각 정리');
    const p = think[0];
    const intent = turn?.intent || q?.intent;
    return {
      step,
      title,
      html: `${p ? `<p class="phrase">${esc(p.text)}</p>` : ''}${intent ? `<p class="muted">묻는 이유 · ${esc(intent)}</p>` : ''}`,
    };
  }
  if (step === 2) {
    const kind = q?.prep?.kind || inferKind(q);
    const labels = (q?.prep?.beats || []).map((b) => b.label).filter(Boolean);
    const use = labels.length ? labels : BEATS[kind] || BEATS.experience;
    return { step, title, html: `<p>${use.map(esc).join(' → ')}</p>` };
  }
  if (step === 3) {
    let cues = turn?.cues?.length ? turn.cues : q?.prep?.cues?.length ? q.prep.cues : extractCues(q?.answer, exps);
    if (!cues?.length) return { step, title, needsAi: true, fallbackHtml: '<p class="muted">준비된 키워드가 없습니다.</p>' };
    return { step, title, html: chipsHtml(cues) };
  }
  if (step === 4) {
    const { opener, conclusion } = q?.prep || {};
    if (!opener && !conclusion) return { step, title, needsAi: true, fallbackHtml: '<p>결론부터 말씀드리면, ~</p>' };
    return {
      step,
      title,
      html: `${opener ? `<p>${esc(opener)}</p>` : ''}${conclusion && conclusion !== opener ? `<p class="muted">결론 · ${esc(conclusion)}</p>` : ''}`,
    };
  }
  return { step, title, html: '' };
}

/** ai.hint() 결과를 힌트 단계 html로 */
export function hintFromAi(step, r = {}) {
  const title = HINT_TITLES[step] || '';
  const cues = (r.cues || []).slice(0, 5);
  if (step === 3) return { step, title, html: cues.length ? chipsHtml(cues) : '<p class="muted">준비된 키워드가 없습니다.</p>' };
  const parts = [];
  if (r.opener) parts.push(`<p>${esc(r.opener)}</p>`);
  if (r.conclusion) parts.push(`<p class="muted">결론 · ${esc(r.conclusion)}</p>`);
  if (cues.length) parts.push(chipsHtml(cues));
  return { step, title, html: parts.join('') || '<p>결론부터 말씀드리면, ~</p>' };
}

/** 힌트 하나를 .hint-step 마크업으로 */
export function hintStepHtml(h) {
  if (!h) return '';
  return `<div class="hint-step" data-step="${h.step}"><span class="lbl-sm">${h.step} · ${esc(h.title)}</span>${h.html ?? h.fallbackHtml ?? ''}</div>`;
}

/** 결론 첫 낱말 + … (원고 단계 2, "결론 첫마디") */
export function conclusionTeaser(conclusion) {
  const s = String(conclusion || '').trim();
  if (!s) return '';
  // 결론의 첫 낱말만 (낱말 중간에서 자르면 깨진 글처럼 보인다). 너무 긴 낱말은 6자까지.
  const word = s.split(/\s+/)[0];
  const head = [...word].slice(0, 6).join('');
  return head.length < s.length ? `${head}…` : head;
}
