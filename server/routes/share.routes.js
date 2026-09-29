// /share/:clubId/:month — 네이버 웍스 대화방에 올린 링크가 열리는 **공개** 페이지.
//
// 여기만 로그인 없이 열립니다. 이유는 하나뿐입니다: 메신저의 미리보기 카드를 만드는 쪽은
// 우리 세션 쿠키를 갖고 있지 않아서, 인증을 걸면 카드가 영원히 안 뜹니다.
//
// 그래서 나가는 정보를 **집계 숫자로만** 제한합니다 — 동아리 이름, 추천 날짜와 요일, 가능 인원 수.
// 누가 언제 안 되는지(이름·개인 일정)는 이 경로로 절대 나가지 않습니다 (`buildShareCard`).
// 링크 자체는 (club_id, month) 서명 토큰으로 잠가 두어 id 를 훑을 수 없습니다.
import { Router } from 'express';
import { db } from '../db.js';
import { MONTH_RE } from '../lib/permissions.js';
import {
  buildShareCard, renderSharePage, renderShareError, shareUrl, verifyShareToken
} from '../lib/share.js';

export const shareRoutes = Router();

/**
 * 공유 링크에 **누가 다녀갔는지** 남깁니다. 다른 경로에는 접근 로그가 없지만 여기만 둡니다 —
 * 메신저의 미리보기 카드가 안 뜰 때, 원인이 셋 중 어느 것인지 이 줄 하나로 갈리기 때문입니다.
 *
 *   ① 아무 줄도 안 남는다        → 아무도 이 주소를 열지 못했습니다. 미리보기를 만드는 쪽이
 *                                  사내망 밖에 있어서 192.168.x.x 에 닿지 못하는 것입니다.
 *   ② 사내망 밖 IP 로 줄이 남는다 → 크롤러가 닿기는 했습니다. 그럼 문제는 메타데이터 쪽입니다.
 *   ③ 내 PC IP 로 줄이 남는다     → 메신저 클라이언트가 직접 열어 본 것입니다. 닿았는데도 카드를
 *                                  안 그렸다면 http·IP·비표준 포트를 미리보기 대상에서 뺀 것입니다.
 *
 * 토큰은 앞 6자만 남깁니다 — 로그를 보는 것만으로 남의 링크를 열 수 있으면 안 됩니다.
 */
function logHit(req, outcome) {
  const token = String(req.query.t ?? '');
  console.log('[share] %s %s t=%s… → %s · ip=%s · ua=%s',
    req.method, req.path, token.slice(0, 6) || '(없음)', outcome,
    req.ip, String(req.get('user-agent') || '(없음)').slice(0, 120));
}

/** 오류도 사람이 보는 화면입니다 — JSON 을 던지면 대화방에서 넘어온 사람이 읽을 게 없습니다. */
function fail(res, req, why) {
  logHit(req, why);
  res.status(404).type('html').send(renderShareError());
}

shareRoutes.get('/:clubId/:month', (req, res) => {
  const clubId = Number(req.params.clubId);
  const month = String(req.params.month);
  if (!Number.isInteger(clubId) || clubId <= 0 || !MONTH_RE.test(month)) return fail(res, req, '주소 형식');
  if (!verifyShareToken(clubId, month, req.query.t)) return fail(res, req, '서명 불일치');

  const club = db.prepare('SELECT id, name, brand_color, status FROM clubs WHERE id = ?').get(clubId);
  // 정지된 동아리는 공유 링크도 함께 멈춥니다. 정지는 "이 동아리 활동을 세운다" 는 뜻이라
  // 바깥으로 나가는 링크만 계속 살아 있으면 정지의 의미가 없습니다.
  if (!club || club.status === 'suspended') return fail(res, req, '없거나 정지된 동아리');

  logHit(req, '200');
  // 집계는 매번 다시 계산합니다. 어제 올린 링크를 오늘 눌러도 오늘 기준 추천이 보여야 합니다.
  const card = buildShareCard(club, month);
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');   // 폐쇄망이지만 색인 대상이 아님을 분명히 해 둡니다
  res.type('html').send(renderSharePage(card, shareUrl(req, clubId, month)));
});

// /share 아래의 다른 경로도 같은 화면으로 받습니다 (링크가 잘려 들어오는 경우).
shareRoutes.use((req, res) => fail(res, req, '잘린 주소'));
