// 동아리 채팅의 도메인 규칙. service-design.md §8.
// 권한 셀(누가 무엇을 할 수 있는가)은 tests/capability.test.js 의 "동아리 채팅" 블록이 봅니다.
// 여기서는 **동작이 맞는지**를 봅니다 — 커서 페이지네이션, @멘션 파싱, 읽음 카운트,
// soft delete 가 본문을 흘리지 않는지, 시스템 메시지, WebSocket 업그레이드 검증.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'surfboard-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-only-secret-0123456789abcdef0123456789abcdef';
process.env.COOKIE_SECURE = 'false';

const { db, migrate } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { attachChat } = await import('../server/ws.js');
const { default: WebSocket } = await import('ws');
migrate();

const PW = 'chat-test-2026';

let base, port, server, stopChat;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  stopChat = attachChat(server);
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  stopChat();
  server.close();
  db.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------- 도구 ----------
let seq = 0;
const cookies = new Map();

async function call(method, url, { body, as } = {}) {
  const cookie = as ? cookies.get(as) : null;
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 표시 이름을 직접 정합니다 — @멘션 파싱이 이름에 달려 있어서 공백 있는 이름도 씁니다. */
async function makeUser(label, displayName, { serviceAdmin = false } = {}) {
  const username = `${label}${++seq}`.toLowerCase();
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, display_name: displayName, password: PW })
  });
  const user = await res.json();
  cookies.set(label, res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
  if (serviceAdmin) db.prepare('UPDATE users SET is_service_admin = 1 WHERE id = ?').run(user.id);
  return { ...user, username };
}

/**
 * 회장 가영 + 회원 지훈 + 회원 "김 유진"(공백 있는 이름) 으로 이뤄진 동아리.
 *
 * ⚠️ **이름표(쿠키 키)는 동아리마다 다릅니다.** 같은 이름표를 쓰면 두 번째 freshClub() 이
 * 첫 번째의 쿠키를 덮어써서, `as:'member'` 가 갑자기 남의 동아리 사람을 가리킵니다
 * (실제로 이 파일을 쓰다 404 로 당했습니다). 그래서 이름표를 `f.at('member')` 로만 만듭니다.
 */
async function freshClub() {
  const tag = `c${++seq}`;
  const at = (role) => `${role}-${tag}`;
  const pres = await makeUser(at('pres'), '가영');
  const member = await makeUser(at('member'), '지훈');
  const spaced = await makeUser(at('spaced'), '김 유진');

  const club = (await call('POST', '/api/clubs', { body: { name: `동아리${tag}` }, as: at('pres') })).body;
  const invite = (await call('POST', `/api/clubs/${club.id}/invites`, { as: at('pres') })).body;
  await call('POST', `/api/invites/${invite.token}/accept`, { as: at('member') });
  await call('POST', `/api/invites/${invite.token}/accept`, { as: at('spaced') });
  return { club, pres, member, spaced, invite, at };
}

const say = (f, role, body) => call('POST', `/api/clubs/${f.club.id}/messages`, { body: { body }, as: f.at(role) });
const list = (f, role, query = '') => call('GET', `/api/clubs/${f.club.id}/messages${query}`, { as: f.at(role) });
const membershipOf = (club, userId) =>
  db.prepare('SELECT id FROM memberships WHERE club_id = ? AND user_id = ?').get(club.id, userId).id;

