// OpenAI(호환) Chat Completions API를 브라우저에서 직접 호출한다. 키는 localStorage에만 저장된다.
import { getSettings } from './store.js';
import { typeLabel } from './ui.js';
import { extFor } from './media.js';

export const aiReady = () => !!getSettings().aiKey;
export const sttReady = () => aiReady() && getSettings().sttMode === 'openai';

/** 기본 시간 제한(ms). 테스트에서 바꿀 수 있다. */
export const aiTimeouts = { chat: 60000, transcribe: 90000 };
const baseUrl = (s) => (s.aiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

/** fetch + 시간 제한. 외부 signal로도 취소할 수 있다. */
async function fetchWithTimeout(url, init, { timeoutMs, signal, timeoutMsg } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) throw new Error(timeoutMsg || '응답이 없어 중단했습니다.');
    if (e?.name === 'AbortError') throw new Error('요청을 취소했습니다.');
    throw new Error(`연결하지 못했습니다. 네트워크를 확인하세요. (${e?.message || e})`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function chat(messages, { timeoutMs = aiTimeouts.chat, signal } = {}) {
  const s = getSettings();
  if (!s.aiKey) throw new Error('설정에서 API 키를 먼저 입력하세요.');
  const ctrlOpts = { timeoutMs, signal, timeoutMsg: `응답이 ${timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : 60}초 넘게 없어 중단했습니다.` };
  const res = await fetchWithTimeout(
    `${baseUrl(s)}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.aiKey}` },
      body: JSON.stringify({ model: s.aiModel, messages, response_format: { type: 'json_object' } }),
    },
    ctrlOpts
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `API 오류 (${res.status})`);
  const text = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    throw new Error('응답을 해석하지 못했습니다. 다시 시도하세요.');
  }
}

