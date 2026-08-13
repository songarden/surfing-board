-- 인원
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE,          -- 로그인 아이디
  display_name         TEXT    NOT NULL,                 -- 달력에 보이는 이름
  color                TEXT    NOT NULL DEFAULT '#5AD1BE',
  role                 TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  password_hash        TEXT    NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  note                 TEXT    NOT NULL DEFAULT '',      -- 상시 참고사항 (예: 한마음 날짜 미정)
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at        TEXT
);

-- 날짜별 개인 상태. 'yes'(가능)는 기본값이라 행을 만들지 않고, 바꾼 날만 저장합니다.
CREATE TABLE IF NOT EXISTS availability (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,                            -- YYYY-MM-DD
  status     TEXT    NOT NULL CHECK (status IN ('no','maybe')),
  reason     TEXT    NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_availability_date ON availability(date);

-- 날짜 공용 메모 (예: "OO팀 한마음")
CREATE TABLE IF NOT EXISTS day_notes (
  date       TEXT PRIMARY KEY,
  note       TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 확정된 모임
CREATE TABLE IF NOT EXISTS meetups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '보드게임 모임',
  place      TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meetups_date ON meetups(date);
