# swITch

코드 재작성 제발 그만
이번에 진짜 완성하자

기억해

비밀번호는 8~20자, 영어, 숫자, !@#$%^&*만 사용 가능
닉네임은 2~12자, 영어, 숫자, 한글만 사용 가능

> codex & claude code 사용 + Gemini는 구경만

## 로컬에서 켜는 법

최초 1회만 `.env`를 `.env.example` 보고 채워둘 것 (DB_*, REDIS_PASSWORD 등).

```bash
# 1. DB/Redis (Docker) — 최초 실행이면 이미지 받느라 좀 걸림
npm run db:up

# 2. shared 워크스페이스 빌드 (다른 서버들이 이걸 import함, 코드 바꿨으면 다시 빌드)
npm run shared:build

# 3. 매칭 서버 (Nest, :3000) — 로그인/방/전적/신고 등 REST API
npm run match:dev

# 4. 게이트웨이 + 감독자 + 인게임 서버(자동 기동) — :4100
npm run cluster:start
#   (인게임 서버 한 대만 고정 포트로 띄우고 싶으면 대신 npm run game:start, :4000)

# 5. 클라이언트 (Vite, :5173) — vite.config.ts 프록시가 :4100/:3000으로 붙음
npm --prefix client run dev
```

3~5는 각자 별도 터미널에서 계속 떠 있어야 함 (watch/서빙 프로세스). 끌 때는 각 터미널에서 Ctrl+C, DB는 `npm run db:down`.

다 뜨면 http://localhost:5173 접속.