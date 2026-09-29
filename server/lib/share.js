// 추천 날짜를 사내 메신저(네이버 웍스)에 공유하기 위한 조립기.
//
// 동호회의 실제 소통 창구는 네이버 웍스 대화방입니다. 거기에 링크만 던지면 아무도 안 누르니,
// **대화방 미리보기 카드(og 메타데이터)에서 추천 요일이 바로 읽히도록** 만드는 것이 이 파일의 목적입니다.
//
// 만드는 것이 세 가지입니다. 셋 다 같은 집계에서 나옵니다.
//   1) og:title / og:description  → 메신저 미리보기 카드에 뜨는 글
//   2) share_text                 → 회원이 대화방에 붙여넣는 메시지 본문 (링크 포함)
//   3) 공개 요약 페이지 HTML       → 링크를 눌렀을 때 로그인 없이 보이는 화면
//
// ⚠️ **미리보기 카드는 네이버 웍스가 이 주소를 직접 열어 og 태그를 읽어야 만들어집니다.**
//    사내망 주소를 웍스가 못 여는 망 구성이면 카드가 안 뜹니다. 그래서 (2) 의 본문 자체에
//    추천 요일·인원을 전부 적습니다 — 카드가 못 떠도 정보는 대화방에 남습니다.
//
// ⚠️ **og:image 는 넣지 않습니다.** 이미지를 서버에서 그리려면 글자를 래스터화할 폰트 렌더러가
//    필요한데(폐쇄망이라 외부 이미지도 못 씁니다), 뜻 없는 그림을 넣으면 카드에서 글자 자리만
//    좁아집니다. 이미지 없는 카드는 제목·설명을 더 넓게 보여주므로 요일 전달에 오히려 유리합니다.
//    (`.claude/DECISIONS.md` 2026-08-18 절)
import crypto from 'node:crypto';
import { buildCalendar } from './calendar.js';
import { publicBaseUrl } from './baseurl.js';

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
const SITE_NAME = '서핑보드 · 동아리 일정 조율';

/** 제목에 짧게 쓸 후보 수 / 설명과 본문에 길게 쓸 후보 수 */
const TITLE_DATES = 3;
const DESC_DATES = 2;
const TEXT_DATES = 5;

// ---------- 링크 서명 ----------
//
// 공유 링크는 **로그인 없이** 열려야 합니다. 미리보기를 만드는 쪽이 우리 세션 쿠키를 갖고 있지
// 않기 때문입니다. 그래서 동아리 id 를 그대로 노출하면 1, 2, 3... 으로 남의 동아리 집계를
// 훑을 수 있습니다. `(club_id, month)` 를 SESSION_SECRET 으로 서명해 그 조합의 링크를 받은
// 사람만 열 수 있게 합니다.
//
// 상태를 만들지 않는(=DB 를 늘리지 않는) 대신 개별 회수가 안 됩니다. 전체 무효화는
// SESSION_SECRET 교체입니다. 근거와 대안은 DECISIONS.md 2026-08-18 절.

const payloadOf = (clubId, month) => `share:v1:${Number(clubId)}:${month}`;

/** 공유 링크에 붙는 토큰. 같은 (동아리, 월) 이면 항상 같은 값입니다. */
export function shareToken(clubId, month) {
  // SECRET 은 호출 시점에 읽습니다 — 테스트가 env 를 세운 뒤 import 하기 때문입니다.
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || '')
    .update(payloadOf(clubId, month))
    .digest('base64url')
    .slice(0, 22);                     // 132비트. 사내망에서 추측으로 뚫을 수 있는 길이가 아닙니다.
}

