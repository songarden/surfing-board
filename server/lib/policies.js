import { db } from '../db.js';

/** 서비스 전역 정책. 002 마이그레이션이 id=1 한 행을 넣어 둡니다. */
export function getPolicies() {
  return db.prepare(
    'SELECT signup_enabled, invite_default_days, club_max_members FROM service_policies WHERE id = 1'
  ).get();
}
