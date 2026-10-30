# 면접 연습장

서버 없이 **GitHub Pages + GitHub 저장소**만으로 동작하는 개인 면접 연습 도구입니다.
경험, 질문, 연습 기록은 모두 이 저장소의 `data/*.json`에 커밋으로 남습니다.

## 기능

| 기능 | 설명 |
| --- | --- |
| **경험** | 경험을 상황·과제·행동·결과 + 배운 점 + 키워드로 정리 |
| **질문** | 직무 / 인성 탭으로 분리, 카테고리·검색·"경험 미연결"·"복습할 질문"·"뼈대 없음" 필터 |
| **보기** | 질문에 연결된 경험을 바로 확인 (키워드 기반 추천 경험 제공) |
| **연습** | 답변 뼈대(결론 한 문장·박자·키워드·첫 문장) 정리 → 답변 작성 → 꼬리질문 받기 → 첨삭 받기 → 기록 저장 |
| **질문 뽑기** | 경험에서 직무(기술 꼬리질문)/인성 면접 질문을 뽑아 자동 연결 |
| **꼬리질문 → 질문** | 받은 꼬리질문을 질문 리스트에 하위 질문으로 추가 |
| **말하기 연습** | 원고 → 첫 글자 → 키워드 → 질문만, 4단계로 원고를 줄여 가며 소리 내어 답하기. 녹음·받아쓰기·길이/첫마디/멈춤/말 속도/군말 지표, 힌트, 연결 멘트, 어려움·보통·수월 체감 난이도에 따른 복습 일정 |
| **모의면접** | 워밍업/기본/실전 프리셋, 생각 시간, 질문을 하나씩 묻고 경험을 참고해 꼬리질문 → 질문별 체감 난이도 → 전체 첨삭. 힌트, 받아쓰기(Chrome·Safari), 질문 읽어 주기, 새로고침 후 이어서 하기 |
| **기록** | 모의면접/개별 연습/말하기 기록, 말하기 시도별 지표, 최근 평균 점수 |

## 시작하기

### 1. GitHub Pages 켜기
저장소 **Settings → Pages → Build and deployment**에서
Source를 `Deploy from a branch`, Branch를 `main` / `/ (root)`로 선택합니다.
잠시 후 `https://<아이디>.github.io/interview-practice/` 에서 열립니다.

> 로컬에서 실행: `python3 -m http.server 8000` 후 http://localhost:8000
> (ES 모듈을 쓰기 때문에 `index.html`을 파일로 직접 열면 동작하지 않습니다.)

### 2. 데이터용 private 저장소 연결 (경험이 공개되지 않게)
무료 GitHub Pages는 public 저장소에서만 동작하므로, **앱 코드(이 저장소, public)와 데이터(별도 private 저장소)를 분리**합니다.
public 저장소에는 코드와 `(예시)` 샘플만 있고, 내 경험·답변·기록은 private 저장소에만 커밋됩니다.

1. GitHub에서 **private** 저장소를 새로 만듭니다 (예: `interview-data`). *Add a README file*에 체크해 `main` 브랜치를 만들어 주세요.
2. [Fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) 생성
   - Repository access: **Only select repositories → interview-data** (데이터 저장소만)
   - Permissions → Repository → **Contents: Read and write**
3. 앱의 **설정** 탭에서 Owner / Repository(`interview-data`) / Branch(`main`) / Token 입력 → "연결 테스트" → "저장 후 다시 불러오기"
   - public 저장소를 지정하면 경고가 뜹니다.
   - `data/` 폴더와 json 파일은 첫 저장 때 자동으로 만들어집니다.

변경 사항은 4초 뒤 자동으로 커밋됩니다(설정에서 끄고 상단 **저장** 버튼으로 수동 커밋 가능).
토큰이 없으면 **로컬 모드**로 동작하며 브라우저에만 저장됩니다(설정 → JSON 내보내기로 백업).
PC·아이폰 등 기기마다 설정 탭에서 토큰/키를 한 번씩 입력하면 같은 데이터를 함께 씁니다.

### 3. OpenAI 키 연결 (꼬리질문 · 첨삭 · 받아쓰기)
설정 탭에 OpenAI API Key, 모델명(기본 `gpt-4o-mini`, 원하는 모델로 변경 가능), 목표 직무, 채용공고(JD)를 입력하세요.
JD를 넣으면 질문과 첨삭이 해당 회사/직무에 맞춰집니다. OpenAI 호환 API라면 Base URL만 바꿔서 쓸 수 있습니다.

