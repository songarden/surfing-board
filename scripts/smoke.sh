#!/bin/bash
# 떠 있는 서버에 실제 흐름을 한 번 흘려봅니다:  npm run smoke
#
# 가입 → 동아리 생성 → 초대 발급 → 다른 사람이 수락 → 일정 표시 → 집계 확인
# → 확정(잠금) → 잠긴 채 변경 시도(409) → 수정 모드 → 확정 저장
#
# 임시 계정을 만들기 때문에 운영 DB 에 흔적이 남습니다. 끝에 스스로 정리합니다.
#
# ⚠️ 보내는 값은 전부 ASCII 입니다. Git Bash 등 CP949 셸에서 한글을 -d 로 보내면 깨져서
#    "이름 그대로 입력" 확인이 엉뚱하게 통과/실패합니다. 한글 왕복은 tests/ 에서 확인합니다.
set -u
BASE=${BASE:-http://localhost:8888}
MONTH=${MONTH:-$(date +%Y-%m)}
STAMP=$(date +%s)
PW=smoke-password-2026
A=smoke-a$STAMP        # 회장
B=smoke-b$STAMP        # 회원
C=smoke-c$STAMP        # 아무 동아리에도 속하지 않은 사람
CLUB_NAME="Smoke Club"
JAR_A=$(mktemp); JAR_B=$(mktemp); JAR_C=$(mktemp)
FAIL=0

step () { echo ""; echo "=== $1"; }
# check <기대 상태코드> <설명> <curl 인자...>
check () {
  local want=$1 label=$2; shift 2
  local out code
  out=$("$@" -s -w '\n%{http_code}')
  code=$(echo "$out" | tail -n1)
  local body; body=$(echo "$out" | head -n -1)
  if [ "$code" = "$want" ]; then
    echo "  ✓ $label [$code] $(echo "$body" | head -c 200)"
  else
    echo "  ✗ $label — $want 를 기대했는데 $code: $(echo "$body" | head -c 300)"
    FAIL=$((FAIL + 1))
  fi
  LAST_BODY=$body
}
json () { echo "$LAST_BODY" | sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p" | head -n1; }
jstr () { echo "$LAST_BODY" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1; }

step "1. 헬스체크"
check 200 "GET /api/health" curl "$BASE/api/health"

step "2. 가입 (회장 $A / 회원 $B / 비회원 $C)"
check 201 "POST /api/auth/signup (A)" curl -c "$JAR_A" -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' -d "{\"username\":\"$A\",\"display_name\":\"Smoke President\",\"password\":\"$PW\"}"
check 201 "POST /api/auth/signup (B)" curl -c "$JAR_B" -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' -d "{\"username\":\"$B\",\"display_name\":\"Smoke Member\",\"password\":\"$PW\"}"
check 201 "POST /api/auth/signup (C)" curl -c "$JAR_C" -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' -d "{\"username\":\"$C\",\"display_name\":\"Smoke Outsider\",\"password\":\"$PW\"}"

step "3. 동아리 만들기 (만든 사람이 회장)"
check 201 "POST /api/clubs" curl -b "$JAR_A" -X POST "$BASE/api/clubs" \
  -H 'Content-Type: application/json' -d "{\"name\":\"$CLUB_NAME\"}"
CLUB=$(json id)
echo "  → club_id=$CLUB"

step "4. 초대 발급 → 수락"
check 201 "POST /api/clubs/$CLUB/invites" curl -b "$JAR_A" -X POST "$BASE/api/clubs/$CLUB/invites" \
  -H 'Content-Type: application/json' -d '{"max_uses":2}'
TOKEN=$(jstr token)
INVITE_URL=$(jstr url)
# 남에게 전달할 수 있는 절대 주소여야 합니다 (localhost 로 열어도 .env 의 PUBLIC_BASE_URL 이 나와야 함)
case "$INVITE_URL" in
  http*://*/invite.html*token=*) echo "  ✓ 초대 url 절대 주소 [$INVITE_URL]" ;;
  *) echo "  ✗ 초대 url 이 절대 주소가 아닙니다: '$INVITE_URL'"; FAIL=$((FAIL + 1)) ;;
esac
check 200 "GET /api/invites/:token (미리보기)" curl -b "$JAR_B" "$BASE/api/invites/$TOKEN"
check 201 "POST /api/invites/:token/accept" curl -b "$JAR_B" -X POST "$BASE/api/invites/$TOKEN/accept"

step "5. 소속되지 않은 사람은 존재조차 알 수 없다"
check 404 "GET /api/clubs/$CLUB (로그인했지만 비회원)" curl -b "$JAR_C" "$BASE/api/clubs/$CLUB"
check 404 "GET calendar (비회원)" curl -b "$JAR_C" "$BASE/api/clubs/$CLUB/calendar?month=$MONTH"
check 401 "GET /api/clubs (비로그인)" curl "$BASE/api/clubs"

step "6. 일정 표시 — 안 되는 날만"
check 200 "PUT availability (불가)" curl -b "$JAR_B" -X PUT "$BASE/api/clubs/$CLUB/availability" \
  -H 'Content-Type: application/json' -d "{\"date\":\"$MONTH-13\",\"status\":\"no\"}"
check 400 "PUT availability (status=yes 는 저장하지 않음)" curl -b "$JAR_B" -X PUT "$BASE/api/clubs/$CLUB/availability" \
  -H 'Content-Type: application/json' -d "{\"date\":\"$MONTH-14\",\"status\":\"yes\"}"
check 200 "POST bulk (요일 통째로 불가)" curl -b "$JAR_B" -X POST "$BASE/api/clubs/$CLUB/availability/bulk" \
  -H 'Content-Type: application/json' -d "{\"op\":\"weekday_off\",\"month\":\"$MONTH\",\"dow\":5}"

step "7. 달력 집계 (추천 날짜·확인 현황)"
check 200 "GET /api/clubs/$CLUB/calendar?month=$MONTH" curl -b "$JAR_A" "$BASE/api/clubs/$CLUB/calendar?month=$MONTH"
echo "  요약: $(echo "$LAST_BODY" | tr ',' '\n' | grep -E '"(member_count|confirmed_count|best_count)"' | tr '\n' ' ')"

step "8. 확정 → 잠금 확인 → 수정 모드 → 확정 저장"
check 200 "POST confirm" curl -b "$JAR_B" -X POST "$BASE/api/clubs/$CLUB/confirm?month=$MONTH"
check 409 "PUT availability (잠긴 달)" curl -b "$JAR_B" -X PUT "$BASE/api/clubs/$CLUB/availability" \
  -H 'Content-Type: application/json' -d "{\"date\":\"$MONTH-20\",\"status\":\"no\"}"
check 200 "POST unconfirm (일정 변경)" curl -b "$JAR_B" -X POST "$BASE/api/clubs/$CLUB/unconfirm?month=$MONTH"
check 200 "POST confirm + entries (확정 저장)" curl -b "$JAR_B" -X POST "$BASE/api/clubs/$CLUB/confirm?month=$MONTH" \
  -H 'Content-Type: application/json' -d "{\"entries\":{\"$MONTH-20\":\"maybe\"}}"

step "9. 회장 전용 API 는 일반 회원이 못 쓴다"
check 403 "POST invites (회원)" curl -b "$JAR_B" -X POST "$BASE/api/clubs/$CLUB/invites" \
  -H 'Content-Type: application/json' -d '{}'
check 403 "GET /api/admin/stats (회원)" curl -b "$JAR_B" "$BASE/api/admin/stats"

step "10. 정리 — 동아리 삭제 (이름 확인 필요)"
check 400 "DELETE club (이름 틀림)" curl -b "$JAR_A" -X DELETE "$BASE/api/clubs/$CLUB" \
  -H 'Content-Type: application/json' -d '{"name":"Wrong Name"}'
check 200 "DELETE club (이름 맞음)" curl -b "$JAR_A" -X DELETE "$BASE/api/clubs/$CLUB" \
  -H 'Content-Type: application/json' -d "{\"name\":\"$CLUB_NAME\"}"
check 200 "DELETE /api/me (A)" curl -b "$JAR_A" -X DELETE "$BASE/api/me"
check 200 "DELETE /api/me (B)" curl -b "$JAR_B" -X DELETE "$BASE/api/me"
check 200 "DELETE /api/me (C)" curl -b "$JAR_C" -X DELETE "$BASE/api/me"

rm -f "$JAR_A" "$JAR_B" "$JAR_C"
echo ""
if [ "$FAIL" = "0" ]; then
  echo "전부 통과했습니다. 임시 계정과 동아리는 스스로 정리했습니다."
else
  echo "$FAIL 건 실패했습니다. 위 ✗ 줄을 보세요."
  echo "임시 계정이 남아 있을 수 있습니다: 아이디 $A, $B, $C"
fi
exit "$FAIL"
