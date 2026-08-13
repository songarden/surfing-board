// 동아리·초대·달력·일정·확정·관리자 API. 도메인 규칙 위주로 확인합니다.
// 권한 셀별 허용/거부는 tests/permissions.test.js 와 6단계 테스트가 담당합니다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'surfboard-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-only-secret-0123456789abcdef0123456789abcdef';
process.env.COOKIE_SECURE = 'false';
// 추천 날짜가 "지난 날짜 제외" 라서 실제 날짜에 따라 결과가 흔들립니다. 2026-08 이 전부 미래인
// 날로 고정해 이 파일의 집계 단정을 안정화합니다 (server/lib/today.js).
process.env.SURFBOARD_TODAY = '2026-08-01';

const { db, migrate } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { selectableDays } = await import('../server/lib/calendar.js');
migrate();

// 2026-08 은 토요일로 시작하고 8/17 이 광복절 대체휴일입니다 → 평일 21일, 표시 가능 20일.
const MONTH = '2026-08';
const HOLIDAY = '2026-08-17';
const SUNDAY = '2026-08-16';

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

const jar = {};
async function call(method, url, { body, as } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Cookie: jar[as] } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** 가입하고 쿠키를 jar[key] 에 담아 둡니다. */
async function user(key, displayName, { serviceAdmin = false } = {}) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: key, display_name: displayName, password: 'surfboard-2026' })
  });
  const body = await res.json();
  jar[key] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (serviceAdmin) db.prepare('UPDATE users SET is_service_admin = 1 WHERE id = ?').run(body.id);
  return body.id;
}

let ids = {};
let clubId;
let inviteToken;

describe('동아리 만들기', () => {
  test('가입한 사람 셋 + 서비스 관리자 하나를 준비한다', async () => {
    ids.minsu = await user('minsu', '민수');
    ids.jihun = await user('jihun', '지훈');
    ids.yujin = await user('yujin', '유진');
    ids.admin = await user('svcadmin', '서비스관리자', { serviceAdmin: true });
    assert.ok(ids.minsu && ids.admin);
  });

  test('만든 사람이 회장이 된다', async () => {
    const r = await call('POST', '/api/clubs', { body: { name: '서핑보드' }, as: 'minsu' });
    assert.equal(r.status, 201);
    assert.equal(r.body.my_role, 'president');
    clubId = r.body.id;

    const list = await call('GET', '/api/clubs', { as: 'minsu' });
    assert.equal(list.body.clubs.length, 1);
    assert.equal(list.body.clubs[0].member_count, 1);
    assert.equal(list.body.clubs[0].my_month_state, 'unconfirmed');
  });

  test('이름이 비었거나 30자를 넘으면 400', async () => {
    assert.equal((await call('POST', '/api/clubs', { body: { name: '  ' }, as: 'minsu' })).status, 400);
    assert.equal((await call('POST', '/api/clubs', { body: { name: 'x'.repeat(31) }, as: 'minsu' })).status, 400);
  });

  test('소속되지 않은 사람에게는 목록에 보이지 않는다', async () => {
    assert.equal((await call('GET', '/api/clubs', { as: 'jihun' })).body.clubs.length, 0);
  });
});

