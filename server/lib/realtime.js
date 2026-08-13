// 동아리 채팅 실시간 룸. service-design.md §8.5.
//
// **단일 프로세스 인메모리**입니다. 폐쇄망 · 10명 규모라 Redis 같은 외부 브로커를 두지 않습니다
// (DECISIONS.md 2026-08-13 절). 프로세스를 여러 개로 늘리면 그때 브로커를 검토하세요.
//
// 여기는 **전송만** 합니다. 진실의 출처는 언제나 DB 이고, WebSocket 이 끊긴 클라이언트는
// `GET /api/clubs/:id/messages?after=` 로 누락분을 그대로 따라잡을 수 있어야 합니다.
//
// 전송 수단(ws)에 의존하지 않습니다 — 클라이언트는 `{ userId, membershipId, send(obj) }` 면 됩니다.
// 그래서 라우트(REST)는 ws 패키지를 몰라도 publish 할 수 있고, 테스트에서 가짜 소켓을 넣기도 쉽습니다.

/** club_id → Set<client>. 검증을 통과한 소켓만 들어옵니다 (ws.js 의 업그레이드 핸들러). */
const rooms = new Map();

export function join(clubId, client) {
  const key = Number(clubId);
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(client);
  return () => leave(key, client);
}

export function leave(clubId, client) {
  const key = Number(clubId);
  const room = rooms.get(key);
  if (!room) return;
  room.delete(client);
  if (!room.size) rooms.delete(key);       // 빈 방은 버립니다 (동아리가 늘어도 Map 이 자라지 않도록)
}

/**
 * 방 전체에 이벤트 하나를 보냅니다.
 * `except` 로 보낸 사람 본인을 뺄 수 있습니다(typing 처럼 메아리가 필요 없는 것).
 * 소켓 하나가 죽어도 나머지 전송을 막지 않습니다 — 실시간은 최선 노력이고 REST 가 뒤를 받칩니다.
 */
export function publish(clubId, type, payload, { except = null } = {}) {
  const room = rooms.get(Number(clubId));
  if (!room?.size) return 0;
  const frame = { type, payload };
  let sent = 0;
  for (const client of room) {
    if (except && client === except) continue;
    try { client.send(frame); sent++; } catch { leave(clubId, client); }
  }
  return sent;
}

/** 지금 그 방에 접속해 있는 회원 (헤더의 "N명 접속 중"). 한 사람이 탭을 여러 개 열어도 하나로 셉니다. */
export function presence(clubId) {
  const room = rooms.get(Number(clubId));
  if (!room?.size) return [];
  const seen = new Map();
  for (const c of room) if (c.membershipId && !seen.has(c.membershipId)) {
    seen.set(c.membershipId, { membership_id: c.membershipId, user_id: c.userId });
  }
  return [...seen.values()];
}

/** 방 하나를 통째로 비웁니다 (동아리 삭제·정지). 소켓은 닫지 않고 룸에서만 뺍니다. */
export function clearRoom(clubId) {
  rooms.delete(Number(clubId));
}
