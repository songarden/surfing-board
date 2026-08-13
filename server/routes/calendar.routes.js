// /api/clubs/:id — 달력·일정·월 확정·공용 메모.
// 도메인 규칙: 미선택 평일 = 가능. 'no'/'maybe' 만 저장하고 'yes' 는 저장하지 않습니다.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  loadClub, requireActiveClub, requireMembership, requireUnlockedMonth,
  monthState, MONTH_RE, DATE_RE
} from '../lib/permissions.js';
import { buildCalendar, previousMonth, selectableDays } from '../lib/calendar.js';
import { announceMonthConfirmed, announceAvailabilityChanged } from '../lib/chat-events.js';

export const calendarRoutes = Router();
calendarRoutes.use(requireAuth);

const thisMonth = () => new Date().toISOString().slice(0, 7);
const STATUS = ['no', 'maybe'];

/** 그 달에 표시 가능한 날짜 집합 (주말·공휴일 제외) */
const selectableSet = (month) => new Set(selectableDays(month).map((d) => d.date));

// prepare 는 호출 시점에 합니다 — 모듈 로드 때 하면 마이그레이션보다 먼저 돌아 테이블이 없습니다.
const upsert = () => db.prepare(`INSERT INTO availability (membership_id, date, status, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(membership_id, date) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`);
const remove = () => db.prepare('DELETE FROM availability WHERE membership_id = ? AND date = ?');

/**
 * { "2026-08-13": "no", "2026-08-20": null } 형태를 한 트랜잭션에 적용합니다.
 * 주말·공휴일과 다른 달 날짜는 건너뛰고 몇 건을 건너뛰었는지 알려줍니다.
 */
function applyEntries(membershipId, month, entries) {
  const ok = selectableSet(month);
  const set = upsert(), del = remove();
  let saved = 0, cleared = 0, skipped = 0;
  db.transaction(() => {
    for (const [date, status] of Object.entries(entries)) {
      if (!DATE_RE.test(date) || !ok.has(date)) { skipped++; continue; }
      if (status === null) { del.run(membershipId, date); cleared++; }
      else if (STATUS.includes(status)) { set.run(membershipId, date, status); saved++; }
      else skipped++;
    }
  })();
  return { saved, cleared, skipped };
}

/** GET /api/clubs/:id/calendar?month=YYYY-MM */
calendarRoutes.get('/:id/calendar', loadClub, (req, res) => {
  const month = String(req.query.month || thisMonth());
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month 는 YYYY-MM 형식으로 보내주세요.' });

  const data = buildCalendar(req.club.id, month, req.membership?.id ?? null);
  res.json({
    ...data,
    club: { ...req.club, my_role: req.membership?.role ?? null },
    my_month_state: req.membership ? monthState(req.membership.id, month) : null
  });
});

/** PUT /api/clubs/:id/availability — { date, status: 'no'|'maybe'|null }. 본인 것만. */
calendarRoutes.put('/:id/availability',
  loadClub, requireActiveClub, requireMembership,
  requireUnlockedMonth((req) => String(req.body?.date ?? '').slice(0, 7)),
  (req, res) => {
    const date = String(req.body?.date ?? '');
    const status = req.body?.status ?? null;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: '날짜는 YYYY-MM-DD 형식으로 보내주세요.' });
    if (status === 'yes') {
      return res.status(400).json({
        error: '가능은 저장하지 않습니다. 가능으로 되돌리려면 status 를 null 로 보내주세요.',
        code: 'YES_NOT_STORED'
      });
    }
    if (status !== null && !STATUS.includes(status)) {
      return res.status(400).json({ error: "status 는 'no', 'maybe', null 중 하나입니다." });
    }
    if (!selectableSet(date.slice(0, 7)).has(date)) {
      return res.status(400).json({
        error: '주말과 공휴일은 모임 대상이 아니라 표시할 수 없습니다.',
        code: 'NOT_SELECTABLE'
      });
    }

    if (status === null) remove().run(req.membership.id, date);
    else upsert().run(req.membership.id, date, status);
    res.json({ ok: true, date, status });
  });

/**
 * POST /api/clubs/:id/availability/bulk — 일괄 입력.
 *   { op:'all_ok',      month }                     그 달 표시를 전부 지웁니다(= 전부 가능)
 *   { op:'weekday_off', month, dow, on }            그 요일 전체를 불가로/해제
 *   { op:'copy_last',   month }                     지난달 표시를 날짜 기준으로 복사
 *   { op:'set',         month, entries }            수정 모드에서 모아둔 변경을 한 번에 커밋
 */