function system() {
  const s = getSettings();
  return [
    '당신은 한국 IT 기업의 숙련된 면접관이자 면접 코치입니다.',
    `지원자의 목표 직무: ${s.targetRole || '소프트웨어 개발자'}.`,
    s.jobDescription ? `참고할 채용공고/JD:\n${s.jobDescription}` : '',
    '지원자가 정리한 경험 카드(STAR)를 근거로, 실제 면접처럼 구체적이고 날카롭게 질문하고 평가하세요.',
    '모든 답변은 한국어로, 요청한 JSON 형식으로만 응답하세요.',
    '생각할 시간을 요청하거나, 모르는 것을 솔직히 인정하고 추론하는 것은 감점하지 말고 긍정적으로 평가하세요.',
    '보완점은 최대 3개, 그중 효과가 가장 큰 하나를 oneFix로 고르세요.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function experienceText(e) {
  return [
    `[${e.title}]${e.period ? ` (${e.period})` : ''}${e.role ? ` / 역할: ${e.role}` : ''}`,
    e.situation && `- 상황(S): ${e.situation}`,
    e.task && `- 과제(T): ${e.task}`,
    e.action && `- 행동(A): ${e.action}`,
    e.result && `- 결과(R): ${e.result}`,
    e.learned && `- 배운 점: ${e.learned}`,
    e.tags?.length && `- 키워드: ${e.tags.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const expBlock = (exps) => (exps?.length ? exps.map(experienceText).join('\n\n') : '(연결된 경험 없음)');

const turnsText = (turns) =>
  (turns || [])
    .map(
      (t, i) =>
        `${i === 0 ? '[메인 질문]' : `[꼬리질문 ${i}]`} ${t.q}\n[답변] ${t.a || '(무응답)'}${t.hintsUsed > 0 ? ` [힌트 ${t.hintsUsed}단계 사용]` : ''}`
    )
    .join('\n\n');

const KINDS = ['experience', 'knowledge', 'opinion', 'intro'];
const LEVEL_KO = ['원고 보며', '첫 글자만 보며', '키워드만 보며', '질문만 보고'];
const STRUCT_SPEC = `"oneFix":"다음 연습에서 고칠 것 하나(한 문장, 구체적 예시 포함)","firstSentenceIsConclusion":true|false,"structure":{"conclusion":bool,"evidence":bool,"result":bool,"link":bool}`;
const arr = (x, n) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.trim()).slice(0, n) : []);

/** 모델이 준 목록 칸: 배열이 아니라 문자열 하나로 오는 경우도 목록으로 바꾼다 */
const list = (x, n = 10) => {
  if (typeof x === 'string') return x.trim() ? [x.trim()] : [];
  if (!Array.isArray(x)) return [];
  return x
    .map((v) => (typeof v === 'string' ? v : v != null && typeof v !== 'object' ? String(v) : ''))
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, n);
};
const str = (x) => (x == null || typeof x === 'object' ? '' : String(x));
const bool = (x) => x === true || x === 'true';

/**
 * 첨삭 객체 모양 맞추기. 저장(sessions.json)하기 전에 반드시 거친다.
 * 빠진 칸은 생략하고, 예전 필드(score/summary/strengths/improvements/betterAnswer)는 그대로 유지한다.
 */
export function normFeedback(fb) {
  if (!fb || typeof fb !== 'object' || Array.isArray(fb)) return null;
  const out = {};
  const n = Number(fb.score);
  if (fb.score != null && fb.score !== '' && Number.isFinite(n)) out.score = Math.max(0, Math.min(10, Math.round(n)));
  for (const k of ['summary', 'oneFix', 'rewriteOpener', 'betterAnswer']) {
    const v = str(fb[k]).trim();
    if (v) out[k] = v;
  }
  out.strengths = list(fb.strengths, 5);
  out.improvements = list(fb.improvements, 5);
  if (fb.structure && typeof fb.structure === 'object' && !Array.isArray(fb.structure)) {
    out.structure = Object.fromEntries(['conclusion', 'evidence', 'result', 'link'].map((k) => [k, bool(fb.structure[k])]));
  }
  if (fb.firstSentenceIsConclusion != null) out.firstSentenceIsConclusion = bool(fb.firstSentenceIsConclusion);
  const d = fb.delivery;
  if (d && typeof d === 'object') {
    const top = list(d.top, 3);
    const drill = str(d.drill).trim();
    if (top.length || drill) out.delivery = { top, drill };
  }
  return out;
}

/** 질문 + (선택)답변 + 경험을 바탕으로 꼬리질문 여러 개 생성 */
export async function generateFollowUps({ question, answer, experiences, count = 4 }) {
  const r = await chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `다음 면접 질문에 대해 면접관이 이어서 던질 법한 꼬리질문 ${count}개를 만들어 주세요.
답변과 경험의 구체적인 내용(수치, 기술 선택 이유, 트레이드오프, 갈등 상황, 본인 기여도 등)을 파고드는 질문이어야 합니다.

[질문 유형] ${typeLabel(question.type)}
[질문] ${question.text}

[지원자 답변]
${answer || '(아직 답변 없음 — 경험 카드를 근거로 예상 꼬리질문 생성)'}

[관련 경험]
${expBlock(experiences)}

JSON 형식: {"followUps":[{"text":"꼬리질문","intent":"이 질문으로 확인하려는 것"}]}`,
    },
  ]);
  return r.followUps || [];
}

/** 단일 질문 답변 피드백 */
export async function getFeedback({ question, turns, experiences }) {
  const r = await chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `다음 면접 답변을 평가해 주세요. 두괄식 여부, 구체성(수치/근거), STAR 구조, 질문 의도 부합, 경험과의 일관성을 기준으로 봐 주세요.

[질문 유형] ${typeLabel(question.type)}

${turnsText(turns)}

[지원자가 정리한 관련 경험]
${expBlock(experiences)}

JSON 형식: {"score":1~10 정수,"summary":"총평 2~3문장","strengths":["좋은 점"],"improvements":["구체적으로 보완할 점(최대 3개)"],${STRUCT_SPEC},"betterAnswer":"경험을 활용해 다듬은 답변"}
betterAnswer는 말로 하는 구어체 합쇼체, 약 1분 분량, 한 줄에 한 문장(\\n 구분)으로 쓰세요.`,
    },
  ]);
  return normFeedback(r);
}

/** 모의면접: 지금까지의 대화를 보고 다음 꼬리질문 1개 생성 */
export async function nextFollowUp({ question, turns, experiences }) {
  const r = await chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `실제 면접 중입니다. 아래 대화를 보고 면접관으로서 다음 꼬리질문을 딱 1개만 하세요.
답변에서 모호하거나 근거가 부족한 부분, 더 깊이 확인할 기술적/행동적 포인트를 짚어야 합니다. 이미 한 질문은 반복하지 마세요.

[질문 유형] ${typeLabel(question.type)}

${turnsText(turns)}

[지원자 경험 카드(면접관만 참고)]
${expBlock(experiences)}

JSON 형식: {"question":"꼬리질문","intent":"확인하려는 것","cues":["답변에 쓸 만한 키워드 3개(경험 카드 근거, 각 10자 이내)"]}`,
    },
  ]);
  return { ...r, cues: arr(r?.cues, 5) };
}

/** 모의면접 전체 리뷰 */
export async function mockReview({ items, gentle = false }) {
  const body = items
    .map((it, i) => `### 질문 ${i + 1} (${typeLabel(it.type)})\n${turnsText(it.turns)}`)
    .join('\n\n');
  const r = await chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `모의면접이 끝났습니다. 질문별로 평가하고 전체 총평을 해주세요. 꼬리질문에 대한 대응력도 평가에 포함하세요.

${body}

JSON 형식: {"overall":{"score":1~10,"summary":"전체 총평","strengths":["..."],"improvements":["..."],${STRUCT_SPEC}},"items":[{"score":1~10,"summary":"...","strengths":["..."],"improvements":["..."],${STRUCT_SPEC},"betterAnswer":"다듬은 메인 답변(구어체 합쇼체, 한 줄에 한 문장)"}]}
items 배열은 질문 순서와 같은 길이로 작성하세요.${gentle ? '\n워밍업입니다. summary는 잘된 점 1개와 다음에 해볼 것 1개만, 담담하고 구체적으로. improvements는 1개만.' : ''}`,
    },
  ]);
  return {
    overall: normFeedback(r?.overall),
    items: Array.isArray(r?.items) ? r.items.map(normFeedback) : [],
  };
}

