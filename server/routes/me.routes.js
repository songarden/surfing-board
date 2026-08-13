// /api/me — 계정 설정.
import { Router } from 'express';
import { db } from '../db.js';
import { clearSession, requireAuth } from '../auth.js';

export const meRoutes = Router();
meRoutes.use(requireAuth);

/** PATCH /api/me — 표시 이름. 아이디는 바꿀 수 없습니다. */
meRoutes.patch('/', (req, res) => {
  const displayName = String(req.body?.display_name ?? '').trim();
  if (!displayName || displayName.length > 20) {
    return res.status(400).json({ error: '표시 이름을 1~20자로 입력해 주세요.' });
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
  res.json({ ok: true, display_name: displayName });
});

/** DELETE /api/me — 탈퇴. 회장인 동아리가 남아 있으면 막습니다. */
meRoutes.delete('/', (req, res) => {
  const owned = db.prepare(`SELECT c.id, c.name FROM memberships m JOIN clubs c ON c.id = m.club_id
    WHERE m.user_id = ? AND m.role = 'president'`).all(req.user.id);
  if (owned.length) {
    return res.status(409).json({
      error: `회장으로 있는 동아리가 ${owned.length}개 있습니다. 회장직을 넘기거나 동아리를 삭제한 뒤에 탈퇴할 수 있습니다.`,
      code: 'PRESIDENT_MUST_TRANSFER',
      clubs: owned
    });
  }
  // 마지막 서비스 관리자가 사라지면 콘솔에 아무도 못 들어갑니다.
  if (req.user.is_service_admin) {
    const others = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_service_admin = 1 AND id != ?')
      .get(req.user.id).c;
    if (!others) {
      return res.status(409).json({
        error: '서비스 관리자가 한 명뿐이라 탈퇴할 수 없습니다. 다른 계정에 관리자 권한을 먼저 주세요.',
        code: 'LAST_SERVICE_ADMIN'
      });
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);   // 멤버십·일정·확정은 CASCADE
  clearSession(res);
  res.json({ ok: true });
});