calendarRoutes.post('/:id/availability/bulk',
  loadClub, requireActiveClub, requireMembership,
  requireUnlockedMonth((req) => String(req.body?.month ?? '')),
  (req, res) => {
    const { month } = req;
    const op = String(req.body?.op ?? '');
    const msId = req.membership.id;
    const days = selectableDays(month);

    if (op === 'all_ok') {
      const info = db.prepare("DELETE FROM availability WHERE membership_id = ? AND date LIKE ?")
        .run(msId, `${month}-%`);
      return res.json({ ok: true, op, cleared: info.changes });
    }

    if (op === 'weekday_off') {
      const dow = Number(req.body?.dow);
      if (![1, 2, 3, 4, 5].includes(dow)) {
        return res.status(400).json({ error: 'dow 는 1(월)~5(금) 사이여야 합니다.' });
      }
      const on = req.body?.on !== false;                 // 기본은 "불가로 만든다"
      const targets = days.filter((d) => d.dow === dow).map((d) => d.date);
      const entries = Object.fromEntries(targets.map((date) => [date, on ? 'no' : null]));
      return res.json({ ok: true, op, dow, on, ...applyEntries(msId, month, entries) });
    }

    if (op === 'copy_last') {
      const from = previousMonth(month);
      const rows = db.prepare('SELECT date, status FROM availability WHERE membership_id = ? AND date LIKE ?')
        .all(msId, `${from}-%`);
      const ok = selectableSet(month);
      const set = upsert();
      let saved = 0, skipped = 0;
      db.transaction(() => {
        db.prepare('DELETE FROM availability WHERE membership_id = ? AND date LIKE ?').run(msId, `${month}-%`);
        for (const r of rows) {
          const date = `${month}-${r.date.slice(8, 10)}`;
          if (!ok.has(date)) { skipped++; continue; }     // 그 날이 이번 달엔 주말·공휴일이거나 없는 날
          set.run(msId, date, r.status);
          saved++;
        }
      })();
      return res.json({ ok: true, op, from, copied: saved, skipped });
    }

    if (op === 'set') {
      const entries = req.body?.entries;
      if (!entries || typeof entries !== 'object') {
        return res.status(400).json({ error: 'entries 가 필요합니다. { "2026-08-13": "no" } 형태로 보내주세요.' });
      }
      if (Object.keys(entries).length > 200) {
        return res.status(400).json({ error: '한 번에 200일까지만 보낼 수 있습니다.' });
      }
      return res.json({ ok: true, op, ...applyEntries(msId, month, entries) });
    }

    res.status(400).json({ error: "op 는 'all_ok', 'weekday_off', 'copy_last', 'set' 중 하나입니다." });
  });

/**
 * POST /api/clubs/:id/confirm?month=YYYY-MM — 내 일정 확정(잠금).
 * 수정 모드에서 "확정 저장" 을 누른 경우 body 에 { entries } 를 실어 보내면 저장과 잠금이 한 트랜잭션으로 처리됩니다.
 */
calendarRoutes.post('/:id/confirm', loadClub, requireActiveClub, requireMembership, (req, res) => {
  const month = String(req.query.month || req.body?.month || '');
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month 는 YYYY-MM 형식으로 보내주세요.' });

  const entries = req.body?.entries;
  if (entries !== undefined && (entries === null || typeof entries !== 'object')) {
    return res.status(400).json({ error: 'entries 는 { "2026-08-13": "no" } 형태여야 합니다.' });
  }
  const applied = entries ? applyEntries(req.membership.id, month, entries) : null;

  const was = monthState(req.membership.id, month);
  db.prepare(`INSERT INTO month_confirmations (membership_id, month, confirmed, confirmed_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(membership_id, month) DO UPDATE SET confirmed = 1, confirmed_at = datetime('now')`)
    .run(req.membership.id, month);

  // 이미 확정된 달을 다시 확정하는 건(같은 버튼 두 번) 사건이 아닙니다 — 채팅에 남기지 않습니다.
  if (was !== 'confirmed') {
    announceMonthConfirmed(req.club.id, req.user.display_name, month, req.membership.id);
  }
  res.json({ ok: true, month, state: 'confirmed', applied });
});

/** POST /api/clubs/:id/unconfirm?month=YYYY-MM — "일정 변경". 확정 이력은 남겨 수정 중 상태가 됩니다. */
calendarRoutes.post('/:id/unconfirm', loadClub, requireActiveClub, requireMembership, (req, res) => {
  const month = String(req.query.month || req.body?.month || '');
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month 는 YYYY-MM 형식으로 보내주세요.' });
  if (monthState(req.membership.id, month) === 'unconfirmed') {
    return res.status(409).json({
      error: '아직 확정하지 않은 달입니다. 바로 일정을 표시할 수 있습니다.',
      code: 'NOT_CONFIRMED'
    });
  }
  const was = monthState(req.membership.id, month);
  db.prepare('UPDATE month_confirmations SET confirmed = 0 WHERE membership_id = ? AND month = ?')
    .run(req.membership.id, month);

  // 이미 수정 중이면 상태가 바뀌지 않았으니 남기지 않습니다.
  if (was === 'confirmed') {
    announceAvailabilityChanged(req.club.id, req.user.display_name, month, req.membership.id);
  }
  res.json({ ok: true, month, state: 'editing' });
});

/** PUT /api/clubs/:id/notes — 날짜별 공용 메모. 동아리 회원 누구나 고칠 수 있습니다. */
calendarRoutes.put('/:id/notes', loadClub, requireActiveClub, requireMembership, (req, res) => {
  const date = String(req.body?.date ?? '');
  if (!DATE_RE.test(date)) return res.status(400).json({ error: '날짜는 YYYY-MM-DD 형식으로 보내주세요.' });
  const text = String(req.body?.text ?? '').slice(0, 200).trim();

  if (!text) {
    db.prepare('DELETE FROM day_notes WHERE club_id = ? AND date = ?').run(req.club.id, date);
    return res.json({ ok: true, date, text: '' });
  }
  db.prepare(`INSERT INTO day_notes (club_id, date, text, updated_by, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(club_id, date) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by,
      updated_at = datetime('now')`).run(req.club.id, date, text, req.user.id);
  res.json({ ok: true, date, text });
});