/** 경험 카드에서 면접 질문 카드 생성 */
export async function generateCards({ experience, type, count = 5 }) {
  const typeGuide = {
    job: '직무(기술) 면접 질문만 만드세요. 사용 기술의 원리, 기술 선택 이유와 대안 비교, 설계/트레이드오프, 트러블슈팅 과정, 성능/확장성, 관련 CS 지식으로 확장되는 질문을 포함하세요.',
    personality: '인성 면접 질문만 만드세요. 협업, 갈등 해결, 실패와 극복, 책임감, 의사소통, 가치관을 드러내는 질문을 포함하세요.',
    both: '직무(기술) 질문과 인성 질문을 적절히 섞어서 만드세요.',
  }[type];
  const r = await chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `다음 경험 카드를 보고 면접관이 실제로 물어볼 질문 ${count}개를 만들어 주세요.
${typeGuide}

[경험]
${experienceText(experience)}

category는 직무라면 [기술 기본기, CS, 프로젝트, 트러블슈팅, 설계/아키텍처, 성능/최적화, 협업/개발문화] 중,
인성이라면 [자기소개/지원동기, 성격/가치관, 협업/갈등, 실패/극복, 성장/목표, 기타] 중 하나를 고르세요.

JSON 형식: {"cards":[{"text":"질문","type":"job 또는 personality","category":"카테고리","intent":"질문 의도"}]}`,
    },
  ]);
  return (r.cards || []).map((c) => ({ ...c, type: c.type === 'personality' ? 'personality' : 'job' }));
}

// ---------- 말하기 연습 ----------
const BEAT_GUIDE = 'experience: 결론→상황→행동→결과→연결 | knowledge: 정의→핵심→예시→한계 | opinion: 주장→이유→사례→마무리 | intro: 한 줄 소개→근거 1→근거 2→지원 동기';

