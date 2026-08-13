// 동아리 채팅 데이터 계층. service-design.md §4 (ChatMessage/ChatMention/ChatRead) · §8 이 기준입니다.
//
// 여기서는 **권한을 검사하지 않습니다.** 멤버십 검사는 라우트의 가드(permissions.js)와
// WebSocket 업그레이드 핸들러가 합니다. 이 파일은 "이미 자격이 확인된 요청"의 DB 조작만 담당합니다.
//
// 본문은 **원문 그대로 저장**합니다. 이스케이프는 렌더 시점(프런트)에서 합니다 — 저장할 때 이스케이프하면
// 수정 화면에 `&amp;` 가 그대로 보이고, 이중 이스케이프가 쌓입니다.
import { db } from '../db.js';

export const BODY_MAX = 2000;          // 한 메시지 최대 길이(문자)
export const PAGE_MAX = 100;           // 한 번에 가져갈 수 있는 최대 개수
export const PAGE_DEFAULT = 50;

export const SYSTEM_EVENTS = [
  'month_confirmed', 'availability_changed', 'member_joined', 'member_left', 'president_transferred'
];

/** 삭제된 메시지 자리에 내려보내는 문구. 본문은 응답에 절대 싣지 않습니다 (§8.4). */
export const DELETED_PLACEHOLDER = '삭제된 메시지입니다.';

// prepare 는 호출 시점에 합니다 — 모듈 로드 때 하면 마이그레이션보다 먼저 돌아 "no such table" 로 깨집니다.
const SELECT_MESSAGE = `
  SELECT c.id, c.club_id, c.membership_id, c.author_user_id, c.kind, c.body, c.system_event,
         c.edited_at, c.deleted_at, c.deleted_by, c.created_at,
         u.display_name, m.member_color, m.role
    FROM chat_messages c
    LEFT JOIN memberships m ON m.id = c.membership_id
    LEFT JOIN users u       ON u.id = c.author_user_id`;

/**
 * DB 행 → API 응답 한 건.
 * **삭제된 메시지는 body 를 null 로 지웁니다.** 라우트가 실수로 흘리지 않도록 직렬화 지점 한 곳에서 막습니다.
 */
export function serializeMessage(row, mentionsByMessage = null) {
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    club_id: row.club_id,
    kind: row.kind,
    system_event: row.system_event ?? null,
    membership_id: row.membership_id ?? null,
    user_id: row.author_user_id ?? null,
    // 멤버십이 사라진(탈퇴·내보내기) 회원의 메시지도 대화 흐름을 위해 남습니다.
    display_name: row.kind === 'system' ? null : (row.display_name ?? '탈퇴한 회원'),
    member_color: row.member_color ?? null,
    role: row.role ?? null,
    body: deleted ? null : row.body,
    deleted,
    deleted_placeholder: deleted ? DELETED_PLACEHOLDER : null,
    edited: !!row.edited_at && !deleted,
    edited_at: deleted ? null : (row.edited_at ?? null),
    created_at: row.created_at,
    mentions: deleted ? [] : (mentionsByMessage?.get(row.id) ?? [])
  };
}

/** 메시지 묶음의 멘션을 한 번에 읽어 Map<message_id, membership_id[]> 로 만듭니다 (N+1 방지). */
function loadMentions(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db.prepare(
    `SELECT message_id, membership_id FROM chat_mentions WHERE message_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push(r.membership_id);
  }
  return map;
}

/** 동아리 멤버 (membership_id, 표시 이름, 색). 멘션 파싱과 멤버 팝오버가 같은 목록을 씁니다. */
export function clubMembers(clubId) {
  return db.prepare(`
    SELECT m.id AS membership_id, m.user_id, m.member_color, m.role, u.display_name
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.club_id = ?
     ORDER BY (m.role = 'president') DESC, u.display_name`).all(clubId);
}

/**
 * 본문에서 `@표시이름` 을 찾아 membership_id 목록을 돌려줍니다.
 * - 이름에 공백이 있을 수 있으므로 **긴 이름부터** 맞춰 봅니다("김 가영" 이 "김" 보다 먼저).
 * - `@` 앞이 글자·숫자면 멘션이 아닙니다(`a@b` 같은 것).
 * - 실제로 존재하는 멤버만 남습니다 — 아무 문자열이나 멘션 행이 되지 않습니다.
 */
export function findMentions(clubId, body, members = null) {
  const list = (members ?? clubMembers(clubId)).filter((m) => m.display_name);
  if (!list.length) return [];
  const byLength = [...list].sort((a, b) => b.display_name.length - a.display_name.length);
  const wordChar = /[\p{L}\p{N}_]/u;
  const hit = new Set();

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue;
    if (i > 0 && wordChar.test(body[i - 1])) continue;
    for (const m of byLength) {
      if (body.startsWith(m.display_name, i + 1)) {
        hit.add(m.membership_id);
        i += m.display_name.length;
        break;
      }
    }
  }
  return [...hit];
}

/**
 * 회원 메시지 저장. 멘션 파싱·저장과 "내가 쓴 건 읽은 것" 처리까지 한 트랜잭션입니다.
 * body 는 호출 전에 trim·길이 검사를 마친 상태여야 합니다.
 */
export function insertUserMessage({ clubId, membershipId, userId, body }) {
  const mentions = findMentions(clubId, body);
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO chat_messages (club_id, membership_id, author_user_id, kind, body)
       VALUES (?, ?, ?, 'user', ?)`).run(clubId, membershipId, userId, body);
    const mid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT OR IGNORE INTO chat_mentions (message_id, membership_id) VALUES (?, ?)');
    for (const target of mentions) ins.run(mid, target);
    markRead(membershipId, mid);       // 보낸 사람에게는 안 읽은 메시지가 아닙니다
    return mid;
  })();
  return getMessage(id);
}

