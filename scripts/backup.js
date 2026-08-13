#!/usr/bin/env node
// DB 백업:  npm run backup [-- --keep=14]
//
// 서버를 내리지 않고 복사합니다. SQLite 온라인 백업 API 를 쓰기 때문에
// WAL 에 아직 남아 있는 내용까지 합쳐진 완결된 파일 하나가 나옵니다.
// (`npm run down` 뒤 파일 복사와 달리 서비스를 멈출 필요가 없습니다.)
import '../server/env.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.DATA_DIR || './data';
const SRC = path.join(DATA_DIR, 'surfboard.db');
const OUT_DIR = path.join(DATA_DIR, 'backups');

const keepArg = process.argv.slice(2).find(a => a.startsWith('--keep='));
const keep = keepArg ? Number(keepArg.slice(7)) : 14;
if (!Number.isInteger(keep) || keep < 1) {
  console.error('--keep 은 1 이상의 정수여야 합니다.');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`${SRC} 가 없습니다. DATA_DIR 이 맞는지 확인하세요 (지금 값: ${DATA_DIR}).`);
  process.exit(1);
}

const now = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
const dest = path.join(OUT_DIR, `surfboard-${stamp}.db`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(SRC, { readonly: true });
await db.backup(dest);
db.close();

// 복사본을 열어서 실제로 읽히는지 확인합니다. 여기서 걸리면 백업이 쓸모없는 파일입니다.
const copy = new Database(dest, { readonly: true });
const integrity = copy.pragma('integrity_check', { simple: true });
const users = copy.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const clubs = copy.prepare('SELECT COUNT(*) AS c FROM clubs').get().c;
copy.close();

if (integrity !== 'ok') {
  console.error(`백업 파일이 손상됐습니다 (integrity_check: ${integrity}). ${dest} 를 믿지 마세요.`);
  process.exit(1);
}

const mb = (fs.statSync(dest).size / 1048576).toFixed(2);
console.log(`백업 완료: ${dest} (${mb} MB, 계정 ${users}명 / 동아리 ${clubs}개, integrity ok)`);

// 오래된 백업 정리 — 파일명이 시간순이라 이름 정렬로 충분합니다.
const olds = fs.readdirSync(OUT_DIR)
  .filter(f => /^surfboard-\d{8}-\d{6}\.db$/.test(f))
  .sort()
  .slice(0, -keep);
for (const f of olds) {
  fs.unlinkSync(path.join(OUT_DIR, f));
  console.log(`  오래된 백업 삭제: ${f}`);
}
console.log(`최근 ${keep}개를 남깁니다. 되돌릴 때는 docs/operations.md 의 "복구" 절을 보세요.`);
