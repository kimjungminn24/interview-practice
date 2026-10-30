// OpenAI(호환) Chat Completions API를 브라우저에서 직접 호출한다. 키는 localStorage에만 저장된다.
import { getSettings } from './store.js';
import { typeLabel } from './ui.js';

export const aiReady = () => !!getSettings().aiKey;

async function chat(messages) {
  const s = getSettings();
  if (!s.aiKey) throw new Error('설정에서 OpenAI API 키를 먼저 입력하세요.');
  const res = await fetch(`${s.aiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.aiKey}` },
    body: JSON.stringify({ model: s.aiModel, messages, response_format: { type: 'json_object' } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `OpenAI 오류 (${res.status})`);
  const text = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI 응답을 해석하지 못했습니다.');
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
  turns.map((t, i) => `${i === 0 ? '[메인 질문]' : `[꼬리질문 ${i}]`} ${t.q}\n[답변] ${t.a || '(무응답)'}`).join('\n\n');

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
  return chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `다음 면접 답변을 평가해 주세요. 두괄식 여부, 구체성(수치/근거), STAR 구조, 질문 의도 부합, 경험과의 일관성을 기준으로 봐 주세요.

[질문 유형] ${typeLabel(question.type)}

${turnsText(turns)}

[지원자가 정리한 관련 경험]
${expBlock(experiences)}

JSON 형식: {"score":1~10 정수,"summary":"총평 2~3문장","strengths":["좋은 점"],"improvements":["구체적으로 보완할 점"],"betterAnswer":"경험을 활용해 개선한 모범 답변(1분 분량)"}`,
    },
  ]);
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

JSON 형식: {"question":"꼬리질문","intent":"확인하려는 것"}`,
    },
  ]);
  return r;
}

/** 모의면접 전체 리뷰 */
export async function mockReview({ items }) {
  const body = items
    .map((it, i) => `### 질문 ${i + 1} (${typeLabel(it.type)})\n${turnsText(it.turns)}`)
    .join('\n\n');
  return chat([
    { role: 'system', content: system() },
    {
      role: 'user',
      content: `모의면접이 끝났습니다. 질문별로 평가하고 전체 총평을 해주세요. 꼬리질문에 대한 대응력도 평가에 포함하세요.

${body}

JSON 형식: {"overall":{"score":1~10,"summary":"전체 총평","strengths":["..."],"improvements":["..."]},"items":[{"score":1~10,"summary":"...","strengths":["..."],"improvements":["..."],"betterAnswer":"개선된 메인 답변 예시"}]}
items 배열은 질문 순서와 같은 길이로 작성하세요.`,
    },
  ]);
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
