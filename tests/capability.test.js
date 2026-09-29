// service-design.md §3 Capability Matrix 를 셀 단위로 확인합니다.
// 각 기능마다 다섯 시점의 기대 상태코드를 적고, 표를 그대로 돌립니다.
//
//   anon      비로그인
//   outsider  로그인했지만 그 동아리 회원이 아님
//   member    일반 회원
//   pres      동아리 회장
//   svc       서비스 관리자 (그 동아리 회원이 아님 — 플랫폼 권한만)
//   svcMember 서비스 관리자이면서 그 동아리 회원 (⚠️ "소속 동아리에서만" 확인용)
//
// UI 노출과 무관하게 서버가 다시 검사하는지를 보는 것이 목적입니다.
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
migrate();

const MONTH = '2026-08';
const DATE = '2026-08-13';
const PW = 'capability-2026';

let base, server;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------- 도구 ----------
let seq = 0;
const cookies = new Map();

async function call(method, url, { body, as } = {}) {
  const cookie = as && as !== 'anon' ? cookies.get(as) : null;
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 계정을 만들고 쿠키를 이름표에 담아 둡니다. */
async function makeUser(label, { serviceAdmin = false } = {}) {
  const username = `${label}${++seq}`.toLowerCase();
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, display_name: label, password: PW })
  });
  const user = await res.json();
  cookies.set(label, res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
  if (serviceAdmin) db.prepare('UPDATE users SET is_service_admin = 1 WHERE id = ?').run(user.id);
  return { ...user, username };
}

/**
 * 회장 1명 + 일반 회원 1명 + (서비스 관리자 회원 1명) 으로 이뤄진 동아리를 새로 만듭니다.
 * 파괴적인 기능(삭제·양도·내보내기)은 셀마다 새 동아리로 확인해야 서로 간섭하지 않습니다.
 */
async function freshClub({ withSvcMember = false } = {}) {
  const pres = await makeUser('pres');
  const member = await makeUser('member');
  const outsider = await makeUser('outsider');
  const svc = await makeUser('svc', { serviceAdmin: true });

  const club = (await call('POST', '/api/clubs', { body: { name: `동아리${seq}` }, as: 'pres' })).body;
  const invite = (await call('POST', `/api/clubs/${club.id}/invites`, { as: 'pres' })).body;
  await call('POST', `/api/invites/${invite.token}/accept`, { as: 'member' });

  let svcMember = null;
  if (withSvcMember) {
    svcMember = await makeUser('svcMember', { serviceAdmin: true });
    await call('POST', `/api/invites/${invite.token}/accept`, { as: 'svcMember' });
  }
  return { club, pres, member, outsider, svc, svcMember, invite };
}