/**
 * 시스템 메시지 저장. 작성자가 없고(membership_id NULL) 수정·삭제할 수 없습니다 (§8.2).
 * `actorMembershipId` 는 "그 사람에게는 안 읽음으로 세지 않기" 위해서만 씁니다 — 본인 행동의 알림이니까요.
 */
export function insertSystemMessage({ clubId, event, body, actorMembershipId = null }) {
  if (!SYSTEM_EVENTS.includes(event)) throw new Error(`알 수 없는 시스템 이벤트: ${event}`);
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO chat_messages (club_id, membership_id, author_user_id, kind, body, system_event)
       VALUES (?, NULL, NULL, 'system', ?, ?)`).run(clubId, body, event);
    const mid = Number(info.lastInsertRowid);
    if (actorMembershipId) markRead(actorMembershipId, mid);
    return mid;
  })();
  return getMessage(id);
}

/** 단건 조회 (직렬화된 형태). 없으면 null. */
export function getMessage(id) {
  const row = db.prepare(`${SELECT_MESSAGE} WHERE c.id = ?`).get(id);
  return row ? serializeMessage(row, loadMentions([id])) : null;
}

/** 권한 검사용 원본 행 (body 포함, 직렬화 전). 라우트에서 소유자·동아리를 확인할 때 씁니다. */
export function getMessageRow(id) {
  return db.prepare(
    'SELECT id, club_id, membership_id, author_user_id, kind, body, deleted_at FROM chat_messages WHERE id = ?'
  ).get(id);
}

/**
 * 커서 페이지네이션. 항상 **오래된 것 → 최신** 순으로 돌려줍니다(그리는 순서 그대로).
 *   before 만: 그보다 과거 limit개  — 위로 스크롤해 더 읽기
 *   after  만: 그 뒤로 생긴 limit개 — 재연결 후 누락분 보충
 *   둘 다 없음: 최신 limit개        — 패널을 처음 열 때
 */
export function listMessages({ clubId, before = null, after = null, limit = PAGE_DEFAULT }) {
  const n = Math.min(Math.max(1, Number(limit) || PAGE_DEFAULT), PAGE_MAX);
  let rows;
  if (after) {
    rows = db.prepare(`${SELECT_MESSAGE} WHERE c.club_id = ? AND c.id > ? ORDER BY c.id ASC LIMIT ?`)
      .all(clubId, after, n + 1);
  } else if (before) {
    rows = db.prepare(`${SELECT_MESSAGE} WHERE c.club_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT ?`)
      .all(clubId, before, n + 1).reverse();
  } else {
    rows = db.prepare(`${SELECT_MESSAGE} WHERE c.club_id = ? ORDER BY c.id DESC LIMIT ?`)
      .all(clubId, n + 1).reverse();
  }

  // n+1 개를 읽어 "더 있는지" 를 판단하고 한 개를 버립니다.
  const more = rows.length > n;
  if (more) rows = after ? rows.slice(0, n) : rows.slice(rows.length - n);

  const mentions = loadMentions(rows.map((r) => r.id));
  return {
    messages: rows.map((r) => serializeMessage(r, mentions)),
    // 위로 더 읽을 때 쓸 커서. after 조회에서는 "아직 남은 게 있다" 는 뜻으로만 씁니다.
    has_more: more,
    oldest_id: rows.length ? rows[0].id : null,
    latest_id: rows.length ? rows[rows.length - 1].id : null
  };
}

/** 본문 수정. 시스템·삭제된 메시지는 호출 전에 걸러야 합니다. */
export function editMessage(id, body) {
  db.prepare(`UPDATE chat_messages SET body = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
               WHERE id = ? AND deleted_at IS NULL`).run(body, id);
  return getMessage(id);
}

/**
 * soft delete. 행을 지우지 않고 표시만 합니다.
 * **body 는 남겨 둡니다** — 회장·서비스 관리자가 지운 글을 나중에 확인할 수 있어야 하기 때문입니다.
 * 대신 serializeMessage 가 응답에서 항상 지웁니다. 멘션 행은 지웁니다(지운 글이 계속 남을 부를 이유가 없음).
 */
export function deleteMessage(id, byUserId) {
  db.transaction(() => {
    db.prepare(`UPDATE chat_messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), deleted_by = ?
                 WHERE id = ? AND deleted_at IS NULL`).run(byUserId, id);
    db.prepare('DELETE FROM chat_mentions WHERE message_id = ?').run(id);
  })();
  return getMessage(id);
}

/**
 * 읽음 지점을 **앞으로만** 옮깁니다. 뒤로 보내는 요청은 무시합니다(늦게 도착한 read 이벤트).
 * 요청한 id 는 **내 동아리의 실재하는 메시지로 잘라 냅니다** — 남의 방 메시지 id 나 아직 없는 id
 * (다른 탭이 먼저 읽어 앞서간 경우)를 그대로 쓰면 FK 가 깨지거나 남의 방 진행도가 새 나갑니다.
 */
export function markRead(membershipId, messageId) {
  const row = db.prepare(`
    SELECT MAX(c.id) AS id
      FROM chat_messages c
      JOIN memberships m ON m.id = ? AND m.club_id = c.club_id
     WHERE c.id <= ?`).get(membershipId, messageId);
  if (!row?.id) return lastReadId(membershipId);

  db.prepare(`INSERT INTO chat_reads (membership_id, last_read_message_id, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(membership_id) DO UPDATE SET
      last_read_message_id = MAX(COALESCE(chat_reads.last_read_message_id, 0), excluded.last_read_message_id),
      updated_at = excluded.updated_at`).run(membershipId, row.id);
  return lastReadId(membershipId);
}

export function lastReadId(membershipId) {
  const row = db.prepare('SELECT last_read_message_id FROM chat_reads WHERE membership_id = ?').get(membershipId);
  return row?.last_read_message_id ?? 0;
}

/**
 * 안 읽은 개수. **내가 보낸 메시지와 삭제된 메시지는 세지 않습니다.**
 * (내 글은 보낼 때 읽음 처리되고, 지워진 글은 읽을 내용이 없습니다.)
 */
export function unreadCount(clubId, membershipId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM chat_messages
     WHERE club_id = ? AND id > ? AND deleted_at IS NULL
       AND (membership_id IS NULL OR membership_id <> ?)`)
    .get(clubId, lastReadId(membershipId), membershipId);
  return row.n;
}