/** 길이가 다르면 timingSafeEqual 이 던지므로 먼저 봅니다. */
export function verifyShareToken(clubId, month, token) {
  const want = Buffer.from(shareToken(clubId, month));
  const got = Buffer.from(String(token ?? ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export const sharePath = (clubId, month) =>
  `/share/${Number(clubId)}/${month}?t=${shareToken(clubId, month)}`;

/** 대화방에 그대로 붙여넣을 수 있는 절대 주소 */
export const shareUrl = (req, clubId, month) => `${publicBaseUrl(req)}${sharePath(clubId, month)}`;

// ---------- 날짜 표기 ----------
const monthNum = (month) => Number(month.slice(5, 7));
const dayNum = (date) => Number(date.slice(8, 10));

/** '2026-08-20' → '8/20(목)' — 제목처럼 좁은 자리용 */
export const shortDateKo = (date, dow) => `${monthNum(date)}/${dayNum(date)}(${DOW_KO[dow]})`;

/** '2026-08-20' → '8월 20일 목요일' — 요일을 흘려 읽지 않도록 풀어 씁니다 */
export const longDateKo = (date, dow) => `${monthNum(date)}월 ${dayNum(date)}일 ${DOW_KO[dow]}요일`;

/** '2026-08-20' → '8월 20일(목)' — 메시지 본문용 */
export const textDateKo = (date, dow) => `${monthNum(date)}월 ${dayNum(date)}일(${DOW_KO[dow]})`;

// ---------- 집계 → 공유 카드 ----------

/**
 * 공유에 필요한 값만 뽑은 납작한 객체. 이름 목록은 **일부러 넣지 않습니다** —
 * 로그인 없이 열리는 페이지라 누가 언제 안 되는지는 나가면 안 됩니다.
 */
export function buildShareCard(club, month) {
  const cal = buildCalendar(club.id, month, null);
  const s = cal.summary;
  const byDate = new Map(cal.days.map((d) => [d.date, d]));

  const dates = s.best_dates.map((date) => {
    const d = byDate.get(date);
    return {
      date,
      dow: d.dow,
      dow_ko: DOW_KO[d.dow],
      ok_count: d.ok_count,
      full_party: d.full_party,
      note: d.note || ''
    };
  });

  const card = {
    club: { id: club.id, name: club.name, brand_color: club.brand_color },
    month,
    month_label: `${monthNum(month)}월`,
    dates,
    member_count: s.member_count,
    best_count: s.best_count,
    confirmed_count: s.confirmed_count,
    unconfirmed_count: s.member_count - s.confirmed_count,
    full_party: s.best_count === s.member_count && s.member_count > 0,
    past_excluded: s.past_excluded,
    today: s.today
  };
  card.title = shareTitle(card);
  card.description = shareDescription(card);
  return card;
}

/** 후보가 없는 이유. 히어로와 같은 기준으로 갈라 씁니다 (지난 달 vs 평일이 전부 공휴일). */
function emptyReason(card) {
  return card.past_excluded > 0
    ? `${card.month_label}은 평일이 모두 지났어요. 다음 달에서 다시 골라 주세요.`
    : `${card.month_label}에는 고를 수 있는 평일이 없어요. 평일이 모두 공휴일이거나 회원이 없습니다.`;
}

/**
 * og:title — 미리보기 카드에서 가장 크게 보이는 줄입니다. **날짜와 요일을 여기에 먼저** 넣습니다.
 * 동아리 이름만 넣으면 대화방에서 "그래서 언제?" 를 다시 물어야 합니다.
 */
export function shareTitle(card) {
  if (!card.dates.length) return `${card.club.name} · ${card.month_label} 추천 날짜 없음`;
  const head = card.dates.slice(0, TITLE_DATES).map((d) => shortDateKo(d.date, d.dow)).join(', ');
  const more = card.dates.length - TITLE_DATES;
  return `${card.club.name} ${card.month_label} 모임 추천일 · ${head}${more > 0 ? ` 외 ${more}일` : ''}`;
}

/** og:description — 제목 아래 두어 줄. 요일을 '목요일' 로 풀어 쓰고 인원 근거를 붙입니다. */
export function shareDescription(card) {
  if (!card.dates.length) return emptyReason(card);

  const head = card.full_party
    ? `회원 ${card.member_count}명 전원이 되는 날이에요 🎉`
    : `회원 ${card.member_count}명 중 ${card.best_count}명 가능`;
  const list = card.dates.slice(0, DESC_DATES).map((d) => longDateKo(d.date, d.dow)).join(' · ');
  const more = card.dates.length - DESC_DATES;
  const tail = more > 0 ? ` 외 ${more}일` : '';
  return `${head} — ${list}${tail}. 주말·공휴일과 지난 날짜를 뺀 평일 중 가장 많은 사람이 되는 날입니다.`;
}

/**
 * 대화방에 붙여넣는 메시지 본문. **미리보기 카드가 안 떠도 이 글만으로 다 읽혀야 합니다.**
 * 마지막 줄에 링크를 둡니다 — 메신저가 URL 을 찾아 카드를 만들 자리입니다.
 */
export function shareText(card, url) {
  const lines = [`📅 ${card.club.name} ${card.month_label} 모임 추천 날짜`];

  if (!card.dates.length) {
    lines.push(emptyReason(card));
  } else {
    for (const d of card.dates.slice(0, TEXT_DATES)) {
      const mark = d.full_party ? '🎉' : '✅';
      const who = d.full_party
        ? `${card.member_count}명 전원 가능`
        : `${card.member_count}명 중 ${d.ok_count}명 가능`;
      lines.push(`${mark} ${textDateKo(d.date, d.dow)} — ${who}${d.note ? ` · ${d.note}` : ''}`);
    }
    const more = card.dates.length - TEXT_DATES;
    if (more > 0) lines.push(`… 같은 조건의 날이 ${more}일 더 있어요.`);
    if (card.unconfirmed_count > 0) {
      lines.push(`⏳ 아직 ${card.unconfirmed_count}명이 이번 달 일정을 확정하지 않았어요.`);
    }
  }
  lines.push(url);
  return lines.join('\n');
}

// ---------- 공개 요약 페이지 ----------

/**
 * HTML 이스케이프. 동아리 이름과 공용 메모는 **회원이 쓴 글**이라 반드시 거칩니다.
 * 속성값에도 그대로 쓰므로 따옴표까지 막습니다.
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const META = (attr, name, content) => `<meta ${attr}="${esc(name)}" content="${esc(content)}">`;

/** 미리보기 카드가 읽는 메타 태그. og 를 못 읽고 twitter 만 읽는 클라이언트가 있어 둘 다 냅니다. */
function metaTags(card, url) {
  return [
    META('name', 'description', card.description),
    META('property', 'og:type', 'website'),
    META('property', 'og:site_name', SITE_NAME),
    META('property', 'og:locale', 'ko_KR'),
    META('property', 'og:title', card.title),
    META('property', 'og:description', card.description),
    META('property', 'og:url', url),
    META('name', 'twitter:card', 'summary'),
    META('name', 'twitter:title', card.title),
    META('name', 'twitter:description', card.description)
  ].join('\n');
}

const page = ({ title, meta = '', body }) => `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${meta}
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<div class="wrap share-wrap">
${body}
</div>
</body>
</html>
`;

const brand = `<div class="brand brand-sm share-brand">
  <div class="brand-mark"><i></i><i></i><i></i></div>
  <div class="brand-name">서핑보드</div>
</div>`;

/** 추천 날짜 한 줄. 요일을 따로 큰 글씨로 둡니다 — 대화방에서 넘어온 사람이 제일 먼저 볼 값입니다. */
function dateRow(card, d) {
  const badge = d.full_party
    ? '<span class="share-full">전원 가능 🎉</span>'
    : `<span class="share-count">${card.member_count}명 중 <b>${d.ok_count}명</b> 가능</span>`;
  return `<li class="share-date">
    <span class="share-date-day">${monthNum(d.date)}월 ${dayNum(d.date)}일</span>
    <span class="share-date-dow">${esc(d.dow_ko)}요일</span>
    ${badge}
    ${d.note ? `<span class="share-date-note">📝 ${esc(d.note)}</span>` : ''}
  </li>`;
}

/**
 * 링크를 눌렀을 때 보이는 화면. **로그인 없이** 열리므로 집계 숫자만 있고 이름은 없습니다.
 * 자세히 보려면 달력으로 보내고, 거기서 세션이 없으면 로그인 화면으로 넘어갑니다.
 */
export function renderSharePage(card, url) {
  const has = card.dates.length > 0;
  const heroSub = has
    ? (card.full_party
      ? `회원 ${card.member_count}명 전원이 되는 날이에요.`
      : `회원 ${card.member_count}명 중 ${card.best_count}명이 되는 날이에요.`)
    : emptyReason(card);

  const body = `${brand}
<div class="card card-lg share-card">
  <div class="cap">${esc(card.club.name)} · ${esc(card.month_label)} 모임 추천일</div>
  <div class="share-hero-title">${has ? esc(card.dates.map((d) => shortDateKo(d.date, d.dow)).join('  ·  ')) : '추천할 날짜가 없어요'}</div>
  <div class="share-hero-sub">${esc(heroSub)}</div>

  ${has ? `<ul class="share-dates">${card.dates.map((d) => dateRow(card, d)).join('\n')}</ul>` : ''}

  <div class="share-meta">
    <span>이번 달 확정 <b>${card.confirmed_count}</b>/${card.member_count}명</span>
    ${card.unconfirmed_count > 0 ? `<span>미확정 ${card.unconfirmed_count}명</span>` : ''}
    <span>기준일 ${esc(card.today)}</span>
  </div>

  <a class="btn btn-primary share-cta" href="/club.html?id=${card.club.id}&amp;month=${esc(card.month)}">동아리 달력 열기</a>
  <div class="tiny share-foot">
    회원 이름과 각자의 일정은 이 화면에 나오지 않습니다. 달력을 열려면 로그인이 필요해요.<br>
    이 페이지는 열 때마다 최신 집계를 다시 계산합니다 — 지금 회원들이 표시한 그대로예요.
  </div>
</div>`;

  return page({ title: card.title, meta: metaTags(card, url), body });
}

/**
 * 링크가 틀렸을 때. **왜 틀렸는지는 구분해서 알려주지 않습니다** — 동아리가 있는지 없는지를
 * 링크를 주워 온 사람에게 흘리지 않으려고요. 대신 무엇을 하면 되는지는 알려줍니다.
 */
export function renderShareError() {
  return page({
    title: '열 수 없는 공유 링크 · 서핑보드',
    body: `${brand}
<div class="card card-lg share-card">
  <div class="share-hero-title">이 링크는 열 수 없어요</div>
  <div class="share-hero-sub">주소가 잘린 링크이거나, 동아리가 없어졌거나, 서비스 관리자가 정지시킨 동아리입니다.</div>
  <a class="btn btn-primary share-cta" href="/clubs.html">내 동아리로 가기</a>
  <div class="tiny share-foot">대화방에 올라온 링크가 여러 줄로 잘렸다면, 올린 사람에게 다시 공유해 달라고 해 주세요.</div>
</div>`
  });
}
