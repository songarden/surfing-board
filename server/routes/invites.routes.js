// 초대. 동아리 참여는 초대 링크로만 됩니다. service-design.md §5.
import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { loadClub, requireActiveClub, requirePresident } from '../lib/permissions.js';
import { getPolicies } from '../lib/policies.js';
import { pickMemberColor } from '../lib/palette.js';
import { inviteUrl } from '../lib/baseurl.js';
import { announceMemberJoined } from '../lib/chat-events.js';

export const inviteRoutes = Router();
inviteRoutes.use(requireAuth);

const newToken = () => crypto.randomBytes(16).toString('hex');

/** 만료·회수·횟수를 확인해 쓸 수 있는 초대만 돌려줍니다. */
function usableInvite(token) {
  const invite = db.prepare(`SELECT i.*, c.name AS club_name, c.status AS club_status
    FROM invites i JOIN clubs c ON c.id = i.club_id WHERE i.token = ?`).get(token);
  if (!invite) return { error: '없는 초대 링크입니다. 회장에게 새 링크를 받아 주세요.', code: 'INVITE_NOT_FOUND', status: 404 };
  if (invite.revoked) return { error: '회수된 초대 링크입니다.', code: 'INVITE_REVOKED', status: 410 };
  if (invite.expires_at && invite.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)) {
    return { error: '기한이 지난 초대 링크입니다.', code: 'INVITE_EXPIRED', status: 410 };
  }
  if (invite.max_uses !== null && invite.used_count >= invite.max_uses) {
    return { error: '사용 횟수를 다 쓴 초대 링크입니다.', code: 'INVITE_EXHAUSTED', status: 410 };
  }
  if (invite.club_status === 'suspended') {
    return { error: '정지된 동아리입니다. 서비스 관리자에게 문의해 주세요.', code: 'CLUB_SUSPENDED', status: 403 };
  }
  return { invite };
}

/** POST /api/clubs/:id/invites — { expires_in_days?, max_uses? }. 0 이나 null 은 무제한. */
inviteRoutes.post('/clubs/:id/invites', loadClub, requireActiveClub, requirePresident, (req, res) => {
  const policies = getPolicies();
  const rawDays = req.body?.expires_in_days;
  const days = rawDays === undefined ? policies.invite_default_days : Number(rawDays);
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    return res.status(400).json({ error: '유효기간은 0(무제한)에서 3650일 사이의 일수로 보내주세요.' });
  }
  const rawUses = req.body?.max_uses;
  const maxUses = rawUses === undefined || rawUses === null ? null : Number(rawUses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) {
    return res.status(400).json({ error: '사용 횟수는 1~1000 사이여야 합니다. 무제한이면 비워 두세요.' });
  }

  const token = newToken();
  const expiresAt = days > 0
    ? new Date(Date.now() + days * 864e5).toISOString().replace('T', ' ').slice(0, 19)
    : null;
  const info = db.prepare(`INSERT INTO invites (club_id, token, created_by, expires_at, max_uses)
    VALUES (?, ?, ?, ?, ?)`).run(req.club.id, token, req.user.id, expiresAt, maxUses);

  res.status(201).json({
    id: Number(info.lastInsertRowid),
    token,
    path: `/invite.html?token=${token}`,
    url: inviteUrl(req, token),          // 그대로 전달할 수 있는 절대 주소
    expires_at: expiresAt,
    max_uses: maxUses,
    used_count: 0
  });
});

/** GET /api/clubs/:id/invites — 살아 있는 초대 목록 */
inviteRoutes.get('/clubs/:id/invites', loadClub, requirePresident, (req, res) => {
  const rows = db.prepare(`SELECT id, token, expires_at, max_uses, used_count, revoked, created_at
    FROM invites WHERE club_id = ? ORDER BY created_at DESC`).all(req.club.id);
  res.json({
    invites: rows.map((r) => ({
      ...r,
      revoked: !!r.revoked,
      path: `/invite.html?token=${r.token}`,
      url: inviteUrl(req, r.token),
      usable: !usableInvite(r.token).error
    }))
  });
});

/** DELETE /api/invites/:token — 회수. 그 동아리 회장 또는 서비스 관리자만. */
inviteRoutes.delete('/invites/:token', (req, res) => {
  const invite = db.prepare('SELECT id, club_id FROM invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: '없는 초대 링크입니다.', code: 'INVITE_NOT_FOUND' });

  const membership = db.prepare('SELECT role FROM memberships WHERE club_id = ? AND user_id = ?')
    .get(invite.club_id, req.user.id);
  if (!req.user.is_service_admin && membership?.role !== 'president') {
    return res.status(403).json({ error: '동아리 회장만 초대를 회수할 수 있습니다.', code: 'NEED_PRESIDENT' });
  }
  db.prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(invite.id);
  res.json({ ok: true, revoked: true });
});

/** GET /api/invites/:token — 수락 화면에 보여줄 미리보기 */
inviteRoutes.get('/invites/:token', (req, res) => {
  const { invite, error, code, status } = usableInvite(req.params.token);
  if (error) return res.status(status).json({ error, code });

  const president = db.prepare(`SELECT u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.club_id = ? AND m.role = 'president'`).get(invite.club_id);
  const already = db.prepare('SELECT 1 FROM memberships WHERE club_id = ? AND user_id = ?')
    .get(invite.club_id, req.user.id);

  res.json({
    club: {
      id: invite.club_id,
      name: invite.club_name,
      member_count: db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE club_id = ?').get(invite.club_id).c,
      president_name: president?.display_name ?? null
    },
    members_preview: db.prepare(`SELECT u.display_name, m.member_color FROM memberships m
      JOIN users u ON u.id = m.user_id WHERE m.club_id = ?
      ORDER BY (m.role = 'president') DESC, m.joined_at LIMIT 6`).all(invite.club_id),
    already_member: !!already,
    expires_at: invite.expires_at
  });
});

/** POST /api/invites/:token/accept — 참여. 색은 동아리 팔레트에서 자동 배정합니다. */
inviteRoutes.post('/invites/:token/accept', (req, res) => {
  const { invite, error, code, status } = usableInvite(req.params.token);
  if (error) return res.status(status).json({ error, code });

  if (db.prepare('SELECT 1 FROM memberships WHERE club_id = ? AND user_id = ?').get(invite.club_id, req.user.id)) {
    return res.status(409).json({
      error: '이미 이 동아리 회원입니다.', code: 'ALREADY_MEMBER', club_id: invite.club_id
    });
  }
  const max = getPolicies().club_max_members;
  const count = db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE club_id = ?').get(invite.club_id).c;
  if (max > 0 && count >= max) {
    return res.status(409).json({
      error: `이 동아리는 최대 인원 ${max}명이 다 찼습니다. 회장에게 문의해 주세요.`,
      code: 'CLUB_FULL'
    });
  }

  const membershipId = db.transaction(() => {
    const info = db.prepare("INSERT INTO memberships (user_id, club_id, role, member_color) VALUES (?, ?, 'member', ?)")
      .run(req.user.id, invite.club_id, pickMemberColor(invite.club_id));
    db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE id = ?').run(invite.id);
    return Number(info.lastInsertRowid);
  })();

  announceMemberJoined(invite.club_id, req.user.display_name, membershipId);
  res.status(201).json({ ok: true, club_id: invite.club_id, club_name: invite.club_name, role: 'member' });
});