describe('초대', () => {
  test('회장이 발급하고 미리보기를 볼 수 있다', async () => {
    const r = await call('POST', `/api/clubs/${clubId}/invites`, { body: { max_uses: 5 }, as: 'minsu' });
    assert.equal(r.status, 201);
    assert.ok(r.body.token);
    assert.ok(r.body.expires_at, '정책 기본값 7일이 적용됩니다');
    inviteToken = r.body.token;

    const preview = await call('GET', `/api/invites/${inviteToken}`, { as: 'jihun' });
    assert.equal(preview.body.club.name, '서핑보드');
    assert.equal(preview.body.club.president_name, '민수');
    assert.equal(preview.body.already_member, false);
  });

  // 회장이 localhost 로 열어서 만든 링크를 남에게 주면 받는 쪽 localhost 로 가버립니다.
  test('초대 응답은 그대로 전달할 수 있는 절대 주소를 준다', async () => {
    const issue = () => call('POST', `/api/clubs/${clubId}/invites`, { as: 'minsu' });
    const list = () => call('GET', `/api/clubs/${clubId}/invites`, { as: 'minsu' });

    // PUBLIC_BASE_URL 이 없으면 요청이 들어온 주소를 씁니다.
    delete process.env.PUBLIC_BASE_URL;
    const bare = (await issue()).body;
    assert.equal(bare.url, `${base}/invite.html?token=${bare.token}`);

    // 있으면 그 값이 이깁니다. 뒤에 붙은 / 는 떼어냅니다.
    process.env.PUBLIC_BASE_URL = 'http://192.168.0.10:8888/';
    const fixed = (await issue()).body;
    assert.equal(fixed.url, `http://192.168.0.10:8888/invite.html?token=${fixed.token}`);
    const listed = (await list()).body.invites.find((i) => i.token === fixed.token);
    assert.equal(listed.url, fixed.url, '목록도 같은 주소를 줍니다');

    // 형식이 틀리면 무시하고 요청 주소로 돌아갑니다 (링크가 깨지는 것보다 낫습니다).
    process.env.PUBLIC_BASE_URL = '192.168.0.10:8888';
    const bad = (await issue()).body;
    assert.equal(bad.url, `${base}/invite.html?token=${bad.token}`);
    delete process.env.PUBLIC_BASE_URL;
  });

  test('수락하면 회원이 되고 색이 겹치지 않는다', async () => {
    assert.equal((await call('POST', `/api/invites/${inviteToken}/accept`, { as: 'jihun' })).status, 201);
    assert.equal((await call('POST', `/api/invites/${inviteToken}/accept`, { as: 'yujin' })).status, 201);

    const members = (await call('GET', `/api/clubs/${clubId}/members`, { as: 'minsu' })).body.members;
    assert.equal(members.length, 3);
    assert.equal(members[0].role, 'president', '회장이 맨 위');
    assert.equal(new Set(members.map((m) => m.member_color)).size, 3);
  });

  test('이미 회원이면 409, 회수한 링크는 410', async () => {
    const again = await call('POST', `/api/invites/${inviteToken}/accept`, { as: 'jihun' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_MEMBER');

    const extra = (await call('POST', `/api/clubs/${clubId}/invites`, { as: 'minsu' })).body.token;
    assert.equal((await call('DELETE', `/api/invites/${extra}`, { as: 'minsu' })).status, 200);
    const dead = await call('GET', `/api/invites/${extra}`, { as: 'jihun' });
    assert.equal(dead.status, 410);
    assert.equal(dead.body.code, 'INVITE_REVOKED');
  });

  test('최대 인원이 차면 409 CLUB_FULL', async () => {
    db.prepare('UPDATE service_policies SET club_max_members = 3 WHERE id = 1').run();
    await user('sujin', '수진');
    const r = await call('POST', `/api/invites/${inviteToken}/accept`, { as: 'sujin' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CLUB_FULL');
    db.prepare('UPDATE service_policies SET club_max_members = 50 WHERE id = 1').run();
  });
});

describe('달력 집계 — 미선택 평일 = 가능', () => {
  test('아무도 표시하지 않았으면 모든 평일이 전원 가능(풀파티)', async () => {
    const r = await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'minsu' });
    assert.equal(r.status, 200);
    assert.equal(r.body.days.length, 21, '2026-08 평일 21일');
    assert.equal(r.body.summary.member_count, 3);
    assert.equal(r.body.summary.best_count, 3, '표시가 없으면 전원 가능');
    assert.equal(r.body.summary.full_party_dates.length, 20, '공휴일 8/17 은 후보에서 빠짐');
    assert.equal(r.body.my_month_state, 'unconfirmed');
  });

  test('공휴일 타일은 selectable=false 이고 카운트가 0', async () => {
    const r = await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'minsu' });
    const holiday = r.body.days.find((d) => d.date === HOLIDAY);
    assert.equal(holiday.selectable, false);
    assert.equal(holiday.holiday, '광복절 대체휴일');
    assert.equal(holiday.ok_count, 0);
    assert.deepEqual(holiday.statuses, {});
    assert.equal(r.body.days.filter((d) => d.selectable).length, selectableDays(MONTH).length);
  });

  test('불가·미정을 표시하면 가능 인원에서 빠진다', async () => {
    assert.equal((await call('PUT', `/api/clubs/${clubId}/availability`,
      { body: { date: '2026-08-13', status: 'no' }, as: 'jihun' })).status, 200);
    assert.equal((await call('PUT', `/api/clubs/${clubId}/availability`,
      { body: { date: '2026-08-13', status: 'maybe' }, as: 'yujin' })).status, 200);

    const day = (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'jihun' }))
      .body.days.find((d) => d.date === '2026-08-13');
    assert.equal(day.ok_count, 1);
    assert.equal(day.no_count, 1);
    assert.equal(day.maybe_count, 1);
    assert.equal(day.full_party, false);
    assert.equal(day.my_status, 'no', '요청한 사람의 상태');
  });

  test('추천 날짜는 가능 인원 최다인 평일이고, 8/13 은 빠진다', async () => {
    const s = (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'minsu' })).body.summary;
    assert.equal(s.best_count, 3);
    assert.equal(s.best_dates.includes('2026-08-13'), false);
    assert.equal(s.best_dates.length, 19);
    // 8/13 은 불가 1명 + 미정 1명이라 가능이 1명뿐 → 2등(가능 2명)에도 들지 않습니다.
    assert.deepEqual(s.runner_up_dates, []);
    assert.equal(s.today, '2026-08-01');
    assert.equal(s.past_excluded, 0, '고정한 오늘이 이 달 첫날이라 지난 평일이 없습니다');
  });

  // 지난 날짜로는 모임을 잡을 수 없습니다. 달력 타일은 그대로 남기고 추천에서만 뺍니다.
  describe('지난 날짜는 추천에서 제외 (한국 날짜 기준)', () => {
    const ask = async () => (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'minsu' })).body;
    after(() => { process.env.SURFBOARD_TODAY = '2026-08-01'; });

    test('오늘 이전 평일은 후보에서 빠지고 오늘은 남는다', async () => {
      process.env.SURFBOARD_TODAY = '2026-08-20';
      const body = await ask();
      assert.equal(body.summary.today, '2026-08-20');
      assert.equal(body.summary.past_excluded, 12, '8/3~8/19 평일 13일 중 8/17 은 공휴일이라 애초에 후보가 아님');
      assert.ok(body.summary.best_dates.every((d) => d >= '2026-08-20'), '지난 날짜가 남아 있습니다');
      assert.ok(body.summary.best_dates.includes('2026-08-20'), '오늘은 아직 후보입니다');
      assert.ok(body.summary.full_party_dates.every((d) => d >= '2026-08-20'));
      assert.equal(body.days.length, 21, '달력 타일은 지난 날짜도 그대로 보여줍니다');
    });

    test('그 달이 전부 지났으면 후보가 비고 past_excluded 로 이유를 알 수 있다', async () => {
      process.env.SURFBOARD_TODAY = '2026-09-15';
      const body = await ask();
      assert.deepEqual(body.summary.best_dates, []);
      assert.equal(body.summary.best_count, 0);
      assert.deepEqual(body.summary.runner_up_dates, []);
      assert.equal(body.summary.past_excluded, 20, '8월 평일 21일 - 공휴일 1일');
      assert.equal(body.days.length, 21);
    });
  });

  test("'가능'은 저장하지 않는다 — status:'yes' 는 400", async () => {
    const r = await call('PUT', `/api/clubs/${clubId}/availability`,
      { body: { date: '2026-08-14', status: 'yes' }, as: 'jihun' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'YES_NOT_STORED');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM availability WHERE status = 'yes'").get().c, 0);
  });

  test('null 을 보내면 행이 지워져 가능으로 돌아간다', async () => {
    await call('PUT', `/api/clubs/${clubId}/availability`,
      { body: { date: '2026-08-13', status: null }, as: 'jihun' });
    const day = (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'jihun' }))
      .body.days.find((d) => d.date === '2026-08-13');
    assert.equal(day.my_status, null);
    assert.equal(day.ok_count, 2);
  });

  test('주말·공휴일은 표시할 수 없다 — 400 NOT_SELECTABLE', async () => {
    for (const date of [HOLIDAY, SUNDAY]) {
      const r = await call('PUT', `/api/clubs/${clubId}/availability`, { body: { date, status: 'no' }, as: 'jihun' });
      assert.equal(r.status, 400, date);
      assert.equal(r.body.code, 'NOT_SELECTABLE', date);
    }
  });
});

