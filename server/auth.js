import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from './db.js';

const COOKIE = 'sb_session';
const SECRET = process.env.SESSION_SECRET;
const DAYS = Number(process.env.SESSION_DAYS || 30);

if (!SECRET || SECRET === 'change-me-please') {
  console.error('[auth] SESSION_SECRET 을 .env 에 새로 넣어야 서버가 뜹니다.');
  process.exit(1);
}

export const hashPassword = (pw) => bcrypt.hashSync(pw, 12);
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export function issueSession(res, user) {
  // 토큰에는 사용자 식별자만 담습니다. 권한은 요청마다 DB 에서 조회합니다
  // (토큰에 역할을 넣으면 회장직 이전·권한 회수가 즉시 반영되지 않습니다).
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: `${DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: DAYS * 864e5,
    path: '/'
  });
}
export const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

export function currentUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    const { uid } = jwt.verify(token, SECRET);
    const user = db.prepare(
      'SELECT id, username, display_name, is_service_admin, status FROM users WHERE id = ?'
    ).get(uid);
    return user && user.status === 'active' ? user : null;
  } catch { return null; }
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = user;
  next();
}

/** 플랫폼 전역 권한. 동아리 소속과 무관합니다. */
export function requireServiceAdmin(req, res, next) {
  if (!req.user?.is_service_admin) {
    return res.status(403).json({ error: '서비스 관리자만 할 수 있습니다.', code: 'NEED_SERVICE_ADMIN' });
  }
  next();
}

// 로그인 시도 제한: 같은 아이디로 5분에 10번까지.
const attempts = new Map();
export function throttleLogin(username) {
  const now = Date.now();
  const rec = attempts.get(username) || { n: 0, until: 0 };
  if (rec.until > now) return false;
  rec.n = now - (rec.at || 0) > 3e5 ? 1 : rec.n + 1;
  rec.at = now;
  if (rec.n > 10) { rec.until = now + 3e5; rec.n = 0; }
  attempts.set(username, rec);
  return true;
}
export const clearThrottle = (username) => attempts.delete(username);
