import { api, qs, requireMe } from './api.js';
import {
  $, DOW_KO, avatar, confirmModal, el, loadingBox, monthLabel, render, roleTag,
  shiftMonth, thisMonth, toast, toastError
} from './ui.js';
import { createChat } from './chat.js';
import { openShareModal } from './share.js';
// 오늘 판정은 ui.js 의 todayISO() 대신 서버가 준 summary.today 를 씁니다 — 브라우저 시계에
// 기대면 사용자마다 "지난 날짜" 경계가 달라집니다. thisMonth() 는 첫 진입 월 결정에만 씁니다.

const clubId = Number(qs('id'));
const app = $('#app');
render(app, loadingBox());

// ⚠️ 모듈 상수는 아래 `await load()` 보다 **위**에 둬야 합니다. load() → draw() → hero() 가
// 곧바로 읽는데, const 는 호이스팅되지 않아 아래에 두면 TDZ ReferenceError 로 화면이
// LOADING 에서 멈춥니다 (load() 의 catch 가 잡아 토스트만 뜹니다).
const HERO_PREVIEW = 3;   // 추천 날짜 중 제목에 바로 보여줄 수. 나머지는 "외 N일" 로 펼칩니다.

// 채팅 패널. **회원일 때만** 만듭니다 — 소속 없는 서비스 관리자는 채팅을 읽고 쓸 수 없습니다.
// 패널은 #app 밖(body)에 살아서 draw() 가 다시 그려도 스크롤·입력 중인 글자가 남습니다.
let chat = null;

const me = await requireMe();
if (!clubId) location.replace('/clubs.html');

const state = {
  month: qs('month') || thisMonth(),
  cal: null,          // GET /calendar 응답
  myClubs: [],
  switcherOpen: false,
  showUnconfirmed: false,
  showAllBest: false,       // 추천 날짜 "외 N일" 펼침 여부
  openDay: null,
  /**
   * 수정 모드에서 모아 두는 변경. { 'YYYY-MM-DD': 'no'|'maybe'|null }
   * 확정 저장에서 한 번에 커밋하고, 취소하면 그냥 버립니다 → 서버를 건드리지 않습니다.
   */
  draft: null
};

await load();

async function load() {
  try {
    const [cal, clubs] = await Promise.all([
      api.get(`/api/clubs/${clubId}/calendar?month=${state.month}`),
      api.get('/api/clubs')
    ]);
    state.cal = cal;
    state.myClubs = clubs.clubs;
    if (state.cal.my_month_state !== 'editing') state.draft = null;
    else if (!state.draft) state.draft = {};
    draw();
  } catch (err) {
    if (err.status === 404) {
      render(app, el('div', { class: 'card', style: 'margin-top:40px;text-align:center;' },
        el('div', { class: 'lead' }, '볼 수 없는 동아리예요'),
        el('div', { class: 'muted', style: 'margin-bottom:18px;' }, '초대를 받아 참여했는지 확인해 주세요.'),
        el('a', { class: 'btn btn-primary', href: '/clubs.html' }, '내 동아리로')));
      return;
    }
    toastError(err);
  }
}

/** 화면에 보여줄 내 상태 — 수정 중이면 draft 를 먼저 봅니다. */
function myStatus(day) {
  if (state.draft && day.date in state.draft) return state.draft[day.date];
  return day.my_status;
}

/** draft 를 반영한 날짜별 집계 (수정 중에도 숫자가 바로 움직이게) */
function counts(day) {
  const total = state.cal.summary.member_count;
  if (!day.selectable) return { ok: 0, maybe: 0, no: 0, total };
  let no = day.no_count, maybe = day.maybe_count;
  const before = day.my_status, after = myStatus(day);
  if (before !== after) {
    if (before === 'no') no--; else if (before === 'maybe') maybe--;
    if (after === 'no') no++; else if (after === 'maybe') maybe++;
  }
  return { ok: total - no - maybe, maybe, no, total };
}

// 함수 선언 — draw() 가 위에서 먼저 불리므로 화살표 const 로 두면 TDZ 오류가 납니다.
function stateOf() {
  return state.draft ? 'editing' : state.cal.my_month_state;
}
function canEdit() {
  return state.cal.club.status !== 'suspended' && state.cal.club.my_role !== null
    && (stateOf() === 'unconfirmed' || stateOf() === 'editing');
}