describe('일괄 입력', () => {
  test('요일 통째로 불가 — 공휴일은 자동으로 건너뛴다', async () => {
    const r = await call('POST', `/api/clubs/${clubId}/availability/bulk`,
      { body: { op: 'weekday_off', month: MONTH, dow: 1 }, as: 'jihun' });   // 8월 월요일: 3·10·17·24·31
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, 4, '8/17 은 공휴일이라 제외');

    const days = (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'jihun' })).body.days;
    assert.equal(days.find((d) => d.date === '2026-08-03').my_status, 'no');
    assert.equal(days.find((d) => d.date === HOLIDAY).my_status, null);
  });

  test('해제하면 다시 가능으로 돌아간다', async () => {
    const r = await call('POST', `/api/clubs/${clubId}/availability/bulk`,
      { body: { op: 'weekday_off', month: MONTH, dow: 1, on: false }, as: 'jihun' });
    assert.equal(r.body.cleared, 4);
  });

  test('전부 가능 — 그 달 표시를 모두 지운다', async () => {
    await call('PUT', `/api/clubs/${clubId}/availability`, { body: { date: '2026-08-20', status: 'no' }, as: 'jihun' });
    const r = await call('POST', `/api/clubs/${clubId}/availability/bulk`,
      { body: { op: 'all_ok', month: MONTH }, as: 'jihun' });
    assert.equal(r.body.cleared, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM availability WHERE date LIKE '2026-08-%'").get().c, 1,
      '유진의 8/13 미정만 남습니다');
  });

  test('지난달 패턴 복사 — 이번 달에 못 쓰는 날은 건너뛴다', async () => {
    await call('PUT', `/api/clubs/${clubId}/availability`, { body: { date: '2026-07-13', status: 'no' }, as: 'jihun' });
    await call('PUT', `/api/clubs/${clubId}/availability`, { body: { date: '2026-07-17', status: 'maybe' }, as: 'jihun' });

    const r = await call('POST', `/api/clubs/${clubId}/availability/bulk`,
      { body: { op: 'copy_last', month: MONTH }, as: 'jihun' });
    assert.equal(r.body.from, '2026-07');
    assert.equal(r.body.copied, 1, '7/13 → 8/13 만 복사');
    assert.equal(r.body.skipped, 1, '7/17 → 8/17 은 공휴일이라 건너뜀');
  });

  test('set — 수정 모드에서 모아둔 변경을 한 번에 커밋한다', async () => {
    const r = await call('POST', `/api/clubs/${clubId}/availability/bulk`, {
      body: {
        op: 'set',
        month: MONTH,
        entries: { '2026-08-13': null, '2026-08-20': 'maybe', [HOLIDAY]: 'no', '2026-09-01': 'no' }
      },
      as: 'jihun'
    });
    assert.equal(r.body.saved, 1);
    assert.equal(r.body.cleared, 1);
    assert.equal(r.body.skipped, 2, '공휴일과 다른 달 날짜는 건너뜁니다');
  });

  test('알 수 없는 op 는 400', async () => {
    assert.equal((await call('POST', `/api/clubs/${clubId}/availability/bulk`,
      { body: { op: 'wipe_everything', month: MONTH }, as: 'jihun' })).status, 400);
  });
});

