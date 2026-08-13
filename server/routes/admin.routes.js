// /api/admin — 서비스 관리자 콘솔. 전부 is_service_admin 이 있어야 합니다.
import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { hashPassword, requireAuth, requireServiceAdmin } from '../auth.js';
import { getPolicies } from '../lib/policies.js';

export const adminRoutes = Router();
adminRoutes.use(requireAuth, requireServiceAdmin);

const thisMonth = () => new Date().toISOString().slice(0, 7);
const tempPassword = () => 'sb-' + crypto.randomBytes(6).toString('hex');

/** GET /api/admin/stats — 콘솔 상단 카드 4개 */
adminRoutes.get('/stats', (req, res) => {
  const month = thisMonth();
  res.json({
    month,
    club_count: db.prepare('SELECT COUNT(*) AS c FROM clubs').get().c,
    user_count: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    // 이번 달에 일정을 표시했거나 확정한 사람이 있는 동아리
    active_club_count: db.prepare(`SELECT COUNT(DISTINCT club_id) AS c FROM memberships m WHERE EXISTS (
        SELECT 1 FROM availability a WHERE a.membership_id = m.id AND a.date LIKE ?
      ) OR EXISTS (
        SELECT 1 FROM month_confirmations mc WHERE mc.membership_id = m.id AND mc.month = ? AND mc.confirmed = 1
      )`).get(`${month}-%`, month).c,
    open_report_count: db.prepare("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'").get().c
  });
});

/** GET /api/admin/clubs — 전체 동아리 */
adminRoutes.get('/clubs', (req, res) => {
  res.json({
    clubs: db.prepare(`SELECT c.id, c.name, c.brand_color, c.status, c.created_at,
        (SELECT COUNT(*) FROM memberships m WHERE m.club_id = c.id) AS member_count,
        (SELECT u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.club_id = c.id AND m.role = 'president') AS president_name
      FROM clubs c ORDER BY c.created_at DESC`).all()
  });
});

/** POST /api/admin/clubs/:id/suspend — { suspend: true|false } */
adminRoutes.post('/clubs/:id/suspend', (req, res) => {
  const suspend = req.body?.suspend !== false;
  const info = db.prepare('UPDATE clubs SET status = ? WHERE id = ?')
    .run(suspend ? 'suspended' : 'active', Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: '없는 동아리입니다.' });
  res.json({ ok: true, status: suspend ? 'suspended' : 'active' });
});

/** DELETE /api/admin/clubs/:id — 일정·메모·초대까지 함께 사라집니다. */
adminRoutes.delete('/clubs/:id', (req, res) => {
  const info = db.prepare('DELETE FROM clubs WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: '없는 동아리입니다.' });
  res.json({ ok: true });
});

/** GET /api/admin/users — 전체 회원 */
adminRoutes.get('/users', (req, res) => {
  res.json({
    users: db.prepare(`SELECT u.id, u.username, u.display_name, u.is_service_admin, u.status,
        u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS club_count
      FROM users u ORDER BY u.created_at DESC`).all()
      .map((u) => ({ ...u, is_service_admin: !!u.is_service_admin }))
  });
});

/** POST /api/admin/users/:id/suspend — { suspend: true|false } */
adminRoutes.post('/users/:id/suspend', (req, res) => {
  const id = Number(req.params.id);
  const suspend = req.body?.suspend !== false;
  if (suspend && id === req.user.id) {
    return res.status(409).json({ error: '자기 계정은 정지할 수 없습니다.', code: 'CANNOT_SUSPEND_SELF' });
  }
  const info = db.prepare('UPDATE users SET status = ? WHERE id = ?')
    .run(suspend ? 'suspended' : 'active', id);
  if (!info.changes) return res.status(404).json({ error: '없는 사용자입니다.' });
  res.json({ ok: true, status: suspend ? 'suspended' : 'active' });
});

/** POST /api/admin/users/:id/reset-password — 새 비밀번호를 한 번만 보여줍니다. */
adminRoutes.post('/users/:id/reset-password', (req, res) => {
  const pw = tempPassword();
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(pw), Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: '없는 사용자입니다.' });
  res.json({ ok: true, temporary_password: pw });
});

