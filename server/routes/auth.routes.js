import { Router } from 'express';
import { db } from '../db.js';
import {
  clearSession, clearThrottle, currentUser, hashPassword,
  issueSession, requireAuth, throttleLogin, verifyPassword
} from '../auth.js';
import { getPolicies } from '../lib/policies.js';

export const authRoutes = Router();

const USERNAME_RE = /^[a-z0-9._-]{3,24}$/;

/** POST /api/auth/signup — 누구나 가입. 동아리 참여는 초대 링크로만 됩니다. */
authRoutes.post('/signup', (req, res) => {
  if (!getPolicies().signup_enabled) {
    return res.status(403).json({
      error: '지금은 회원가입을 받지 않습니다. 서비스 관리자에게 문의해 주세요.',
      code: 'SIGNUP_DISABLED'
    });
  }
  const username = String(req.body?.username || '').trim().toLowerCase();
  const displayName = String(req.body?.display_name || '').trim();
  const password = String(req.body?.password || '');

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: '아이디는 영문 소문자·숫자·.·_·- 로 3~24자입니다. 다시 입력해 주세요.' });
  }
  if (!displayName || displayName.length > 20) {
    return res.status(400).json({ error: '달력에 보일 이름을 1~20자로 입력해 주세요.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상으로 해 주세요.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: '이미 쓰는 아이디입니다. 다른 아이디를 골라 주세요.' });
  }

  const info = db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)')
    .run(username, displayName, hashPassword(password));
  const user = { id: Number(info.lastInsertRowid) };
  issueSession(res, user);
  res.status(201).json({ id: user.id, username, display_name: displayName, is_service_admin: false });
});

authRoutes.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해 주세요.' });
  if (!throttleLogin(username)) return res.status(429).json({ error: '시도가 너무 많습니다. 5분 뒤에 다시 해 주세요.' });

  const user = db.prepare("SELECT * FROM users WHERE username = ? AND status = 'active'").get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '아이디나 비밀번호가 맞지 않습니다.' });
  }
  clearThrottle(username);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  issueSession(res, user);
  res.json({ ok: true });
});

authRoutes.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

authRoutes.get('/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  res.json({
    id: user.id, username: user.username, display_name: user.display_name,
    is_service_admin: !!user.is_service_admin
  });
});

authRoutes.post('/password', requireAuth, (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < 8) return res.status(400).json({ error: '새 비밀번호는 8자 이상으로 해 주세요.' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, row.password_hash)) {
    return res.status(401).json({ error: '지금 쓰는 비밀번호가 맞지 않습니다.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});