describe('월 확정 상태 머신', () => {
  test('확정하면 잠기고 일정 변경은 409', async () => {
    const c = await call('POST', `/api/clubs/${clubId}/confirm?month=${MONTH}`, { as: 'jihun' });
    assert.equal(c.body.state, 'confirmed');

    const cal = await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'jihun' });
    assert.equal(cal.body.my_month_state, 'confirmed');
    assert.equal(cal.body.summary.confirmed_count, 1);
    assert.deepEqual(cal.body.summary.unconfirmed_members.map((m) => m.display_name), ['민수', '유진']);

    const blocked = await call('PUT', `/api/clubs/${clubId}/availability`,
      { body: { date: '2026-08-21', status: 'no' }, as: 'jihun' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'MONTH_LOCKED');
    assert.equal((await call('POST', `/api/clubs/${clubId}/availability/bulk`,
      { body: { op: 'all_ok', month: MONTH }, as: 'jihun' })).status, 409, '일괄 입력도 막힙니다');
  });

  test('일정 변경을 누르면 수정 중이 되고 다시 쓸 수 있다', async () => {
    const u = await call('POST', `/api/clubs/${clubId}/unconfirm?month=${MONTH}`, { as: 'jihun' });
    assert.equal(u.body.state, 'editing');
    assert.equal((await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'jihun' }))
      .body.my_month_state, 'editing');
    assert.equal((await call('PUT', `/api/clubs/${clubId}/availability`,
      { body: { date: '2026-08-21', status: 'no' }, as: 'jihun' })).status, 200);
  });

  test('확정 저장 — entries 를 함께 보내면 저장과 잠금이 한 번에 된다', async () => {
    const r = await call('POST', `/api/clubs/${clubId}/confirm?month=${MONTH}`, {
      body: { entries: { '2026-08-21': null, '2026-08-25': 'no' } },
      as: 'jihun'
    });
    assert.equal(r.body.state, 'confirmed');
    assert.deepEqual(r.body.applied, { saved: 1, cleared: 1, skipped: 0 });

    const days = (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'jihun' })).body.days;
    assert.equal(days.find((d) => d.date === '2026-08-25').my_status, 'no');
    assert.equal(days.find((d) => d.date === '2026-08-21').my_status, null);
  });

  test('확정하지 않은 달에 일정 변경을 누르면 409 NOT_CONFIRMED', async () => {
    const r = await call('POST', `/api/clubs/${clubId}/unconfirm?month=2026-12`, { as: 'jihun' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NOT_CONFIRMED');
  });

  test('잠금은 그 달에만 걸린다', async () => {
    assert.equal((await call('PUT', `/api/clubs/${clubId}/availability`,
      { body: { date: '2026-09-14', status: 'no' }, as: 'jihun' })).status, 200);
  });
});

