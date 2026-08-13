import { api, requireMe } from './api.js';
import {
  $, confirmModal, el, initial, loadingBox, pageHead, render, toast, toastError
} from './ui.js';

const app = $('#app');
render(app, loadingBox());

let stats, clubs, users, policies, reports;

const me = await requireMe();
if (!me.is_service_admin) {
  render(app, el('div', { class: 'card', style: 'margin-top:40px;text-align:center;' },
    el('div', { class: 'lead' }, '서비스 관리자만 볼 수 있어요'),
    el('a', { class: 'btn btn-primary', style: 'margin-top:14px;', href: '/clubs.html' }, '내 동아리로')));
} else {
  await load();
}

async function load() {
  try {
    [stats, clubs, users, policies, reports] = await Promise.all([
      api.get('/api/admin/stats'),
      api.get('/api/admin/clubs').then((r) => r.clubs),
      api.get('/api/admin/users').then((r) => r.users),
      api.get('/api/admin/policies'),
      api.get('/api/admin/reports').then((r) => r.reports)
    ]);
    draw();
  } catch (err) { toastError(err); }
}

function draw() {
  render(app,
    pageHead('서비스 관리자 콘솔', {
      backHref: '/clubs.html', backLabel: '← 내 동아리',
      extras: [el('span', { class: 'tag tag-svc' }, '플랫폼 전역 권한')]
    }),
    statCards(),
    el('div', { class: 'stack', style: 'margin-top:18px;' },
      clubsCard(), usersCard(),
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;' }, policyCard(), noticeCard()),
      reportsCard()));
}

function statCards() {
  const cards = [
    ['전체 동아리', stats.club_count, '개', 'var(--indigo)'],
    ['전체 회원', stats.user_count, '명', 'var(--ok)'],
    ['이번 달 활성 동아리', stats.active_club_count, '개', '#0EA5E9'],
    ['대기 중 신고', stats.open_report_count, '건', 'var(--no)']
  ];
  return el('div', { class: 'stat-grid' }, cards.map(([label, value, unit, color]) =>
    el('div', { class: 'card' },
      el('div', { class: 'stat-label' }, label),
      el('div', { class: 'stat-value', style: `color:${color};` }, String(value), el('small', {}, unit)))));
}

// ---------- 전체 동아리 ----------
function clubsCard() {
  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '전체 동아리'),
    clubs.length
      ? el('div', { class: 'stack', style: 'gap:9px;' }, clubs.map((club) => el('div', { class: 'member-row' },
        el('span', { class: 'color-dot', style: `background:${club.brand_color};` }),
        el('div', { class: 'grow' },
          el('div', { style: 'font-size:14px;font-weight:600;' }, club.name),
          el('div', { class: 'tiny', style: 'margin-top:2px;' },
            `회장 ${club.president_name ?? '없음'} · 회원 ${club.member_count}명`)),
        club.status === 'active'
          ? el('span', { class: 'tag tag-ok' }, '활성')
          : el('span', { class: 'tag tag-no' }, '정지'),
        el('div', { class: 'row', style: 'gap:6px;flex:none;' },
          el('a', { class: 'btn btn-sm', href: `/club.html?id=${club.id}` }, '보기'),
          el('button', {
            class: 'btn btn-sm',
            onclick: () => suspendClub(club, club.status === 'active')
          }, club.status === 'active' ? '정지' : '정지 해제'),
          el('button', { class: 'btn btn-sm btn-danger', onclick: () => removeClub(club) }, '삭제')))))
      : el('div', { class: 'tiny' }, '아직 만들어진 동아리가 없어요.'));
}

async function suspendClub(club, suspend) {
  if (suspend && !await confirmModal({
    title: `"${club.name}" 을 정지할까요?`,
    body: '회원은 달력을 볼 수는 있지만 일정·초대·회원을 바꿀 수 없게 됩니다.',
    confirmLabel: '정지', danger: true
  })) return;
  try {
    await api.post(`/api/admin/clubs/${club.id}/suspend`, { suspend });
    toast(suspend ? '정지했어요.' : '정지를 해제했어요.', 'good');
    await load();
  } catch (err) { toastError(err); }
}

async function removeClub(club) {
  if (!await confirmModal({
    title: `"${club.name}" 을 삭제할까요?`,
    body: '회원·일정·메모·초대가 모두 사라집니다. 되돌릴 수 없어요.',
    confirmLabel: '영구 삭제', danger: true, requireText: club.name
  })) return;
  try {
    await api.del(`/api/admin/clubs/${club.id}`);
    toast('삭제했어요.', 'good');
    await load();
  } catch (err) { toastError(err); }
}

// ---------- 전체 회원 ----------
function usersCard() {
  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '전체 회원'),
    el('div', { class: 'stack', style: 'gap:9px;' }, users.map((user) => el('div', { class: 'member-row' },
      el('div', {
        class: 'avatar avatar-lg',
        style: `background:${user.status === 'active' ? '#5D5FEF' : '#C0C4CC'};`
      }, initial(user.display_name)),
      el('div', { class: 'grow' },
        el('div', { class: 'row', style: 'gap:7px;' },
          el('span', { style: 'font-size:14px;font-weight:600;' }, user.display_name),
          el('span', { class: 'mono tiny' }, user.username),
          user.is_service_admin ? el('span', { class: 'tag tag-svc' }, '서비스 관리자') : null),
        el('div', { class: 'tiny', style: 'margin-top:2px;' },
          `소속 동아리 ${user.club_count}개 · 마지막 로그인 ${user.last_login_at ? user.last_login_at.slice(0, 10) : '없음'}`)),
      user.status === 'active'
        ? el('span', { class: 'tag tag-ok' }, '정상')
        : el('span', { class: 'tag tag-no' }, '정지'),
      el('div', { class: 'row', style: 'gap:6px;flex:none;' },
        el('button', { class: 'btn btn-sm', onclick: () => resetPassword(user) }, '비밀번호 초기화'),
        el('button', {
          class: 'btn btn-sm',
          onclick: () => toggleAdmin(user)
        }, user.is_service_admin ? '권한 회수' : '관리자 권한'),
        el('button', {
          class: user.status === 'active' ? 'btn btn-sm btn-danger' : 'btn btn-sm',
          onclick: () => suspendUser(user, user.status === 'active')
        }, user.status === 'active' ? '계정 정지' : '정지 해제'))))));
}

