// 추천 날짜를 네이버 웍스 대화방에 공유하는 기능.
//
// 권한 셀(누가 링크를 만들 수 있는가)은 tests/capability.test.js 의 "추천 날짜 공유" 가 봅니다.
// 여기서는 **공유물이 맞는지**를 봅니다 — 미리보기 메타데이터에 요일이 들어 있는지,
// 링크가 서명 없이는 안 열리는지, 로그인 없이 열리는 페이지로 회원 이름이 새지 않는지.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'surfboard-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-only-secret-0123456789abcdef0123456789abcdef';
process.env.COOKIE_SECURE = 'false';
// 추천은 "지난 날짜 제외" 라서 실제 날짜에 따라 결과가 흔들립니다. 2026-08 이 전부 미래인 날로 고정합니다.
process.env.SURFBOARD_TODAY = '2026-08-01';

const { db, migrate } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { selectableDays } = await import('../server/lib/calendar.js');
const { shareToken } = await import('../server/lib/share.js');
migrate();

const MONTH = '2026-08';
const PW = 'share-test-2026';
// 2026-08-20 은 목요일, 8-21 은 금요일입니다 (8/1 이 토요일).
const THU = '2026-08-20';
const FRI = '2026-08-21';

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

async function call(method, url, { body, cookie } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 로그인 없이 여는 페이지. 본문을 HTML 문자열 그대로 돌려줍니다. */
async function getPage(url) {
  const res = await fetch(base + url);
  return { status: res.status, html: await res.text(), headers: res.headers };
}

async function makeUser(displayName) {
  const username = `share${++seq}`;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, display_name: displayName, password: PW })
  });
  const user = await res.json();
  return { ...user, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

/**
 * 회장 + 회원 2명짜리 동아리. `okDates` 만 남기고 나머지 평일은 회원이 전부 불가로 표시합니다
 * → 추천 날짜가 정확히 `okDates` 가 됩니다.
 */
async function freshClub({ name = null, okDates = [THU, FRI] } = {}) {
  const pres = await makeUser('회장가영');
  const member = await makeUser('회원지훈');
  const club = (await call('POST', '/api/clubs',
    { body: { name: name ?? `공유동아리${seq}` }, cookie: pres.cookie })).body;
  const invite = (await call('POST', `/api/clubs/${club.id}/invites`, { cookie: pres.cookie })).body;
  await call('POST', `/api/invites/${invite.token}/accept`, { cookie: member.cookie });

  const entries = {};
  for (const d of selectableDays(MONTH)) if (!okDates.includes(d.date)) entries[d.date] = 'no';
  await call('POST', `/api/clubs/${club.id}/availability/bulk`,
    { body: { op: 'set', month: MONTH, entries }, cookie: member.cookie });

  return { club, pres, member };
}

const share = (clubId, cookie, month = MONTH) =>
  call('GET', `/api/clubs/${clubId}/share?month=${month}`, { cookie });

// ==========================================================================
describe('공유 꾸러미 (GET /api/clubs/:id/share)', () => {
  let f, data;
  before(async () => {
    f = await freshClub();
    data = (await share(f.club.id, f.member.cookie)).body;
  });

  test('추천 날짜와 요일을 함께 돌려준다', () => {
    assert.deepEqual(data.dates.map((d) => d.date), [THU, FRI]);
    assert.deepEqual(data.dates.map((d) => d.dow_ko), ['목', '금']);
    assert.equal(data.member_count, 2);
    assert.equal(data.best_count, 2);
    assert.equal(data.full_party, true, '두 사람 다 되는 날이라 전원 가능');
  });

  test('og:title 에 쓸 제목에 날짜와 요일이 들어 있다', () => {
    assert.match(data.title, /8\/20\(목\)/);
    assert.match(data.title, /8\/21\(금\)/);
    assert.ok(data.title.includes(f.club.name), '어느 동아리인지도 제목에서 알 수 있어야 합니다');
  });

  test('og:description 은 요일을 풀어 쓰고 인원 근거를 붙인다', () => {
    assert.match(data.description, /목요일/);
    assert.match(data.description, /금요일/);
    assert.match(data.description, /2명/);
  });

  test('붙여넣을 본문에 날짜·요일·인원이 다 있고 마지막 줄이 링크다', () => {
    const lines = data.text.split('\n');
    assert.equal(lines.at(-1), data.url, '메신저가 URL 을 찾아 카드를 만들 자리입니다');
    assert.ok(lines.some((l) => l.includes('8월 20일(목)')), `본문: ${data.text}`);
    assert.ok(lines.some((l) => l.includes('8월 21일(금)')));
    assert.ok(lines.some((l) => l.includes('전원 가능')));
  });

  test('url 은 남에게 전달할 수 있는 절대 주소다', () => {
    assert.match(data.url, /^https?:\/\/[^/]+\/share\/\d+\/2026-08\?t=.+$/);
    assert.ok(data.url.endsWith(data.path), 'path 와 url 이 같은 링크를 가리켜야 합니다');
  });

  test('아직 확정 안 한 사람 수를 함께 준다 (대화방에서 재촉할 근거)', async () => {
    assert.equal(data.unconfirmed_count, 2, '아무도 확정하지 않은 상태');
    await call('POST', `/api/clubs/${f.club.id}/confirm?month=${MONTH}`, { cookie: f.member.cookie });
    const after = (await share(f.club.id, f.member.cookie)).body;
    assert.equal(after.confirmed_count, 1);
    assert.equal(after.unconfirmed_count, 1);
    assert.match(after.text, /아직 1명이/);
  });

  test('일정이 바뀌면 공유 내용도 따라 바뀐다 — 링크는 그대로', async () => {
    const before = (await share(f.club.id, f.pres.cookie)).body;
    await call('PUT', `/api/clubs/${f.club.id}/availability`,
      { body: { date: THU, status: 'no' }, cookie: f.pres.cookie });
    const now = (await share(f.club.id, f.pres.cookie)).body;

    assert.deepEqual(now.dates.map((d) => d.date), [FRI], '목요일이 후보에서 빠집니다');
    assert.equal(now.url, before.url, '같은 (동아리, 월) 이면 링크는 같습니다');

    // 원상복구 — 아래 테스트들이 이 동아리를 다시 씁니다.
    await call('PUT', `/api/clubs/${f.club.id}/availability`,
      { body: { date: THU, status: null }, cookie: f.pres.cookie });
  });

  test('month 형식이 틀리면 400', async () => {
    assert.equal((await share(f.club.id, f.member.cookie, '2026-8')).status, 400);
  });

  test('정지된 동아리는 새 링크를 만들 수 없다', async () => {
    db.prepare("UPDATE clubs SET status = 'suspended' WHERE id = ?").run(f.club.id);
    const res = await share(f.club.id, f.member.cookie);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CLUB_SUSPENDED');
    db.prepare("UPDATE clubs SET status = 'active' WHERE id = ?").run(f.club.id);
  });
});

// ==========================================================================
describe('공개 공유 페이지 (GET /share/:clubId/:month)', () => {
  let f, data, page;
  before(async () => {
    f = await freshClub();
    data = (await share(f.club.id, f.member.cookie)).body;
    page = await getPage(data.path);
  });

  test('로그인 없이 열린다 — 미리보기를 만드는 쪽에는 세션 쿠키가 없다', () => {
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
  });

  test('미리보기 메타데이터가 API 가 준 문자열과 정확히 같다', () => {
    // 프런트의 미리보기 흉내와 실제 카드가 어긋나면 안 됩니다.
    assert.ok(page.html.includes(`<meta property="og:title" content="${data.title}">`), page.html.slice(0, 900));
    assert.ok(page.html.includes(`<meta property="og:description" content="${data.description}">`));
    assert.ok(page.html.includes(`<meta property="og:url" content="${data.url}">`));
    assert.match(page.html, /<meta name="twitter:card" content="summary">/);
    assert.match(page.html, /<meta property="og:locale" content="ko_KR">/);
  });

  test('메타데이터만 읽어도 추천 요일을 알 수 있다', () => {
    const og = /<meta property="og:description" content="([^"]*)">/.exec(page.html)[1];
    assert.match(og, /목요일/);
    assert.match(og, /금요일/);
    const title = /<meta property="og:title" content="([^"]*)">/.exec(page.html)[1];
    assert.match(title, /\(목\)/);
  });

  test('화면에도 요일이 큰 글씨로 남는다', () => {
    assert.match(page.html, /share-date-dow">목요일/);
    assert.match(page.html, /share-date-dow">금요일/);
    assert.match(page.html, /8월 20일/);
  });

  test('회원 이름과 개인 일정은 새지 않는다', () => {
    assert.ok(!page.html.includes('회원지훈'), '이름이 로그인 없는 페이지에 나오면 안 됩니다');
    assert.ok(!page.html.includes('회장가영'));
    assert.ok(!page.html.includes('membership'), '멤버십 식별자도 나가지 않습니다');
  });

  test('동아리 이름은 HTML 로 해석되지 않는다', async () => {
    const evil = await freshClub({ name: '<b>"x"</b>동아리' });
    const link = (await share(evil.club.id, evil.member.cookie)).body;
    const html = (await getPage(link.path)).html;

    assert.ok(!html.includes('<b>"x"</b>'), '원문 태그가 그대로 박히면 안 됩니다');
    assert.ok(html.includes('&lt;b&gt;&quot;x&quot;&lt;/b&gt;'), '텍스트로도 속성값으로도 이스케이프됩니다');
  });
});

