// 말하기 지표 계산 (순수 함수, DOM/부작용 없음)

export const SYL_PER_SEC = 4.5;

const HANGUL = /[가-힣]/g;
const LATIN_WORD = /[A-Za-z]+/g;
const DIGIT = /[0-9]/g;

/** 한글 음절 수 + 영문 단어×2 + 숫자×1.5 (반올림) */
export function countSyllables(text) {
  const s = String(text || '');
  const h = (s.match(HANGUL) || []).length;
  const l = (s.match(LATIN_WORD) || []).length;
  const d = (s.match(DIGIT) || []).length;
  return Math.round(h + l * 2 + d * 1.5);
}

export function estimateSeconds(text, sps = SYL_PER_SEC) {
  return Math.round(countSyllables(text) / sps);
}

/** 64 -> "1:04" */
export function fmtSec(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

const ENDINGS = /(습니다|입니다|어요|아요|에요|죠|다)(?=\s|$)/g;

/** 문장 나누기: 문장부호/줄바꿈 + 한국어 종결어미. 문장부호는 문장에 남긴다. */
export function splitSentences(text) {
  // 1.2초 같은 소수점은 나누지 않는다
  const s = String(text || '')
    .replace(/(\d)\.(\d)/g, '$1\u0000$2')
    .replace(ENDINGS, '$1\n');
  return (s.match(/[^.?!\n]+[.?!]*/g) || [])
    .map((x) => x.replace(/\u0000/g, '.').trim())
    .filter((x) => x && /[^.?!\s]/.test(x));
}

const EDGE_PUNCT = /^[,.?!…~"'()“”‘’]+|[,.?!…~"'()“”‘’]+$/g;

export function tokens(text) {
  return String(text || '')
    .split(/\s+/)
    .map((t) => t.replace(EDGE_PUNCT, ''))
    .filter(Boolean);
}

const HESITATION = /^(음+|어+|아+|에+|으+|흠+)$/;
const DISCOURSE = new Set(['이제', '약간', '뭔가', '좀', '막', '그니까', '그러니까', '뭐', '되게', '진짜', '일단', '사실', '솔직히', '이렇게']);
const MULTI = ['어떻게 보면', '뭐랄까'];

/** {counts:{word:n}, total} */
export function fillerStats(text) {
  const counts = {};
  const add = (w) => (counts[w] = (counts[w] || 0) + 1);
  for (const t of tokens(text)) {
    if (HESITATION.test(t)) add(t[0]);
    else if (DISCOURSE.has(t)) add(t);
  }
  const s = String(text || '');
  for (const m of MULTI) {
    const n = s.split(m).length - 1;
    if (n) counts[m] = (counts[m] || 0) + n;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total };
}

export function hedgeCount(text) {
  return (String(text || '').match(/것\s?같(습니다|아요|은데|고|다)/g) || []).length;
}

/** 같은 낱말을 연달아 말한 횟수 ("제가 제가", "그 그"). 망설임 소리는 제외. */
export function restartCount(text) {
  const t = tokens(text).map((x) => x.toLowerCase());
  let n = 0;
  for (let i = 1; i < t.length; i++) if (t[i] === t[i - 1] && !HESITATION.test(t[i])) n++;
  return n;
}

export function longSentenceCount(text, max = 80) {
  return splitSentences(text).filter((s) => countSyllables(s) > max).length;
}

export function firstSentence(text) {
  return splitSentences(text)[0] || '';
}

/** 원고 단계 1: 낱말마다 첫 음절만 보이고 나머지 한글은 · 로 가린다 */
export function firstSyllables(text) {
  return String(text || '').replace(/\S+/g, (tok) => {
    const m = tok.match(/^([가-힣]+)(.*)$/s);
    if (!m) return tok;
    return m[1][0] + '·'.repeat(m[1].length - 1) + m[2];
  });
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

/** {hits, total, missing[]} — 대소문자/공백 무시 부분 문자열 */
export function cueCoverage(text, cues) {
  const t = norm(text);
  const list = (cues || []).filter((c) => norm(c));
  const missing = list.filter((c) => !t.includes(norm(c)));
  return { hits: list.length - missing.length, total: list.length, missing };
}

/**
 * 시도 지표 계산. A.2의 attempt 필드 중 텍스트/시간에서 나오는 값을 돌려준다.
 * 선택: meter(createMeter().summary())를 주면 firstSpeechMs/pauses/longestPauseMs/speechMs를,
 * cues를 주면 cueHits/cueTotal/cueMissing을 함께 채운다.
 */
export function analyze({ text, durMs = null, speechMs = null, cues = null, meter = null } = {}) {
  const t = String(text || '').trim();
  const hasText = !!t;
  const syl = countSyllables(t);
  const fs = fillerStats(t);
  const min = durMs ? durMs / 60000 : 0;
  const cov = cues?.length ? cueCoverage(t, cues) : null;
  const first = firstSentence(t);
  return {
    durMs: durMs ?? null,
    speechMs: meter?.speechMs ?? speechMs ?? null,
    firstSpeechMs: meter?.firstSpeechMs ?? null,
    pauses: meter?.pauses ?? null,
    longestPauseMs: meter?.longestPauseMs ?? null,
    hasText,
    syl,
    spm: hasText && min ? Math.round(syl / min) : null,
    estSec: estimateSeconds(t),
    fillersPerMin: hasText && min ? Math.round((fs.total / min) * 10) / 10 : null,
    fillers: fs.counts,
    fillerTotal: fs.total,
    hedges: hedgeCount(t),
    restarts: restartCount(t),
    longSent: longSentenceCount(t),
    firstSentSyl: countSyllables(first),
    cueHits: cov ? cov.hits : null,
    cueTotal: cov ? cov.total : null,
    cueMissing: cov ? cov.missing : [],
  };
}

const sec1 = (ms) => `${(ms / 1000).toFixed(1)}초`;
const topFillers = (counts, n = 3) =>
  Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w, c]) => `${w} ${c}`)
    .join(', ');

