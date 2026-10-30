# 🎤 면접 연습장

서버 없이 **GitHub Pages + GitHub 저장소**만으로 동작하는 개인 면접 연습 도구입니다.
경험 카드, 질문, 연습 기록은 모두 이 저장소의 `data/*.json`에 커밋으로 남습니다.

## 기능

| 기능 | 설명 |
| --- | --- |
| **경험 카드** | 경험을 STAR(상황·과제·행동·결과) + 배운 점 + 키워드로 정리 |
| **질문 리스트** | 직무 / 인성 탭으로 분리, 카테고리·검색·"경험 미연결" 필터 |
| **보기** | 질문에 연결된 경험 카드를 바로 확인 (키워드 기반 추천 경험 제공) |
| **연습** | 답변 작성 → 🤖 꼬리질문 생성 → 🤖 피드백(점수·좋은 점·보완점·개선 답변) → 기록 저장 |
| **면접 카드 생성** | 경험 카드에서 GPT로 직무(기술 꼬리질문)/인성 면접 질문 카드 생성 후 자동 연결 |
| **꼬리질문 → 카드** | 생성된 꼬리질문을 질문 리스트에 하위 카드(↳)로 추가 |
| **모의면접** | 무작위 출제 → 답변 → AI 면접관이 경험을 참고해 꼬리질문 → 전체 평가. 타이머, 음성 입력(Chrome), 질문 읽어주기 지원 |
| **기록** | 모의면접/개별 연습 기록과 평균 점수 |

## 시작하기

### 1. GitHub Pages 켜기
저장소 **Settings → Pages → Build and deployment**에서
Source를 `Deploy from a branch`, Branch를 `main` / `/ (root)`로 선택합니다.
잠시 후 `https://<아이디>.github.io/interview-practice/` 에서 열립니다.

> 로컬에서 실행: `python3 -m http.server 8000` 후 http://localhost:8000
> (ES 모듈을 쓰기 때문에 `index.html`을 파일로 직접 열면 동작하지 않습니다.)

### 2. GitHub 토큰 연결 (데이터 저장)
1. [Fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) 생성
   - Repository access: **Only select repositories → interview-practice**
   - Permissions → Repository → **Contents: Read and write**
2. 앱의 **설정** 탭에서 Owner / Repository / Branch / Token 입력 → "연결 테스트" → "저장 후 다시 불러오기"

변경 사항은 4초 뒤 자동으로 커밋됩니다(설정에서 끄고 상단 **저장** 버튼으로 수동 커밋 가능).
토큰이 없으면 **로컬 모드**로 동작하며 브라우저에만 저장됩니다(설정 → JSON 내보내기로 백업).

### 3. OpenAI 키 연결 (꼬리질문 · 피드백)
설정 탭에 OpenAI API Key, 모델명(기본 `gpt-4o-mini`, 원하는 모델로 변경 가능), 목표 직무, 채용공고(JD)를 입력하세요.
JD를 넣으면 질문과 피드백이 해당 회사/직무에 맞춰집니다. OpenAI 호환 API라면 Base URL만 바꿔서 쓸 수 있습니다.

## 🔐 보안 주의

- 토큰과 API 키는 **브라우저 localStorage에만** 저장되고 저장소에는 커밋되지 않습니다.
- 공용 PC에서는 사용 후 설정에서 토큰/키를 지워 주세요.
- 저장소가 **public이면 `data/`의 면접 답변도 공개**됩니다. 공개를 원치 않으면 저장소를 private으로 두세요.
  (private 저장소의 GitHub Pages는 유료 플랜이 필요하므로, 이 경우 로컬 서버로 실행하거나 public 저장소엔 코드만 두고 데이터 저장소를 별도 private 저장소로 지정하세요 — 설정의 Owner/Repository를 데이터용 저장소로 입력하면 됩니다.)

## 데이터 구조

```
data/
  experiences.json  # 경험 카드 [{ id, title, period, role, tags[], situation, task, action, result, learned }]
  questions.json    # 질문 [{ id, text, type: job|personality, category, experienceIds[], followUps[], answer, parentId? }]
  sessions.json     # 연습 기록 [{ id, mode: mock|single, startedAt, items[{ questionId, turns[{q,a}], feedback }], overall }]
```

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
  ai.js           # OpenAI 프롬프트 (꼬리질문/피드백/카드 생성/모의면접 평가)
  ui.js           # 모달, 토스트 등 공통 UI
  views/          # experiences, questions, mock, history, settings, components
```
