import { api, requireMe, toLogin } from './api.js';
import { $, confirmModal, el, loadingBox, pageHead, render, roleTag, toast, toastError } from './ui.js';

const app = $('#app');
render(app, loadingBox());

const me = await requireMe();
const clubs = (await api.get('/api/clubs').catch(() => ({ clubs: [] }))).clubs;
draw();

function draw() {
  render(app,
    pageHead('계정 설정', { backHref: '/clubs.html', backLabel: '← 내 동아리' }),
    el('div', { class: 'stack' }, profileCard(), passwordCard(), clubsCard(), dangerCard()));
}

function profileCard() {
  const displayName = el('input', { class: 'input', value: me.display_name });
  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '프로필'),
    el('label', { class: 'field' }, el('span', {}, '표시 이름'), displayName),
    el('div', { class: 'tiny', style: 'margin-bottom:16px;' },
      '아이디 ', el('span', { class: 'mono', style: 'color:#1A1D24;font-weight:500;' }, me.username), ' · 변경 불가',
      me.is_service_admin ? [' · ', el('span', { class: 'tag tag-svc' }, '서비스 관리자')] : null),
    el('button', {
      class: 'btn btn-primary', style: 'padding:9px 16px;',
      onclick: async () => {
        try {
          await api.patch('/api/me', { display_name: displayName.value.trim() });
          toast('표시 이름을 바꿨어요.', 'good');
          location.reload();
        } catch (err) { toastError(err); }
      }
    }, '저장'));
}

function passwordCard() {
  const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '8자 이상' });
  const error = el('div', { class: 'error-text' });

  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '비밀번호 변경'),
    el('label', { class: 'field' }, el('span', {}, '지금 비밀번호'), current),
    el('label', { class: 'field' }, el('span', {}, '새 비밀번호'), next),
    error,
    el('button', {
      class: 'btn btn-primary', style: 'padding:9px 16px;',
      onclick: async () => {
        error.textContent = '';
        try {
          await api.post('/api/auth/password', { current: current.value, next: next.value });
          current.value = ''; next.value = '';
          toast('비밀번호를 바꿨어요.', 'good');
        } catch (err) { error.textContent = err.message; }
      }
    }, '바꾸기'));
}

function clubsCard() {
  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, `참여 중인 동아리 ${clubs.length}개`),
    clubs.length
      ? el('div', { class: 'stack', style: 'gap:9px;' }, clubs.map((club) => el('div', { class: 'member-row' },
        el('span', { class: 'color-dot', style: `background:${club.brand_color};` }),
        el('a', { class: 'grow', href: `/club.html?id=${club.id}`, style: 'font-weight:600;color:#1A1D24;' }, club.name),
        roleTag(club.my_role),
        club.my_role === 'member'
          ? el('button', { class: 'btn btn-sm btn-danger', onclick: () => leave(club) }, '나가기')
          : el('span', { class: 'tiny' }, '회장직을 넘긴 뒤 나갈 수 있어요'))))
      : el('div', { class: 'tiny' }, '아직 참여한 동아리가 없어요.'));
}

async function leave(club) {
  if (!await confirmModal({
    title: `"${club.name}" 에서 나갈까요?`,
    body: '이 동아리에 표시한 일정과 확정 기록이 사라집니다. 다시 들어오려면 초대 링크가 필요해요.',
    confirmLabel: '나가기', danger: true
  })) return;
  try {
    await api.del(`/api/clubs/${club.id}/leave`);
    toast('나왔어요.', 'good');
    location.reload();
  } catch (err) { toastError(err); }
}

function dangerCard() {
  return el('div', { class: 'card danger-zone' },
    el('div', { class: 'card-title' }, '위험 구역'),
    el('div', { class: 'row-between', style: 'padding:9px 0;' },
      el('div', {},
        el('div', { style: 'font-size:13.5px;font-weight:600;' }, '계정 탈퇴'),
        el('div', { class: 'tiny' },
          '모든 동아리에서 빠지고 일정 기록이 사라집니다. 회장인 동아리가 있으면 먼저 넘기거나 삭제해야 해요.')),
      el('button', { class: 'btn btn-danger', onclick: removeAccount }, '계정 탈퇴')));
}

async function removeAccount() {
  if (!await confirmModal({
    title: '정말 탈퇴할까요?',
    body: `되돌릴 수 없습니다. 확인을 위해 아이디 "${me.username}" 을 그대로 입력해 주세요.`,
    confirmLabel: '탈퇴', danger: true, requireText: me.username
  })) return;
  try {
    await api.del('/api/me');
    toLogin();
  } catch (err) { toastError(err); }
}
