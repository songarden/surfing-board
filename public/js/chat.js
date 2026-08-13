// 동아리 채팅 사이드 패널. service-design.md §8 · 핸드오프 README 화면 8번.
//
// **XSS**: 본문은 절대 innerHTML 로 넣지 않습니다. 전부 텍스트 노드로 만들고,
// 멘션·링크는 그 텍스트를 잘라 만든 **별도 노드**로 감쌉니다 — 이스케이프가 먼저이고 꾸미기가 나중입니다.
//
// **패널은 #app 밖(document.body)에 삽니다.** 달력 화면은 draw() 때마다 #app 을 통째로 다시 그리는데,
// 패널이 그 안에 있으면 스크롤 위치·입력 중이던 글자·포커스가 매번 날아갑니다.
//
// WebSocket 은 **패널을 열지 않아도** 붙여 둡니다. 그래야 닫아 둔 채로도 안 읽은 배지가 실시간으로 움직입니다.
// 소켓이 죽어도 채팅은 REST 만으로 동작해야 합니다 — 재연결하면 `?after=` 로 빠진 것만 채웁니다.
import { api } from './api.js';
import { avatar, confirmModal, el, initial, render, toastError } from './ui.js';

const SEOUL = 9 * 3600e3;                 // 서비스 기준 시각은 한국. 브라우저 TZ 를 믿지 않습니다.
const TYPING_SHOW_MS = 4000;              // "입력 중…" 을 띄워 두는 시간
const TYPING_SEND_MS = 2500;              // typing 신호를 다시 보내기까지의 최소 간격
const RECONNECT_MAX_MS = 15000;

const seoulParts = (iso) => new Date(new Date(iso).getTime() + SEOUL);
const seoulDay = (iso) => seoulParts(iso).toISOString().slice(0, 10);

function clockLabel(iso) {
  const d = seoulParts(iso);
  const h = d.getUTCHours();
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** '2026-08-05' → '오늘' | '어제' | '2026년 8월 5일' */
function dayLabel(day, today) {
  if (day === today) return '오늘';
  const y = new Date(Date.parse(`${today}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  if (day === y) return '어제';
  return `${day.slice(0, 4)}년 ${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
}

/**
 * 본문을 안전한 노드 배열로. **여기서 문자열은 절대 HTML 로 해석되지 않습니다.**
 *   1) `@표시이름` — 서버 파싱과 같은 규칙(긴 이름 먼저, 앞이 글자면 제외)
 *   2) http(s) 링크 — 스킴을 http/https 로만 좁혀서 `javascript:` 가 끼어들 여지를 없앱니다
 */
function bodyNodes(text, names) {
  const byLength = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
  const wordChar = /[\p{L}\p{N}_]/u;
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(...linkNodes(buf)); buf = ''; } };

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '@' && !(i > 0 && wordChar.test(text[i - 1]))) {
      const hit = byLength.find((n) => text.startsWith(n, i + 1));
      if (hit) {
        flush();
        out.push(el('span', { class: 'mention' }, `@${hit}`));
        i += hit.length;
        continue;
      }
    }
    buf += text[i];
  }
  flush();
  return out;
}

