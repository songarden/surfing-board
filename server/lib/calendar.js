// 월별 집계. 도메인 규칙은 docs/spec.md "상태 규칙" 이 기준입니다.
//
//   가능 = 표시하지 않은 평일 + (availability 행이 없는 사람)
//   불가('no')·미정('maybe') = 집계 제외
//   추천 날짜 = 그 달 평일(공휴일 제외) 중 가능 인원 최다
//   공휴일·주말 = 아예 후보가 아님
//   지난 날짜 = 후보가 아님 (한국 날짜 기준. 이미 지난 날로 모임을 잡을 수는 없습니다)
import { db } from '../db.js';
import { weekdaysOfMonth } from './holidays.js';
import { todaySeoul } from './today.js';

/** 'YYYY-MM' → { year, month } */
export function splitMonth(month) {
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}

/** 'YYYY-MM' 의 한 달 전 */
export function previousMonth(month) {
  const { year, month: m } = splitMonth(month);
  const d = m === 1 ? { y: year - 1, m: 12 } : { y: year, m: m - 1 };
  return `${d.y}-${String(d.m).padStart(2, '0')}`;
}

/** 그 달에 회원이 상태를 표시할 수 있는 날(평일 - 공휴일)만 돌려줍니다. */
export function selectableDays(month) {
  const { year, month: m } = splitMonth(month);
  return weekdaysOfMonth(year, m).filter((d) => !d.holiday);
}

export function isSelectableDate(date) {
  return selectableDays(date.slice(0, 7)).some((d) => d.date === date);
}

/**
 * 동아리 한 달치 달력. 프런트가 그대로 그릴 수 있는 모양으로 돌려줍니다.
 * `myMembershipId` 가 null 이면(소속 없는 서비스 관리자) 내 상태 관련 필드는 비웁니다.
 */
export function buildCalendar(clubId, month, myMembershipId = null, today = todaySeoul()) {
  const members = db.prepare(`
    SELECT m.id AS membership_id, m.user_id, u.display_name, m.member_color, m.role,
           COALESCE(mc.confirmed, 0) AS confirmed
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN month_confirmations mc ON mc.membership_id = m.id AND mc.month = ?
    WHERE m.club_id = ?
    ORDER BY (m.role = 'president') DESC, m.joined_at, m.id`).all(month, clubId)
    .map((r) => ({ ...r, confirmed: !!r.confirmed }));

  const like = `${month}-%`;
  const rows = db.prepare(`
    SELECT a.membership_id, a.date, a.status
    FROM availability a JOIN memberships m ON m.id = a.membership_id
    WHERE m.club_id = ? AND a.date LIKE ?`).all(clubId, like);
  const notes = db.prepare('SELECT date, text FROM day_notes WHERE club_id = ? AND date LIKE ?')
    .all(clubId, like);

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    byDate.get(r.date)[r.membership_id] = r.status;
  }
  const noteOf = new Map(notes.map((n) => [n.date, n.text]));

  const { year, month: m } = splitMonth(month);
  const days = weekdaysOfMonth(year, m).map((d) => {
    if (d.holiday) {
      // 공휴일은 투표 대상이 아닙니다. 카운트도 하지 않습니다.
      return {
        date: d.date, dow: d.dow, holiday: d.holiday, selectable: false,
        statuses: {}, ok_count: 0, maybe_count: 0, no_count: 0,
        full_party: false, my_status: null, note: noteOf.get(d.date) || ''
      };
    }
    const statuses = byDate.get(d.date) || {};
    let no = 0, maybe = 0;
    for (const mb of members) {
      if (statuses[mb.membership_id] === 'no') no++;
      else if (statuses[mb.membership_id] === 'maybe') maybe++;
    }
    const ok = members.length - no - maybe;   // 표시하지 않은 사람 = 가능
    return {
      date: d.date, dow: d.dow, holiday: null, selectable: true,
      statuses,
      ok_count: ok, maybe_count: maybe, no_count: no,
      full_party: members.length > 0 && ok === members.length,
      my_status: myMembershipId ? (statuses[myMembershipId] ?? null) : null,
      note: noteOf.get(d.date) || ''
    };
  });

  const candidates = days.filter((d) => d.selectable);
  // 추천은 앞으로 남은 날 중에서만 뽑습니다. 달력 타일(`days`)은 지난 날짜도 그대로 보여줍니다 —
  // 누가 언제 안 됐는지는 기록으로 남아야 하고, 추천만 앞을 봐야 합니다.
  const upcoming = candidates.filter((d) => d.date >= today);
  const best = upcoming.length ? Math.max(...upcoming.map((d) => d.ok_count)) : 0;

  return {
    month,
    members,
    days,
    summary: {
      member_count: members.length,
      confirmed_count: members.filter((mb) => mb.confirmed).length,
      unconfirmed_members: members.filter((mb) => !mb.confirmed)
        .map((mb) => ({ user_id: mb.user_id, display_name: mb.display_name })),
      today,
      past_excluded: candidates.length - upcoming.length,
      best_count: best,
      best_dates: upcoming.filter((d) => d.ok_count === best).map((d) => d.date),
      runner_up_dates: best > 0 ? upcoming.filter((d) => d.ok_count === best - 1).map((d) => d.date) : [],
      full_party_dates: upcoming.filter((d) => d.full_party).map((d) => d.date)
    }
  };
}
