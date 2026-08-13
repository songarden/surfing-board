// 동아리 채팅 WebSocket. service-design.md §5 (WS 계약) · §8.5.
//
//   WS /ws?club=:id
//     server→client : message | edit | delete | system | presence | typing | read
//     client→server : typing | read
//
// 보안 (§8 보안 요구):
//   업그레이드 시점에 **세션 쿠키로 인증하고 그 동아리 멤버십을 검증**합니다.
//   검증을 통과한 소켓만 룸에 들어갑니다. 소속 없는 서비스 관리자도 들어올 수 없습니다
//   (읽기 = 멤버십 필수. 강제 삭제는 REST 로만 합니다).
//   그리고 **소켓 검증만 믿지 않습니다** — REST 쪽에서도 요청마다 멤버십을 다시 봅니다.
//
// 실시간은 최선 노력입니다. 진실의 출처는 DB 이고, 끊겼다 돌아온 클라이언트는
// `GET /api/clubs/:id/messages?after=<마지막으로 받은 id>` 로 누락분을 그대로 따라잡습니다.
import { WebSocketServer } from 'ws';
import { db } from './db.js';
import { currentUser } from './auth.js';
import { join, leave, publish, presence } from './lib/realtime.js';
import { markRead } from './lib/chat.js';

const HEARTBEAT_MS = 30_000;     // 죽은 소켓 정리 주기
const MAX_PAYLOAD = 8 * 1024;    // client→server 는 typing/read 뿐이라 넉넉합니다

/** `a=1; b=2` → { a:'1', b:'2' }. cookie-parser 는 Express 요청용이라 업그레이드에서 못 씁니다. */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 다른 사이트가 사용자의 쿠키로 우리 소켓을 여는 것(CSWSH)을 막습니다.
 * WebSocket 에는 CORS 가 없어서 브라우저가 대신 막아주지 않습니다.
 * Origin 이 없으면(브라우저가 아닌 클라이언트) 통과시킵니다 — 쿠키 인증은 이미 지났습니다.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch { return false; }
}

const refuse = (socket, code, text) => {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

/**
 * 떠 있는 http 서버에 채팅 소켓을 붙입니다. `createApp().listen()` 이 돌려준 서버를 넘기세요.
 * 돌려주는 `close()` 는 테스트에서 하트비트 타이머와 소켓을 정리할 때 씁니다.
 */
export function attachChat(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return refuse(socket, 400, 'Bad Request'); }
    if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
    if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden');

    // 1) 세션 인증 — 쿠키에서 사용자. 정지된 계정은 currentUser 가 걸러 줍니다.
    const user = currentUser({ cookies: parseCookies(req.headers.cookie) });
    if (!user) return refuse(socket, 401, 'Unauthorized');

    // 2) 멤버십 검증 — 그 동아리 회원이 아니면 룸에 넣지 않습니다.
    const clubId = Number(url.searchParams.get('club'));
    if (!Number.isInteger(clubId) || clubId <= 0) return refuse(socket, 400, 'Bad Request');
    const membership = db.prepare('SELECT id, role FROM memberships WHERE club_id = ? AND user_id = ?')
      .get(clubId, user.id);
    if (!membership) return refuse(socket, 403, 'Forbidden');

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, { user, clubId, membership });
    });
  });

  wss.on('connection', (ws, ctx) => {
    const { user, clubId, membership } = ctx;
    const client = {
      userId: user.id,
      membershipId: membership.id,
      // publish() 는 이 send 만 압니다 — 룸이 전송 수단을 몰라도 되도록.
      send: (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); }
    };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    join(clubId, client);
    publish(clubId, 'presence', { club_id: clubId, members: presence(clubId) });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }     // 깨진 프레임은 조용히 버립니다

      if (msg?.type === 'typing') {
        // 본인에게는 메아리를 보내지 않습니다. 만료는 클라이언트가 타이머로 합니다.
        publish(clubId, 'typing', {
          club_id: clubId,
          membership_id: membership.id,
          display_name: user.display_name
        }, { except: client });
        return;
      }

      if (msg?.type === 'read') {
        const target = Number(msg.last_read_message_id);
        if (!Number.isInteger(target) || target <= 0) return;
        // markRead 가 내 동아리의 실재하는 메시지로 잘라 냅니다 — 남의 방 id 를 보내도 새지 않습니다.
        const last = markRead(membership.id, target);
        publish(clubId, 'read', { club_id: clubId, membership_id: membership.id, last_read_message_id: last });
        return;
      }
      // 그 밖의 type 은 무시합니다. 메시지 전송·수정·삭제는 REST 로만 합니다 —
      // 소켓으로도 쓰게 하면 권한 검사를 두 벌 유지해야 합니다.
    });

    const cleanup = () => {
      leave(clubId, client);
      publish(clubId, 'presence', { club_id: clubId, members: presence(clubId) });
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // 끊긴 걸 알리지 않고 사라진 소켓(노트북 덮기, 네트워크 전환)을 걷어 냅니다.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  beat.unref?.();

  return () => {
    clearInterval(beat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