## 보안 주의

- 토큰과 API 키는 **브라우저 localStorage에만** 저장되고 저장소에는 커밋되지 않습니다.
- 공용 PC에서는 사용 후 설정에서 토큰/키를 지워 주세요.
- 내 데이터는 **private 데이터 저장소**에만 저장하세요. 토큰도 그 저장소에만 권한을 주면, 토큰이 유출돼도 다른 저장소는 안전합니다.
- 이 앱 저장소의 `data/`에는 예시 데이터만 두세요.
- 말하기 연습의 녹음은 이 기기의 메모리에만 있다가 화면을 떠나면 지워집니다. 디스크나 저장소에는 저장·커밋되지 않습니다. 받아쓰기를 켜면(설정 → 말하기) 녹음이 OpenAI로 전송됩니다.

## 데이터 구조

```
data/
  experiences.json  # 경험 [{ id, title, period, role, tags[], situation, task, action, result, learned }]
  questions.json    # 질문 [{ id, text, type: job|personality, category, intent, experienceIds[], followUps[], answer, parentId?, prep?, drill? }]
  sessions.json     # 기록 [{ id, mode: mock|single|speak, startedAt, endedAt, config?, items[{ questionId, question, type, turns[{q,a}], feedback, confidence?, attempts? }], overall? }]
  phrases.json      # 연결 멘트 [{ id, situation, text }] 사용자 멘트, [{ id: 기본 멘트 id, hidden: true }] 기본 멘트 숨김
```

새 필드는 모두 선택 항목이라 예전 json도 그대로 읽힙니다.

- `question.prep` 답변 뼈대: `{ kind: experience|knowledge|opinion|intro, conclusion, beats[{label,text}], cues[], opener, spoken, short30, gaps[], source: ai|manual|template, updatedAt }`
- `question.drill` 말하기 단계와 복습 일정: `{ level: 0 원고 · 1 첫 글자 · 2 키워드 · 3 질문만, streak, reps, box: 0~4, due: YYYY-MM-DD, last: hard|fair|easy, ratedAt }`. 복습 간격은 box 0~4에 따라 0/1/3/7/14일입니다.
- `mode: speak` 세션의 `items[].attempts[]`: `{ at, level, target, inputMode: voice|text, transcribed, durMs, speechMs, firstSpeechMs, pauses, longestPauseMs, syl, spm, estSec, fillersPerMin, fillers{}, hedges, restarts, longSent, cueHits, cueTotal, hintsUsed, confidence }` (녹음 파일 자체는 저장하지 않습니다)
- `mode: mock` 세션: `config{ preset: warmup|basic|real|custom, thinkSec, answerMode: text|voice, order, … }`, `items[].confidence`, `turns[].hintsUsed`, `turns[].thinkMs`, `turns[].intent`, `turns[].cues`
- 첨삭(`feedback`)은 `score, summary, strengths[], improvements[], betterAnswer`에 더해 `oneFix, firstSentenceIsConclusion, structure{conclusion,evidence,result,link}, delivery{top[],drill}, rewriteOpener`를 가질 수 있습니다.
- 브라우저 localStorage: `ip.settings`(토큰·키·말하기 설정), `ip.cache`(저장 전 변경분), `ip.mock`(진행 중인 모의면접), `ip.speak.pending`(저장 전 말하기 시도)

`(예시)`로 시작하는 샘플 데이터는 자유롭게 지우고 시작하세요.

## 구조

빌드 도구 없이 순수 HTML/CSS/JS(ES 모듈)로 작성했습니다.

```
index.html
css/style.css
js/
  app.js          # 라우팅, 동기화 상태 표시
  store.js        # 상태 관리, GitHub/로컬 저장, 자동 저장
  github.js       # GitHub Contents API
  ai.js           # OpenAI 프롬프트 (꼬리질문/첨삭/질문 뽑기/모의면접 첨삭/뼈대/힌트/받아쓰기)
  speech-metrics.js # 음절 수, 길이 추정, 군말·긴 문장 등 말하기 지표 (순수 함수)
  coach.js        # 답변 유형·박자, 복습 일정, 기본 멘트, 힌트 (순수 함수)
  media.js        # 마이크, 녹음, 음량 측정, 받아쓰기, 읽어 주기
  icons.js        # 인라인 SVG 아이콘
  ui.js           # 모달, 토스트 등 공통 UI
  views/          # experiences, questions, speak, mock, history, settings, components
```
