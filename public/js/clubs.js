import { api, requireMe, toLogin } from './api.js';
import {
  $, accountMenu, avatarStack, brandMark, el, emptyBox, loadingBox, promptModal,
  render, roleTag, toast, toastError
} from './ui.js';

const app = $('#app');
render(app, loadingBox());

// ⚠️ `await draw()` 보다 **위**에 둬야 합니다. draw() 가 곧바로 읽는데 let 은 호이스팅되지 않아
// 아래에 두면 TDZ ReferenceError 로 화면이 LOADING 에서 멈춥니다 (tests/frontend-init.test.js).
/** club_id → 안 읽은 채팅 개수. 실패해도 목록은 그려야 하므로 빈 Map 으로 넘어갑니다. */
let unread = new Map();

const me = await requireMe();
await draw();

async function draw() {
  let data;
  try { data = await api.get('/api/clubs'); } catch (err) { toastError(err); return; }
  try {
    const res = await api.get('/api/clubs/unread');
    unread = new Map(res.clubs.map((c) => [c.club_id, c.unread_count]));
  } catch { unread = new Map(); }

  // 확인 안 한 동아리를 위로. 그 다음은 이름 순(서버 정렬 유지).
  const clubs = [...data.clubs].sort((a, b) => rank(a) - rank(b));

  render(app,
    el('div', { class: 'row-between', style: 'margin-bottom:24px;' },
      brandMark(true),
      accountMenu(me, { onLogout: logout })),
    el('div', { class: 'row-between', style: 'margin-bottom:18px;' },
      el('div', {},
        el('div', { class: 'page-title' }, '내 동아리'),
        el('div', { class: 'tiny', style: 'margin-top:4px;' },
          clubs.length
            ? `${data.month.slice(5)}월 기준 · 확인 필요 ${clubs.filter((c) => c.my_month_state !== 'confirmed').length}개`
            : '아직 참여한 동아리가 없어요')),
      el('button', { class: 'btn btn-primary', onclick: createClub }, '+ 동아리 만들기')),
    clubs.length
      ? el('div', { class: 'club-grid' }, clubs.map(card))
      : el('div', { class: 'card' }, emptyBox('🏄', '동아리가 없어요',
        '동아리를 만들면 회장이 됩니다. 이미 있는 동아리에는 초대 링크로만 들어갈 수 있어요.',
        el('button', { class: 'btn btn-primary', onclick: createClub }, '+ 동아리 만들기'))));
}

// 함수 선언으로 둡니다 — draw() 가 위에서 먼저 불리므로 화살표 const 로 두면 TDZ 오류가 납니다.
function rank(club) {
  return club.my_month_state === 'confirmed' ? 1 : 0;
}

function card(club) {
  const needs = club.my_month_state !== 'confirmed';
  const stateTag = needs
    ? el('span', { class: 'tag tag-president' }, '확인 필요')
    : el('span', { class: 'tag tag-ok' }, '확인함');

  return el('button', {
    class: needs ? 'club-card club-card-needs' : 'club-card',
    onclick: () => { location.href = `/club.html?id=${club.id}`; }
  },
  el('div', { class: 'club-bar', style: `background:${club.brand_color};` }),
  el('div', { class: 'club-body' },
    el('div', { class: 'row-between', style: 'margin-bottom:14px;' },
      el('div', { class: 'row', style: 'min-width:0;gap:8px;' },
        el('div', { class: 'club-name' }, club.name),
        // 안 읽은 채팅이 있으면 이름 옆에 빨간 배지. 0 이면 아예 그리지 않습니다.
        unread.get(club.id) ? el('span', { class: 'chat-badge' }, String(unread.get(club.id))) : null),
      stateTag),
    el('div', { class: 'row-between' },
      el('div', { class: 'row' },
        avatarStack(club.members_preview),
        el('span', { class: 'tiny', style: 'margin-left:10px;' }, `${club.member_count}명`)),
      el('div', { class: 'row' },
        club.status === 'suspended' ? el('span', { class: 'tag tag-no' }, '정지') : null,
        roleTag(club.my_role)))));
}

async function createClub() {
  const name = await promptModal({
    title: '동아리 만들기',
    body: '만든 사람이 회장이 됩니다. 회원은 초대 링크로 모을 수 있어요.',
    label: '동아리 이름',
    placeholder: '예: 서핑보드',
    confirmLabel: '만들기'
  });
  if (!name) return;
  try {
    const club = await api.post('/api/clubs', { name });
    toast(`"${club.name}" 을 만들었습니다.`, 'good');
    location.href = `/club-admin.html?id=${club.id}`;
  } catch (err) { toastError(err); }
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* 이미 끊겼으면 그냥 넘어갑니다 */ }
  toLogin();
}
