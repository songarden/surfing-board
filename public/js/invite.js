import { api, qs, requireMe } from './api.js';
import { $, avatarStack, brandMark, el, emptyBox, loadingBox, render, toastError } from './ui.js';

const token = qs('token');
const app = $('#app');
render(app, loadingBox());

if (!token) {
  render(app, el('div', { class: 'card card-lg' },
    emptyBox('🔗', '초대 링크가 올바르지 않아요', '링크 전체를 다시 복사해 열어 주세요.',
      el('a', { class: 'btn', href: '/clubs.html' }, '내 동아리로'))));
} else {
  await requireMe();
  try {
    const invite = await api.get(`/api/invites/${token}`);
    render(app, view(invite));
  } catch (err) {
    render(app, el('div', { class: 'card card-lg' },
      emptyBox('🚫', '이 초대는 쓸 수 없어요', err.message,
        el('a', { class: 'btn', href: '/clubs.html' }, '내 동아리로'))));
  }
}

function view(invite) {
  const join = el('button', { class: 'btn btn-primary btn-block', onclick: onJoin }, '참여하기');

  async function onJoin() {
    join.disabled = true;
    try {
      const res = await api.post(`/api/invites/${token}/accept`);
      location.replace(`/club.html?id=${res.club_id}`);
    } catch (err) {
      if (err.code === 'ALREADY_MEMBER') { location.replace(`/club.html?id=${err.data.club_id}`); return; }
      toastError(err);
      join.disabled = false;
    }
  }

  return [
    el('div', { style: 'display:flex;justify-content:center;margin-bottom:30px;' }, brandMark()),
    el('div', { class: 'card card-lg', style: 'text-align:center;' },
      el('div', { class: 'label-cap', style: 'margin-bottom:10px;' }, 'INVITATION'),
      el('div', { style: 'font-size:24px;font-weight:800;letter-spacing:-.03em;' }, invite.club.name),
      el('div', { class: 'muted', style: 'margin-top:6px;' },
        `회장 ${invite.club.president_name ?? '알 수 없음'} · 회원 ${invite.club.member_count}명`),
      el('div', { style: 'display:flex;justify-content:center;margin:22px 0;' },
        avatarStack(invite.members_preview, true)),
      el('div', { class: 'tiny', style: 'line-height:1.6;margin-bottom:22px;' },
        '이 동아리에서는 ', el('b', {}, '안 되는 날만'), ' 표시하면 됩니다.',
        el('br'), '표시하지 않은 평일은 자동으로 "가능" 으로 집계돼요.'),
      invite.already_member
        ? el('a', { class: 'btn btn-primary btn-block', href: `/club.html?id=${invite.club.id}` }, '이미 회원이에요 · 달력 보기')
        : join,
      invite.expires_at
        ? el('div', { class: 'tiny', style: 'margin-top:14px;' }, `링크 유효기간 ${invite.expires_at.slice(0, 10)} 까지`)
        : null)
  ];
}