describe('공용 메모', () => {
  test('회원 누구나 쓰고 지울 수 있다', async () => {
    await call('PUT', `/api/clubs/${clubId}/notes`, { body: { date: '2026-08-20', text: 'OO팀 한마음' }, as: 'yujin' });
    let days = (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'minsu' })).body.days;
    assert.equal(days.find((d) => d.date === '2026-08-20').note, 'OO팀 한마음');

    await call('PUT', `/api/clubs/${clubId}/notes`, { body: { date: '2026-08-20', text: '  ' }, as: 'minsu' });
    days = (await call('GET', `/api/clubs/${clubId}/calendar?month=${MONTH}`, { as: 'minsu' })).body.days;
    assert.equal(days.find((d) => d.date === '2026-08-20').note, '');
  });
});

describe('회장직·탈퇴·삭제', () => {
  test('회장직을 넘기면 이전 회장은 일반 회원이 된다', async () => {
    const r = await call('POST', `/api/clubs/${clubId}/transfer`, { body: { to_user_id: ids.jihun }, as: 'minsu' });
    assert.equal(r.status, 200);
    const members = (await call('GET', `/api/clubs/${clubId}/members`, { as: 'minsu' })).body.members;
    assert.equal(members.filter((m) => m.role === 'president').length, 1);
    assert.equal(members.find((m) => m.user_id === ids.jihun).role, 'president');
    assert.equal(members.find((m) => m.user_id === ids.minsu).role, 'member');
  });

  test('회장은 내보낼 수 없다', async () => {
    const r = await call('DELETE', `/api/clubs/${clubId}/members/${ids.jihun}`, { as: 'jihun' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CANNOT_REMOVE_PRESIDENT');
  });

  test('회장은 바로 나갈 수 없고, 회원은 나갈 때 일정도 사라진다', async () => {
    const pres = await call('DELETE', `/api/clubs/${clubId}/leave`, { as: 'jihun' });
    assert.equal(pres.status, 409);
    assert.equal(pres.body.code, 'PRESIDENT_MUST_TRANSFER');

    const before = db.prepare('SELECT COUNT(*) AS c FROM availability').get().c;
    assert.equal((await call('DELETE', `/api/clubs/${clubId}/leave`, { as: 'yujin' })).status, 200);
    assert.ok(db.prepare('SELECT COUNT(*) AS c FROM availability').get().c < before, '탈퇴하면 일정도 함께 사라집니다');
    assert.equal((await call('GET', `/api/clubs/${clubId}`, { as: 'yujin' })).status, 404);
  });

  test('내보내면 그 회원은 접근할 수 없다', async () => {
    assert.equal((await call('DELETE', `/api/clubs/${clubId}/members/${ids.minsu}`, { as: 'jihun' })).status, 200);
    assert.equal((await call('GET', `/api/clubs/${clubId}`, { as: 'minsu' })).status, 404);
  });

  test('삭제는 이름을 그대로 입력해야 한다', async () => {
    const wrong = await call('DELETE', `/api/clubs/${clubId}`, { body: { name: '서핑보드!' }, as: 'jihun' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'NAME_CONFIRMATION_REQUIRED');
    assert.equal((await call('DELETE', `/api/clubs/${clubId}`, { body: { name: '서핑보드' }, as: 'jihun' })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM clubs').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memberships').get().c, 0, '멤버십도 CASCADE 로 정리');
  });
});

describe('계정 설정', () => {
  test('표시 이름을 바꿀 수 있다', async () => {
    assert.equal((await call('PATCH', '/api/me', { body: { display_name: '민수님' }, as: 'minsu' })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { as: 'minsu' })).body.display_name, '민수님');
    assert.equal((await call('PATCH', '/api/me', { body: { display_name: '' }, as: 'minsu' })).status, 400);
  });

  test('회장으로 있는 동아리가 있으면 탈퇴가 막힌다', async () => {
    const club = (await call('POST', '/api/clubs', { body: { name: '탈퇴테스트' }, as: 'minsu' })).body;
    const blocked = await call('DELETE', '/api/me', { as: 'minsu' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'PRESIDENT_MUST_TRANSFER');

    await call('DELETE', `/api/clubs/${club.id}`, { body: { name: '탈퇴테스트' }, as: 'minsu' });
    assert.equal((await call('DELETE', '/api/me', { as: 'minsu' })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { as: 'minsu' })).status, 401);
  });
});

describe('서비스 관리자 콘솔', () => {
  test('통계 카드 4개 값을 준다', async () => {
    await call('POST', '/api/clubs', { body: { name: '콘솔테스트' }, as: 'jihun' });
    const r = await call('GET', '/api/admin/stats', { as: 'svcadmin' });
    assert.equal(r.status, 200);
    assert.ok(r.body.club_count >= 1);
    assert.ok(r.body.user_count >= 3);
    assert.equal(typeof r.body.active_club_count, 'number');
    assert.equal(r.body.open_report_count, 0);
  });

  test('일반 회원은 콘솔 API 를 쓸 수 없다', async () => {
    for (const url of ['/api/admin/stats', '/api/admin/clubs', '/api/admin/users', '/api/admin/policies']) {
      const r = await call('GET', url, { as: 'jihun' });
      assert.equal(r.status, 403, url);
      assert.equal(r.body.code, 'NEED_SERVICE_ADMIN', url);
    }
  });

  test('동아리를 정지하면 회원의 변경이 막히고, 해제하면 풀린다', async () => {
    const club = (await call('GET', '/api/admin/clubs', { as: 'svcadmin' })).body.clubs[0];
    assert.equal(club.president_name, '지훈');

    await call('POST', `/api/admin/clubs/${club.id}/suspend`, { body: { suspend: true }, as: 'svcadmin' });
    const blocked = await call('PUT', `/api/clubs/${club.id}/availability`,
      { body: { date: '2026-08-20', status: 'no' }, as: 'jihun' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'CLUB_SUSPENDED');
    assert.equal((await call('GET', `/api/clubs/${club.id}/calendar?month=${MONTH}`, { as: 'jihun' })).status, 200,
      '조회는 계속 됩니다');

    await call('POST', `/api/admin/clubs/${club.id}/suspend`, { body: { suspend: false }, as: 'svcadmin' });
    assert.equal((await call('PUT', `/api/clubs/${club.id}/availability`,
      { body: { date: '2026-08-20', status: 'no' }, as: 'jihun' })).status, 200);
  });

  test('계정 정지·비밀번호 초기화', async () => {
    const users = (await call('GET', '/api/admin/users', { as: 'svcadmin' })).body.users;
    const target = users.find((u) => u.username === 'sujin');
    assert.equal(target.club_count, 0);

    const reset = await call('POST', `/api/admin/users/${target.id}/reset-password`, { as: 'svcadmin' });
    assert.match(reset.body.temporary_password, /^sb-[0-9a-f]{12}$/);
    assert.equal((await call('POST', '/api/auth/login',
      { body: { username: 'sujin', password: reset.body.temporary_password } })).status, 200);

    await call('POST', `/api/admin/users/${target.id}/suspend`, { body: { suspend: true }, as: 'svcadmin' });
    assert.equal((await call('POST', '/api/auth/login',
      { body: { username: 'sujin', password: reset.body.temporary_password } })).status, 401);
  });

  test('자기 계정은 정지할 수 없고, 마지막 관리자 권한은 회수할 수 없다', async () => {
    const me = (await call('GET', '/api/auth/me', { as: 'svcadmin' })).body;
    assert.equal((await call('POST', `/api/admin/users/${me.id}/suspend`, { body: { suspend: true }, as: 'svcadmin' }))
      .body.code, 'CANNOT_SUSPEND_SELF');
    assert.equal((await call('POST', `/api/admin/users/${me.id}/revoke-admin`, { as: 'svcadmin' }))
      .body.code, 'LAST_SERVICE_ADMIN');
  });

  test('권한을 주고 회수할 수 있다', async () => {
    const jihunId = (await call('GET', '/api/admin/users', { as: 'svcadmin' })).body.users
      .find((u) => u.username === 'jihun').id;
    assert.equal((await call('POST', `/api/admin/users/${jihunId}/grant-admin`, { as: 'svcadmin' })).status, 200);
    assert.equal((await call('GET', '/api/admin/stats', { as: 'jihun' })).status, 200);
    assert.equal((await call('POST', `/api/admin/users/${jihunId}/revoke-admin`, { as: 'svcadmin' })).status, 200);
    assert.equal((await call('GET', '/api/admin/stats', { as: 'jihun' })).status, 403);
  });

  test('정책을 바꾸면 가입이 막힌다', async () => {
    const r = await call('PATCH', '/api/admin/policies',
      { body: { signup_enabled: false, invite_default_days: 30, club_max_members: 0 }, as: 'svcadmin' });
    assert.deepEqual(r.body, { signup_enabled: 0, invite_default_days: 30, club_max_members: 0 });
    assert.equal((await call('POST', '/api/auth/signup',
      { body: { username: 'nope', display_name: '안됨', password: 'surfboard-2026' } })).body.code, 'SIGNUP_DISABLED');

    await call('PATCH', '/api/admin/policies', { body: { signup_enabled: true }, as: 'svcadmin' });
    assert.equal((await call('PATCH', '/api/admin/policies',
      { body: { invite_default_days: -1 }, as: 'svcadmin' })).status, 400);
  });

  test('공지를 발행하면 회원이 읽을 수 있다', async () => {
    const created = await call('POST', '/api/admin/notices',
      { body: { title: '9월 정기 모임 안내', body: '추석 연휴가 있습니다.' }, as: 'svcadmin' });
    assert.equal(created.status, 201);

    const read = await call('GET', '/api/notices', { as: 'jihun' });
    assert.equal(read.body.notices[0].title, '9월 정기 모임 안내');
    assert.equal((await call('GET', '/api/notices')).status, 401, '비로그인은 못 봅니다');
    assert.equal((await call('POST', '/api/admin/notices',
      { body: { title: '', body: 'x' }, as: 'svcadmin' })).status, 400);
    assert.equal((await call('DELETE', `/api/admin/notices/${created.body.id}`, { as: 'svcadmin' })).status, 200);
  });

  test('신고를 처리할 수 있다', async () => {
    db.prepare("INSERT INTO reports (target_type, target_id, reason) VALUES ('user', 1, '스팸 계정입니다')").run();
    const open = await call('GET', '/api/admin/reports?status=open', { as: 'svcadmin' });
    assert.equal(open.body.reports.length, 1);
    assert.equal((await call('GET', '/api/admin/stats', { as: 'svcadmin' })).body.open_report_count, 1);

    const id = open.body.reports[0].id;
    assert.equal((await call('POST', `/api/admin/reports/${id}/resolve`,
      { body: { status: 'dismissed' }, as: 'svcadmin' })).status, 200);
    assert.equal((await call('GET', '/api/admin/reports?status=open', { as: 'svcadmin' })).body.reports.length, 0);
  });
});
