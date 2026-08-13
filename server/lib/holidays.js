// 공휴일 목록. 음력·대체공휴일은 해마다 바뀌니 연말에 한 번씩 확인해서 고쳐 주세요.
const FIXED = {
  '01-01': '신정', '03-01': '삼일절', '05-05': '어린이날', '06-06': '현충일',
  '08-15': '광복절', '10-03': '개천절', '10-09': '한글날', '12-25': '성탄절'
};

// 2026년 — 2026-08-11 실제 달력과 대조 완료.
// 연말에 2027년 줄을 추가해야 합니다. 안 하면 설날·추석이 평일로 잡혀 모임 후보에 들어갑니다.
const EXTRA = {
  '2026-02-16': '설날 연휴', '2026-02-17': '설날', '2026-02-18': '설날 연휴',
  '2026-03-02': '삼일절 대체휴일', '2026-05-24': '부처님오신날', '2026-05-25': '부처님오신날 대체휴일',
  '2026-06-03': '지방선거',          // 제9회 전국동시지방선거. 선거일은 관공서 공휴일입니다.
  '2026-08-17': '광복절 대체휴일', '2026-09-24': '추석 연휴', '2026-09-25': '추석',
  '2026-09-26': '추석 연휴', '2026-09-28': '추석 대체휴일', '2026-10-05': '개천절 대체휴일'
};

export function holidayOf(date) {
  return EXTRA[date] || FIXED[date.slice(5)] || null;
}

/** 해당 월의 평일 목록 (월~금). [{ date, dow, holiday }] */
export function weekdaysOfMonth(year, month) {
  const out = [];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push({ date, dow, holiday: holidayOf(date) });
  }
  return out;
}
