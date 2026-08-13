// 동아리 스코프 권한 가드. service-design.md §3 "서버 측 권한 검사 규칙" 이 기준입니다.
//
//   동아리 리소스 변경 → 해당 동아리 회장 또는 서비스 관리자
//   본인 일정 변경     → 요청자 == 대상 회원 (서비스 관리자도 예외 없음)
//   플랫폼 API         → is_service_admin  (auth.js 의 requireServiceAdmin)
//   잠금(확정) 월 변경 → 409
//
// UI 에서 버튼을 숨겼는지와 무관하게 여기서 다시 검사합니다.
import { db } from '../db.js';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const clubIdOf = (req) => Number(req.params.clubId ?? req.params.id);

/**
 * `:id`(또는 `:clubId`) 동아리와 요청자의 멤버십을 실어 줍니다. requireAuth 뒤에 씁니다.
 * 회원도 아니고 서비스 관리자도 아니면 **404** — 동아리가 있는지조차 알려주지 않습니다.
 */
export function loadClub(req, res, next) {
  const id = clubIdOf(req);
  const club = Number.isInteger(id) && id > 0
    ? db.prepare('SELECT id, name, brand_color, status, created_at FROM clubs WHERE id = ?').get(id)
    : null;
  const membership = club
    ? db.prepare('SELECT id, user_id, club_id, role, member_color, joined_at FROM memberships WHERE club_id = ? AND user_id = ?')
      .get(id, req.user.id)
    : null;

  if (!club || (!membership && !req.user.is_service_admin)) {
    return res.status(404).json({ error: '없는 동아리입니다.', code: 'NOT_FOUND' });
  }
  req.club = club;
  req.membership = membership || null;   // 서비스 관리자는 소속 없이도 여기까지 옵니다
  next();
}

/**
 * 본인 일정·확정·공용 메모·채팅처럼 "그 동아리 회원이어야" 하는 것.
 * 서비스 관리자도 소속이 없으면 막습니다.
 */
export function requireMembership(req, res, next) {
  if (!req.membership) {
    return res.status(403).json({
      error: '그 동아리 회원이 아닙니다. 소속된 동아리에서만 할 수 있습니다.',
      code: 'NOT_A_MEMBER'
    });
  }
  next();
}

/** 초대·회원·역할·동아리 정보/삭제. 회장 또는 서비스 관리자(강제)만. */
export function requirePresident(req, res, next) {
  if (req.user.is_service_admin) return next();
  if (req.membership?.role === 'president') return next();
  return res.status(403).json({ error: '동아리 회장만 할 수 있습니다.', code: 'NEED_PRESIDENT' });
}

/** 정지된 동아리는 회원이 아무것도 바꿀 수 없습니다. 조회는 되고, 서비스 관리자는 통과합니다. */
export function requireActiveClub(req, res, next) {
  if (req.club.status === 'suspended' && !req.user.is_service_admin) {
    return res.status(403).json({
      error: '정지된 동아리입니다. 서비스 관리자에게 문의해 주세요.',
      code: 'CLUB_SUSPENDED'
    });
  }
  next();
}

/**
 * 월 확정 상태. service-design.md §7.
 *   'unconfirmed' 미확인 (행 없음 또는 확정한 적 없음)
 *   'confirmed'   확정/잠금 — 읽기 전용
 *   'editing'     수정 중 — 확정했다가 "일정 변경" 을 누른 상태
 */
export function monthState(membershipId, month) {
  const row = db.prepare('SELECT confirmed, confirmed_at FROM month_confirmations WHERE membership_id = ? AND month = ?')
    .get(membershipId, month);
  if (!row || !row.confirmed_at) return 'unconfirmed';
  return row.confirmed ? 'confirmed' : 'editing';
}

/**
 * 잠긴 달의 일정 변경을 409 로 막습니다. 수정 모드(editing)와 미확인은 통과.
 * `pick(req)` 이 YYYY-MM 을 돌려주면 됩니다 — 날짜만 받는 API 는 `req => req.body.date?.slice(0,7)`.
 * requireMembership 뒤에 씁니다.
 */
export function requireUnlockedMonth(pick) {
  return (req, res, next) => {
    const month = String(pick(req) ?? '');
    if (!MONTH_RE.test(month)) {
      return res.status(400).json({ error: '월은 YYYY-MM 형식으로 보내주세요.' });
    }
    if (monthState(req.membership.id, month) === 'confirmed') {
      return res.status(409).json({
        error: '확정한 달이라 잠겨 있습니다. "일정 변경" 을 눌러 수정 모드로 들어와 주세요.',
        code: 'MONTH_LOCKED'
      });
    }
    req.month = month;
    next();
  };
}