/** POST /api/admin/users/:id/grant-admin · revoke-admin */
adminRoutes.post('/users/:id/grant-admin', (req, res) => {
  const info = db.prepare('UPDATE users SET is_service_admin = 1 WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: '없는 사용자입니다.' });
  res.json({ ok: true, is_service_admin: true });
});

adminRoutes.post('/users/:id/revoke-admin', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT is_service_admin FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '없는 사용자입니다.' });
  const others = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_service_admin = 1 AND id != ?').get(id).c;
  if (user.is_service_admin && !others) {
    return res.status(409).json({
      error: '서비스 관리자가 한 명뿐이라 권한을 회수할 수 없습니다. 다른 계정에 먼저 권한을 주세요.',
      code: 'LAST_SERVICE_ADMIN'
    });
  }
  db.prepare('UPDATE users SET is_service_admin = 0 WHERE id = ?').run(id);
  res.json({ ok: true, is_service_admin: false });
});

/** GET·PATCH /api/admin/policies — 0 은 무제한입니다. */
adminRoutes.get('/policies', (req, res) => res.json(getPolicies()));

adminRoutes.patch('/policies', (req, res) => {
  const patch = {};
  if (req.body?.signup_enabled !== undefined) patch.signup_enabled = req.body.signup_enabled ? 1 : 0;
  if (req.body?.invite_default_days !== undefined) {
    const days = Number(req.body.invite_default_days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      return res.status(400).json({ error: '초대 기본 유효기간은 0(무제한)~3650일 사이의 일수입니다.' });
    }
    patch.invite_default_days = days;
  }
  if (req.body?.club_max_members !== undefined) {
    const max = Number(req.body.club_max_members);
    if (!Number.isInteger(max) || max < 0 || max > 10000) {
      return res.status(400).json({ error: '동아리 최대 인원은 0(무제한)~10000 사이입니다.' });
    }
    patch.club_max_members = max;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: '바꿀 내용이 없습니다.' });

  for (const [key, value] of Object.entries(patch)) {
    db.prepare(`UPDATE service_policies SET ${key} = ?, updated_at = datetime('now') WHERE id = 1`).run(value);
  }
  res.json(getPolicies());
});

/** POST·GET·DELETE /api/admin/notices — 서비스 공지 */
adminRoutes.post('/notices', (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  if (!title || title.length > 100) return res.status(400).json({ error: '공지 제목을 1~100자로 입력해 주세요.' });
  if (!body || body.length > 2000) return res.status(400).json({ error: '공지 내용을 1~2000자로 입력해 주세요.' });
  const info = db.prepare('INSERT INTO service_notices (title, body, created_by) VALUES (?, ?, ?)')
    .run(title, body, req.user.id);
  res.status(201).json({ id: Number(info.lastInsertRowid), title, body });
});

adminRoutes.get('/notices', (req, res) => {
  res.json({
    notices: db.prepare(`SELECT n.id, n.title, n.body, n.published_at, u.display_name AS created_by_name
      FROM service_notices n LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.published_at DESC`).all()
  });
});

adminRoutes.delete('/notices/:id', (req, res) => {
  const info = db.prepare('DELETE FROM service_notices WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: '없는 공지입니다.' });
  res.json({ ok: true });
});

/** GET /api/admin/reports · POST /api/admin/reports/:id/resolve — 신고 처리 */
adminRoutes.get('/reports', (req, res) => {
  const status = String(req.query.status ?? '');
  const rows = ['open', 'resolved', 'dismissed'].includes(status)
    ? db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  res.json({ reports: rows });
});

adminRoutes.post('/reports/:id/resolve', (req, res) => {
  const status = String(req.body?.status ?? 'resolved');
  if (!['resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: "status 는 'resolved' 또는 'dismissed' 여야 합니다." });
  }
  const info = db.prepare("UPDATE reports SET status = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(status, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: '없는 신고입니다.' });
  res.json({ ok: true, status });
});
