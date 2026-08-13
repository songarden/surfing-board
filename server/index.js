import './env.js';                       // 반드시 첫 줄 — 아래 모듈들이 환경변수를 읽습니다.
import { createApp } from './app.js';
import { db, migrate } from './db.js';
import { hashPassword } from './auth.js';
import { attachChat } from './ws.js';

migrate();

// 계정이 하나도 없으면 첫 서비스 관리자를 만듭니다.
if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const pw = process.env.ADMIN_INITIAL_PASSWORD || 'surfboard-first-login';
  db.prepare(`INSERT INTO users (username, display_name, password_hash, is_service_admin)
    VALUES (?, ?, ?, 1)`)
    .run(username, process.env.ADMIN_DISPLAY_NAME || '관리자', hashPassword(pw));
  console.log(`[setup] 서비스 관리자 계정을 만들었습니다 — 아이디 ${username} / 비밀번호 ${pw}`);
  console.log('[setup] 로그인한 뒤 계정 설정에서 비밀번호를 바꿔 주세요.');
}

const port = Number(process.env.PORT || 8888);
const server = createApp().listen(port, () => console.log(`[surfboard] http://localhost:${port} 에서 듣고 있습니다.`));
// 채팅 실시간. 같은 포트의 /ws 로 업그레이드합니다 (별도 포트를 열지 않습니다).
attachChat(server);