// ==========================================================================
describe('메시지 전송과 본문', () => {
  let f;
  before(async () => { f = await freshClub(); });

  test('빈 본문·공백뿐인 본문·너무 긴 본문은 400', async () => {
    assert.equal((await say(f, 'member', '')).status, 400);
    assert.equal((await say(f, 'member', '   \n  ')).status, 400);
    assert.equal((await say(f, 'member', 'ㄱ'.repeat(2001))).status, 400);
    assert.equal((await say(f, 'member', 'ㄱ'.repeat(2000))).status, 201, '2000자는 됩니다');
  });

  test('앞뒤 공백은 잘리고 안쪽 줄바꿈은 남는다', async () => {
    const res = await say(f, 'member', '  첫 줄\n둘째 줄  ');
    assert.equal(res.body.body, '첫 줄\n둘째 줄');
  });

  test('본문은 이스케이프하지 않고 원문 그대로 저장·반환한다 (렌더 시점에 이스케이프)', async () => {
    const raw = '<script>alert(1)</script> & "따옴표" <b>굵게</b>';
    const sent = await say(f, 'member', raw);
    assert.equal(sent.body.body, raw, '서버가 본문을 바꾸지 않습니다');

    const stored = db.prepare('SELECT body FROM chat_messages WHERE id = ?').get(sent.body.id).body;
    assert.equal(stored, raw, 'DB 에도 원문 그대로');

    const page = await list(f, 'member');
    assert.equal(page.body.messages.at(-1).body, raw, '목록에서도 원문 그대로');
    // 서버가 이스케이프하면 수정 화면에 &amp; 가 보이고 이중 이스케이프가 쌓입니다.
    // 이스케이프 책임은 프런트에 있고, 아래 "프런트 렌더" 절이 그걸 정적으로 지킵니다.
  });

  test('작성자 정보가 함께 내려온다', async () => {
    const res = await say(f, 'pres', '회장입니다');
    assert.equal(res.body.kind, 'user');
    assert.equal(res.body.display_name, '가영');
    assert.equal(res.body.role, 'president');
    assert.equal(res.body.user_id, f.pres.id);
    assert.match(res.body.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'ISO-8601 UTC');
  });
});

