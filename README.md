# 설치 없는 HWP/HWPX 웹 편집기

Docker로 실행한 웹 환경에서 HWP/HWPX 문서를 열고 편집 흐름을 확인할 수 있도록 만든 공개용 포트폴리오 저장소입니다.

처음에는 공동 편집까지 목표로 잡았지만, 최종적으로 실시간 공동 편집 기능은 완성하지 못했습니다. 대신 설치 없이 브라우저에서 한글 문서 편집 UI, 저장, 내보내기, local-only/no-share 흐름을 사용할 수 있게 만드는 데 집중했습니다.

## 구현 범위

- React 기반 브라우저 편집 화면 구성
- Express API로 문서 메타데이터, 업로드, 미리보기, 저장 흐름 구성
- HWP/HWPX 파일 입력 검증과 텍스트 추출 보조 로직 작성
- Docker Compose 기반 로컬 실행 구조 작성
- 업로드 문서가 서버에 남지 않도록 점검하는 스크립트 작성
- 공개 저장소에서는 별도 라이선스가 필요한 HWP 엔진, wasm, 폰트, 내부 배포 자료 제거

## 폴더별 설명

- `src/`: React 앱 코드입니다. 파일 열기, 편집기 어댑터 연결, 저장 상태, API 호출 흐름을 다룹니다.
- `server/`: Express API 코드입니다. 업로드, 미리보기, 문서 메타데이터, 텍스트 추출, 세션 모드를 처리합니다.
- `scripts/`: 스트레스 테스트와 no-content-at-rest 점검 스크립트입니다.
- `Dockerfile`: 웹앱을 컨테이너로 실행하기 위한 이미지 정의입니다.
- `docker-compose.yml`: 로컬에서 API와 프론트엔드를 함께 띄우기 위한 Compose 설정입니다.
- `package.json`: npm 스크립트와 의존성 목록입니다.
- `index.html`: Vite 진입 HTML입니다.
- `vite.config.js`: Vite 개발 서버와 빌드 설정입니다.

## 엔진 경계

이 저장소에는 HWP 렌더링/편집 엔진 자체가 포함되어 있지 않습니다. 전체 편집 화면을 실제로 띄우려면 별도로 승인된 엔진을 `/rhwp-studio/` 경로나 `HWP_COLLAB_ENGINE_URL`로 연결해야 합니다.

엔진이 없어도 API 구조, React UI 흐름, 파일 검증, 스크립트 구성은 코드로 확인할 수 있습니다.

## 실행 방법

```bash
npm install
npm start
```

다른 터미널에서 프론트엔드를 실행합니다.

```bash
npm run dev
```

Docker Compose로 실행할 때:

```bash
docker compose up --build
```

엔진 URL을 연결할 때:

```bash
HWP_COLLAB_ENGINE_URL=http://127.0.0.1:9000/rhwp-studio/ docker compose up --build
```

## 검증 방법

```bash
npm run check
npm test
node scripts/stress-test.mjs --clients=100 --messages=8 --concurrency=20
node scripts/no-content-at-rest.mjs
```

스트레스 테스트는 기본적으로 `http://127.0.0.1:8170`에 API가 떠 있다고 가정합니다. 다른 주소를 쓰려면 `STRESS_BASE_URL`을 지정합니다.

## 공개 범위

회사 데이터, 런타임 JSON, DB, CSV, 배포 영수증, 내부 지시문, 엔진 asset, 빌드 결과물, `node_modules`, `.env` 파일은 포함하지 않습니다.

2년차 주니어 관점에서 과장하지 않도록, 완성한 범위와 끝내 구현하지 못한 공동 편집 범위를 분리해서 적었습니다.
