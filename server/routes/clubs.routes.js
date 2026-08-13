// /api/clubs — 동아리와 멤버십. service-design.md §5.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  loadClub, requireActiveClub, requireMembership, requirePresident, monthState, MONTH_RE
} from '../lib/permissions.js';
import { MEMBER_PALETTE, pickBrandColor, pickMemberColor } from '../lib/palette.js';
import { announceMemberLeft, announcePresidentTransferred } from '../lib/chat-events.js';

export const clubsRoutes = Router();
clubsRoutes.use(requireAuth);

const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthParam = (req) => {
  const m = String(req.query.month || thisMonth());
  return MONTH_RE.test(m) ? m : null;
};
const clubName = (v) => String(v ?? '').trim();

/** 아바타 스택용 미리보기 (최대 6명, 회장 먼저) */
function membersPreview(clubId) {
  return db.prepare(`SELECT u.display_name, m.member_color FROM memberships m
    JOIN users u ON u.id = m.user_id WHERE m.club_id = ?
    ORDER BY (m.role = 'president') DESC, m.joined_at, m.id LIMIT 6`).all(clubId);
}

/** GET /api/clubs — 내 동아리 목록. 미확인 동아리를 위로 올릴 수 있게 월 확정 상태를 함께 줍니다. */
clubsRoutes.get('/', (req, res) => {
  const month = monthParam(req);
  if (!month) return res.status(400).json({ error: 'month 는 YYYY-MM 형식으로 보내주세요.' });

  const rows = db.prepare(`
    SELECT c.id, c.name, c.brand_color, c.status, m.id AS membership_id, m.role AS my_role,
           (SELECT COUNT(*) FROM memberships mm WHERE mm.club_id = c.id) AS member_count
    FROM memberships m JOIN clubs c ON c.id = m.club_id
    WHERE m.user_id = ? ORDER BY c.name`).all(req.user.id);

  res.json({
    month,
    clubs: rows.map((r) => ({
      id: r.id,
      name: r.name,
      brand_color: r.brand_color,
      status: r.status,
      my_role: r.my_role,
      member_count: r.member_count,
      my_month_state: monthState(r.membership_id, month),
      members_preview: membersPreview(r.id)
    }))
  });
});

/** POST /api/clubs — 만든 사람이 회장이 됩니다. */
clubsRoutes.post('/', (req, res) => {
  const name = clubName(req.body?.name);
  if (!name || name.length > 30) {
    return res.status(400).json({ error: '동아리 이름을 1~30자로 입력해 주세요.' });
  }
  const clubId = db.transaction(() => {
    const info = db.prepare('INSERT INTO clubs (name, brand_color) VALUES (?, ?)')
      .run(name, pickBrandColor());
    const id = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO memberships (user_id, club_id, role, member_color) VALUES (?, ?, 'president', ?)")
      .run(req.user.id, id, pickMemberColor(id));
    return id;
  })();
  res.status(201).json({ id: clubId, name, my_role: 'president' });
});

/** GET /api/clubs/:id */
clubsRoutes.get('/:id', loadClub, (req, res) => {
  const president = db.prepare(`SELECT u.id AS user_id, u.display_name FROM memberships m
    JOIN users u ON u.id = m.user_id WHERE m.club_id = ? AND m.role = 'president'`).get(req.club.id);
  res.json({
    ...req.club,
    member_count: db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE club_id = ?').get(req.club.id).c,
    my_role: req.membership?.role ?? null,
    president: president || null
  });
});

/** PATCH /api/clubs/:id — 회장 또는 서비스 관리자 */
clubsRoutes.patch('/:id', loadClub, requireActiveClub, requirePresident, (req, res) => {
  const patch = {};
  if (req.body?.name !== undefined) {
    const name = clubName(req.body.name);
    if (!name || name.length > 30) return res.status(400).json({ error: '동아리 이름을 1~30자로 입력해 주세요.' });
    patch.name = name;
  }
  if (req.body?.brand_color !== undefined) {
    const color = String(req.body.brand_color);
    if (!MEMBER_PALETTE.includes(color)) {
      return res.status(400).json({ error: '팔레트에 있는 색만 쓸 수 있습니다.' });
    }
    patch.brand_color = color;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: '바꿀 내용이 없습니다.' });

  if (patch.name) db.prepare('UPDATE clubs SET name = ? WHERE id = ?').run(patch.name, req.club.id);
  if (patch.brand_color) db.prepare('UPDATE clubs SET brand_color = ? WHERE id = ?').run(patch.brand_color, req.club.id);
  res.json({ ok: true, ...patch });
});

/** DELETE /api/clubs/:id — 회장은 이름을 다시 입력해야 하고, 회장이 아닌 서비스 관리자는 바로 삭제합니다. */
clubsRoutes.delete('/:id', loadClub, requirePresident, (req, res) => {
  const iAmPresident = req.membership?.role === 'president';
  if (iAmPresident && clubName(req.body?.name) !== req.club.name) {
    return res.status(400).json({
      error: `지우려면 동아리 이름 "${req.club.name}" 을 그대로 입력해 주세요.`,
      code: 'NAME_CONFIRMATION_REQUIRED'
    });
  }
  db.prepare('DELETE FROM clubs WHERE id = ?').run(req.club.id);
  res.json({ ok: true, deleted: req.club.name });
});