function draw() {
  render(app, header(), hero(), unconfirmedPanel(), monthBar(), banner(), grid());
  // 회원 목록·오늘이 바뀌었을 수 있으니 열려 있는 패널도 다시 그립니다.
  chat?.refresh();
}

// ---------- 머리 ----------
function header() {
  const cal = state.cal;
  const switcher = el('div', { class: 'dropdown-anchor' },
    el('button', {
      class: 'club-switch-btn',
      onclick: (e) => { e.stopPropagation(); state.switcherOpen = !state.switcherOpen; draw(); }
    },
    el('span', { class: 'color-dot', style: `background:${cal.club.brand_color};` }),
    el('span', { class: 'name' }, cal.club.name),
    cal.club.my_role ? roleTag(cal.club.my_role) : el('span', { class: 'tag tag-svc' }, '서비스 관리자'),
    el('span', { style: 'color:#AEB4C0;font-size:11px;' }, '▾')),
    state.switcherOpen
      ? el('div', { class: 'dropdown' }, state.myClubs.map((c) => el('button', {
        onclick: () => { location.href = `/club.html?id=${c.id}`; }
      },
      el('span', { class: 'color-dot', style: `background:${c.brand_color};` }),
      el('span', { class: 'grow' }, c.name),
      c.my_month_state !== 'confirmed' ? el('span', { class: 'dot-indigo' }) : null)))
      : null);

  if (state.switcherOpen) {
    document.addEventListener('click', function once() {
      state.switcherOpen = false;
      document.removeEventListener('click', once);
      draw();
    }, { once: true });
  }

  if (!chat && cal.club.my_role) {
    chat = createChat({
      clubId,
      me,
      getClub: () => state.cal.club,
      getMembers: () => state.cal.members,
      getToday: () => state.cal.summary.today
    });
  }

  const isPresident = cal.club.my_role === 'president' || me.is_service_admin;
  return el('div', { class: 'row-between', style: 'margin-bottom:20px;' },
    el('div', { class: 'row' }, el('a', { class: 'btn', href: '/clubs.html' }, '←'), switcher),
    el('div', { class: 'row' },
      chat ? chat.button() : null,
      isPresident ? el('a', { class: 'btn', href: `/club-admin.html?id=${clubId}` }, '⚙ 동아리 관리') : null,
      el('a', { class: 'btn', href: '/account.html' }, `${me.display_name} 님`)));
}

