#!/usr/bin/env node
// 비밀번호 초기화:  npm run user:passwd -- gildong
import '../server/env.js';
import crypto from 'node:crypto';
import { db } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const username = (process.argv[2] || '').toLowerCase();
if (!username) { console.error('사용법: npm run user:passwd -- <아이디>'); process.exit(1); }
const pw = 'sb-' + crypto.randomBytes(6).toString('hex');
const info = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
  .run(hashPassword(pw), username);
if (!info.changes) { console.error('그 아이디가 없습니다.'); process.exit(1); }
console.log(`${username} 새 비밀번호: ${pw}`);
console.log('본인에게 전달하고, 계정 설정에서 다시 바꾸게 하세요.');