async function resetPassword(user) {
  if (!await confirmModal({
    title: `${user.display_name} 님의 비밀번호를 초기화할까요?`,
    body: '새 비밀번호가 한 번만 표시됩니다. 본인에게 직접 전해 주세요.',
    confirmLabel: '초기화'
  })) return;
  try {
    const res = await api.post(`/api/admin/users/${user.id}/reset-password`);
    await confirmModal({
      title: '새 비밀번호',
      body: `${user.username} 의 새 비밀번호는 "${res.temporary_password}" 입니다. 이 창을 닫으면 다시 볼 수 없습니다.`,
      confirmLabel: '확인했어요'
    });
  } catch (err) { toastError(err); }
}

async function suspendUser(user, suspend) {
  try {
    await api.post(`/api/admin/users/${user.id}/suspend`, { suspend });
    toast(suspend ? '계정을 정지했어요.' : '정지를 해제했어요.', 'good');
    await load();
  } catch (err) { toastError(err); }
}

async function toggleAdmin(user) {
  const grant = !user.is_service_admin;
  if (!await confirmModal({
    title: grant ? `${user.display_name} 님에게 서비스 관리자 권한을 줄까요?` : '권한을 회수할까요?',
    body: grant ? '모든 동아리와 회원을 관리할 수 있게 됩니다.' : '플랫폼 콘솔에 들어갈 수 없게 됩니다.',
    confirmLabel: grant ? '권한 주기' : '회수', danger: !grant
  })) return;
  try {
    await api.post(`/api/admin/users/${user.id}/${grant ? 'grant-admin' : 'revoke-admin'}`);
    await load();
  } catch (err) { toastError(err); }
}

// ---------- 정책 ----------
function policyCard() {
  const row = (label, control) => el('div', { class: 'policy-row' },
    el('span', { style: 'font-size:13.5px;' }, label), control);

  const signup = el('button', {
    class: policies.signup_enabled ? 'switch on' : 'switch',
    onclick: () => patchPolicy({ signup_enabled: !policies.signup_enabled })
  }, el('i'));

  const daysSelect = el('select', {
    class: 'input',
    onchange: (e) => patchPolicy({ invite_default_days: Number(e.target.value) })
  }, [7, 30, 0].map((d) => el('option', {
    value: String(d), selected: policies.invite_default_days === d
  }, d === 0 ? '무제한' : `${d}일`)));

  const maxSelect = el('select', {
    class: 'input',
    onchange: (e) => patchPolicy({ club_max_members: Number(e.target.value) })
  }, [50, 100, 0].map((n) => el('option', {
    value: String(n), selected: policies.club_max_members === n
  }, n === 0 ? '무제한' : `${n}명`)));

  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '서비스 정책'),
    row('신규 회원가입 허용', signup),
    row('초대 링크 기본 유효기간', daysSelect),
    row('동아리당 최대 회원 수', maxSelect));
}

async function patchPolicy(patch) {
  try {
    policies = await api.patch('/api/admin/policies', patch);
    toast('정책을 바꿨어요.', 'good');
    draw();
  } catch (err) { toastError(err); await load(); }
}

// ---------- 공지 ----------
function noticeCard() {
  const title = el('input', { class: 'input input-sm', placeholder: '공지 제목', style: 'margin-bottom:9px;' });
  const body = el('textarea', { class: 'input input-sm', rows: '3', placeholder: '모든 회원에게 표시할 내용', style: 'margin-bottom:12px;' });

  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, '서비스 공지 등록'),
    title, body,
    el('button', {
      class: 'btn btn-primary', style: 'padding:10px 18px;',
      onclick: async () => {
        try {
          await api.post('/api/admin/notices', { title: title.value.trim(), body: body.value.trim() });
          title.value = ''; body.value = '';
          toast('공지를 발행했어요.', 'good');
        } catch (err) { toastError(err); }
      }
    }, '공지 발행'));
}

// ---------- 신고 ----------
function reportsCard() {
  const open = reports.filter((r) => r.status === 'open');
  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, `신고 ${open.length}건 대기`),
    open.length
      ? el('div', { class: 'stack', style: 'gap:9px;' }, open.map((report) => el('div', { class: 'member-row' },
        el('div', { class: 'grow' },
          el('div', { style: 'font-size:13.5px;font-weight:600;' },
            `${report.target_type === 'club' ? '동아리' : '회원'} #${report.target_id}`),
          el('div', { class: 'tiny', style: 'margin-top:2px;' }, report.reason)),
        el('button', { class: 'btn btn-sm', onclick: () => resolve(report, 'dismissed') }, '기각'),
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => resolve(report, 'resolved') }, '처리 완료'))))
      : el('div', { class: 'tiny' }, '대기 중인 신고가 없어요. (신고 접수 화면은 아직 없습니다.)'));
}

async function resolve(report, status) {
  try {
    await api.post(`/api/admin/reports/${report.id}/resolve`, { status });
    await load();
  } catch (err) { toastError(err); }
}