// ---------- 추천 히어로 ----------
/** '2026-08-20' → '8/20(목)' */
function shortDate(date) {
  const dow = DOW_KO[new Date(date + 'T00:00:00Z').getUTCDay()];
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${dow})`;
}

function hero() {
  const s = state.cal.summary;
  const best = s.best_dates;                 // 서버가 지난 날짜를 뺀 뒤 준 후보입니다.
  const fullParty = new Set(s.full_party_dates);
  const full = s.best_count === s.member_count && s.member_count > 0;
  const label = full ? '풀파티' : best.length > 1 ? `후보 ${best.length}일` : '최다 가능';
  const hidden = best.length - HERO_PREVIEW;

  // 후보가 없는 이유를 구분해서 알려줍니다. "지난 달" 과 "공휴일뿐" 은 대처가 다릅니다.
  const emptyTitle = s.past_excluded > 0 ? '남은 평일이 없어요' : '이번 달에는 후보가 없어요';
  const emptySub = s.past_excluded > 0
    ? '이 달의 평일이 모두 지났습니다. → 로 다음 달을 보세요.'
    : '평일이 모두 공휴일이거나 회원이 없습니다.';

  const title = best.length
    ? el('div', { class: 'hero-title' },
      best.slice(0, HERO_PREVIEW).map(shortDate).join(' · '),
      hidden > 0
        ? el('button', {
          class: 'hero-more',
          'aria-expanded': state.showAllBest ? 'true' : 'false',
          onclick: () => { state.showAllBest = !state.showAllBest; draw(); }
        }, state.showAllBest ? '접기 ▴' : `외 ${hidden}일 ▾`)
        : null)
    : el('div', { class: 'hero-title' }, emptyTitle);

  const sub = best.length
    ? `${s.member_count}명 중 ${s.best_count}명 가능${full ? ' · 전원이 됩니다 🎉' : ''}`
    : emptySub;

  return el('div', { class: 'hero', style: 'margin-bottom:18px;' },
    el('div', { class: 'hero-main' },
      el('div', { class: 'hero-cap' }, `추천 날짜 · ${label}`),
      title,
      el('div', { class: 'hero-sub' }, sub),
      // 동호회의 실질적 소통 창구는 네이버 웍스 대화방입니다. 달력이 약속으로 이어지려면
      // 추천 날짜를 여기서 바로 그쪽으로 넘길 수 있어야 합니다.
      // 회원에게만 보입니다 — 링크를 만드는 API 가 소속을 요구합니다(소속 없는 서비스 관리자 403).
      state.cal.club.my_role
        ? el('button', {
          class: 'hero-share',
          onclick: () => openShareModal({
            clubId,
            month: state.month,
            pendingChanges: Object.keys(state.draft || {}).length
          })
        }, '💬 메신저로 공유')
        : null,
      state.showAllBest && hidden > 0
        ? el('div', { class: 'hero-dates' },
          best.map((d) => el('span', {
            class: fullParty.has(d) ? 'hero-date hero-date-full' : 'hero-date'
          }, shortDate(d), fullParty.has(d) ? ' 🎉' : '')))
        : null),
    el('div', { class: 'hero-stat' },
      el('div', { class: 'hero-stat-label' }, '이번 달 확인'),
      el('div', { class: 'hero-stat-value' }, String(s.confirmed_count), el('small', {}, `/${s.member_count}`)),
      s.unconfirmed_members.length
        ? el('button', {
          class: 'hero-btn',
          onclick: () => { state.showUnconfirmed = !state.showUnconfirmed; draw(); }
        }, state.showUnconfirmed ? '명단 접기' : `미확인 ${s.unconfirmed_members.length}명 보기`)
        : el('div', { class: 'hero-stat-label', style: 'margin-top:8px;' }, '전원 확인 완료')));
}

function unconfirmedPanel() {
  if (!state.showUnconfirmed) return null;
  const list = state.cal.summary.unconfirmed_members;
  const isPresident = state.cal.club.my_role === 'president' || me.is_service_admin;
  return el('div', { class: 'card', style: 'margin-bottom:18px;border-radius:14px;padding:16px 18px;animation:sbpop .16s;' },
    el('div', { style: 'font-size:12px;font-weight:600;color:#5A616E;margin-bottom:10px;' }, '아직 확인 안 한 사람'),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:7px;' },
      list.map((m) => el('span', { class: 'chip' }, m.display_name))),
    isPresident
      ? el('div', { class: 'tiny', style: 'margin-top:11px;' },
        '미확인이 많으면 추천 날짜 신뢰도가 낮아요. 단톡방에서 살짝 재촉해보세요.')
      : null);
}

// ---------- 월 이동 + 일괄 툴바 ----------
function monthBar() {
  const { month, year } = monthLabel(state.month);
  // 달을 옮기면 후보 목록이 완전히 달라지니 펼침도 접습니다.
  const go = (delta) => () => {
    state.month = shiftMonth(state.month, delta);
    state.openDay = null; state.draft = null; state.showAllBest = false;
    load();
  };

  return el('div', { class: 'row-between', style: 'margin-bottom:16px;' },
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-icon', 'aria-label': '이전 달', onclick: go(-1) }, '←'),
      el('div', { style: 'font-size:20px;font-weight:700;letter-spacing:-.02em;min-width:120px;text-align:center;' },
        month, ' ', el('span', { style: 'color:#AEB4C0;font-weight:500;font-size:15px;' }, year)),
      el('button', { class: 'btn btn-icon', 'aria-label': '다음 달', onclick: go(1) }, '→'),
      el('button', {
        class: 'btn', onclick: () => { state.month = thisMonth(); state.draft = null; state.showAllBest = false; load(); }
      }, '오늘')),
    canEdit() ? toolbar() : null);
}

function toolbar() {
  const weekdayOn = (dow) => {
    const days = state.cal.days.filter((d) => d.selectable && d.dow === dow);
    return days.length > 0 && days.every((d) => myStatus(d) === 'no');
  };

  return el('div', { class: 'toolbar' },
    el('span', { class: 'toolbar-label' }, '내 일정'),
    el('button', { class: 'btn btn-sm btn-ok', onclick: () => bulk({ op: 'all_ok' }) }, '전부 가능'),
    el('button', { class: 'btn btn-sm', onclick: () => bulk({ op: 'copy_last' }) }, '지난달 복사'),
    el('span', { class: 'toolbar-divider' }),
    el('span', { class: 'toolbar-label' }, '요일 불가'),
    [1, 2, 3, 4, 5].map((dow) => el('button', {
      class: weekdayOn(dow) ? 'dow-btn on' : 'dow-btn',
      onclick: () => bulk({ op: 'weekday_off', dow, on: !weekdayOn(dow) })
    }, DOW_KO[dow])));
}

/** 일괄 입력. 수정 중이면 draft 에만 반영하고 서버는 확정 저장에서 한 번에 씁니다. */
async function bulk(payload) {
  const days = state.cal.days.filter((d) => d.selectable);
  if (state.draft) {
    if (payload.op === 'all_ok') for (const d of days) state.draft[d.date] = null;
    if (payload.op === 'weekday_off') {
      for (const d of days.filter((x) => x.dow === payload.dow)) state.draft[d.date] = payload.on ? 'no' : null;
    }
    if (payload.op === 'copy_last') {
      toast('수정 중에는 지난달 복사를 쓸 수 없어요. 확정 저장 뒤에 다시 시도해 주세요.');
      return;
    }
    draw();
    return;
  }
  try {
    const res = await api.post(`/api/clubs/${clubId}/availability/bulk`, { month: state.month, ...payload });
    if (payload.op === 'copy_last') {
      toast(res.copied
        ? `지난달에서 ${res.copied}일을 옮겼어요${res.skipped ? ` (${res.skipped}일은 주말·공휴일이라 건너뜀)` : ''}.`
        : '지난달에 표시한 날이 없어요.', 'good');
    }
    await load();
  } catch (err) { toastError(err); }
}

// ---------- 확정 상태 배너 ----------
function banner() {
  if (!state.cal.club.my_role) {
    return el('div', { class: 'banner banner-fresh', style: 'margin-bottom:16px;' },
      el('div', {},
        el('div', { class: 'banner-title' }, '서비스 관리자 시점 · 읽기 전용'),
        el('div', { class: 'tiny', style: 'margin-top:3px;' }, '이 동아리 회원이 아니라 일정을 표시할 수 없습니다.')));
  }
  const sub = `${state.cal.summary.confirmed_count}/${state.cal.summary.member_count}명이 이번 달을 확정했어요.`;

  if (stateOf() === 'editing') {
    const changed = Object.keys(state.draft || {}).length;
    return el('div', { class: 'banner banner-editing', style: 'margin-bottom:16px;' },
      el('div', { class: 'row' },
        el('span', { class: 'banner-icon' }, '✎'),
        el('div', {},
          el('div', { class: 'banner-title' }, '수정 중 · 날짜를 눌러 내 일정을 바꿔보세요'),
          el('div', { class: 'tiny', style: 'margin-top:2px;' },
            changed ? `바꾼 날 ${changed}일 · 확정 저장을 눌러야 반영돼요.` : sub))),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: cancelEdit }, '취소'),
        el('button', { class: 'btn btn-primary', style: 'padding:9px 17px;', onclick: saveConfirm }, '✓ 확정 저장')));
  }

  if (stateOf() === 'confirmed') {
    return el('div', { class: 'banner banner-locked', style: 'margin-bottom:16px;' },
      el('div', { class: 'row' },
        el('span', { class: 'banner-icon' }, '✓'),
        el('div', {},
          el('div', { class: 'banner-title' }, '이번 달 일정을 확정했어요 · 🔒 읽기 전용'),
          el('div', { class: 'tiny', style: 'margin-top:2px;' }, sub))),
      el('button', { class: 'btn', style: 'font-weight:600;', onclick: startEdit }, '✎ 일정 변경'));
  }

  return el('div', { class: 'banner banner-fresh', style: 'margin-bottom:16px;' },
    el('div', {},
      el('div', { class: 'banner-title' }, '아직 이번 달 일정을 확정하지 않았어요'),
      el('div', { class: 'tiny', style: 'margin-top:3px;' },
        '안 되는 날만 눌러 표시하고 확정해 주세요. 표시하지 않은 평일은 가능으로 셉니다.')),
    el('button', { class: 'btn btn-primary', onclick: saveConfirm }, '✓ 내 일정 확정'));
}

async function startEdit() {
  try {
    await api.post(`/api/clubs/${clubId}/unconfirm?month=${state.month}`);
    state.draft = {};
    await load();
  } catch (err) { toastError(err); }
}

async function cancelEdit() {
  const changed = Object.keys(state.draft || {}).length;
  if (changed && !await confirmModal({
    title: '수정을 취소할까요?',
    body: `바꾼 ${changed}일이 사라지고 확정 상태로 되돌아갑니다.`,
    confirmLabel: '취소하고 되돌리기',
    danger: true
  })) return;

  state.draft = null;
  try {
    await api.post(`/api/clubs/${clubId}/confirm?month=${state.month}`);   // 변경 없이 다시 잠금
    await load();
  } catch (err) { toastError(err); }
}

async function saveConfirm() {
  const entries = state.draft && Object.keys(state.draft).length ? state.draft : undefined;
  try {
    await api.post(`/api/clubs/${clubId}/confirm?month=${state.month}`, entries ? { entries } : undefined);
    state.draft = null;
    toast('이번 달 일정을 확정했어요.', 'good');
    await load();
  } catch (err) { toastError(err); }
}

// ---------- 달력 ----------
function grid() {
  // 월~금 5칸에 요일 자리를 맞춰 채웁니다. 요일이 뒤로 안 가면(월요일이 다시 나오면) 새 주.
  const weeks = [];
  let week = new Array(5).fill(null);
  let lastCol = -1;
  for (const day of state.cal.days) {
    const col = day.dow - 1;
    if (col <= lastCol) { weeks.push(week); week = new Array(5).fill(null); }
    week[col] = day;
    lastCol = col;
  }
  if (week.some(Boolean)) weeks.push(week);

  return el('div', {},
    el('div', { class: 'dow-head' }, ['MON', 'TUE', 'WED', 'THU', 'FRI'].map((d) => el('span', {}, d))),
    weeks.map((w) => el('div', { class: 'week' }, w.map((day) => (day ? tile(day) : el('div'))))));
}

/** 오늘(한국 날짜)보다 앞선 날. 기준은 서버가 준 값을 씁니다 — 브라우저 시계를 믿지 않습니다. */
function isPast(date) {
  return date < state.cal.summary.today;
}

function tile(day) {
  const past = isPast(day.date);

  if (!day.selectable) {
    return el('div', { class: past ? 'tile tile-holiday tile-past' : 'tile tile-holiday' },
      el('div', { class: 'tile-holiday-body' },
        el('div', { class: 'row-between' },
          el('span', { class: 'tile-num' }, String(Number(day.date.slice(8, 10)))),
          el('span', { style: 'font-size:10px;font-weight:700;padding:3px 9px;border-radius:6px;background:#E5484D;color:#fff;letter-spacing:.3px;' }, '공휴일')),
        el('div', { class: 'row', style: 'margin-top:15px;gap:7px;' },
          el('span', { style: 'font-size:16px;' }, '🎌'),
          el('span', { class: 'tile-holiday-name' }, day.holiday)),
        el('div', { class: 'tile-holiday-note' }, '쉬는 날 · 모임 대상에서 제외')));
  }

  const c = counts(day);
  const mine = myStatus(day);
  // 지난 날짜는 누를 수 없습니다. 눌러 봐야 아무 결정도 바꾸지 못하는데
  // 초록 포커싱까지 받으면 아직 고를 수 있는 날처럼 보입니다.
  const editable = canEdit() && !past;
  const full = c.ok === c.total && c.total > 0;
  const ratio = c.total ? c.ok / c.total : 0;

  const cls = ['tile'];
  if (past) cls.push('tile-past');
  if (day.date === state.cal.summary.today) cls.push('tile-today');
  if (editable) cls.push('tile-clickable',
    mine === 'no' ? 'tile-edit-no' : mine === 'maybe' ? 'tile-edit-maybe' : 'tile-edit-ok');
  else if (full && !past) cls.push('tile-full');

  // 지난 날에 "풀파티 🎉" 는 틀린 말입니다 — 이미 지나간 날을 축하할 수 없습니다.
  const badge = full && !past
    ? el('span', { style: 'font-size:10px;font-weight:600;padding:3px 8px;border-radius:6px;background:#5D5FEF;color:#fff;' }, '풀파티 🎉')
    : el('span', { style: 'font-size:10px;font-weight:600;padding:3px 8px;border-radius:6px;background:#F7F8FA;color:#8A909E;' }, DOW_KO[day.dow]);

  // 지난 날은 의미색 없이 — CSS 가 덮지만 클래스부터 중립으로 둡니다.
  const nClass = past ? 'n' : full ? 'n n-full' : ratio >= 0.7 ? 'n n-high' : ratio >= 0.5 ? 'n n-mid' : 'n n-low';
  const pillClass = mine === 'no' ? 'pill pill-no' : mine === 'maybe' ? 'pill pill-maybe' : 'pill pill-ok';
  const pillIcon = mine === 'no' ? '✕' : mine === 'maybe' ? '?' : '✓';
  const pillText = mine === 'no' ? '불가' : mine === 'maybe' ? '미정' : '가능';

  const statusFor = (member) => (member.membership_id === myMembershipId() ? mine : (day.statuses[member.membership_id] ?? null));

  // 흐리게 만든 것만으로는 색을 못 보는 사람에게 아무 말도 하지 않습니다. 이유를 글로도 남깁니다.
  return el('div', {
    class: cls.join(' '),
    ...(past ? {
      'aria-disabled': 'true',
      'aria-label': `${Number(day.date.slice(5, 7))}월 ${Number(day.date.slice(8, 10))}일 `
        + `${DOW_KO[day.dow]}요일, 지난 날짜 · 모임 대상이 아닙니다`
    } : {})
  },
    el('div', {
      class: 'tile-face',
      onclick: editable ? () => cycle(day) : null
    },
    el('div', { class: 'row-between' },
      el('span', { class: 'tile-num' }, String(Number(day.date.slice(8, 10)))),
      badge),
    el('div', { class: 'avatar-row', style: 'margin:11px 0 10px;' },
      state.cal.members.map((m) => avatar(m, statusFor(m), m.membership_id === myMembershipId()))),
    el('div', { class: 'tile-counts' },
      el('span', { style: 'color:#8A909E;white-space:nowrap;' },
        el('b', { class: nClass }, String(c.ok)), `/${c.total} 가능`,
        c.maybe ? el('span', { class: 'maybe-extra' }, ` +${c.maybe}?`) : null),
      state.cal.club.my_role
        ? el('span', { class: editable ? pillClass : `${pillClass} pill-locked` },
          el('span', { style: 'font-size:10px;' }, pillIcon), pillText)
        : null)),
    el('button', {
      class: 'tile-expand',
      onclick: () => { state.openDay = state.openDay === day.date ? null : day.date; draw(); }
    }, state.openDay === day.date ? '접기 ▲' : '명단 ▾'),
    state.openDay === day.date ? detail(day, statusFor) : null);
}

function myMembershipId() {
  const mine = state.cal.members.find((m) => m.user_id === me.id);
  return mine ? mine.membership_id : null;
}

function detail(day, statusFor) {
  const group = (label, list, cls) => (list.length
    ? el('div', { class: 'tile-detail-group' },
      el('div', { class: 'tile-detail-label' }, `${label} ${list.length}`),
      el('div', { class: 'tile-detail-chips' }, list.map((m) => el('span', { class: `name-chip ${cls}` }, m.display_name))))
    : null);

  const members = state.cal.members;
  const note = el('input', {
    class: 'input input-sm', value: day.note, placeholder: '공용 메모 (예: OO팀 한마음)',
    style: 'margin-top:4px;',
    onchange: async (e) => {
      try {
        await api.put(`/api/clubs/${clubId}/notes`, { date: day.date, text: e.target.value });
        await load();
      } catch (err) { toastError(err); }
    }
  });

  return el('div', { class: 'tile-detail' },
    group('가능', members.filter((m) => statusFor(m) === null), 'tag-ok'),
    group('미정', members.filter((m) => statusFor(m) === 'maybe'), 'tag-maybe'),
    group('불가', members.filter((m) => statusFor(m) === 'no'), 'tag-no'),
    state.cal.club.my_role
      ? el('div', { style: 'margin-top:10px;' },
        el('div', { class: 'tile-detail-label' }, '공용 메모'), note)
      : (day.note ? el('div', { class: 'tiny', style: 'margin-top:10px;' }, `📝 ${day.note}`) : null));
}

/** 가능 → 불가(✕) → 미정(?) → 가능 */
async function cycle(day) {
  const now = myStatus(day);
  const next = now === null ? 'no' : now === 'no' ? 'maybe' : null;

  if (state.draft) { state.draft[day.date] = next; draw(); return; }
  try {
    await api.put(`/api/clubs/${clubId}/availability`, { date: day.date, status: next });
    // 응답을 기다리지 않고 그리면 집계가 어긋나므로 다시 읽습니다.
    await load();
  } catch (err) {
    if (err.code === 'MONTH_LOCKED') { toast('확정한 달이에요. "일정 변경" 을 눌러 주세요.'); await load(); return; }
    toastError(err);
  }
}