/** 답변 뼈대(prep) 생성 */
export async function buildPrep({ question, kind = 'experience', experiences, answer, targetSec = 60 }) {
  const r = await chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `다음 면접 질문의 답변 준비 자료를 만들어 주세요. 말하기가 서툰 지원자가 외우지 않고 말할 수 있게 하는 것이 목적입니다.
[질문 유형] ${typeLabel(question.type)}
[카테고리] ${question.category || '-'}
[의도] ${question.intent || '-'}
[질문] ${question.text}
[유형 추정] ${kind} — 맞지 않으면 바꿔도 됨
[목표 길이] 약 ${targetSec}초
[박자 템플릿] ${BEAT_GUIDE}
[지원자 답변(있으면 내용을 살려 다듬기)] ${answer || '(없음)'}
[경험 카드]
${expBlock(experiences)}
규칙:
- 경험 카드와 답변에 있는 사실만 사용. 없는 수치·기술은 지어내지 말고 "[수치 필요]"로 쓰고 gaps에 기록.
- 말로 하는 문장: 합쇼체, 한 문장 40음절 이하, 한 문장에 정보 하나. "~함에 있어", "~를 통해", "~하였으며", "~의 경우" 금지. "것 같습니다" 쓰지 않기.
- 첫 문장에 결론(두괄식). opener는 그 첫 문장.
- cues는 3~5개, 각 10자 이내 명사/숫자. 문장 금지.
- spoken: 약 60초(260~290음절), short30: 약 30초(130~150음절). 둘 다 한 줄에 한 문장(\n 구분).
JSON: {"kind":"experience|knowledge|opinion|intro","conclusion":"","beats":[{"label":"","text":""}],"cues":[],"opener":"","spoken":"","short30":"","gaps":[]}`,
    },
  ]);
  const beats = Array.isArray(r?.beats)
    ? r.beats.filter((b) => b && (b.label || b.text)).map((b) => ({ label: String(b.label || ''), text: String(b.text || '') }))
    : [];
  return {
    kind: KINDS.includes(r?.kind) ? r.kind : kind,
    conclusion: String(r?.conclusion || ''),
    beats,
    cues: arr(r?.cues, 5),
    opener: String(r?.opener || ''),
    spoken: String(r?.spoken || ''),
    short30: String(r?.short30 || ''),
    gaps: arr(r?.gaps, 10),
    source: 'ai',
    updatedAt: new Date().toISOString(),
  };
}

/** 힌트 3~4단계: 답을 대신 써 주지 않고 단서만 */
export async function hint({ question, turns, experiences, step = 3 }) {
  const want =
    step >= 4
      ? 'cues(단어 3~5개, 각 10자 이내), opener(첫 문장 한 문장), conclusion(결론 한 줄)만 주세요.'
      : 'cues(단어 3~5개, 각 10자 이내)만 주세요. 문장은 쓰지 마세요.';
  const r = await chat(
    [
      { role: 'system', content: system() },
      {
        role: 'user',
        content: `지원자가 아래 질문에서 말문이 막혔습니다. 답을 대신 써 주지 말고, 말을 이어갈 단서만 주세요.
경험 카드에 있는 사실만 쓰고, 없으면 일반적인 관점 단어를 주세요.
${want}

[질문 유형] ${typeLabel(question.type)}
${turns?.length ? turnsText(turns) : `[질문] ${question.text}`}

[경험 카드]
${expBlock(experiences)}

JSON 형식: {"cues":[],"opener":"","conclusion":"","structure":[]}`,
      },
    ],
    { timeoutMs: 30000 }
  );
  return {
    cues: arr(r?.cues, 5),
    opener: step >= 4 ? String(r?.opener || '') : '',
    conclusion: step >= 4 ? String(r?.conclusion || '') : '',
    structure: arr(r?.structure, 6),
  };
}

const secTxt = (ms) => `${(ms / 1000).toFixed(1)}초`;
const mmss = (sec) => {
  const n = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

/** 지표 객체(speech-metrics analyze 결과 + target)를 한 줄 요약으로 */
export function metricsLine(m = {}, targetSec) {
  const parts = [];
  const len = m.durMs != null ? m.durMs / 1000 : m.estSec;
  if (len != null && (m.durMs != null || m.syl)) parts.push(`길이 ${mmss(len)}${targetSec ? `(목표 ${mmss(targetSec)})` : ''}${m.durMs == null ? ' 추정' : ''}`);
  if (m.firstSpeechMs != null) parts.push(`첫마디 ${secTxt(m.firstSpeechMs)}`);
  if (m.spm != null) parts.push(`속도 ${m.spm}음절/분`);
  if (m.pauses != null) parts.push(`긴 멈춤 ${m.pauses}회${m.longestPauseMs ? `(최장 ${secTxt(m.longestPauseMs)})` : ''}`);
  const fillers = Object.entries(m.fillers || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w, n]) => `${w} ${n}`)
    .join(', ');
  if (m.fillersPerMin != null) parts.push(`군말 분당 ${m.fillersPerMin}${fillers ? `(${fillers})` : ''}`);
  else if (fillers) parts.push(`군말 ${fillers}`);
  if (m.hedges != null && m.hedges > 0) parts.push(`'것 같다' ${m.hedges}회`);
  if (m.longSent != null && m.longSent > 0) parts.push(`긴 문장 ${m.longSent}`);
  if (m.restarts) parts.push(`말 다시 시작 ${m.restarts}회`);
  if (m.cueTotal) parts.push(`키워드 ${m.cueHits}/${m.cueTotal}`);
  return parts.join(' · ');
}

