# moneygrace

개인용 지출 기록 웹앱. 정적 HTML/CSS/JS 단일 페이지이고 데이터는
브라우저 `localStorage` 에만 저장한다.

## 기능

- 월 단위 지출 기록 (금액, 장소, 대상, 목적, 메모 등)
- 월 예산 · 월 시작일 설정
- 페이스 지표 (오늘까지 기대되는 흐름 vs 실제 흐름)
- 경험 태그 (책갈피 · 낭비 · 도전)
- 카테고리 분포
- 글로벌 검색, 필터 칩
- 자동 백업 스냅샷(최대 30개)과 시점 복원
- JSON 내보내기 / 가져오기
- 영수증 OCR 자동 채움 (Tesseract.js, 클라이언트에서만 처리)
- 이달의 보고서 (요약 + 전체 기록) · 인쇄 / 마크다운 다운로드 / 클립보드 복사
- PWA 지원 (홈 화면 설치, Service Worker 오프라인 캐시)

## 개인 정보 정책

- 모든 기록은 브라우저 localStorage 에만 저장된다.
- 영수증 이미지는 파일로 저장하지 않고, OCR 텍스트만 남긴다.
- 네트워크로 나가는 요청: GitHub Pages 정적 파일, Tesseract.js CDN
  (첫 로드 시 한국어 모델 다운로드).
- 그 외 서버로 송신되는 개인 데이터 없음.

## 실행

브라우저로 `index.html` 을 직접 열거나, 로컬 HTTP 서버에서 서빙.

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## 배포

`main` 브랜치 푸시 시 GitHub Pages 로 자동 배포되는 워크플로가
`.github/workflows/pages.yml` 에 있다.

## 파일 구성

```
index.html       구조
styles.css       스타일
app.js           상태 · 렌더 · 저장 · OCR · 보고서
sw.js            Service Worker
manifest.json    PWA manifest
icon.svg         아이콘
```