/** GET /api/clubs/:id/members — 이번 달 확인 여부까지 */
clubsRoutes.get('/:id/members', loadClub, (req, res) => {
  const month = monthParam(req);
  if (!month) return res.status(400).json({ error: 'month 는 YYYY-MM 형식으로 보내주세요.' });
  const members = db.prepare(`
    SELECT m.id AS membership_id, m.user_id, u.display_name, m.member_color, m.role, m.joined_at,
           COALESCE(mc.confirmed, 0) AS confirmed, mc.confirmed_at
    FROM memberships m JOIN users u ON u.id = m.user_id
    LEFT JOIN month_confirmations mc ON mc.membership_id = m.id AND mc.month = ?
    WHERE m.club_id = ? ORDER BY (m.role = 'president') DESC, m.joined_at, m.id`).all(month, req.club.id);
  res.json({
    month,
    members: members.map((m) => ({
      ...m,
      confirmed: !!m.confirmed,
      month_state: monthState(m.membership_id, month)
    }))
  });
});

/** PATCH /api/clubs/:id/members/:uid — 멤버 색. 회장·서비스 관리자 또는 본인. */
clubsRoutes.patch('/:id/members/:uid', loadClub, requireActiveClub, (req, res) => {
  const uid = Number(req.params.uid);
  const isSelf = uid === req.user.id;
  const canManage = req.user.is_service_admin || req.membership?.role === 'president';
  if (!isSelf && !canManage) {
    return res.status(403).json({ error: '동아리 회장만 다른 회원의 색을 바꿀 수 있습니다.', code: 'NEED_PRESIDENT' });
  }
  const color = String(req.body?.member_color ?? '');
  if (!MEMBER_PALETTE.includes(color)) {
    return res.status(400).json({ error: '팔레트에 있는 색만 쓸 수 있습니다.' });
  }
  const info = db.prepare('UPDATE memberships SET member_color = ? WHERE club_id = ? AND user_id = ?')
    .run(color, req.club.id, uid);
  if (!info.changes) return res.status(404).json({ error: '그 회원이 이 동아리에 없습니다.' });
  res.json({ ok: true, user_id: uid, member_color: color });
});

/** DELETE /api/clubs/:id/members/:uid — 내보내기. 일정·확정 기록도 함께 지워집니다. */
clubsRoutes.delete('/:id/members/:uid', loadClub, requireActiveClub, requirePresident, (req, res) => {
  const uid = Number(req.params.uid);
  const target = db.prepare(`SELECT m.id, m.role, u.display_name FROM memberships m
    JOIN users u ON u.id = m.user_id WHERE m.club_id = ? AND m.user_id = ?`).get(req.club.id, uid);
  if (!target) return res.status(404).json({ error: '그 회원이 이 동아리에 없습니다.' });
  if (target.role === 'president') {
    return res.status(409).json({
      error: '회장은 내보낼 수 없습니다. 먼저 회장직을 다른 회원에게 넘겨 주세요.',
      code: 'CANNOT_REMOVE_PRESIDENT'
    });
  }
  db.prepare('DELETE FROM memberships WHERE id = ?').run(target.id);
  // 이름은 지우기 전에 읽어 뒀습니다. 내보내진 것과 스스로 나간 것에 같은 문구를 씁니다.
  announceMemberLeft(req.club.id, target.display_name);
  res.json({ ok: true, removed_user_id: uid });
});

/** POST /api/clubs/:id/transfer — 회장직 넘기기. 넘긴 사람은 일반 회원이 됩니다. */
clubsRoutes.post('/:id/transfer', loadClub, requireActiveClub, requirePresident, (req, res) => {
  const toUserId = Number(req.body?.to_user_id);
  const target = db.prepare(`SELECT m.id, m.role, u.display_name FROM memberships m
    JOIN users u ON u.id = m.user_id WHERE m.club_id = ? AND m.user_id = ?`).get(req.club.id, toUserId);
  if (!target) return res.status(404).json({ error: '그 회원이 이 동아리에 없습니다. 먼저 초대해 주세요.' });
  if (target.role === 'president') {
    return res.status(409).json({ error: '이미 그 회원이 회장입니다.' });
  }
  // 서비스 관리자가 강제로 넘길 수도 있어서 "누가 넘겼는지" 는 현재 회장을 읽어 씁니다.
  const from = db.prepare(`SELECT m.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.club_id = ? AND m.role = 'president'`).get(req.club.id);
  // 회장은 동아리당 1명이라 (부분 유니크 인덱스) 내리고 올리는 순서를 지켜야 합니다.
  db.transaction(() => {
    db.prepare("UPDATE memberships SET role = 'member' WHERE club_id = ? AND role = 'president'").run(req.club.id);
    db.prepare("UPDATE memberships SET role = 'president' WHERE id = ?").run(target.id);
  })();
  if (from) announcePresidentTransferred(req.club.id, from.display_name, target.display_name, from.id);
  res.json({ ok: true, president_user_id: toUserId });
});

/** DELETE /api/clubs/:id/leave — 탈퇴. 회장은 넘긴 뒤에만 나갈 수 있습니다. */
clubsRoutes.delete('/:id/leave', loadClub, requireMembership, (req, res) => {
  if (req.membership.role === 'president') {
    return res.status(409).json({
      error: '회장은 바로 나갈 수 없습니다. 회장직을 넘기거나 동아리를 삭제해 주세요.',
      code: 'PRESIDENT_MUST_TRANSFER'
    });
  }
  db.prepare('DELETE FROM memberships WHERE id = ?').run(req.membership.id);
  announceMemberLeft(req.club.id, req.user.display_name);
  res.json({ ok: true, left_club_id: req.club.id });
});