/** [{key,label,value,verdict:'ok'|'warn'|null,note}] */
export function verdicts(m, targetSec = 60) {
  const rows = [];
  const voice = m.durMs != null;
  const row = (key, label, value, verdict = null, note = '') => rows.push({ key, label, value, verdict, note });

  // 길이
  const sec = voice ? m.durMs / 1000 : m.estSec;
  if (!voice && !m.hasText) row('len', '길이', '—', null, `목표 ${fmtSec(targetSec)}`);
  else {
    const v = sec < targetSec * 0.5 ? ['warn', '짧음'] : sec > targetSec * 1.5 ? ['warn', '김'] : ['ok', '적정'];
    row('len', '길이', `${voice ? '' : '약 '}${fmtSec(sec)}`, v[0], `${v[1]} · 목표 ${fmtSec(targetSec)}${voice ? '' : ' · 글자 수로 추정'}`);
  }

  // 첫마디
  if (m.firstSpeechMs != null) {
    const ms = m.firstSpeechMs;
    const v = ms <= 3000 ? ['ok', ''] : ms <= 5000 ? [null, '보통'] : ['warn', '늦음'];
    row('first', '첫마디', sec1(ms), v[0], v[1]);
  }

  // 긴 멈춤
  if (m.pauses != null) {
    row('pauses', '긴 멈춤', `${m.pauses}회${m.longestPauseMs ? ` · 최장 ${sec1(m.longestPauseMs)}` : ''}`, m.pauses > 3 ? 'warn' : 'ok', '1.5초 이상');
  }

  // 말 속도
  if (voice) {
    if (m.spm == null) row('spm', '말 속도', '—', null, '받아쓰기 후 계산');
    else {
      const v = m.spm < 210 ? ['warn', '느림'] : m.spm > 330 ? ['warn', '빠름'] : ['ok', '적정'];
      row('spm', '말 속도', `${m.spm}음절/분`, v[0], v[1]);
    }
  }

  const fillerNote = "참고용 · 받아쓰기가 '음/어'를 빠뜨릴 수 있음";
  if (m.hasText) {
    const detail = topFillers(m.fillers);
    if (m.fillersPerMin != null) {
      row('fillers', '군말/분', `${m.fillersPerMin}${detail ? ` (${detail})` : ''}`, m.fillersPerMin > 6 ? 'warn' : 'ok', fillerNote);
    } else {
      row('fillers', '군말', `${m.fillerTotal || 0}회${detail ? ` (${detail})` : ''}`, null, fillerNote);
    }
    row('hedges', '것 같다', `${m.hedges}회`, m.hedges > 2 ? 'warn' : 'ok');
    row('longSent', '긴 문장', `${m.longSent}`, m.longSent > 0 ? 'warn' : 'ok', '80음절 넘는 문장');
  } else if (voice) {
    row('fillers', '군말/분', '—', null, '받아쓰기 후 계산');
  }

  if (m.cueTotal) {
    row('cues', '키워드', `${m.cueHits}/${m.cueTotal}`, m.cueHits / m.cueTotal < 0.5 ? 'warn' : 'ok', m.cueMissing?.length ? `빠짐: ${m.cueMissing.join(', ')}` : '');
  }

  if (m.hasText) {
    const long = m.firstSentSyl > 60;
    row('firstSent', '첫 문장', `${m.firstSentSyl}음절`, long ? 'warn' : 'ok', long ? '첫 문장이 깁니다' : '');
  }
  return rows;
}
