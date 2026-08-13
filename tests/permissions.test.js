// 권한 가드 검증. service-design.md §3·§7.
// 컨테이너 안에서 돌립니다:  docker compose exec app npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

// 임시 DB 를 쓰도록 server/db.js 보다 먼저 환경변수를 정합니다.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'surfboard-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-only-secret-0123456789abcdef0123456789abcdef';
process.env.COOKIE_SECURE = 'false';

const { db, migrate } = await import('../server/db.js');
const { requireAuth, issueSession, hashPassword } = await import('../server/auth.js');
const {
  loadClub, requireMembership, requirePresident, requireActiveClub,
  requireUnlockedMonth, monthState
} = await import('../server/lib/permissions.js');

migrate();

// ---------- 시드 ----------
// user 1 서비스 관리자(어느 동아리에도 소속 없음) / 2 club1 회장 / 3 club1 회원·club2 회장 / 4 아무 데도 없는 사람
const mkUser = db.prepare('INSERT INTO users (username, display_name, password_hash, is_service_admin) VALUES (?, ?, ?, ?)');
const pw = hashPassword('test-password');
mkUser.run('svcadmin', '서비스관리자', pw, 1);
mkUser.run('president', '회장', pw, 0);
mkUser.run('member', '회원', pw, 0);
mkUser.run('outsider', '남', pw, 0);

db.prepare("INSERT INTO clubs (id, name, brand_color, status) VALUES (1, '활성 동아리', '#5D5FEF', 'active')").run();
db.prepare("INSERT INTO clubs (id, name, brand_color, status) VALUES (2, '정지 동아리', '#16A97A', 'suspended')").run();
const mkMember = db.prepare('INSERT INTO memberships (user_id, club_id, role, member_color) VALUES (?, ?, ?, ?)');
mkMember.run(2, 1, 'president', '#5D5FEF');
mkMember.run(3, 1, 'member', '#16A97A');
mkMember.run(3, 2, 'president', '#F59E0B');
const MS = {
  president_club1: db.prepare("SELECT id FROM memberships WHERE user_id=2 AND club_id=1").get().id,
  member_club1: db.prepare("SELECT id FROM memberships WHERE user_id=3 AND club_id=1").get().id
};

// ---------- 가드만 붙인 최소 앱 ----------
const app = express();
app.use(express.json());
app.use(cookieParser());

// 테스트 전용 로그인. 실제 서비스에는 없습니다.
app.post('/t/login/:uid', (req, res) => {
  issueSession(res, { id: Number(req.params.uid) });
  res.json({ ok: true });
});
// 조회 — 소속 회원 또는 서비스 관리자
app.get('/t/clubs/:id', requireAuth, loadClub, (req, res) =>
  res.json({ club: req.club.name, role: req.membership?.role ?? null }));
// 동아리 운영 — 회장 또는 서비스 관리자
app.post('/t/clubs/:id/invites', requireAuth, loadClub, requireActiveClub, requirePresident, (req, res) =>
  res.json({ ok: true }));
// 본인 일정 — 그 동아리 회원 + 잠기지 않은 달
app.put('/t/clubs/:id/availability', requireAuth, loadClub, requireActiveClub, requireMembership,
  requireUnlockedMonth((req) => String(req.body?.date ?? '').slice(0, 7)),
  (req, res) => res.json({ ok: true, month: req.month }));

let base;
let server;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 해당 사용자로 로그인한 쿠키를 얻습니다. */
async function login(uid) {
  const res = await fetch(`${base}/t/login/${uid}`, { method: 'POST' });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function call(method, url, cookie, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('동아리 조회 — 존재 여부를 흘리지 않는다', () => {
  test('비로그인은 401', async () => {
    assert.equal((await call('GET', '/t/clubs/1')).status, 401);
  });

  test('소속되지 않은 사람에게는 404 (403 이 아님 — 있는지조차 알려주지 않음)', async () => {
    const r = await call('GET', '/t/clubs/1', await login(4));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'NOT_FOUND');
  });

  test('없는 동아리·잘못된 id 도 똑같이 404', async () => {
    const cookie = await login(2);
    for (const id of ['999', '0', '-1', 'abc']) {
      assert.equal((await call('GET', `/t/clubs/${id}`, cookie)).status, 404, `id=${id}`);
    }
  });

  test('일반 회원은 조회 가능', async () => {
    const r = await call('GET', '/t/clubs/1', await login(3));
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'member');
  });

  test('서비스 관리자는 소속이 없어도 조회 가능 (role 은 null)', async () => {
    const r = await call('GET', '/t/clubs/1', await login(1));
    assert.equal(r.status, 200);
    assert.equal(r.body.role, null);
  });
});