// ==========================================================================
describe('일정 / 달력', () => {
  let f;
  before(async () => { f = await freshClub({ withSvcMember: true }); });

  test('본인 일정 표시 — 회원·회장·(소속된)서비스 관리자만', async () => {
    const put = (as, date) => call('PUT', `/api/clubs/${f.club.id}/availability`, { body: { date, status: 'no' }, as });

    assert.equal((await put('member', DATE)).status, 200, '일반 회원 허용');
    assert.equal((await put('pres', DATE)).status, 200, '회장 허용');
    assert.equal((await put('svcMember', DATE)).status, 200, '소속된 서비스 관리자 허용');

    const svc = await put('svc', DATE);
    assert.equal(svc.status, 403, '소속되지 않은 서비스 관리자는 거부');
    assert.equal(svc.body.code, 'NOT_A_MEMBER');

    assert.equal((await put('outsider', DATE)).status, 404, '비회원에게는 존재를 숨김');
    assert.equal((await put('anon', DATE)).status, 401, '비로그인');
  });

  test("'가능'은 저장되지 않고, 남의 일정은 건드릴 수 있는 경로가 없다", async () => {
    // 세션 주인 것만 씁니다 — 대상 회원을 지정하는 파라미터가 애초에 없습니다.
    await call('PUT', `/api/clubs/${f.club.id}/availability`, { body: { date: DATE, status: 'no' }, as: 'member' });
    const rows = db.prepare(`SELECT m.user_id FROM availability a JOIN memberships m ON m.id = a.membership_id
      WHERE a.date = ? AND m.club_id = ?`).all(DATE, f.club.id).map((r) => r.user_id);
    assert.ok(rows.includes(f.member.id), '본인 행만 생깁니다');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM availability WHERE status = 'yes'").get().c, 0);
  });

  test('일괄 입력 — 회원·회장·(소속된)서비스 관리자만', async () => {
    const bulk = (as) => call('POST', `/api/clubs/${f.club.id}/availability/bulk`,
      { body: { op: 'weekday_off', month: MONTH, dow: 3 }, as });
    assert.equal((await bulk('member')).status, 200);
    assert.equal((await bulk('pres')).status, 200);
    assert.equal((await bulk('svcMember')).status, 200);
    assert.equal((await bulk('svc')).status, 403);
    assert.equal((await bulk('outsider')).status, 404);
    assert.equal((await bulk('anon')).status, 401);
  });

  test('본인 일정 확정 / 변경 — 회원·회장·(소속된)서비스 관리자만', async () => {
    const confirm = (as) => call('POST', `/api/clubs/${f.club.id}/confirm?month=${MONTH}`, { as });
    const unconfirm = (as) => call('POST', `/api/clubs/${f.club.id}/unconfirm?month=${MONTH}`, { as });

    assert.equal((await confirm('member')).status, 200);
    assert.equal((await unconfirm('member')).status, 200);
    assert.equal((await confirm('pres')).status, 200);
    assert.equal((await confirm('svcMember')).status, 200);
    assert.equal((await confirm('svc')).status, 403);
    assert.equal((await confirm('outsider')).status, 404);
    assert.equal((await confirm('anon')).status, 401);
  });

  test('확정(잠금) 중 일정 변경 요청은 409 — UI 를 우회해도 막힌다', async () => {
    await call('POST', `/api/clubs/${f.club.id}/confirm?month=${MONTH}`, { as: 'member' });
    const blocked = await call('PUT', `/api/clubs/${f.club.id}/availability`,
      { body: { date: '2026-08-20', status: 'no' }, as: 'member' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'MONTH_LOCKED');

    const bulkBlocked = await call('POST', `/api/clubs/${f.club.id}/availability/bulk`,
      { body: { op: 'all_ok', month: MONTH }, as: 'member' });
    assert.equal(bulkBlocked.status, 409, '일괄 입력도 같은 규칙');

    await call('POST', `/api/clubs/${f.club.id}/unconfirm?month=${MONTH}`, { as: 'member' });
    assert.equal((await call('PUT', `/api/clubs/${f.club.id}/availability`,
      { body: { date: '2026-08-20', status: 'no' }, as: 'member' })).status, 200, '수정 모드에서는 통과');
  });

  test('추천 날짜·응답 현황·미확인 명단 조회 — 서비스 관리자는 소속 없이도 본다', async () => {
    for (const persona of ['member', 'pres', 'svc', 'svcMember']) {
      const res = await call('GET', `/api/clubs/${f.club.id}/calendar?month=${MONTH}`, { as: persona });
      assert.equal(res.status, 200, persona);
      assert.ok(Array.isArray(res.body.summary.best_dates), `${persona} 추천 날짜`);
      assert.ok(Array.isArray(res.body.summary.unconfirmed_members), `${persona} 미확인 명단`);
    }
    assert.equal((await call('GET', `/api/clubs/${f.club.id}/calendar?month=${MONTH}`, { as: 'outsider' })).status, 404);
    assert.equal((await call('GET', `/api/clubs/${f.club.id}/calendar?month=${MONTH}`, { as: 'anon' })).status, 401);

    // 소속 없는 서비스 관리자에게는 "내 상태" 가 없습니다.
    const svcView = await call('GET', `/api/clubs/${f.club.id}/calendar?month=${MONTH}`, { as: 'svc' });
    assert.equal(svcView.body.my_month_state, null);
    assert.equal(svcView.body.club.my_role, null);
  });

  test('날짜별 공용 메모 — 회원·회장·(소속된)서비스 관리자만', async () => {
    const note = (as) => call('PUT', `/api/clubs/${f.club.id}/notes`, { body: { date: DATE, text: '메모' }, as });
    assert.equal((await note('member')).status, 200);
    assert.equal((await note('pres')).status, 200);
    assert.equal((await note('svcMember')).status, 200);
    assert.equal((await note('svc')).status, 403);
    assert.equal((await note('outsider')).status, 404);
    assert.equal((await note('anon')).status, 401);
  });

  // 만들어진 링크 자체는 로그인 없이 열립니다(메신저 미리보기 크롤러에 쿠키가 없어서).
  // 그래서 **누가 링크를 만들 수 있는가** 가 유일한 관문입니다 — 여기서 새면 뒤가 없습니다.
  test('추천 날짜 공유 링크 만들기 — 회원·회장·(소속된)서비스 관리자만', async () => {
    const link = (as) => call('GET', `/api/clubs/${f.club.id}/share?month=${MONTH}`, { as });

    assert.equal((await link('member')).status, 200);
    assert.equal((await link('pres')).status, 200);
    assert.equal((await link('svcMember')).status, 200);

    const svc = await link('svc');
    assert.equal(svc.status, 403, '소속되지 않은 서비스 관리자는 링크를 만들 수 없습니다');
    assert.equal(svc.body.code, 'NOT_A_MEMBER');

    assert.equal((await link('outsider')).status, 404, '비회원에게는 존재를 숨김');
    assert.equal((await link('anon')).status, 401);
  });
});

// ==========================================================================
// service-design.md §3 Matrix 의 "동아리 채팅" 블록 · §8.4
describe('동아리 채팅', () => {
  let f;
  before(async () => { f = await freshClub({ withSvcMember: true }); });

  const say = (as, body) => call('POST', `/api/clubs/${f.club.id}/messages`, { body: { body }, as });

  test('채팅 읽기 — 회원·회장·(소속된)서비스 관리자만', async () => {
    const list = (as) => call('GET', `/api/clubs/${f.club.id}/messages`, { as });

    assert.equal((await list('member')).status, 200, '일반 회원 허용');
    assert.equal((await list('pres')).status, 200, '회장 허용');
    assert.equal((await list('svcMember')).status, 200, '소속된 서비스 관리자 허용');

    const svc = await list('svc');
    assert.equal(svc.status, 403, '소속되지 않은 서비스 관리자는 거부');
    assert.equal(svc.body.code, 'NOT_A_MEMBER');

    assert.equal((await list('outsider')).status, 404, '비회원에게는 존재를 숨김');
    assert.equal((await list('anon')).status, 401, '비로그인');
  });

  test('메시지 전송 — 회원·회장·(소속된)서비스 관리자만', async () => {
    assert.equal((await say('member', '회원입니다')).status, 201);
    assert.equal((await say('pres', '회장입니다')).status, 201);
    assert.equal((await say('svcMember', '소속된 관리자입니다')).status, 201);

    assert.equal((await say('svc', '소속 없는 관리자')).body.code, 'NOT_A_MEMBER');
    assert.equal((await say('svc', '소속 없는 관리자')).status, 403);
    assert.equal((await say('outsider', '남의 방')).status, 404);
    assert.equal((await say('anon', '비로그인')).status, 401);
  });

  test('본인 메시지 수정 — 본인만. 회장도 서비스 관리자도 남의 말은 못 고친다', async () => {
    const mine = (await say('member', '고칠 메시지')).body;
    const edit = (as) => call('PATCH', `/api/messages/${mine.id}`, { body: { body: '고쳤습니다' }, as });

    for (const persona of ['pres', 'svcMember', 'svc']) {
      const res = await edit(persona);
      assert.equal(res.status, 403, `${persona} 는 남의 말을 못 고칩니다`);
      assert.equal(res.body.code, 'NOT_MESSAGE_AUTHOR', persona);
    }
    assert.equal((await edit('outsider')).status, 404, '비회원에게는 존재를 숨김');
    assert.equal((await edit('anon')).status, 401);

    const ok = await edit('member');
    assert.equal(ok.status, 200, '본인은 허용');
    assert.equal(ok.body.body, '고쳤습니다');
    assert.equal(ok.body.edited, true);
  });

  test('본인 메시지 삭제 — 본인 허용', async () => {
    const mine = (await say('member', '내가 지울 메시지')).body;
    const res = await call('DELETE', `/api/messages/${mine.id}`, { as: 'member' });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
  });

  test('타인 메시지 삭제 — 회장 ✅ / 서비스 관리자 ✅(강제) / 일반 회원 —', async () => {
    const a = (await say('member', '회장이 지울 메시지')).body;
    assert.equal((await call('DELETE', `/api/messages/${a.id}`, { as: 'pres' })).status, 200, '회장 허용');

    const b = (await say('member', '소속된 관리자가 지울 메시지')).body;
    assert.equal((await call('DELETE', `/api/messages/${b.id}`, { as: 'svcMember' })).status, 200);

    // 강제: 서비스 관리자는 그 동아리 회원이 아니어도 지울 수 있습니다 (읽기·쓰기와 다른 유일한 지점).
    const c = (await say('member', '소속 없는 관리자가 강제로 지울 메시지')).body;
    assert.equal((await call('DELETE', `/api/messages/${c.id}`, { as: 'svc' })).status, 200, '서비스 관리자 강제 삭제');

    const d = (await say('pres', '회장이 쓴 메시지')).body;
    const denied = await call('DELETE', `/api/messages/${d.id}`, { as: 'member' });
    assert.equal(denied.status, 403, '일반 회원은 남의 말을 못 지웁니다');
    assert.equal(denied.body.code, 'NEED_PRESIDENT');

    assert.equal((await call('DELETE', `/api/messages/${d.id}`, { as: 'outsider' })).status, 404);
    assert.equal((await call('DELETE', `/api/messages/${d.id}`, { as: 'anon' })).status, 401);
  });

  test('시스템 메시지는 누구도 고치거나 지울 수 없다', async () => {
    // 회원 참여가 시스템 메시지를 남깁니다 (§8.2).
    const page = (await call('GET', `/api/clubs/${f.club.id}/messages`, { as: 'pres' })).body;
    const system = page.messages.find((m) => m.kind === 'system');
    assert.ok(system, '참여 시스템 메시지가 있어야 합니다');

    for (const persona of ['member', 'pres', 'svcMember', 'svc']) {
      assert.equal((await call('PATCH', `/api/messages/${system.id}`, { body: { body: 'x' }, as: persona })).body.code,
        'SYSTEM_MESSAGE_IMMUTABLE', persona);
      assert.equal((await call('DELETE', `/api/messages/${system.id}`, { as: persona })).body.code,
        'SYSTEM_MESSAGE_IMMUTABLE', persona);
    }
  });

  test('읽음 처리 · 안 읽은 개수 — 회원만', async () => {
    const read = (as, id) => call('POST', `/api/clubs/${f.club.id}/messages/read`,
      { body: { last_read_message_id: id }, as });
    const latest = (await call('GET', `/api/clubs/${f.club.id}/messages`, { as: 'pres' })).body.latest_id;

    assert.equal((await read('member', latest)).status, 200);
    assert.equal((await read('svc', latest)).status, 403, '소속되지 않은 서비스 관리자는 거부');
    assert.equal((await read('outsider', latest)).status, 404);
    assert.equal((await read('anon', latest)).status, 401);

    assert.equal((await call('GET', '/api/clubs/unread', { as: 'member' })).status, 200);
    assert.equal((await call('GET', '/api/clubs/unread', { as: 'anon' })).status, 401);
  });
});

// ==========================================================================
describe('동아리 운영', () => {
  test('동아리 만들기 — 로그인한 사람은 누구나, 만든 사람이 회장', async () => {
    for (const persona of ['member', 'pres', 'svc', 'outsider']) {
      const res = await call('POST', '/api/clubs', { body: { name: `새동아리${persona}${seq}` }, as: persona });
      assert.equal(res.status, 201, persona);
      assert.equal(res.body.my_role, 'president', persona);
    }
    assert.equal((await call('POST', '/api/clubs', { body: { name: '비로그인' }, as: 'anon' })).status, 401);
  });

  test('동아리 이름·정보 수정 — 회장 또는 서비스 관리자(강제)', async () => {
    const f = await freshClub();
    const patch = (as, name) => call('PATCH', `/api/clubs/${f.club.id}`, { body: { name }, as });

    const denied = await patch('member', '회원이바꿈');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'NEED_PRESIDENT');
    assert.equal((await patch('outsider', '남이바꿈')).status, 404);
    assert.equal((await patch('anon', '비로그인')).status, 401);
    assert.equal((await patch('pres', '회장이바꿈')).status, 200);
    assert.equal((await patch('svc', '관리자가강제로바꿈')).status, 200, '서비스 관리자는 소속 없이도 강제');
    assert.equal((await call('GET', `/api/clubs/${f.club.id}`, { as: 'pres' })).body.name, '관리자가강제로바꿈');
  });

  test('초대 링크 발급 / 목록 / 회수 — 회장 또는 서비스 관리자', async () => {
    const f = await freshClub();
    const issue = (as) => call('POST', `/api/clubs/${f.club.id}/invites`, { as });
    const list = (as) => call('GET', `/api/clubs/${f.club.id}/invites`, { as });

    assert.equal((await issue('member')).status, 403);
    assert.equal((await list('member')).status, 403);
    assert.equal((await issue('outsider')).status, 404);
    assert.equal((await issue('anon')).status, 401);

    const byPresident = await issue('pres');
    assert.equal(byPresident.status, 201);
    const bySvc = await issue('svc');
    assert.equal(bySvc.status, 201);
    assert.equal((await list('pres')).status, 200);

    // 회수: 회장·서비스 관리자만
    assert.equal((await call('DELETE', `/api/invites/${byPresident.body.token}`, { as: 'member' })).status, 403);
    assert.equal((await call('DELETE', `/api/invites/${byPresident.body.token}`, { as: 'anon' })).status, 401);
    assert.equal((await call('DELETE', `/api/invites/${byPresident.body.token}`, { as: 'pres' })).status, 200);
    assert.equal((await call('DELETE', `/api/invites/${bySvc.body.token}`, { as: 'svc' })).status, 200);

    // 회수된 링크로는 참여 불가
    const dead = await call('POST', `/api/invites/${byPresident.body.token}/accept`, { as: 'outsider' });
    assert.equal(dead.status, 410);
    assert.equal(dead.body.code, 'INVITE_REVOKED');
  });

  test('회원 내보내기 — 회장 또는 서비스 관리자, 회장은 대상이 될 수 없다', async () => {
    const f = await freshClub();
    const kick = (as, uid) => call('DELETE', `/api/clubs/${f.club.id}/members/${uid}`, { as });

    assert.equal((await kick('member', f.pres.id)).status, 403, '일반 회원은 못 내보냄');
    assert.equal((await kick('outsider', f.member.id)).status, 404);
    assert.equal((await kick('anon', f.member.id)).status, 401);

    const president = await kick('pres', f.pres.id);
    assert.equal(president.status, 409, '회장은 내보낼 수 없음');
    assert.equal(president.body.code, 'CANNOT_REMOVE_PRESIDENT');

    assert.equal((await kick('pres', f.member.id)).status, 200);
    assert.equal((await call('GET', `/api/clubs/${f.club.id}`, { as: 'member' })).status, 404, '내보낸 뒤엔 접근 불가');

    // 서비스 관리자도 강제로 내보낼 수 있습니다.
    const g = await freshClub();
    assert.equal((await call('DELETE', `/api/clubs/${g.club.id}/members/${g.member.id}`, { as: 'svc' })).status, 200);
  });

  test('회장직 넘기기 — 회장 또는 서비스 관리자, 넘긴 사람은 일반 회원이 된다', async () => {
    const f = await freshClub();
    const transfer = (as, uid) => call('POST', `/api/clubs/${f.club.id}/transfer`, { body: { to_user_id: uid }, as });

    assert.equal((await transfer('member', f.member.id)).status, 403);
    assert.equal((await transfer('outsider', f.member.id)).status, 404);
    assert.equal((await transfer('anon', f.member.id)).status, 401);
    assert.equal((await transfer('pres', f.outsider.id)).status, 404, '회원이 아닌 사람에게는 넘길 수 없음');

    assert.equal((await transfer('pres', f.member.id)).status, 200);
    const roles = (await call('GET', `/api/clubs/${f.club.id}/members`, { as: 'pres' })).body.members;
    assert.equal(roles.filter((m) => m.role === 'president').length, 1, '회장은 항상 1명');
    assert.equal(roles.find((m) => m.user_id === f.member.id).role, 'president');
    assert.equal(roles.find((m) => m.user_id === f.pres.id).role, 'member');

    // 이제 이전 회장은 일반 회원이라 넘길 권한이 없습니다.
    assert.equal((await transfer('pres', f.pres.id)).status, 403);
    // 서비스 관리자는 강제로 되돌릴 수 있습니다.
    assert.equal((await transfer('svc', f.pres.id)).status, 200);
  });

  test('동아리 삭제 — 회장은 이름 확인, 서비스 관리자는 강제', async () => {
    const f = await freshClub();
    const name = (await call('GET', `/api/clubs/${f.club.id}`, { as: 'pres' })).body.name;

    assert.equal((await call('DELETE', `/api/clubs/${f.club.id}`, { body: { name }, as: 'member' })).status, 403);
    assert.equal((await call('DELETE', `/api/clubs/${f.club.id}`, { body: { name }, as: 'outsider' })).status, 404);
    assert.equal((await call('DELETE', `/api/clubs/${f.club.id}`, { body: { name }, as: 'anon' })).status, 401);

    const wrongName = await call('DELETE', `/api/clubs/${f.club.id}`, { body: { name: '엉뚱한이름' }, as: 'pres' });
    assert.equal(wrongName.status, 400);
    assert.equal(wrongName.body.code, 'NAME_CONFIRMATION_REQUIRED');
    assert.equal((await call('DELETE', `/api/clubs/${f.club.id}`, { body: { name }, as: 'pres' })).status, 200);

    const g = await freshClub();
    assert.equal((await call('DELETE', `/api/clubs/${g.club.id}`, { as: 'svc' })).status, 200,
      '서비스 관리자는 이름 확인 없이 삭제');
  });

  test('동아리 탈퇴 — 일반 회원은 가능, 회장은 넘긴 뒤, 소속 없는 서비스 관리자는 대상 아님', async () => {
    const f = await freshClub();
    const leave = (as) => call('DELETE', `/api/clubs/${f.club.id}/leave`, { as });

    assert.equal((await leave('anon')).status, 401);
    assert.equal((await leave('outsider')).status, 404);

    const svc = await leave('svc');
    assert.equal(svc.status, 403);
    assert.equal(svc.body.code, 'NOT_A_MEMBER');

    const president = await leave('pres');
    assert.equal(president.status, 409);
    assert.equal(president.body.code, 'PRESIDENT_MUST_TRANSFER');

    assert.equal((await leave('member')).status, 200);
    assert.equal((await call('GET', `/api/clubs/${f.club.id}`, { as: 'member' })).status, 404);
  });

  test('정지된 동아리 — 회원은 변경 불가·조회 가능, 서비스 관리자는 통과', async () => {
    const f = await freshClub();
    await call('POST', `/api/admin/clubs/${f.club.id}/suspend`, { body: { suspend: true }, as: 'svc' });

    const write = await call('PUT', `/api/clubs/${f.club.id}/availability`, { body: { date: DATE, status: 'no' }, as: 'member' });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, 'CLUB_SUSPENDED');
    assert.equal((await call('POST', `/api/clubs/${f.club.id}/invites`, { as: 'pres' })).status, 403);
    assert.equal((await call('GET', `/api/clubs/${f.club.id}/calendar?month=${MONTH}`, { as: 'member' })).status, 200);
    assert.equal((await call('PATCH', `/api/clubs/${f.club.id}`, { body: { name: '관리자수정' }, as: 'svc' })).status, 200);
  });
});

