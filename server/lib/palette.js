import { db } from '../db.js';

// design_handoff_surfboard/README.md 의 멤버 팔레트(10색). 새 색을 만들지 마세요.
export const MEMBER_PALETTE = [
  '#5D5FEF', '#16A97A', '#F59E0B', '#E5484D', '#0EA5E9',
  '#D6409F', '#8B5CF6', '#F97316', '#0891B2', '#65A30D'
];

/** 동아리 안에서 가장 덜 쓰인 색을 고릅니다. 10명까지는 겹치지 않습니다. */
export function pickMemberColor(clubId) {
  const used = db.prepare('SELECT member_color FROM memberships WHERE club_id = ?').all(clubId)
    .map((r) => r.member_color);
  const free = MEMBER_PALETTE.find((c) => !used.includes(c));
  if (free) return free;
  // 11명째부터는 가장 적게 쓰인 색을 다시 씁니다.
  const count = new Map(MEMBER_PALETTE.map((c) => [c, 0]));
  for (const c of used) if (count.has(c)) count.set(c, count.get(c) + 1);
  return [...count.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

/** 동아리 브랜드 색(카드 상단 바). 만든 순서대로 팔레트를 돌립니다. */
export function pickBrandColor() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM clubs').get().c;
  return MEMBER_PALETTE[n % MEMBER_PALETTE.length];
}
