#!/usr/bin/env node
// 계정 만들기:  npm run user:create -- gildong 홍길동 [--service-admin]
// 공개 가입(POST /api/auth/signup)이 있으니 이건 폐쇄망 초기 세팅용입니다.
import '../server/env.js';
import crypto from 'node:crypto';
import { db, migrate } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const args = process.argv.slice(2);
const serviceAdmin = args.includes('--service-admin');
const [username, ...nameParts] = args.filter(a => a !== '--service-admin');
const name = nameParts.join(' ');
if (!username || !name) {
  console.error('사용법: npm run user:create -- <아이디> <표시이름> [--service-admin]');
  process.exit(1);
}
migrate();
const pw = 'sb-' + crypto.randomBytes(6).toString('hex');
try {
  db.prepare(`INSERT INTO users (username, display_name, password_hash, is_service_admin)
    VALUES (?, ?, ?, ?)`)
    .run(username.toLowerCase(), name, hashPassword(pw), serviceAdmin ? 1 : 0);
} catch (e) {
  console.error('만들지 못했습니다:', e.message);
  process.exit(1);
}
console.log(`아이디 ${username.toLowerCase()} / 비밀번호 ${pw}${serviceAdmin ? ' (서비스 관리자)' : ''}`);
console.log('본인에게 전달하고, 계정 설정에서 비밀번호를 바꾸게 하세요.');
console.log('동아리 참여는 초대 링크로만 됩니다.');
