import { api, qs, requireMe } from './api.js';
import {
  $, avatar, confirmModal, copyText, el, loadingBox, pageHead, promptModal, render, roleTag, toast, toastError
} from './ui.js';

const MEMBER_PALETTE = [
  '#5D5FEF', '#16A97A', '#F59E0B', '#E5484D', '#0EA5E9',
  '#D6409F', '#8B5CF6', '#F97316', '#0891B2', '#65A30D'
];

const clubId = Number(qs('id'));
const app = $('#app');
render(app, loadingBox());

const me = await requireMe();
let club, members, invites;
await load();

async function load() {
  try {
    [club, members, invites] = await Promise.all([
      api.get(`/api/clubs/${clubId}`),
      api.get(`/api/clubs/${clubId}/members`).then((r) => r.members),
      api.get(`/api/clubs/${clubId}/invites`).then((r) => r.invites).catch(() => [])
    ]);
  } catch (err) {
    render(app, el('div', { class: 'card', style: 'margin-top:40px;text-align:center;' },
      el('div', { class: 'lead' }, '관리 화면을 열 수 없어요'),
      el('div', { class: 'muted', style: 'margin-bottom:18px;' }, err.message),
      el('a', { class: 'btn btn-primary', href: '/clubs.html' }, '내 동아리로')));
    return;
  }
  const isPresident = club.my_role === 'president' || me.is_service_admin;
  if (!isPresident) {
    render(app, el('div', { class: 'card', style: 'margin-top:40px;text-align:center;' },
      el('div', { class: 'lead' }, '동아리 회장만 볼 수 있어요'),
      el('a', { class: 'btn btn-primary', style: 'margin-top:14px;', href: `/club.html?id=${clubId}` }, '달력으로')));
    return;
  }
  draw();
}

function draw() {
  render(app,
    pageHead(club.name, {
      backHref: `/club.html?id=${clubId}`, backLabel: '← 달력',
      extras: [
        el('span', { class: 'color-dot', style: `background:${club.brand_color};` }),
        el('span', { class: 'tiny' }, `회원 ${club.member_count}명`),
        me.is_service_admin && club.my_role !== 'president'
          ? el('span', { class: 'tag tag-svc' }, '서비스 관리자 권한으로 보는 중') : null
      ]
    }),
    el('div', { class: 'stack' }, inviteCard(), memberCard(), profileCard(), dangerCard()));
}

// ---------- 초대 링크 ----------
function inviteCard() {
  const usable = invites.filter((i) => i.usable);
  // 서버가 준 절대 주소를 씁니다. localhost 로 열었을 때 localhost 링크가 나가는 걸 막습니다
  // (.env 의 PUBLIC_BASE_URL). 옛 응답에는 url 이 없으니 현재 주소로 폴백합니다.
  const link = (invite) => invite.url || `${location.origin}${invite.path}`;

  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '초대 링크'),
    el('div', { class: 'tiny', style: 'margin-bottom:14px;' },
      '동아리 참여는 초대 링크로만 됩니다. 링크를 아는 사람은 누구나 들어올 수 있으니 필요할 때만 열어 두세요.'),
    usable.length
      ? el('div', { class: 'stack', style: 'gap:9px;' }, usable.map((invite) => el('div', { class: 'card-sub row' },
        el('code', { class: 'grow mono', style: 'font-size:12px;color:#5A616E;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
          link(invite)),
        el('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            if (await copyText(link(invite))) toast('링크를 복사했어요.', 'good');
            else toast('복사가 막혔어요. 링크를 직접 선택해 복사해 주세요.');
          }
        }, '복사'),
        el('span', { class: 'tiny', style: 'white-space:nowrap;' },
          invite.expires_at ? `${invite.expires_at.slice(5, 10)} 까지` : '기한 없음',
          invite.max_uses ? ` · ${invite.used_count}/${invite.max_uses}회` : ` · ${invite.used_count}회 사용`),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => revoke(invite) }, '회수'))))
      : el('div', { class: 'tiny', style: 'padding:6px 0 14px;' }, '살아 있는 초대 링크가 없어요.'),
    el('div', { class: 'row', style: 'margin-top:14px;' },
      el('button', { class: 'btn btn-primary', style: 'padding:9px 16px;', onclick: createInvite }, '+ 초대 링크 만들기')));
}

async function createInvite() {
  const days = await promptModal({
    title: '초대 링크 만들기',
    body: '유효기간을 일수로 적어 주세요. 0 은 기한 없음입니다.',
    label: '유효기간 (일)',
    value: '7',
    confirmLabel: '만들기'
  });
  if (days === null) return;
  try {
    await api.post(`/api/clubs/${clubId}/invites`, { expires_in_days: Number(days) || 0 });
    toast('초대 링크를 만들었어요. 복사해서 전해 주세요.', 'good');
    await load();
  } catch (err) { toastError(err); }
}