function linkNodes(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    // href 는 정규식이 https?:// 로 시작하는 것만 잡았으므로 다른 스킴이 들어올 수 없습니다.
    out.push(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * 채팅 패널 하나를 만듭니다. 달력 화면(club.js)이 한 번만 부르고, 그 뒤로는 이 객체가 스스로 삽니다.
 *   getMembers()  달력이 이미 받아 둔 회원 목록 — 아바타 색과 @팝오버가 씁니다
 *   getToday()    서버가 준 오늘(한국 날짜). 날짜 구분선의 "오늘/어제" 판정
 */
export function createChat({ clubId, me, getClub, getMembers, getToday }) {
  const state = {
    open: false, loaded: false, loading: false,
    messages: [], hasMore: false, oldestId: null,
    myMembershipId: null, myLastRead: 0, memberCount: 0,
    readMarks: new Map(),                 // membership_id → last_read_message_id
    presence: [], typing: new Map(),      // membership_id → { name, until }
    editingId: null, unread: 0,
    mention: { open: false, list: [], index: 0 },
    connected: false
  };

  const badges = [];                      // 토글 버튼의 배지들 (달력이 다시 그릴 때마다 늘어납니다)
  let panel = null, logEl = null, headEl = null, mentionEl = null, typingEl = null, inputEl = null, sendEl = null, hintEl = null;
  let ws = null, retry = 0, retryTimer = null, typingSentAt = 0, typingTimer = null, closed = false;

  // ---------------------------------------------------------------- 토글 버튼

  /** 달력 헤더에 넣을 "💬 채팅" 버튼. draw() 마다 새로 만들어도 배지는 계속 살아 있습니다. */
  function button() {
    const badge = el('span', { class: 'chat-badge' }, state.unread ? String(state.unread) : '');
    badges.push(badge);
    return el('button', {
      class: state.open ? 'btn chat-toggle on' : 'btn chat-toggle',
      'aria-expanded': state.open ? 'true' : 'false',
      onclick: toggle
    }, '💬 채팅', badge);
  }

  function paintBadges() {
    for (let i = badges.length - 1; i >= 0; i--) {
      if (!badges[i].isConnected) { badges.splice(i, 1); continue; }
      badges[i].textContent = state.unread ? String(state.unread) : '';
      const btn = badges[i].parentElement;
      if (btn) {
        btn.classList.toggle('on', state.open);
        btn.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      }
    }
  }

  // ---------------------------------------------------------------- 패널 뼈대

  function build() {
    logEl = el('div', { class: 'chat-log', onscroll: onScroll });
    typingEl = el('div', { class: 'chat-typing' });
    mentionEl = el('div');
    headEl = el('div', { class: 'chat-head' });
    inputEl = el('input', {
      class: 'chat-input', placeholder: '메시지를 입력하세요  ( @ 로 멘션 )',
      oninput: onInput, onkeydown: onKey
    });
    sendEl = el('button', { class: 'chat-send', 'aria-label': '보내기', disabled: true, onclick: send }, '↑');
    hintEl = el('div', { class: 'chat-hint' }, 'Enter 전송 · @ 입력하면 멤버 목록이 열려요');

    // "입력 중…" 은 로그 **밖**에 둡니다. 안에 넣으면 위로 스크롤해 옛 대화를 읽는 동안 안 보입니다.
    panel = el('aside', { class: 'chat-panel', 'aria-label': '동아리 채팅' },
      headEl, logEl, typingEl, mentionEl,
      el('div', { class: 'chat-bar' },
        el('div', { class: 'chat-bar-row' }, inputEl, sendEl),
        hintEl));
  }

  // ---------------------------------------------------------------- 열고 닫기

  function toggle() { state.open ? close() : open(); }

  async function open() {
    if (!panel) build();
    state.open = true;
    document.body.append(panel);
    paintBadges();
    drawHead();
    if (!state.loaded) await reload();
    else { drawLog(); toBottom(); }
    inputEl.focus();
    readUpTo(latestId());
  }

  function close() {
    state.open = false;
    state.mention.open = false;
    panel?.remove();
    paintBadges();
  }

  // ---------------------------------------------------------------- 서버에서 읽기

  function latestId() {
    return state.messages.length ? state.messages[state.messages.length - 1].id : 0;
  }

  function absorb(page) {
    state.myMembershipId = page.my_membership_id;
    state.myLastRead = Math.max(state.myLastRead, page.my_last_read_id || 0);
    state.memberCount = page.member_count;
    state.unread = page.unread_count ?? state.unread;
    for (const r of page.read_marks || []) state.readMarks.set(r.membership_id, r.last_read_message_id);
  }

  async function reload() {
    if (state.loading) return;
    state.loading = true;
    try {
      const page = await api.get(`/api/clubs/${clubId}/messages?limit=50`);
      absorb(page);
      state.messages = page.messages;
      state.hasMore = page.has_more;
      state.oldestId = page.oldest_id;
      state.loaded = true;
      drawLog();
      toBottom();
      paintBadges();
    } catch (err) {
      if (state.open) toastError(err);
    } finally { state.loading = false; }
  }

  /** 위로 스크롤해 더 읽기. 스크롤 위치가 튀지 않게 높이 차이만큼 되돌립니다. */
  async function older() {
    if (state.loading || !state.hasMore || !state.oldestId) return;
    state.loading = true;
    const before = logEl.scrollHeight;
    try {
      const page = await api.get(`/api/clubs/${clubId}/messages?before=${state.oldestId}&limit=50`);
      absorb(page);
      state.messages = [...page.messages, ...state.messages];
      state.hasMore = page.has_more;
      state.oldestId = page.oldest_id ?? state.oldestId;
      drawLog();
      logEl.scrollTop += logEl.scrollHeight - before;
    } catch (err) { toastError(err); } finally { state.loading = false; }
  }

  /** 재연결 뒤 빠진 것 채우기. WebSocket 이 끊긴 동안 온 메시지를 DB 에서 그대로 가져옵니다 (§8.5). */
  async function catchUp() {
    if (!state.loaded) return reload();
    try {
      const page = await api.get(`/api/clubs/${clubId}/messages?after=${latestId()}&limit=100`);
      absorb(page);
      for (const m of page.messages) merge(m);
      drawLog();
      if (reading()) { toBottom(); readUpTo(latestId()); }
      paintBadges();
    } catch { /* 다음 재연결에서 다시 시도합니다 */ }
  }

  /** 같은 id 가 이미 있으면 갈아 끼우고, 없으면 시간순 자리에 넣습니다. */
  function merge(message) {
    const at = state.messages.findIndex((m) => m.id === message.id);
    if (at >= 0) { state.messages[at] = message; return false; }
    const pos = state.messages.findIndex((m) => m.id > message.id);
    if (pos < 0) state.messages.push(message); else state.messages.splice(pos, 0, message);
    return true;
  }

  // ---------------------------------------------------------------- 읽음

  async function readUpTo(id) {
    if (!id || id <= state.myLastRead) return;
    state.myLastRead = id;
    if (state.myMembershipId) state.readMarks.set(state.myMembershipId, id);
    state.unread = 0;
    paintBadges();
    drawLog();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'read', last_read_message_id: id }));
      return;
    }
    // 소켓이 없으면 REST 로. 읽음 표시가 소켓에만 의존하면 안 됩니다.
    try { await api.post(`/api/clubs/${clubId}/messages/read`, { last_read_message_id: id }); } catch { /* 다음에 */ }
  }

  const atBottom = () => !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  const toBottom = () => { if (logEl) logEl.scrollTop = logEl.scrollHeight; };

  /**
   * "지금 이 사람이 실제로 읽고 있다" 의 판정.
   * 탭이 뒤에 있으면 **읽은 게 아닙니다** — 숨은 탭에서 읽음 처리를 하면 보지도 않은 메시지가
   * 읽음으로 넘어가고, 상대에게는 "모두 읽음" 이 거짓말이 됩니다.
   */
  const reading = () => state.open && document.visibilityState === 'visible' && atBottom();

  function onScroll() {
    if (logEl.scrollTop < 40) older();
    if (reading()) readUpTo(latestId());
  }

  // 탭으로 돌아왔을 때 밀린 것을 정리합니다. 숨은 동안 쌓인 배지가 스크롤할 때까지 남아 있으면 안 됩니다.
  document.addEventListener('visibilitychange', () => { if (reading()) readUpTo(latestId()); });

  // ---------------------------------------------------------------- 그리기

  function drawHead() {
    if (!headEl) return;
    const club = getClub();
    const online = state.presence.length;
    render(headEl,
      el('div', { class: 'row', style: 'min-width:0;gap:9px;' },
        el('span', { class: 'color-dot', style: `background:${club.brand_color};` }),
        el('div', { style: 'min-width:0;' },
          el('div', { class: 'chat-head-name' }, club.name),
          el('div', { class: 'chat-head-sub' },
            `멤버 ${state.memberCount || getMembers().length}명${online ? ` · ${online}명 접속 중` : ''}`))),
      el('button', { class: 'chat-close', 'aria-label': '채팅 닫기', onclick: close }, '✕'));
  }

  function drawTyping() {
    if (!typingEl) return;
    const now = Date.now();
    const names = [...state.typing.values()].filter((t) => t.until > now).map((t) => t.name);
    typingEl.textContent = names.length
      ? `${names.slice(0, 2).join(', ')}님이 입력 중…${names.length > 2 ? ` 외 ${names.length - 2}명` : ''}`
      : '';
  }

  function drawLog() {
    if (!logEl || !state.open) return;
    const stick = atBottom();
    const members = getMembers();
    const byId = new Map(members.map((m) => [m.membership_id, m]));
    const names = members.map((m) => m.display_name);
    const today = getToday();
    const rows = [];
    let lastDay = null, prev = null;

    if (state.hasMore) {
      rows.push(el('button', { class: 'chat-more', onclick: older }, state.loading ? '불러오는 중…' : '이전 메시지 더 보기'));
    }

    for (const msg of state.messages) {
      const day = seoulDay(msg.created_at);
      if (day !== lastDay) {
        rows.push(el('div', { class: 'chat-divider' },
          el('span'), el('b', {}, dayLabel(day, today)), el('span')));
        lastDay = day;
        prev = null;
      }
      if (msg.kind === 'system') {
        rows.push(el('div', { class: 'chat-system' }, el('span', {}, msg.body)));
        prev = null;
        continue;
      }
      rows.push(messageRow(msg, prev, byId, names));
      prev = msg;
    }

    if (!state.messages.length) {
      rows.push(el('div', { class: 'tiny', style: 'text-align:center;padding:40px 0;' },
        '아직 대화가 없어요. 첫 메시지를 남겨 보세요.'));
    }
    render(logEl, rows);
    drawTyping();
    if (stick) toBottom();
  }

  function messageRow(msg, prev, byId, names) {
    const mine = msg.membership_id !== null && msg.membership_id === state.myMembershipId;
    // 같은 사람이 이어서 보내면 아바타·이름·시각을 생략하고 간격만 좁힙니다 (§8.6).
    const grouped = !!prev && prev.membership_id === msg.membership_id
      && clockLabel(prev.created_at) === clockLabel(msg.created_at);
    const member = byId.get(msg.membership_id);
    const mentioned = !mine && state.myMembershipId !== null && msg.mentions.includes(state.myMembershipId);

    const bubbleCls = ['chat-bubble'];
    if (msg.deleted) bubbleCls.push('chat-bubble-deleted');
    else if (mine) bubbleCls.push('chat-bubble-me');
    else if (mentioned) bubbleCls.push('chat-bubble-mention');

    const bubble = state.editingId === msg.id
      ? editBox(msg)
      : el('div', { class: bubbleCls.join(' ') },
        msg.deleted ? msg.deleted_placeholder : bodyNodes(msg.body, names),
        msg.edited ? el('span', { class: 'chat-edited' }, '(수정됨)') : null);

    // "안 읽음 N" — 이 메시지보다 읽음 지점이 뒤에 있는 **다른** 회원 수 (§8.3)
    const unreadN = [...state.readMarks.entries()]
      .filter(([mid, last]) => mid !== msg.membership_id && last < msg.id).length;

    const canDelete = !msg.deleted && (mine || getClub().my_role === 'president' || me.is_service_admin);
    const foot = el('div', { class: 'chat-foot' },
      el('span', { class: unreadN > 0 ? 'chat-read chat-read-unread' : 'chat-read' },
        unreadN > 0 ? `안 읽음 ${unreadN}` : '모두 읽음'),
      mine && !msg.deleted && state.editingId !== msg.id
        ? el('button', { class: 'chat-act', onclick: () => { state.editingId = msg.id; drawLog(); } }, '수정')
        : null,
      canDelete ? el('button', { class: 'chat-act chat-act-danger', onclick: () => remove(msg) }, '삭제') : null);

    const cls = ['chat-row'];
    if (grouped) cls.push('chat-row-grouped');
    if (mine) cls.push('chat-row-me');

    return el('div', { class: cls.join(' ') },
      grouped
        ? el('div', { class: 'chat-av-gap' })
        : el('div', { class: 'chat-av-gap' },
          member
            ? avatar({ display_name: member.display_name, member_color: member.member_color }, null, mine)
            : el('div', { class: 'avatar', style: 'background:#AEB4C0;' }, initial(msg.display_name))),
      el('div', { class: 'chat-col' },
        grouped ? null : el('div', { class: 'chat-meta' },
          el('b', {}, msg.display_name), el('span', {}, clockLabel(msg.created_at))),
        bubble,
        foot));
  }

  function editBox(msg) {
    const input = el('input', { class: 'chat-input', value: msg.body });
    const commit = async () => {
      const body = input.value.trim();
      if (!body || body === msg.body) { state.editingId = null; drawLog(); return; }
      try {
        merge(await api.patch(`/api/messages/${msg.id}`, { body }));
        state.editingId = null;
        drawLog();
      } catch (err) { toastError(err); }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { state.editingId = null; drawLog(); }
    });
    setTimeout(() => input.focus(), 0);
    return el('div', { class: 'chat-edit' }, input,
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-sm', onclick: () => { state.editingId = null; drawLog(); } }, '취소'),
        el('button', { class: 'btn btn-sm btn-ok', onclick: commit }, '저장')));
  }

  async function remove(msg) {
    const mine = msg.membership_id === state.myMembershipId;
    if (!await confirmModal({
      title: '메시지를 지울까요?',
      body: mine ? '지운 메시지는 "삭제된 메시지입니다" 로 남습니다.'
        : '다른 사람의 메시지를 지웁니다. 지운 사람은 기록에 남습니다.',
      confirmLabel: '지우기', danger: true
    })) return;
    try { merge(await api.del(`/api/messages/${msg.id}`)); drawLog(); } catch (err) { toastError(err); }
  }

  // ---------------------------------------------------------------- 입력 · 멘션

  function onInput() {
    sendEl.disabled = !inputEl.value.trim();
    const tail = /@([^\s@]*)$/.exec(inputEl.value);
    if (tail) {
      const q = tail[1];
      const list = getMembers()
        .filter((m) => m.membership_id !== state.myMembershipId && m.display_name.startsWith(q))
        .slice(0, 6);
      state.mention = { open: list.length > 0, list, index: 0 };
    } else {
      state.mention.open = false;
    }
    drawMention();
    signalTyping();
  }

  function drawMention() {
    if (!mentionEl) return;
    if (!state.mention.open) { render(mentionEl); return; }
    render(mentionEl, el('div', { class: 'chat-mention-pop' },
      el('div', { class: 'chat-mention-cap' }, '멤버 멘션'),
      state.mention.list.map((m, i) => el('button', {
        class: i === state.mention.index ? 'chat-mention-item on' : 'chat-mention-item',
        onclick: () => pickMention(m)
      },
      avatar({ display_name: m.display_name, member_color: m.member_color }),
      el('b', {}, m.display_name)))));
  }

  function pickMention(member) {
    inputEl.value = inputEl.value.replace(/@[^\s@]*$/, `@${member.display_name} `);
    state.mention.open = false;
    drawMention();
    sendEl.disabled = !inputEl.value.trim();
    inputEl.focus();
  }

  function onKey(e) {
    if (state.mention.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = state.mention.list.length;
        state.mention.index = (state.mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        drawMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(state.mention.list[state.mention.index]);
        return;
      }
      if (e.key === 'Escape') { state.mention.open = false; drawMention(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  async function send() {
    const body = inputEl.value.trim();
    if (!body) return;
    inputEl.value = '';
    sendEl.disabled = true;
    state.mention.open = false;
    drawMention();
    try {
      const message = await api.post(`/api/clubs/${clubId}/messages`, { body });
      merge(message);
      drawLog();
      toBottom();
      readUpTo(message.id);
    } catch (err) {
      inputEl.value = body;                 // 실패하면 쓴 글을 돌려줍니다
      sendEl.disabled = false;
      toastError(err);
    }
  }

  function signalTyping() {
    const now = Date.now();
    if (now - typingSentAt < TYPING_SEND_MS) return;
    typingSentAt = now;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'typing' }));
  }

  // ---------------------------------------------------------------- WebSocket

  function connect() {
    if (closed || ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(`${proto}://${location.host}/ws?club=${clubId}`); } catch { return schedule(); }

    ws.addEventListener('open', () => {
      state.connected = true;
      retry = 0;
      drawHint();
      catchUp();
    });
    ws.addEventListener('message', (e) => {
      let frame;
      try { frame = JSON.parse(e.data); } catch { return; }
      handle(frame);
    });
    const gone = () => {
      if (ws) { ws = null; state.connected = false; drawHint(); schedule(); }
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', () => ws?.close());
  }

  /** 끊기면 점점 뜸하게 다시 시도합니다. 그동안에도 REST 로 보내고 읽을 수 있습니다. */
  function schedule() {
    if (closed || retryTimer) return;
    const wait = Math.min(1000 * 2 ** retry++, RECONNECT_MAX_MS);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
  }

  function drawHint() {
    if (!hintEl) return;
    hintEl.className = state.connected ? 'chat-hint' : 'chat-hint chat-hint-off';
    hintEl.textContent = state.connected
      ? 'Enter 전송 · @ 입력하면 멤버 목록이 열려요'
      : '실시간 연결이 끊겼어요. 보내는 건 되고, 새 메시지는 곧 따라잡습니다.';
  }

  function handle(frame) {
    const { type, payload } = frame;

    if (type === 'message' || type === 'system') {
      // 서버가 이미 읽음 처리한 것들: 내가 보낸 메시지, 그리고 내 행동이 만든 시스템 메시지
      // (`actor_membership_id` — 시스템 메시지는 작성자가 NULL 이라 이 힌트가 없으면 구분할 수 없습니다).
      const byMe = state.myMembershipId !== null
        && (payload.membership_id === state.myMembershipId || payload.actor_membership_id === state.myMembershipId);
      if (state.loaded) merge(payload);
      if (!byMe && payload.id > state.myLastRead) {
        if (reading()) readUpTo(payload.id);
        else { state.unread++; paintBadges(); }
      }
      drawLog();
      return;
    }
    if (type === 'edit' || type === 'delete') {
      // 아직 안 읽어 온 메시지의 수정·삭제는 무시합니다. 여기서 끼워 넣으면 이력에 구멍이 생깁니다.
      if (state.messages.some((m) => m.id === payload.id)) { merge(payload); drawLog(); }
      return;
    }
    if (type === 'read') {
      state.readMarks.set(payload.membership_id, payload.last_read_message_id);
      drawLog();
      return;
    }
    if (type === 'presence') {
      state.presence = payload.members || [];
      drawHead();
      return;
    }
    if (type === 'typing') {
      if (payload.membership_id === state.myMembershipId) return;
      state.typing.set(payload.membership_id, { name: payload.display_name, until: Date.now() + TYPING_SHOW_MS });
      drawTyping();
      clearTimeout(typingTimer);
      typingTimer = setTimeout(drawTyping, TYPING_SHOW_MS + 100);
    }
  }

  // ---------------------------------------------------------------- 시작

  /** 배지를 먼저 채웁니다 — 패널을 한 번도 열지 않아도 "안 읽음 N" 이 보여야 합니다. */
  async function start() {
    try {
      const res = await api.get('/api/clubs/unread');
      const row = res.clubs.find((c) => c.club_id === clubId);
      state.unread = row?.unread_count ?? 0;
      paintBadges();
    } catch { /* 배지가 늦게 뜰 뿐입니다 */ }
    connect();
  }
  start();

  return {
    button,
    open,
    close,
    toggle,
    /** 회원 목록·오늘이 바뀌었을 때 달력이 알려 줍니다. */
    refresh() { if (state.open) { drawHead(); drawLog(); } },
    destroy() { closed = true; clearTimeout(retryTimer); ws?.close(); close(); }
  };
}
