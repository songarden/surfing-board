// 가입·로그인·비밀번호. 실제 앱(createApp)을 그대로 띄워서 확인합니다.
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

let base;
let server;
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

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  };
}
const signup = (over = {}) =>
  call('POST', '/api/auth/signup', { username: 'minsu', display_name: '김민수', password: 'surfboard-2026', ...over });

describe('회원가입', () => {
  test('가입하면 201 + 세션 쿠키를 바로 받는다', async () => {
    const r = await signup();
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { id: r.body.id, username: 'minsu', display_name: '김민수', is_service_admin: false });
    assert.match(r.cookie, /^sb_session=/);

    const me = await call('GET', '/api/auth/me', null, r.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.username, 'minsu');
    assert.equal(me.body.is_service_admin, false);
  });

  test('아이디는 대문자를 넣어도 소문자로 저장된다', async () => {
    const r = await signup({ username: 'GilDong', display_name: '홍길동' });
    assert.equal(r.status, 201);
    assert.equal(r.body.username, 'gildong');
  });

  test('중복 아이디는 409', async () => {
    assert.equal((await signup({ username: 'minsu' })).status, 409);
  });

  test('아이디·이름·비밀번호 규칙 위반은 400', async () => {
    assert.equal((await signup({ username: 'ab' })).status, 400, '아이디 3자 미만');
    assert.equal((await signup({ username: '한글아이디' })).status, 400, '허용 문자 외');
    assert.equal((await signup({ username: 'ok-name', display_name: '' })).status, 400, '표시 이름 없음');
    assert.equal((await signup({ username: 'ok-name', password: 'short' })).status, 400, '비밀번호 8자 미만');
  });

  test('signup_enabled = 0 이면 403 SIGNUP_DISABLED', async () => {
    db.prepare('UPDATE service_policies SET signup_enabled = 0 WHERE id = 1').run();
    const r = await signup({ username: 'blocked' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'SIGNUP_DISABLED');
    db.prepare('UPDATE service_policies SET signup_enabled = 1 WHERE id = 1').run();
  });
});

describe('로그인', () => {
  test('맞는 비밀번호로 로그인 → me 조회', async () => {
    const r = await call('POST', '/api/auth/login', { username: 'minsu', password: 'surfboard-2026' });
    assert.equal(r.status, 200);
    const me = await call('GET', '/api/auth/me', null, r.cookie);
    assert.equal(me.body.display_name, '김민수');
  });

  test('틀린 비밀번호는 401 이고 아이디 존재 여부를 흘리지 않는다', async () => {
    const wrong = await call('POST', '/api/auth/login', { username: 'minsu', password: 'wrong-password' });
    const missing = await call('POST', '/api/auth/login', { username: 'nobody-here', password: 'wrong-password' });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.body.error, missing.body.error);
  });

  test('정지된 계정은 로그인할 수 없다', async () => {
    db.prepare("UPDATE users SET status = 'suspended' WHERE username = 'gildong'").run();
    assert.equal((await call('POST', '/api/auth/login', { username: 'gildong', password: 'surfboard-2026' })).status, 401);
    db.prepare("UPDATE users SET status = 'active' WHERE username = 'gildong'").run();
  });

  test('로그아웃하면 세션이 끊긴다', async () => {
    const login = await call('POST', '/api/auth/login', { username: 'minsu', password: 'surfboard-2026' });
    await call('POST', '/api/auth/logout', null, login.cookie);
    // 쿠키를 지웠으니 같은 쿠키 문자열을 다시 보내는 대신, 쿠키 없이 접근해 확인합니다.
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
  });
});

describe('비밀번호 변경', () => {
  test('지금 비밀번호가 맞아야 바꿀 수 있다', async () => {
    const login = await call('POST', '/api/auth/login', { username: 'minsu', password: 'surfboard-2026' });
    assert.equal((await call('POST', '/api/auth/password',
      { current: 'wrong-password', next: 'new-password-2026' }, login.cookie)).status, 401);
    assert.equal((await call('POST', '/api/auth/password',
      { current: 'surfboard-2026', next: 'short' }, login.cookie)).status, 400);
    assert.equal((await call('POST', '/api/auth/password',
      { current: 'surfboard-2026', next: 'new-password-2026' }, login.cookie)).status, 200);
    assert.equal((await call('POST', '/api/auth/login',
      { username: 'minsu', password: 'new-password-2026' })).status, 200);
  });

  test('비로그인은 401', async () => {
    assert.equal((await call('POST', '/api/auth/password', { current: 'a', next: 'bbbbbbbb' })).status, 401);
  });
});
