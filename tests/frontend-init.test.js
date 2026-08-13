// 화면 스크립트의 모듈 초기화 순서 검사.
//
// public/js/*.js 는 최상위 await(`requireMe()`·`load()`)을 씁니다. 그 await 아래에 모듈 스코프
// const/let 을 두면, await 가 부르는 draw() 계열이 선언 전에 그 값을 읽어 TDZ ReferenceError 가
// 납니다. 그런데 load() 의 catch 가 그 에러를 삼켜서 **화면이 LOADING 에서 멈추기만** 하고
// 아무 데도 실패로 안 남습니다. node --check 도 문법 오류가 아니라 못 잡습니다.
//
// 2026-08-12 에 실제로 이걸로 동아리 달력이 멈췄습니다. 그래서 정적으로 잡습니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const JS_DIR = path.join(process.cwd(), 'public', 'js');

/** 들여쓰기 없는 = 모듈 스코프 선언. 자기 자신이 await 대입이면 그 시점에 평가되니 안전합니다. */
const DECL = /^(?:const|let)\s+[^=]*=/;
const AWAIT_STMT = /^(?:await\s|(?:const|let)\s+.*?=\s*\(?await\s)/;

for (const file of fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'))) {
  test(`${file} — 최상위 await 아래에 모듈 상수를 두지 않는다`, () => {
    const lines = fs.readFileSync(path.join(JS_DIR, file), 'utf8').split('\n');

    let lastAwait = -1;
    lines.forEach((line, i) => { if (AWAIT_STMT.test(line)) lastAwait = i; });
    if (lastAwait === -1) return;   // 최상위 await 가 없으면 순서 문제가 없습니다.

    const late = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line, i }) => i > lastAwait && DECL.test(line) && !AWAIT_STMT.test(line))
      .map(({ line, i }) => `${file}:${i + 1}  ${line.trim()}`);

    assert.deepEqual(late, [],
      `최상위 await(${file}:${lastAwait + 1}) 아래에 모듈 선언이 있습니다. `
      + 'await 위로 올리거나 function 선언으로 바꾸세요 — 안 그러면 TDZ 로 화면이 LOADING 에서 멈춥니다.');
  });
}