/** 말하기 시도 첨삭 */
export async function speakFeedback({ question, transcript, metrics, prep, experiences, level = 0, inputMode = 'voice', targetSec }) {
  const prepText = prep
    ? [
        prep.conclusion && `결론: ${prep.conclusion}`,
        prep.beats?.length && `박자: ${prep.beats.map((b) => `${b.label}${b.text ? `(${b.text})` : ''}`).join(' → ')}`,
        prep.cues?.length && `키워드: ${prep.cues.join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const r = await chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `말하기 연습 답변을 첨삭해 주세요. 내용과 말하는 방식을 함께 봅니다.
[질문 유형] ${typeLabel(question.type)}
[질문] ${question.text}
[답변 방식] ${inputMode === 'voice' ? '음성 받아쓰기(문장부호 없음, 오인식 가능)' : '글로 입력'}
[전달 지표] ${metricsLine(metrics, targetSec) || '(없음)'}
[준비한 뼈대] ${prepText || '(없음)'}
[원고 단계] ${LEVEL_KO[level] || LEVEL_KO[0]}
[답변]
${transcript || '(무응답)'}

[경험 카드]
${expBlock(experiences)}

규칙:
- 맞춤법, 띄어쓰기, 문장부호는 평가하지 마세요.
- improvements는 최대 3개.
- delivery.top은 말하기 습관 최대 3개, 가장 중요한 것부터.
- delivery.drill은 다음 시도에서 할 구체적인 과제 딱 하나.
- 답변과 경험 카드에 없는 사실은 지어내지 마세요.

JSON: {"score":1~10,"oneFix":"","firstSentenceIsConclusion":bool,"structure":{"conclusion":bool,"evidence":bool,"result":bool,"link":bool},
 "summary":"2문장","strengths":["≤2"],"improvements":["≤3"],"delivery":{"top":["≤3"],"drill":""},
 "rewriteOpener":"첫 문장을 다시 말한다면","betterAnswer":"구어체 60초, 한 줄에 한 문장"}`,
    },
  ]);
  return normFeedback(r);
}

/** 녹음 받아쓰기 (OpenAI 호환 /audio/transcriptions). 텍스트를 돌려준다. */
export async function transcribe(blob, mime, { timeoutMs = aiTimeouts.transcribe, signal } = {}) {
  const s = getSettings();
  if (!s.aiKey) throw new Error('설정에서 API 키를 먼저 입력하세요.');
  const type = mime || blob?.type || 'audio/webm';
  const fd = new FormData();
  fd.append('file', new File([blob], `answer.${extFor(type)}`, { type }));
  fd.append('model', s.sttModel || 'whisper-1');
  fd.append('language', 'ko');
  fd.append('response_format', 'json');
  fd.append('prompt', '음, 어, 그러니까 제가, 어, 이제 약간 그 프로젝트에서… 말버릇과 머뭇거림도 들리는 그대로 적습니다.');
  const res = await fetchWithTimeout(
    `${baseUrl(s)}/audio/transcriptions`,
    { method: 'POST', headers: { Authorization: `Bearer ${s.aiKey}` }, body: fd },
    { timeoutMs, signal, timeoutMsg: '받아쓰기 응답이 90초 넘게 없어 중단했습니다.' }
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message;
    if ((res.status === 404 || res.status === 400) && !msg) throw new Error('이 API 주소는 받아쓰기를 지원하지 않습니다. 직접 입력하세요.');
    throw new Error(msg || `받아쓰기 오류 (${res.status})`);
  }
  return String(data?.text || '').trim();
}
