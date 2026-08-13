// 서비스의 "오늘" 은 한국 날짜입니다.
//
// 컨테이너 TZ 는 UTC 라서 `new Date().toISOString()` 을 그대로 쓰면 한국 시간 아침 9시 전에는
// 날짜가 하루 뒤로 밀립니다. 새벽 1시에 달력을 열었을 때 어제가 "오늘" 로 보이면
// 지난 날짜 제외·오늘 강조가 전부 하루씩 틀립니다.
//
// 한국은 1988년 이후 서머타임이 없어 UTC+9 고정입니다. Intl 대신 오프셋을 더합니다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 한국 기준 오늘 'YYYY-MM-DD'.
 * `SURFBOARD_TODAY` 는 **테스트용 고정 장치**입니다 — 달력 집계가 실제 날짜에 따라
 * 흔들리면 테스트가 하루마다 깨집니다. 운영 `.env` 에는 넣지 마세요.
 */
export function todaySeoul() {
  const pinned = (process.env.SURFBOARD_TODAY || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}
