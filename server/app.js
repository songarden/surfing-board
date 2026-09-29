import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { authRoutes } from './routes/auth.routes.js';
import { clubsRoutes } from './routes/clubs.routes.js';
import { calendarRoutes } from './routes/calendar.routes.js';
import { inviteRoutes } from './routes/invites.routes.js';
import { noticeRoutes } from './routes/notices.routes.js';
import { meRoutes } from './routes/me.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { shareRoutes } from './routes/share.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // 채팅 소켓(/ws)은 같은 호스트라도 스킴이 ws: 라, 'self' 만으로 통과시켜 주지 않는 브라우저가 있습니다.
  // 그래서 요청이 들어온 호스트만 정확히 열어 줍니다. Host 헤더는 클라이언트가 보내는 값이라
  // 호스트에 쓸 수 있는 문자만 통과시킵니다 — 아니면 CSP 자체가 깨집니다.
  const wsSources = (host) => (/^[A-Za-z0-9.\-:[\]]+$/.test(host || '') ? ` ws://${host} wss://${host}` : '');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // 폐쇄망: 외부 도메인을 아예 허용하지 않습니다. 폰트는 public/fonts/ 자체 호스팅.
    // style-src 에 'unsafe-inline' 은 멤버 색처럼 값이 런타임에 정해지는 style 속성 때문에 남깁니다.
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
      "img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
      `script-src 'self'; connect-src 'self'${wsSources(req.headers.host)}; form-action 'self'`);
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true, at: new Date().toISOString() }));
  app.use('/api/auth', authRoutes);
  // ⚠️ 채팅이 clubsRoutes 보다 **먼저** 와야 합니다. `GET /api/clubs/unread` 가 뒤에 있으면
  //    clubsRoutes 의 `/:id` 가 먼저 잡아 id='unread' 로 읽고 404 를 돌려줍니다.
  app.use('/api', chatRoutes);              // /clubs/unread, /clubs/:id/messages, /messages/:mid
  app.use('/api/clubs', clubsRoutes);       // 동아리·멤버십
  app.use('/api/clubs', calendarRoutes);    // 달력·일정·확정·공용 메모
  app.use('/api', inviteRoutes);            // /clubs/:id/invites, /invites/:token
  app.use('/api', noticeRoutes);            // /notices (읽기)
  app.use('/api/me', meRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: '없는 API 입니다.' }));

  // 추천 날짜 공유 페이지. **로그인 없이** 열립니다 — 메신저의 미리보기 크롤러에는 세션 쿠키가
  // 없어서, 인증을 걸면 대화방에 카드가 영영 안 뜹니다. 나가는 값은 집계 숫자뿐입니다
  // (이름·개인 일정 없음). 링크는 (club_id, month) 서명 토큰으로 잠급니다 — server/lib/share.js.
  // 정적 파일과 '*' 폴백보다 **위**에 있어야 /clubs.html 로 리다이렉트되지 않습니다.
  app.use('/share', shareRoutes);

  const pub = path.join(process.cwd(), 'public');
  // 폰트는 안 바뀌니 오래 캐시하고, HTML·CSS·JS 는 매번 검증합니다.
  // (길게 캐시하면 배포 후에도 브라우저가 옛 화면을 계속 씁니다.)
  app.use('/fonts', express.static(path.join(pub, 'fonts'), { maxAge: '30d', immutable: true }));
  app.use(express.static(pub, { extensions: ['html'], maxAge: 0, etag: true }));
  // 화면마다 별도 HTML 이라 SPA 폴백이 없습니다. 없는 경로는 첫 화면으로 보냅니다.
  app.get('*', (req, res) => res.redirect('/clubs.html'));

  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: '서버에서 처리하지 못했습니다.' });
  });
  return app;
}