// ==========================================================================
describe('계정', () => {
  test('표시 이름·비밀번호 변경 — 로그인한 사람은 누구나 본인 것만', async () => {
    for (const persona of ['member', 'pres', 'svc']) {
      assert.equal((await call('PATCH', '/api/me', { body: { display_name: `${persona}새이름` }, as: persona })).status, 200);
      assert.equal((await call('POST', '/api/auth/password',
        { body: { current: PW, next: `${PW}-next` }, as: persona })).status, 200);
      // 되돌려서 뒤 테스트가 같은 비밀번호를 쓸 수 있게 합니다.
      assert.equal((await call('POST', '/api/auth/password',
        { body: { current: `${PW}-next`, next: PW }, as: persona })).status, 200);
    }
    assert.equal((await call('PATCH', '/api/me', { body: { display_name: '비로그인' }, as: 'anon' })).status, 401);
    assert.equal((await call('POST', '/api/auth/password', { body: { current: PW, next: PW }, as: 'anon' })).status, 401);
  });

  test('계정 탈퇴 — 회장인 동아리를 정리한 뒤에만', async () => {
    const f = await freshClub();
    const blocked = await call('DELETE', '/api/me', { as: 'pres' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'PRESIDENT_MUST_TRANSFER');
    assert.equal(blocked.body.clubs.length, 1);

    assert.equal((await call('POST', `/api/clubs/${f.club.id}/transfer`,
      { body: { to_user_id: f.member.id }, as: 'pres' })).status, 200);
    assert.equal((await call('DELETE', '/api/me', { as: 'pres' })).status, 200, '넘긴 뒤에는 탈퇴 가능');
    assert.equal((await call('GET', '/api/auth/me', { as: 'pres' })).status, 401, '세션도 끊김');

    // 탈퇴하면 그 사람의 일정·멤버십도 함께 사라집니다.
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE user_id = ?').get(f.pres.id).c, 0);
  });

  test('마지막 서비스 관리자는 탈퇴·권한 회수가 막힌다', async () => {
    // 이 테스트 DB 에는 서비스 관리자가 여러 명이라, 나머지를 잠시 내려 마지막 1명 상황을 만듭니다.
    const admins = db.prepare('SELECT id FROM users WHERE is_service_admin = 1').all().map((r) => r.id);
    const solo = (await call('GET', '/api/auth/me', { as: 'svc' })).body.id;
    const others = admins.filter((id) => id !== solo);
    db.prepare(`UPDATE users SET is_service_admin = 0 WHERE id IN (${others.map(() => '?').join(',') || '0'})`).run(...others);

    const leave = await call('DELETE', '/api/me', { as: 'svc' });
    assert.equal(leave.status, 409);
    assert.equal(leave.body.code, 'LAST_SERVICE_ADMIN');

    const revoke = await call('POST', `/api/admin/users/${solo}/revoke-admin`, { as: 'svc' });
    assert.equal(revoke.status, 409);
    assert.equal(revoke.body.code, 'LAST_SERVICE_ADMIN');

    db.prepare(`UPDATE users SET is_service_admin = 1 WHERE id IN (${others.map(() => '?').join(',') || '0'})`).run(...others);
  });
});

// ==========================================================================
describe('플랫폼 — 서비스 관리자 콘솔', () => {
  let target;
  before(async () => { target = await freshClub(); });

  const READS = [
    ['전체 통계', 'GET', '/api/admin/stats'],
    ['전체 동아리 조회', 'GET', '/api/admin/clubs'],
    ['전체 회원 조회', 'GET', '/api/admin/users'],
    ['서비스 정책 조회', 'GET', '/api/admin/policies'],
    ['공지 목록', 'GET', '/api/admin/notices'],
    ['신고 목록', 'GET', '/api/admin/reports']
  ];

  for (const [label, method, url] of READS) {
    test(`${label} — 서비스 관리자만`, async () => {
      assert.equal((await call(method, url, { as: 'svc' })).status, 200);
      for (const persona of ['pres', 'member', 'outsider']) {
        const res = await call(method, url, { as: persona });
        assert.equal(res.status, 403, `${label} · ${persona}`);
        assert.equal(res.body.code, 'NEED_SERVICE_ADMIN');
      }
      assert.equal((await call(method, url, { as: 'anon' })).status, 401);
    });
  }

  test('동아리 정지 / 해제 / 삭제 — 서비스 관리자만', async () => {
    const suspend = (as) => call('POST', `/api/admin/clubs/${target.club.id}/suspend`, { body: { suspend: true }, as });
    for (const persona of ['pres', 'member', 'outsider']) assert.equal((await suspend(persona)).status, 403, persona);
    assert.equal((await suspend('anon')).status, 401);
    assert.equal((await suspend('svc')).status, 200);
    assert.equal((await call('POST', `/api/admin/clubs/${target.club.id}/suspend`,
      { body: { suspend: false }, as: 'svc' })).status, 200);

    const doomed = await freshClub();
    assert.equal((await call('DELETE', `/api/admin/clubs/${doomed.club.id}`, { as: 'pres' })).status, 403);
    assert.equal((await call('DELETE', `/api/admin/clubs/${doomed.club.id}`, { as: 'svc' })).status, 200);
  });

  test('계정 정지 / 비밀번호 초기화 — 서비스 관리자만, 자기 계정 정지는 불가', async () => {
    const victim = target.member.id;
    for (const persona of ['pres', 'member', 'outsider']) {
      assert.equal((await call('POST', `/api/admin/users/${victim}/suspend`, { body: { suspend: true }, as: persona })).status, 403);
      assert.equal((await call('POST', `/api/admin/users/${victim}/reset-password`, { as: persona })).status, 403);
    }
    assert.equal((await call('POST', `/api/admin/users/${victim}/reset-password`, { as: 'anon' })).status, 401);

    const reset = await call('POST', `/api/admin/users/${victim}/reset-password`, { as: 'svc' });
    assert.equal(reset.status, 200);
    assert.match(reset.body.temporary_password, /^sb-[0-9a-f]{12}$/);

    const me = (await call('GET', '/api/auth/me', { as: 'svc' })).body;
    const self = await call('POST', `/api/admin/users/${me.id}/suspend`, { body: { suspend: true }, as: 'svc' });
    assert.equal(self.status, 409);
    assert.equal(self.body.code, 'CANNOT_SUSPEND_SELF');

    assert.equal((await call('POST', `/api/admin/users/${victim}/suspend`, { body: { suspend: true }, as: 'svc' })).status, 200);
    assert.equal((await call('POST', '/api/auth/login',
      { body: { username: target.member.username, password: reset.body.temporary_password } })).status, 401,
    '정지된 계정은 로그인 불가');
    assert.equal((await call('POST', `/api/admin/users/${victim}/suspend`, { body: { suspend: false }, as: 'svc' })).status, 200);
  });

  test('서비스 전역 정책 변경 — 서비스 관리자만, 가입 차단이 실제로 걸린다', async () => {
    for (const persona of ['pres', 'member', 'outsider']) {
      assert.equal((await call('PATCH', '/api/admin/policies', { body: { signup_enabled: false }, as: persona })).status, 403);
    }
    assert.equal((await call('PATCH', '/api/admin/policies', { body: { signup_enabled: false }, as: 'anon' })).status, 401);

    assert.equal((await call('PATCH', '/api/admin/policies', { body: { signup_enabled: false }, as: 'svc' })).status, 200);
    const blocked = await call('POST', '/api/auth/signup',
      { body: { username: `blocked${++seq}`, display_name: '막힘', password: PW } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'SIGNUP_DISABLED');
    assert.equal((await call('PATCH', '/api/admin/policies', { body: { signup_enabled: true }, as: 'svc' })).status, 200);
  });

  test('서비스 공지 발행 — 서비스 관리자만, 회원은 읽기만', async () => {
    const body = { title: '점검 안내', body: '토요일 오전에 잠깐 멈춥니다.' };
    for (const persona of ['pres', 'member', 'outsider']) {
      assert.equal((await call('POST', '/api/admin/notices', { body, as: persona })).status, 403);
    }
    const created = await call('POST', '/api/admin/notices', { body, as: 'svc' });
    assert.equal(created.status, 201);

    assert.equal((await call('GET', '/api/notices', { as: 'member' })).status, 200, '회원은 읽을 수 있음');
    assert.equal((await call('GET', '/api/notices', { as: 'anon' })).status, 401);
    assert.equal((await call('DELETE', `/api/admin/notices/${created.body.id}`, { as: 'member' })).status, 403);
    assert.equal((await call('DELETE', `/api/admin/notices/${created.body.id}`, { as: 'svc' })).status, 200);
  });

  test('신고 처리 — 서비스 관리자만', async () => {
    db.prepare("INSERT INTO reports (target_type, target_id, reason) VALUES ('club', ?, '광고성 동아리')")
      .run(target.club.id);
    const report = (await call('GET', '/api/admin/reports?status=open', { as: 'svc' })).body.reports.at(-1);

    for (const persona of ['pres', 'member']) {
      assert.equal((await call('POST', `/api/admin/reports/${report.id}/resolve`,
        { body: { status: 'resolved' }, as: persona })).status, 403);
    }
    assert.equal((await call('POST', `/api/admin/reports/${report.id}/resolve`,
      { body: { status: 'resolved' }, as: 'svc' })).status, 200);
  });

  test('서비스 관리자 권한 부여 / 회수 — 서비스 관리자만', async () => {
    // 이름표('member' 등)는 가장 최근 freshClub() 의 사용자를 가리킵니다.
    // 부여 대상은 지금 그 쿠키의 주인이어야 하므로 세션에서 직접 읽습니다.
    const memberId = (await call('GET', '/api/auth/me', { as: 'member' })).body.id;
    const grant = (as) => call('POST', `/api/admin/users/${memberId}/grant-admin`, { as });

    for (const persona of ['pres', 'member', 'outsider']) assert.equal((await grant(persona)).status, 403, persona);
    assert.equal((await grant('anon')).status, 401);

    assert.equal((await grant('svc')).status, 200);
    assert.equal((await call('GET', '/api/admin/stats', { as: 'member' })).status, 200, '권한을 받으면 콘솔이 열림');
    assert.equal((await call('POST', `/api/admin/users/${memberId}/revoke-admin`, { as: 'svc' })).status, 200);
    assert.equal((await call('GET', '/api/admin/stats', { as: 'member' })).status, 403, '회수하면 다시 막힘');
  });
});