async function revoke(invite) {
  if (!await confirmModal({
    title: '이 초대 링크를 회수할까요?',
    body: '이미 이 링크로 들어온 회원은 그대로 남습니다. 앞으로 이 링크로는 들어올 수 없어요.',
    confirmLabel: '회수', danger: true
  })) return;
  try {
    await api.del(`/api/invites/${invite.token}`);
    toast('회수했어요.', 'good');
    await load();
  } catch (err) { toastError(err); }
}

// ---------- 회원 ----------
function memberCard() {
  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, `회원 ${members.length}명`),
    el('div', { class: 'stack', style: 'gap:9px;' }, members.map(memberRow)));
}

function memberRow(member) {
  const isMe = member.user_id === me.id;
  return el('div', { class: 'member-row' },
    avatar(member, null, isMe, true),
    el('div', { class: 'grow' },
      el('div', { class: 'row', style: 'gap:7px;' },
        el('span', { style: 'font-size:14px;font-weight:600;' }, member.display_name),
        roleTag(member.role),
        member.confirmed
          ? el('span', { class: 'tag tag-ok' }, '이번 달 확인함')
          : el('span', { class: 'tag' }, '미확인')),
      el('div', { class: 'swatches', style: 'margin-top:8px;' },
        MEMBER_PALETTE.map((color) => el('button', {
          class: color === member.member_color ? 'swatch on' : 'swatch',
          style: `background:${color};`, title: color,
          onclick: () => setColor(member, color)
        })))),
    member.role === 'president'
      ? null
      : el('div', { class: 'row', style: 'gap:6px;flex:none;' },
        el('button', { class: 'btn btn-sm', onclick: () => transfer(member) }, '회장직 넘기기'),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => kick(member) }, '내보내기')));
}

async function setColor(member, color) {
  try {
    await api.patch(`/api/clubs/${clubId}/members/${member.user_id}`, { member_color: color });
    await load();
  } catch (err) { toastError(err); }
}

async function transfer(member) {
  if (!await confirmModal({
    title: `${member.display_name} 님에게 회장직을 넘길까요?`,
    body: '넘기면 회장은 그 사람이 되고, 나는 일반 회원이 됩니다. 되돌리려면 새 회장이 다시 넘겨줘야 해요.',
    confirmLabel: '넘기기'
  })) return;
  try {
    await api.post(`/api/clubs/${clubId}/transfer`, { to_user_id: member.user_id });
    toast(`${member.display_name} 님이 회장이 되었습니다.`, 'good');
    await load();
  } catch (err) { toastError(err); }
}

async function kick(member) {
  if (!await confirmModal({
    title: `${member.display_name} 님을 내보낼까요?`,
    body: '이 동아리에 표시한 일정과 확정 기록이 함께 지워집니다. 다시 들어오려면 초대 링크가 필요해요.',
    confirmLabel: '내보내기', danger: true
  })) return;
  try {
    await api.del(`/api/clubs/${clubId}/members/${member.user_id}`);
    toast('내보냈어요.', 'good');
    await load();
  } catch (err) { toastError(err); }
}

// ---------- 동아리 정보 ----------
function profileCard() {
  const name = el('input', { class: 'input', value: club.name });
  const save = el('button', {
    class: 'btn btn-primary', style: 'padding:9px 16px;',
    onclick: async () => {
      try {
        await api.patch(`/api/clubs/${clubId}`, { name: name.value.trim() });
        toast('이름을 바꿨어요.', 'good');
        await load();
      } catch (err) { toastError(err); }
    }
  }, '이름 저장');

  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '동아리 정보'),
    el('label', { class: 'field' }, el('span', {}, '이름'), name),
    el('div', { class: 'field' }, el('span', {}, '카드 색'),
      el('div', { class: 'swatches' }, MEMBER_PALETTE.map((color) => el('button', {
        class: color === club.brand_color ? 'swatch on' : 'swatch',
        style: `background:${color};`, title: color,
        onclick: async () => {
          try {
            await api.patch(`/api/clubs/${clubId}`, { brand_color: color });
            await load();
          } catch (err) { toastError(err); }
        }
      })))),
    save);
}

// ---------- 위험 구역 ----------
function dangerCard() {
  return el('div', { class: 'card danger-zone' },
    el('div', { class: 'card-title' }, '위험 구역'),
    el('div', { class: 'row-between', style: 'padding:9px 0;' },
      el('div', {},
        el('div', { style: 'font-size:13.5px;font-weight:600;' }, '동아리 삭제'),
        el('div', { class: 'tiny' }, '회원·일정·메모·초대가 모두 사라집니다. 되돌릴 수 없어요.')),
      el('button', { class: 'btn btn-danger', onclick: removeClub }, '동아리 삭제')));
}

async function removeClub() {
  if (!await confirmModal({
    title: '정말 삭제할까요?',
    body: `되돌릴 수 없습니다. 확인을 위해 동아리 이름 "${club.name}" 을 그대로 입력해 주세요.`,
    confirmLabel: '영구 삭제', danger: true, requireText: club.name
  })) return;
  try {
    await api.del(`/api/clubs/${clubId}`, { name: club.name });
    toast('동아리를 삭제했어요.', 'good');
    location.replace('/clubs.html');
  } catch (err) { toastError(err); }
}