// ==========================================================================
describe('@멘션 파싱', () => {
  let f;
  before(async () => { f = await freshClub(); });

  test('실재하는 멤버만, 공백 있는 이름도, 앞이 글자면 제외', async () => {
    const res = await say(f, 'pres',
      '@지훈 안녕하세요 @김 유진 님도요. mail@지훈 은 멘션이 아니고 @없는사람 도 아닙니다');
    assert.deepEqual(
      [...res.body.mentions].sort((a, b) => a - b),
      [membershipOf(f.club, f.member.id), membershipOf(f.club, f.spaced.id)].sort((a, b) => a - b)
    );
  });

  test('멘션이 없으면 빈 배열', async () => {
    assert.deepEqual((await say(f, 'pres', '그냥 이메일 a@b.com 입니다')).body.mentions, []);
  });

  test('같은 사람을 여러 번 불러도 행은 하나', async () => {
    const res = await say(f, 'pres', '@지훈 @지훈 @지훈');
    assert.equal(res.body.mentions.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM chat_mentions WHERE message_id = ?').get(res.body.id).c, 1);
  });
});

// ==========================================================================
describe('soft delete — 본문을 흘리지 않는다', () => {
  let f, target;
  before(async () => {
    f = await freshClub();
    target = (await say(f, 'member', '비밀이 담긴 메시지 @가영')).body;
    await call('DELETE', `/api/messages/${target.id}`, { as: f.at('pres') });   // 회장이 지웁니다
  });

  test('삭제 응답·단건·목록 어디에도 본문이 없다', async () => {
    const page = await list(f, 'member');
    const row = page.body.messages.find((m) => m.id === target.id);
    assert.equal(row.body, null, '본문은 null');
    assert.equal(row.deleted, true);
    assert.equal(row.deleted_placeholder, '삭제된 메시지입니다.');
    assert.deepEqual(row.mentions, [], '멘션도 비웁니다');
    assert.ok(!JSON.stringify(page.body).includes('비밀이 담긴'), '응답 전체를 훑어도 본문이 없습니다');
  });

  test('행은 남고 본문·지운 사람은 감사용으로 DB 에 보관된다', async () => {
    const row = db.prepare('SELECT body, deleted_at, deleted_by FROM chat_messages WHERE id = ?').get(target.id);
    assert.equal(row.body, '비밀이 담긴 메시지 @가영', 'DB 에는 남습니다');
    assert.ok(row.deleted_at);
    assert.equal(row.deleted_by, f.pres.id, '회장이 지웠다고 기록');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM chat_mentions WHERE message_id = ?').get(target.id).c, 0);
  });

  test('지워진 메시지는 고칠 수 없고, 다시 지우면 그대로 200 (멱등)', async () => {
    const edit = await call('PATCH', `/api/messages/${target.id}`, { body: { body: 'x' }, as: f.at('member') });
    assert.equal(edit.status, 410);
    assert.equal(edit.body.code, 'MESSAGE_DELETED');

    const again = await call('DELETE', `/api/messages/${target.id}`, { as: f.at('pres') });
    assert.equal(again.status, 200);
    assert.equal(again.body.body, null);
  });
});

// ==========================================================================
describe('읽음 · 안 읽은 개수', () => {
  let f;
  before(async () => { f = await freshClub(); });

  const unreadOf = async (role) => {
    const res = await call('GET', '/api/clubs/unread', { as: f.at(role) });
    return res.body.clubs.find((c) => c.club_id === f.club.id)?.unread_count ?? 0;
  };

  test('참여 시스템 메시지는 들어온 본인에게 안 읽음이 아니다', async () => {
    // 지훈·유진의 참여로 시스템 메시지 2건이 생겼습니다.
    assert.equal(await unreadOf('member'), 1, '지훈에게는 유진의 참여 1건만');
    assert.equal(await unreadOf('spaced'), 0, '유진은 마지막 사건의 당사자');
    assert.equal(await unreadOf('pres'), 2, '회장은 둘 다 안 읽음');
  });

  test('내가 보낸 메시지는 내 안 읽음에 세지 않는다', async () => {
    const before = await unreadOf('member');
    await say(f, 'member', '내가 쓴 글');
    assert.equal(await unreadOf('member'), 0, '보내면 그 지점까지 읽은 것으로');
    assert.ok(await unreadOf('pres') > before, '남에게는 늘어납니다');
  });

  test('삭제된 메시지는 안 읽음에 세지 않는다', async () => {
    await call('POST', `/api/clubs/${f.club.id}/messages/read`,
      { body: { last_read_message_id: (await list(f, 'pres')).body.latest_id }, as: f.at('pres') });
    assert.equal(await unreadOf('pres'), 0);

    const gone = (await say(f, 'member', '곧 지울 메시지')).body;
    assert.equal(await unreadOf('pres'), 1);
    await call('DELETE', `/api/messages/${gone.id}`, { as: f.at('member') });
    assert.equal(await unreadOf('pres'), 0, '지워지면 배지에서 빠집니다');
  });

  test('읽음 지점은 앞으로만 간다', async () => {
    const latest = (await list(f, 'member')).body.latest_id;
    const forward = await call('POST', `/api/clubs/${f.club.id}/messages/read`,
      { body: { last_read_message_id: latest }, as: f.at('member') });
    assert.equal(forward.body.last_read_message_id, latest);

    const back = await call('POST', `/api/clubs/${f.club.id}/messages/read`,
      { body: { last_read_message_id: 1 }, as: f.at('member') });
    assert.equal(back.body.last_read_message_id, latest, '되감기 요청은 무시');
  });

  test('없는 id·남의 방 id 는 내 방의 실재하는 메시지로 잘린다', async () => {
    const other = await freshClub();                     // 내가 속하지 않은 다른 방
    const stranger = (await say(other, 'pres', '남의 방 메시지')).body;
    const myLatest = (await list(f, 'member')).body.latest_id;

    const huge = await call('POST', `/api/clubs/${f.club.id}/messages/read`,
      { body: { last_read_message_id: 999999 }, as: f.at('member') });
    assert.equal(huge.status, 200, '500 이 아니라 조용히 클램프');
    assert.equal(huge.body.last_read_message_id, myLatest);

    // `stranger.id` 는 내 방보다 큰 id 지만 다른 방 것이라 내 진행도를 끌어올리면 안 됩니다.
    assert.ok(stranger.id > myLatest);
    const cross = await call('POST', `/api/clubs/${f.club.id}/messages/read`,
      { body: { last_read_message_id: stranger.id }, as: f.at('member') });
    assert.equal(cross.body.last_read_message_id, myLatest, '남의 방 진행도가 새지 않습니다');
  });

  test('양수가 아닌 last_read_message_id 는 400', async () => {
    for (const bad of [0, -1, 'abc', null]) {
      assert.equal((await call('POST', `/api/clubs/${f.club.id}/messages/read`,
        { body: { last_read_message_id: bad }, as: f.at('member') })).status, 400, String(bad));
    }
  });

  test('read_marks 로 메시지별 "안 읽음 N" 을 셀 수 있다', async () => {
    const page = (await list(f, 'pres')).body;
    assert.equal(page.read_marks.length, 3, '동아리 전원의 읽음 지점이 옵니다');
    for (const mark of page.read_marks) assert.equal(typeof mark.last_read_message_id, 'number');
  });
});

// ==========================================================================
describe('커서 페이지네이션', () => {
  let f, ids;
  before(async () => {
    f = await freshClub();
    ids = [];
    for (let i = 1; i <= 12; i++) ids.push((await say(f, 'member', `메시지 ${i}`)).body.id);
  });

  test('항상 오래된 것 → 최신 순으로 온다', async () => {
    const page = (await list(f, 'pres')).body;
    const sorted = [...page.messages].sort((a, b) => a.id - b.id);
    assert.deepEqual(page.messages.map((m) => m.id), sorted.map((m) => m.id));
  });

  test('커서 없으면 최신 limit개 + has_more', async () => {
    const page = (await list(f, 'pres', '?limit=5')).body;
    assert.equal(page.messages.length, 5);
    assert.deepEqual(page.messages.map((m) => m.id), ids.slice(-5));
    assert.equal(page.has_more, true);
    assert.equal(page.latest_id, ids.at(-1));
  });

  test('before — 그보다 과거로 (위로 더 읽기)', async () => {
    const page = (await list(f, 'pres', `?before=${ids[5]}&limit=3`)).body;
    assert.deepEqual(page.messages.map((m) => m.id), ids.slice(2, 5));
  });

  test('after — 그 뒤로 생긴 것 (재연결 보충)', async () => {
    const page = (await list(f, 'pres', `?after=${ids[8]}`)).body;
    assert.deepEqual(page.messages.map((m) => m.id), ids.slice(9));
    assert.equal(page.has_more, false);
  });

  test('limit 범위를 벗어나면 400', async () => {
    assert.equal((await list(f, 'pres', '?limit=0')).status, 400);
    assert.equal((await list(f, 'pres', '?limit=101')).status, 400);
    assert.equal((await list(f, 'pres', '?limit=abc')).status, 400);
  });

  test('다른 동아리 메시지는 절대 섞이지 않는다', async () => {
    const other = await freshClub();
    await say(other, 'pres', '남의 방 메시지');
    const page = (await list(f, 'pres', '?limit=100')).body;
    assert.ok(page.messages.every((m) => m.club_id === f.club.id));
    assert.ok(!JSON.stringify(page).includes('남의 방 메시지'));
  });
});

// ==========================================================================
describe('시스템 메시지 (§8.2)', () => {
  test('다섯 가지 도메인 사건이 각각 한 줄을 남긴다', async () => {
    const f = await freshClub();
    const kicked = await makeUser('kicked', '유진');
    await call('POST', `/api/invites/${f.invite.token}/accept`, { as: 'kicked' });

    await call('POST', `/api/clubs/${f.club.id}/confirm?month=2026-08`, { as: f.at('member') });
    await call('POST', `/api/clubs/${f.club.id}/unconfirm?month=2026-08`, { as: f.at('member') });
    await call('DELETE', `/api/clubs/${f.club.id}/members/${kicked.id}`, { as: f.at('pres') });
    await call('POST', `/api/clubs/${f.club.id}/transfer`, { body: { to_user_id: f.member.id }, as: f.at('pres') });
    await call('DELETE', `/api/clubs/${f.club.id}/leave`, { as: f.at('pres') });

    const page = (await list(f, 'member', '?limit=100')).body;
    const events = page.messages.filter((m) => m.kind === 'system').map((m) => m.system_event);
    for (const want of ['member_joined', 'month_confirmed', 'availability_changed',
      'member_left', 'president_transferred']) {
      assert.ok(events.includes(want), `${want} 가 없습니다: ${events.join(', ')}`);
    }
    const system = page.messages.find((m) => m.kind === 'system');
    assert.equal(system.membership_id, null, '시스템 메시지는 작성자가 없습니다');
    assert.equal(system.display_name, null);
  });

  test('같은 상태로 다시 눌러도 줄이 늘지 않는다', async () => {
    const f = await freshClub();
    const count = async () => (await list(f, 'member', '?limit=100')).body
      .messages.filter((m) => m.system_event === 'month_confirmed').length;

    await call('POST', `/api/clubs/${f.club.id}/confirm?month=2026-09`, { as: f.at('member') });
    assert.equal(await count(), 1);
    await call('POST', `/api/clubs/${f.club.id}/confirm?month=2026-09`, { as: f.at('member') });
    assert.equal(await count(), 1, '이미 확정된 달을 또 확정하는 건 사건이 아닙니다');
  });

  test('채팅이 막혀도 일정 확정은 성공한다', async () => {
    const f = await freshClub();
    // 채팅 테이블을 잠깐 못 쓰게 만들어 announce* 가 실패하도록 합니다.
    db.exec('ALTER TABLE chat_messages RENAME TO chat_messages_hidden');
    try {
      const res = await call('POST', `/api/clubs/${f.club.id}/confirm?month=2026-10`, { as: f.at('member') });
      assert.equal(res.status, 200, '채팅 실패가 도메인 동작을 깨뜨리면 안 됩니다');
      assert.equal(res.body.state, 'confirmed');
    } finally {
      db.exec('ALTER TABLE chat_messages_hidden RENAME TO chat_messages');
    }
  });
});

// ==========================================================================
describe('WebSocket 업그레이드 (§8.5)', () => {
  let f;
  before(async () => { f = await freshClub(); });

  /**
   * 연결되면 'open', 거부되면 'HTTP <코드>'.
   * **프레임 수집기를 open 보다 먼저 붙입니다** — 입장 presence 는 join 직후에 나가서,
   * open 콜백에서 붙이면 이미 지나간 뒤입니다.
   */
  function tryOpen(as, query, { origin } = {}) {
    return new Promise((resolve) => {
      const headers = {};
      if (as) headers.Cookie = cookies.get(as);
      if (origin !== null) headers.Origin = origin ?? `http://127.0.0.1:${port}`;
      const ws = new WebSocket(`ws://127.0.0.1:${port}${query}`, { headers });
      const frames = [];
      ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
      ws.on('open', () => resolve({ result: 'open', ws, frames }));
      ws.on('unexpected-response', (_, res) => { ws.terminate(); resolve({ result: `HTTP ${res.statusCode}` }); });
      ws.on('error', (err) => resolve({ result: `error ${err.message}` }));
    });
  }

  test('세션이 없으면 401', async () => {
    assert.equal((await tryOpen(null, `/ws?club=${f.club.id}`)).result, 'HTTP 401');
  });

  test('그 동아리 회원이 아니면 403 — 서비스 관리자도 예외 없음', async () => {
    const outsider = await makeUser('wsout', '외부인');
    const admin = await makeUser('wsadmin', '관리자', { serviceAdmin: true });
    assert.ok(outsider.id && admin.id);
    assert.equal((await tryOpen('wsout', `/ws?club=${f.club.id}`)).result, 'HTTP 403');
    assert.equal((await tryOpen('wsadmin', `/ws?club=${f.club.id}`)).result, 'HTTP 403',
      '읽기는 멤버십 필수. 강제 삭제는 REST 로만 합니다');
  });

  test('club 파라미터가 없거나 이상하면 400, 없는 동아리는 403', async () => {
    assert.equal((await tryOpen(f.at('member'), '/ws')).result, 'HTTP 400');
    assert.equal((await tryOpen(f.at('member'), '/ws?club=abc')).result, 'HTTP 400');
    assert.equal((await tryOpen(f.at('member'), '/ws?club=999999')).result, 'HTTP 403');
  });

  test('/ws 가 아닌 경로는 404', async () => {
    assert.equal((await tryOpen(f.at('member'), `/socket?club=${f.club.id}`)).result, 'HTTP 404');
  });

  test('다른 사이트 Origin 은 403 (CSWSH 차단)', async () => {
    assert.equal((await tryOpen(f.at('member'), `/ws?club=${f.club.id}`, { origin: 'http://evil.example' })).result,
      'HTTP 403');
    assert.equal((await tryOpen(f.at('member'), `/ws?club=${f.club.id}`, { origin: null })).result, 'open',
      'Origin 이 없는 비브라우저 클라이언트는 통과 (쿠키 인증은 이미 지났습니다)');
  });

  test('회원은 연결되고, REST 로 보낸 메시지가 방에 도착한다', async () => {
    const { result, ws, frames } = await tryOpen(f.at('member'), `/ws?club=${f.club.id}`);
    assert.equal(result, 'open');

    await say(f, 'pres', '실시간으로 갑니다');
    await new Promise((r) => setTimeout(r, 300));

    const message = frames.find((x) => x.type === 'message');
    assert.ok(message, `message 프레임이 없습니다: ${frames.map((x) => x.type).join(', ')}`);
    assert.equal(message.payload.body, '실시간으로 갑니다');
    assert.ok(frames.some((x) => x.type === 'presence'), '입장 시 presence 도 옵니다');
    ws.close();
  });

  test('소켓으로는 read 만 쓸 수 있다 — 모르는 type 과 깨진 JSON 은 연결을 끊지 않는다', async () => {
    const { ws } = await tryOpen(f.at('member'), `/ws?club=${f.club.id}`);
    const latest = (await list(f, 'member')).body.latest_id;

    ws.send('깨진 프레임');
    ws.send(JSON.stringify({ type: '없는이벤트', body: '이걸로 메시지가 만들어지면 안 됩니다' }));
    ws.send(JSON.stringify({ type: 'read', last_read_message_id: latest }));
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(ws.readyState, WebSocket.OPEN, '연결은 살아 있습니다');
    assert.equal((await list(f, 'member')).body.latest_id, latest, '소켓으로 메시지를 만들 수 없습니다');
    assert.equal((await list(f, 'member')).body.my_last_read_id, latest, 'read 는 반영됩니다');
    ws.close();
  });
});

// ==========================================================================
// XSS 는 렌더 시점 책임이라 HTTP 로는 잡히지 않습니다. 프런트가 규칙을 어기지 않는지 정적으로 봅니다.
describe('프런트 렌더 — 이스케이프 규칙 (§8 보안 요구)', () => {
  const raw = fs.readFileSync(path.join(process.cwd(), 'public', 'js', 'chat.js'), 'utf8');
  // 주석은 뺍니다 — 이 파일의 주석은 "innerHTML 을 쓰지 않는다" 처럼 금지어 자체를 설명하고 있습니다.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('chat.js 는 innerHTML 계열을 쓰지 않는다', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!code.includes(forbidden), `${forbidden} 을 쓰면 본문이 HTML 로 해석됩니다`);
    }
    // ui.js 의 el() 은 `html:` prop 으로 innerHTML 을 넣을 수 있습니다. 채팅에서는 금지입니다.
    assert.ok(!/\bhtml\s*:/.test(code), 'el() 의 html: prop 은 채팅에서 쓰지 않습니다');
  });

  test('링크 자동 변환은 http(s) 스킴만 잡는다', () => {
    assert.ok(/https\?:\\\/\\\//.test(code),
      '링크 정규식이 https?:\\/\\/ 로 시작해야 javascript: 가 href 에 들어가지 못합니다');
    assert.ok(!code.includes('javascript:'), '코드에 javascript: 스킴이 나타나면 안 됩니다');
  });
});
