// 동아리 채팅 REST. service-design.md §5 (동아리 채팅) · §8.
//
// 권한 요약 (§3 Capability Matrix 의 "동아리 채팅" 블록):
//   읽기 · 전송 · @멘션 · 본인 글 수정/삭제  → **그 동아리 회원만.** 소속 없는 서비스 관리자도 막힙니다.
//   타인 글 삭제                              → 회장 또는 서비스 관리자(강제)
//   타인 글 수정                              → **누구도 불가.** 남의 말은 고칠 수 없습니다.
//
// WebSocket 이 붙어 있어도 여기가 정본입니다. 실시간은 전송 최적화일 뿐이라
// 모든 변경은 REST 로 DB 에 쓴 뒤 publish 합니다 (§8.5).
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { loadClub, requireActiveClub, requireMembership } from '../lib/permissions.js';
import {
  BODY_MAX, PAGE_DEFAULT, PAGE_MAX,
  listMessages, insertUserMessage, editMessage, deleteMessage,
  getMessage, getMessageRow, markRead, lastReadId, unreadCount, unreadByClub, readMarks
} from '../lib/chat.js';
import { publish } from '../lib/realtime.js';

export const chatRoutes = Router();
chatRoutes.use(requireAuth);

/** 양수 정수 커서만 받습니다. 없거나 형식이 틀리면 null (= 커서 없음). */
const cursor = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** 본문 정리. 앞뒤 공백만 자르고 안쪽 줄바꿈은 그대로 둡니다. */
function readBody(raw) {
  const body = String(raw ?? '').trim();
  if (!body) return { error: '보낼 내용을 입력해 주세요.' };
  if (body.length > BODY_MAX) return { error: `메시지는 ${BODY_MAX}자까지 보낼 수 있습니다.` };
  return { body };
}

/**
 * `/api/messages/:mid` 용. `loadClub` 과 같은 규칙으로 동아리·멤버십을 실어 줍니다.
 * 회원도 아니고 서비스 관리자도 아니면 **404** — 메시지가 있는지조차 알려주지 않습니다.
 */
function loadMessage(req, res, next) {
  const id = cursor(req.params.mid);
  const message = id ? getMessageRow(id) : null;
  const club = message
    ? db.prepare('SELECT id, name, brand_color, status, created_at FROM clubs WHERE id = ?').get(message.club_id)
    : null;
  const membership = club
    ? db.prepare('SELECT id, user_id, club_id, role, member_color, joined_at FROM memberships WHERE club_id = ? AND user_id = ?')
      .get(club.id, req.user.id)
    : null;

  if (!message || !club || (!membership && !req.user.is_service_admin)) {
    return res.status(404).json({ error: '없는 메시지입니다.', code: 'NOT_FOUND' });
  }
  req.message = message;
  req.club = club;
  req.membership = membership || null;
  next();
}

/** 그 메시지를 쓴 사람인가. 멤버십이 사라졌으면(탈퇴·내보내기) 더 이상 본인이 아닙니다. */
const isAuthor = (req) => req.message.membership_id !== null && req.message.membership_id === req.membership?.id;

// ---------------------------------------------------------------- 목록

/**
 * GET /api/clubs/:id/messages?before=&after=&limit=
 *   before  그보다 과거로 limit개 — 위로 스크롤해 더 읽기
 *   after   그 뒤로 생긴 limit개  — WebSocket 이 끊겼다 돌아왔을 때 누락분 보충 (§8.5)
 *   없으면  최신 limit개
 * 항상 **오래된 것 → 최신** 순입니다. 커서는 created_at 이 아니라 id 입니다(초 단위라 동률이 납니다).
 */
chatRoutes.get('/clubs/:id/messages', loadClub, requireMembership, (req, res) => {
  const before = cursor(req.query.before);
  const after = cursor(req.query.after);
  const limit = req.query.limit === undefined ? PAGE_DEFAULT : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
    return res.status(400).json({ error: `limit 은 1~${PAGE_MAX} 사이 정수여야 합니다.` });
  }
  const page = listMessages({ clubId: req.club.id, before, after, limit });
  res.json({
    club_id: req.club.id,
    my_membership_id: req.membership.id,
    my_last_read_id: lastReadId(req.membership.id),
    unread_count: unreadCount(req.club.id, req.membership.id),
    member_count: db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE club_id = ?').get(req.club.id).c,
    // "안 읽음 N" 을 그리려면 회원별 읽음 지점이 필요합니다 (§8.3).
    read_marks: readMarks(req.club.id),
    ...page
  });
});

// ---------------------------------------------------------------- 전송

