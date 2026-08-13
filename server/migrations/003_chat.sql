-- 003 동아리 채팅 (2026-08-13)
--
-- 근거: design_handoff_surfboard/service-design.md §4 (ChatMessage / ChatMention / ChatRead), §8 (동아리 채팅)
--
-- 동아리당 채팅방 하나입니다. 날짜별 스레드를 만들지 않으므로 방(room) 테이블도 없고,
-- club_id 가 곧 방 식별자입니다.
--
-- 공용 메모(day_notes)는 그대로 둡니다 — 메모 = 그 날짜의 확정 정보, 채팅 = 대화.
-- 서로 대체하지 않습니다 (service-design.md §8.1).
--
-- 삭제는 soft delete 입니다. 행을 지우지 않고 deleted_at 을 채우며,
-- 응답에는 body 를 절대 싣지 않고 자리표시자만 내려보냅니다 (§8.4). deleted_by 는 감사용입니다.

-- ---------- 메시지 ----------
-- kind='user'   → membership_id 가 작성자. system_event 는 NULL
-- kind='system' → membership_id 는 NULL, system_event 에 트리거 종류
CREATE TABLE chat_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id        INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  -- 탈퇴·내보내기로 멤버십이 사라져도 대화는 남아야 합니다. CASCADE 로 지우면 남의 말에 구멍이 뚫립니다.
  membership_id  INTEGER REFERENCES memberships(id) ON DELETE SET NULL,
  -- 멤버십이 사라진 뒤에도 "누가 썼는지"를 보여주기 위한 계정 링크. 표시 이름을 여기서 조인합니다.
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind           TEXT    NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  body           TEXT    NOT NULL,
  system_event   TEXT    CHECK (system_event IS NULL OR system_event IN
                     ('month_confirmed','availability_changed','member_joined','member_left','president_transferred')),
  edited_at      TEXT,
  deleted_at     TEXT,
  deleted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- ISO-8601 UTC(Z). 다른 테이블의 datetime('now') 와 달리 "오후 3:21" 같은 시각을 그려야 해서
  -- 브라우저가 그대로 파싱할 수 있는 형식으로 둡니다 (DECISIONS.md 2026-08-13 절).
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK ((kind = 'system' AND membership_id IS NULL) OR kind = 'user')
);
-- 방 하나를 시간순으로 읽습니다.
CREATE INDEX idx_chat_messages_club_created ON chat_messages(club_id, created_at);
-- 커서 페이지네이션(before/after)과 안 읽은 개수는 id 로 자릅니다.
-- created_at 은 초 단위라 같은 초에 들어온 메시지의 순서를 가르지 못합니다.
CREATE INDEX idx_chat_messages_club_id ON chat_messages(club_id, id);

-- ---------- @멘션 ----------
-- 전송 시 본문을 파싱해 남깁니다. 멘션된 회원에게 강조 표시를 하고, 나중에 "나를 부른 메시지" 를 찾는 데 씁니다.
CREATE TABLE chat_mentions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  UNIQUE (message_id, membership_id)
);
CREATE INDEX idx_chat_mentions_membership ON chat_mentions(membership_id);

-- ---------- 읽음 표시 ----------
-- 회원별 "마지막으로 읽은 지점" 하나만 둡니다. 메시지마다 읽음 행을 만들지 않습니다.
-- 안 읽은 개수 = 그 동아리 메시지 중 id > last_read_message_id 인 것의 수.
CREATE TABLE chat_reads (
  membership_id        INTEGER PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
  last_read_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
