// 초대 링크처럼 "남에게 전달되는 주소" 를 만들 때 쓰는 절대 주소.
//
// 회장이 http://localhost:8888 로 열어서 초대 링크를 만들면 그 링크는 받는 사람의
// localhost 를 가리켜 아무 데도 도달하지 않습니다. 그래서 .env 의 PUBLIC_BASE_URL 을
// 우선 쓰고, 없으면 요청이 들어온 주소로 대신합니다.
let warned = false;

export function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) {
    if (/^https?:\/\/.+/.test(configured)) return configured;
    if (!warned) {
      warned = true;
      console.error(`[config] PUBLIC_BASE_URL 이 http:// 또는 https:// 로 시작해야 합니다 (지금 값: ${configured}). 무시하고 요청 주소를 씁니다.`);
    }
  }
  return `${req.protocol}://${req.get('host')}`;
}

/** 초대 토큰 → 남에게 전달할 수 있는 전체 주소 */
export const inviteUrl = (req, token) => `${publicBaseUrl(req)}/invite.html?token=${token}`;