/** 동아리 목록 화면의 배지용 — 내 모든 동아리의 안 읽은 개수를 한 번에. */
export function unreadByClub(userId) {
  return db.prepare(`
    SELECT m.club_id,
           COUNT(c.id) AS unread_count,
           (SELECT MAX(id) FROM chat_messages WHERE club_id = m.club_id) AS latest_id
      FROM memberships m
      LEFT JOIN chat_reads r ON r.membership_id = m.id
      LEFT JOIN chat_messages c
             ON c.club_id = m.club_id
            AND c.id > COALESCE(r.last_read_message_id, 0)
            AND c.deleted_at IS NULL
            AND (c.membership_id IS NULL OR c.membership_id <> m.id)
     WHERE m.user_id = ?
     GROUP BY m.club_id`).all(userId);
}

/**
 * 회원별 읽음 지점. 메시지마다 "안 읽음 N" / "모두 읽음" 을 그리는 데 씁니다 (§8.3).
 * 메시지 하나에 대한 미읽음 수 = 이 목록에서 last_read_message_id < 메시지 id 인 **다른** 회원의 수.
 */
export function readMarks(clubId) {
  return db.prepare(`
    SELECT m.id AS membership_id, COALESCE(r.last_read_message_id, 0) AS last_read_message_id
      FROM memberships m LEFT JOIN chat_reads r ON r.membership_id = m.id
     WHERE m.club_id = ?`).all(clubId);
}
