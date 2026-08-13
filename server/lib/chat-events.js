// 도메인 이벤트 → 채팅 시스템 메시지. service-design.md §8.2.
//
// 트리거: 월 일정 확정 · 일정 변경 · 회원 참여/탈퇴 · 회장직 이전.
// 시스템 메시지는 가운데 pill 로 그려지고 **수정·삭제할 수 없습니다**(라우트가 403 으로 막습니다).
//
// 규칙 두 가지:
//   1) **도메인 변경이 커밋된 뒤에** 부릅니다. 채팅이 실패해도 일정 확정 자체는 이미 성공해야 합니다.
//   2) 그래서 **절대 throw 하지 않습니다.** 실패는 로그만 남기고 삼킵니다 —
//      "확정했는데 500 이 떴다" 보다 "확정됐는데 알림 줄이 하나 없다" 가 훨씬 낫습니다.
//
// 문구는 §8.2 예시("지훈님이 8월 일정을 확정했어요")의 말투를 따릅니다.
import { insertSystemMessage } from './chat.js';
import { publish } from './realtime.js';

/** '2026-08' → '8월' */
const monthLabel = (month) => `${Number(String(month).slice(5, 7))}월`;

/** 공통 경로: 저장 → 방에 발행. 실패해도 호출한 도메인 로직을 깨뜨리지 않습니다. */
function announce(clubId, event, body, actorMembershipId = null) {
  try {
    const message = insertSystemMessage({ clubId, event, body, actorMembershipId });
    // `actor_membership_id` 는 **저장하지 않고 이 프레임에만** 싣습니다. 시스템 메시지는 작성자가 NULL 이라
    // 이 힌트가 없으면 클라이언트가 "내 행동이 만든 알림" 을 구분하지 못해 안 읽음으로 세어 버립니다.
    publish(clubId, 'system', { ...message, actor_membership_id: actorMembershipId ?? null });
    return message;
  } catch (err) {
    console.error('[chat] 시스템 메시지를 남기지 못했습니다:', event, err);
    return null;
  }
}

/** "지훈님이 8월 일정을 확정했어요" */
export const announceMonthConfirmed = (clubId, name, month, actorMembershipId) =>
  announce(clubId, 'month_confirmed', `${name}님이 ${monthLabel(month)} 일정을 확정했어요`, actorMembershipId);

/**
 * "지훈님이 8월 일정을 다시 열었어요"
 * 날짜를 하나 누를 때마다가 아니라 **"일정 변경"(unconfirm) 을 눌러 잠금을 푼 때**만 남깁니다.
 * 클릭마다 남기면 대화가 알림으로 뒤덮입니다.
 */
export const announceAvailabilityChanged = (clubId, name, month, actorMembershipId) =>
  announce(clubId, 'availability_changed', `${name}님이 ${monthLabel(month)} 일정을 다시 열었어요`, actorMembershipId);

/** "지훈님이 동아리에 들어왔어요" */
export const announceMemberJoined = (clubId, name, actorMembershipId) =>
  announce(clubId, 'member_joined', `${name}님이 동아리에 들어왔어요`, actorMembershipId);

/**
 * "지훈님이 동아리를 나갔어요"
 * 스스로 탈퇴한 경우와 회장이 내보낸 경우에 **같은 문구**를 씁니다 —
 * 남은 사람들에게 보이는 결과가 같고, 내보내졌다는 사실까지 방송할 이유는 없습니다.
 * 이 시점에 membership 행은 이미 사라졌으므로 actor 를 넘기지 않습니다(이름은 지우기 전에 읽어 두세요).
 */
export const announceMemberLeft = (clubId, name) =>
  announce(clubId, 'member_left', `${name}님이 동아리를 나갔어요`);

/** "가영님이 회장을 지훈님에게 넘겼어요" */
export const announcePresidentTransferred = (clubId, fromName, toName, actorMembershipId) =>
  announce(clubId, 'president_transferred', `${fromName}님이 회장을 ${toName}님에게 넘겼어요`, actorMembershipId);