/** POST /api/clubs/:id/messages — { body }. @멘션은 서버가 파싱해 chat_mentions 에 남깁니다. */
chatRoutes.post('/clubs/:id/messages', loadClub, requireActiveClub, requireMembership, (req, res) => {
  const { body, error } = readBody(req.body?.body);
  if (error) return res.status(400).json({ error });

  const message = insertUserMessage({
    clubId: req.club.id,
    membershipId: req.membership.id,
    userId: req.user.id,
    body
  });
  publish(req.club.id, 'message', message);
  res.status(201).json(message);
});

// ---------------------------------------------------------------- 수정

/** PATCH /api/messages/:mid — { body }. **본인 것만.** 회장도 서비스 관리자도 남의 말은 못 고칩니다. */
chatRoutes.patch('/messages/:mid', loadMessage, requireActiveClub, (req, res) => {
  if (req.message.kind === 'system') {
    return res.status(403).json({ error: '시스템 메시지는 고칠 수 없습니다.', code: 'SYSTEM_MESSAGE_IMMUTABLE' });
  }
  if (req.message.deleted_at) {
    return res.status(410).json({ error: '이미 삭제된 메시지입니다.', code: 'MESSAGE_DELETED' });
  }
  if (!isAuthor(req)) {
    return res.status(403).json({
      error: '본인이 쓴 메시지만 고칠 수 있습니다.',
      code: 'NOT_MESSAGE_AUTHOR'
    });
  }
  const { body, error } = readBody(req.body?.body);
  if (error) return res.status(400).json({ error });

  const message = editMessage(req.message.id, body);
  publish(req.club.id, 'edit', message);
  res.json(message);
});

// ---------------------------------------------------------------- 삭제 (soft)

/**
 * DELETE /api/messages/:mid — 본인 또는 회장/서비스 관리자.
 * soft delete 라 행은 남고 `deleted_by` 에 지운 사람이 기록됩니다. **응답에 본문은 실리지 않습니다** (§8.4).
 * 이미 지워진 메시지는 그대로 200 을 돌려줍니다 — 두 번 눌렀다고 오류를 볼 이유가 없습니다.
 */
chatRoutes.delete('/messages/:mid', loadMessage, requireActiveClub, (req, res) => {
  if (req.message.kind === 'system') {
    return res.status(403).json({ error: '시스템 메시지는 지울 수 없습니다.', code: 'SYSTEM_MESSAGE_IMMUTABLE' });
  }
  // 서비스 관리자는 소속이 없어도 강제 삭제할 수 있습니다 (§3 Matrix "타인 메시지 삭제: ✅(강제)").
  // 읽기·전송과 달리 여기만 멤버십 없이 통과하는 이유는, 신고된 글을 지울 수 있어야 하기 때문입니다.
  const allowed = isAuthor(req) || req.membership?.role === 'president' || req.user.is_service_admin;
  if (!allowed) {
    return res.status(403).json({
      error: '본인이 쓴 메시지만 지울 수 있습니다. 다른 사람의 메시지는 동아리 회장이 지울 수 있습니다.',
      code: 'NEED_PRESIDENT'
    });
  }
  if (req.message.deleted_at) return res.json(getMessage(req.message.id));

  const message = deleteMessage(req.message.id, req.user.id);
  publish(req.club.id, 'delete', message);
  res.json(message);
});

// ---------------------------------------------------------------- 읽음

/**
 * POST /api/clubs/:id/messages/read — { last_read_message_id }
 * 읽음 지점은 **앞으로만** 갑니다. 없는 id·남의 방 id 는 내 방의 실재하는 메시지로 잘립니다.
 */
chatRoutes.post('/clubs/:id/messages/read', loadClub, requireMembership, (req, res) => {
  const target = cursor(req.body?.last_read_message_id);
  if (!target) {
    return res.status(400).json({ error: 'last_read_message_id 는 양수여야 합니다.' });
  }
  const last = markRead(req.membership.id, target);
  publish(req.club.id, 'read', { membership_id: req.membership.id, last_read_message_id: last });
  res.json({
    ok: true,
    club_id: req.club.id,
    membership_id: req.membership.id,
    last_read_message_id: last,
    unread_count: unreadCount(req.club.id, req.membership.id)
  });
});

// ---------------------------------------------------------------- 배지

/**
 * GET /api/clubs/unread — 내 동아리별 안 읽은 개수. 동아리 목록 카드 배지용 (§8.3).
 * ⚠️ 이 경로는 `/api/clubs/:id` 보다 **먼저** 등록되어야 합니다 (app.js 의 mount 순서 주석 참고).
 */
chatRoutes.get('/clubs/unread', (req, res) => {
  const rows = unreadByClub(req.user.id);
  res.json({
    clubs: rows.map((r) => ({
      club_id: r.club_id,
      unread_count: r.unread_count,
      latest_message_id: r.latest_id ?? null
    })),
    total: rows.reduce((sum, r) => sum + r.unread_count, 0)
  });
});
