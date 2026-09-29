// 추천 날짜를 사내 메신저(네이버 웍스) 대화방에 공유하는 모달.
//
// 동호회의 실제 소통은 네이버 웍스에서 일어납니다. 그래서 이 모달의 목적은 두 가지입니다.
//   1) 대화방에 그대로 붙여넣을 **메시지 본문**을 손에 쥐여 주기
//   2) 그 링크가 대화방에서 **어떤 미리보기 카드로 보이는지** 붙여넣기 전에 확인시켜 주기
//
// (2) 가 중요합니다. 미리보기는 서버가 내려주는 og:title / og:description 이 그대로 뜨는
// 자리인데, 보내는 사람은 붙여넣기 전에는 그걸 볼 수 없습니다. 여기서 같은 문자열로
// 카드를 흉내 내 보여 주면 "요일이 안 보이는 링크" 를 대화방에 올리는 일이 없습니다.
//
// 미리보기 문자열은 **프런트에서 다시 만들지 않습니다.** 서버 응답의 title·description 이
// 공유 페이지의 og 태그와 같은 값이라, 여기서 따로 조립하면 둘이 어긋납니다.
import { api } from './api.js';
import { copyText, el, toast, toastError } from './ui.js';

/** 링크에서 사람이 보는 부분. 미리보기 카드 아래에 회색으로 뜨는 그 줄입니다. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * @param clubId  동아리 id
 * @param month   'YYYY-MM'
 * @param pendingChanges  수정 중이라 아직 서버에 없는 변경 수 (0 이면 경고를 안 띄웁니다)
 */
export async function openShareModal({ clubId, month, pendingChanges = 0 }) {
  let data;
  try {
    data = await api.get(`/api/clubs/${clubId}/share?month=${month}`);
  } catch (err) { toastError(err); return; }

  // shareText() 가 마지막 줄에 링크를 답니다. 대화방에서는 그 줄이 링크로 뜨므로 따로 그립니다.
  const lines = data.text.split('\n');
  const linkLine = lines.pop();
  const bodyText = lines.join('\n');

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const copy = async (text, done) => {
    if (await copyText(text)) toast(done, 'good');
    else toast('복사하지 못했어요. 아래 상자의 글을 직접 끌어서 복사해 주세요.', 'bad');
  };

  // 대화방에서 실제로 보이는 모양 — 말풍선 + 그 아래 링크 미리보기 카드.
  const preview = el('div', { class: 'share-mock' },
    el('div', { class: 'share-mock-cap' }, '네이버 웍스 대화방에서 이렇게 보여요'),
    el('div', { class: 'share-mock-bubble' },
      el('div', { class: 'share-mock-text' }, bodyText),
      el('div', { class: 'share-mock-link' }, linkLine),
      el('div', { class: 'share-preview' },
        el('div', { class: 'share-preview-title' }, data.title),
        el('div', { class: 'share-preview-desc' }, data.description),
        el('div', { class: 'share-preview-host' }, hostOf(data.url)))));

  const textBox = el('textarea', {
    class: 'input share-textarea', rows: 6, readonly: true, spellcheck: 'false',
    onclick: (e) => e.target.select()
  });
  textBox.value = data.text;

  const back = el('div', {
    class: 'modal-back', onclick: (e) => { if (e.target === back) close(); }
  }, el('div', { class: 'modal modal-wide' },
    el('div', { class: 'modal-title' }, '네이버 웍스에 공유하기'),
    el('div', { class: 'modal-body' },
      data.dates.length
        ? `${data.club.name} ${Number(month.slice(5, 7))}월 추천 날짜 ${data.dates.length}일을 대화방에 올릴 수 있어요.`
        : '이 달에는 추천할 날짜가 없어서, 링크에도 그렇게 적힙니다.'),

    pendingChanges > 0
      ? el('div', { class: 'share-warn' },
        `아직 확정 저장하지 않은 변경 ${pendingChanges}일은 공유 내용에 들어가지 않았어요. `
        + '먼저 "확정 저장" 을 누르고 다시 공유해 주세요.')
      : null,

    preview,

    el('div', { class: 'share-cap' }, '붙여넣을 메시지'),
    textBox,

    // 미리보기 카드는 네이버 웍스가 이 주소를 직접 열어 og 태그를 읽어야 만들어집니다.
    // 사내망 주소를 못 여는 망 구성이면 카드가 안 뜨는데, 그때도 본문만으로 읽히도록 만들어 뒀습니다.
    el('div', { class: 'share-note' },
      '미리보기 카드는 네이버 웍스가 이 주소를 직접 열어 봐야 만들어집니다. ',
      '대화방에 카드가 안 뜨더라도 위 메시지 본문에 날짜와 요일이 다 적혀 있으니 그대로 보내면 돼요.'),

    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: close }, '닫기'),
      el('button', {
        class: 'btn',
        onclick: () => copy(data.url, '링크를 복사했어요.')
      }, '링크만 복사'),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => copy(data.text, '메시지를 복사했어요. 네이버 웍스 대화방에 붙여넣으세요.')
      }, '메시지 복사'))));

  document.addEventListener('keydown', onKey);
  document.body.append(back);
}