// ==========================================================================
describe('공유 링크 서명', () => {
  let f, data;
  before(async () => {
    f = await freshClub();
    data = (await share(f.club.id, f.member.cookie)).body;
  });

  test('토큰이 없거나 틀리면 열리지 않는다', async () => {
    assert.equal((await getPage(`/share/${f.club.id}/${MONTH}`)).status, 404);
    assert.equal((await getPage(`/share/${f.club.id}/${MONTH}?t=`)).status, 404);
    assert.equal((await getPage(`/share/${f.club.id}/${MONTH}?t=aaaaaaaaaaaaaaaaaaaaaa`)).status, 404);
  });

  test('다른 달·다른 동아리의 토큰은 통하지 않는다', async () => {
    const other = await freshClub();
    const otherToken = (await share(other.club.id, other.member.cookie)).body.path.split('t=')[1];
    assert.equal((await getPage(`/share/${f.club.id}/${MONTH}?t=${otherToken}`)).status, 404);
    assert.equal((await getPage(`/share/${f.club.id}/2026-09?t=${shareToken(f.club.id, MONTH)}`)).status, 404);
  });

  test('id 를 훑어도 동아리가 있는지 알 수 없다', async () => {
    // 서명은 맞지만 없는 동아리 / 서명이 틀린 실재 동아리 → 같은 화면, 같은 상태코드.
    const ghost = await getPage(`/share/999999/${MONTH}?t=${shareToken(999999, MONTH)}`);
    const real = await getPage(`/share/${f.club.id}/${MONTH}?t=bbbbbbbbbbbbbbbbbbbbbb`);
    assert.equal(ghost.status, 404);
    assert.equal(real.status, 404);
    assert.equal(ghost.html, real.html, '있는 동아리와 없는 동아리를 구분해 주면 안 됩니다');
  });

  test('정지된 동아리는 이미 뿌린 링크도 멈춘다', async () => {
    assert.equal((await getPage(data.path)).status, 200);
    db.prepare("UPDATE clubs SET status = 'suspended' WHERE id = ?").run(f.club.id);
    assert.equal((await getPage(data.path)).status, 404);
    db.prepare("UPDATE clubs SET status = 'active' WHERE id = ?").run(f.club.id);
  });

  test('잘린 링크·엉뚱한 월도 안내 화면으로 받는다', async () => {
    assert.equal((await getPage(`/share/${f.club.id}`)).status, 404);
    assert.equal((await getPage('/share')).status, 404);
    assert.equal((await getPage(`/share/${f.club.id}/2026-13?t=${shareToken(f.club.id, '2026-13')}`)).status, 404);
    assert.match((await getPage(`/share/${f.club.id}`)).html, /열 수 없어요/);
  });
});

// ==========================================================================
describe('후보가 없는 달', () => {
  test('지난 달을 공유해도 링크는 열리고, 왜 없는지 알려준다', async () => {
    const f = await freshClub();
    const past = (await share(f.club.id, f.member.cookie, '2026-01')).body;

    assert.deepEqual(past.dates, []);
    assert.match(past.title, /추천 날짜 없음/);
    assert.match(past.description, /평일이 모두 지났어요/);
    assert.match(past.text, /평일이 모두 지났어요/);

    const page = await getPage(past.path);
    assert.equal(page.status, 200, '후보가 없어도 링크 자체는 살아 있어야 합니다');
    assert.match(page.html, /추천할 날짜가 없어요/);
  });
});