describe('동아리 운영 — 회장 또는 서비스 관리자', () => {
  test('일반 회원은 403 NEED_PRESIDENT', async () => {
    const r = await call('POST', '/t/clubs/1/invites', await login(3));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NEED_PRESIDENT');
  });

  test('회장은 허용', async () => {
    assert.equal((await call('POST', '/t/clubs/1/invites', await login(2))).status, 200);
  });

  test('서비스 관리자는 소속이 없어도 허용 (강제)', async () => {
    assert.equal((await call('POST', '/t/clubs/1/invites', await login(1))).status, 200);
  });

  test('다른 동아리 회장은 남의 동아리에 손댈 수 없다 — 404', async () => {
    // user 3 은 club2 의 회장이지만 club1 에서는 일반 회원, user 2 는 club2 에 아예 없음
    const r = await call('POST', '/t/clubs/2/invites', await login(2));
    assert.equal(r.status, 404);
  });
});

describe('정지된 동아리', () => {
  test('회장이라도 변경은 403 CLUB_SUSPENDED', async () => {
    const r = await call('POST', '/t/clubs/2/invites', await login(3));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CLUB_SUSPENDED');
  });

  test('조회는 여전히 된다', async () => {
    assert.equal((await call('GET', '/t/clubs/2', await login(3))).status, 200);
  });

  test('서비스 관리자는 정지된 동아리도 손댈 수 있다', async () => {
    assert.equal((await call('POST', '/t/clubs/2/invites', await login(1))).status, 200);
  });
});

describe('본인 일정 — 소속 회원만', () => {
  test('서비스 관리자도 소속이 없으면 403 NOT_A_MEMBER', async () => {
    const r = await call('PUT', '/t/clubs/1/availability', await login(1), { date: '2026-08-13' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NOT_A_MEMBER');
  });

  test('소속 회원은 허용', async () => {
    const r = await call('PUT', '/t/clubs/1/availability', await login(3), { date: '2026-08-13' });
    assert.equal(r.status, 200);
    assert.equal(r.body.month, '2026-08');
  });

  test('날짜 형식이 틀리면 400', async () => {
    const cookie = await login(3);
    for (const date of ['2026-8-13', '', '2026-13-01', 'xxxx-xx-xx']) {
      assert.equal((await call('PUT', '/t/clubs/1/availability', cookie, { date })).status, 400, `date=${date}`);
    }
  });
});

describe('월 확정 잠금 — service-design.md §7', () => {
  const setConfirmation = (membershipId, month, confirmed, confirmedAt) =>
    db.prepare(`INSERT INTO month_confirmations (membership_id, month, confirmed, confirmed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(membership_id, month) DO UPDATE SET confirmed = excluded.confirmed, confirmed_at = excluded.confirmed_at`)
      .run(membershipId, month, confirmed, confirmedAt);

  test('세 상태를 컬럼 조합으로 구분한다', () => {
    assert.equal(monthState(MS.member_club1, '2026-12'), 'unconfirmed', '행이 없으면 미확인');
    setConfirmation(MS.member_club1, '2026-12', 0, null);
    assert.equal(monthState(MS.member_club1, '2026-12'), 'unconfirmed', '확정한 적 없으면 미확인');
    setConfirmation(MS.member_club1, '2026-12', 1, '2026-12-01 09:00:00');
    assert.equal(monthState(MS.member_club1, '2026-12'), 'confirmed');
    setConfirmation(MS.member_club1, '2026-12', 0, '2026-12-01 09:00:00');
    assert.equal(monthState(MS.member_club1, '2026-12'), 'editing', '확정 이력이 남아 있으면 수정 중');
  });

  test('확정(잠금)한 달의 변경은 409 MONTH_LOCKED', async () => {
    setConfirmation(MS.member_club1, '2026-09', 1, '2026-09-01 09:00:00');
    const r = await call('PUT', '/t/clubs/1/availability', await login(3), { date: '2026-09-14' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'MONTH_LOCKED');
  });

  test('수정 모드로 들어오면 통과한다', async () => {
    setConfirmation(MS.member_club1, '2026-09', 0, '2026-09-01 09:00:00');
    assert.equal((await call('PUT', '/t/clubs/1/availability', await login(3), { date: '2026-09-14' })).status, 200);
  });

  test('잠금은 사람별·월별로 따로 걸린다', async () => {
    setConfirmation(MS.member_club1, '2026-10', 1, '2026-10-01 09:00:00');
    // 같은 사람의 다른 달
    assert.equal((await call('PUT', '/t/clubs/1/availability', await login(3), { date: '2026-11-02' })).status, 200);
    // 같은 달의 다른 사람 (회장은 확정하지 않았음)
    assert.equal((await call('PUT', '/t/clubs/1/availability', await login(2), { date: '2026-10-05' })).status, 200);
    // 본인의 그 달은 여전히 잠김
    assert.equal((await call('PUT', '/t/clubs/1/availability', await login(3), { date: '2026-10-05' })).status, 409);
  });
});

describe('세션', () => {
  test('정지된 계정의 쿠키는 통하지 않는다', async () => {
    const cookie = await login(4);
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = 4").run();
    assert.equal((await call('GET', '/t/clubs/1', cookie)).status, 401);
    db.prepare("UPDATE users SET status = 'active' WHERE id = 4").run();
  });

  test('위조·손상된 쿠키는 401', async () => {
    assert.equal((await call('GET', '/t/clubs/1', 'sb_session=not-a-real-jwt')).status, 401);
  });
});
