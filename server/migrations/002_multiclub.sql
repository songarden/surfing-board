-- 002 멀티 동아리 + 3단계 권한 (2026-08-10)
--
-- 근거: design_handoff_surfboard/service-design.md §4 (데이터 모델), §2 (권한 모델), §7 (확정 상태 머신)
--
-- 001 은 단일 동아리 전제였습니다. 이 마이그레이션은
--   * users 를 전역 계정으로 재구성 (동아리 내 역할·색을 memberships 로 이동, is_service_admin 신설)
--   * clubs / memberships / invites 추가
--   * availability / day_notes 를 동아리 스코프로 재작성
--   * month_confirmations (월 단위 확정·잠금) 추가
--   * 서비스 관리자 콘솔용 service_policies / service_notices / reports 추가
--   * meetups 제거 (핸드오프 모델에 없음. 모임 날짜는 '추천 날짜' 집계로 대체)
-- 합니다.
--
-- ⚠️ 기존 availability / day_notes / meetups 행은 버립니다. 동아리 소속 정보가 없어서
--    어느 동아리의 일정인지 복원할 수 없기 때문입니다. (2026-08-10 사용자 확인: 테스트 데이터뿐)
--    users 행은 살립니다 — role='admin' 이었던 계정은 is_service_admin=1 이 됩니다.
--
-- 저장 원칙: '가능'은 행을 만들지 않습니다. availability 에는 'no'/'maybe' 만 들어가고,
--            표시하지 않은 평일은 집계할 때 가능으로 셉니다.

-- 동아리 스코프가 없어 이관할 수 없는 것들부터 정리합니다 (users 의 자식이라 먼저 지웁니다).
DROP TABLE IF EXISTS meetups;
DROP TABLE IF EXISTS availability;
DROP TABLE IF EXISTS day_notes;

-- ---------- 전역 계정 ----------
CREATE TABLE users_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT    NOT NULL UNIQUE,               -- 로그인 아이디. 변경 불가
  display_name     TEXT    NOT NULL,                      -- 달력에 보이는 이름
  password_hash    TEXT    NOT NULL,
  is_service_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_service_admin IN (0,1)),
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at    TEXT
);

INSERT INTO users_new (id, username, display_name, password_hash, is_service_admin, status, created_at, last_login_at)
SELECT id, username, display_name, password_hash,
       CASE WHEN role = 'admin' THEN 1 ELSE 0 END,
       CASE WHEN active = 1 THEN 'active' ELSE 'suspended' END,
       created_at, last_login_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- ---------- 동아리 ----------
CREATE TABLE clubs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  brand_color TEXT    NOT NULL DEFAULT '#5D5FEF',          -- 카드 상단 바 색
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- (user, club) 쌍마다 하나. 동아리 안에서의 역할과 색이 여기 붙습니다.
CREATE TABLE memberships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id      INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('president','member')),
  member_color TEXT    NOT NULL DEFAULT '#5D5FEF',         -- 동아리 팔레트(10색)에서 배정
  joined_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, club_id)
);
CREATE INDEX idx_memberships_club ON memberships(club_id);
CREATE INDEX idx_memberships_user ON memberships(user_id);
-- 회장은 동아리당 정확히 1명. DB 가 직접 막습니다 (회장직 넘기기는 한 트랜잭션 안에서).
CREATE UNIQUE INDEX ux_memberships_one_president ON memberships(club_id) WHERE role = 'president';

-- ---------- 일정 ----------
-- 'yes'(가능)는 저장하지 않습니다. 행이 없는 평일 = 가능.
CREATE TABLE availability (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL,                          -- YYYY-MM-DD
  status        TEXT    NOT NULL CHECK (status IN ('no','maybe')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (membership_id, date)
);
CREATE INDEX idx_availability_date ON availability(date);

-- ---------- 월 단위 확정(잠금) ----------
-- 상태 판별 (service-design.md §7):
--   행 없음 또는 confirmed_at IS NULL        → 미확인
--   confirmed = 1                            → 확정/잠금(읽기 전용)
--   confirmed = 0 AND confirmed_at NOT NULL  → 수정 중 (한 번 확정한 뒤 '일정 변경'을 누른 상태)
CREATE TABLE month_confirmations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  month         TEXT    NOT NULL,                          -- YYYY-MM
  confirmed     INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  confirmed_at  TEXT,                                      -- 마지막으로 확정한 시각. 수정 중에도 남깁니다
  UNIQUE (membership_id, month)
);
CREATE INDEX idx_month_confirmations_month ON month_confirmations(month);

-- ---------- 날짜별 공용 메모 (동아리 안에서만 보입니다) ----------
CREATE TABLE day_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (club_id, date)
);

-- ---------- 초대 ----------
CREATE TABLE invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  token      TEXT    NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT,                                         -- NULL 이면 만료 없음
  max_uses   INTEGER,                                      -- NULL 이면 횟수 제한 없음
  used_count INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invites_club ON invites(club_id);

-- ---------- 서비스 관리자 콘솔 ----------
CREATE TABLE service_notices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  published_at TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT    NOT NULL CHECK (target_type IN ('club','user')),
  target_id   INTEGER NOT NULL,
  reason      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_reports_status ON reports(status);

-- 서비스 전역 정책. 한 행만 존재합니다 (id = 1).
CREATE TABLE service_policies (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  signup_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (signup_enabled IN (0,1)),
  invite_default_days INTEGER NOT NULL DEFAULT 7,
  club_max_members    INTEGER NOT NULL DEFAULT 50,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO service_policies (id) VALUES (1);
