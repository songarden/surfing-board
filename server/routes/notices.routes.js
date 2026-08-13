// 회원이 읽는 서비스 공지. 발행은 /api/admin/notices 입니다.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

export const noticeRoutes = Router();

/** GET /api/notices — 최근 공지 10건 */
noticeRoutes.get('/notices', requireAuth, (req, res) => {
  res.json({
    notices: db.prepare(`SELECT id, title, body, published_at FROM service_notices
      ORDER BY published_at DESC LIMIT 10`).all()
  });
});
