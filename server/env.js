// .env 를 읽는 side-effect 모듈. 다른 모듈보다 먼저 import 해야 합니다.
// (도커에서는 env_file 이 이미 채워 주므로 여기서 덮어쓰지 않습니다.)
import fs from 'node:fs';

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
