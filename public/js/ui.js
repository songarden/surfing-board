// DOM 조립 도구. CSP 가 인라인 스크립트를 막으므로 이벤트는 전부 addEventListener 로 붙입니다.

/** el('div', { class: 'card', onclick: fn }, '내용', el('b', {}, '강조')) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  add(node, children);
  return node;
}

function add(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 자리를 비우고 새로 그립니다. */
export function render(root, ...children) {
  root.replaceChildren();
  add(root, children);
  return root;
}

export const $ = (sel, scope = document) => scope.querySelector(sel);

// ---------- 브랜드 ----------
export function brandMark(small = false) {
  return el('div', { class: small ? 'brand brand-sm' : 'brand' },
    el('div', { class: 'brand-mark' }, el('i'), el('i'), el('i')),
    el('div', { class: 'brand-name' }, '서핑보드'));
}

// ---------- 토스트 ----------
let toastHost;
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `toast ${kind ? 'toast-' + kind : ''}` }, message);
  toastHost.append(node);
  setTimeout(() => node.remove(), 3200);
}
export const toastError = (err) => toast(err?.message || '요청을 처리하지 못했습니다.', 'bad');

/**
 * 클립보드 복사. 성공하면 true.
 * navigator.clipboard 는 https 나 localhost 에서만 있습니다. 사내망은 평문 http 라
 * 다른 PC 에서 열면 아예 없어서, 옛 execCommand 방식으로 한 번 더 시도합니다.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 아래 폴백으로 */ }
  try {
    const ta = el('textarea', { style: 'position:fixed;top:-1000px;left:0;opacity:0;' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ---------- 모달 ----------
/**
 * 확인 모달. 예를 누르면 true, 취소·배경 클릭·ESC 는 false.
 * confirmText 로 "이름을 그대로 입력" 확인을 요구할 수 있습니다.
 */
export function confirmModal({ title, body, confirmLabel = '확인', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let input;
    const close = (value) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const okBtn = el('button', {
      class: danger ? 'btn btn-danger-solid' : 'btn btn-primary',
      disabled: !!requireText,
      onclick: () => close(true)
    }, confirmLabel);

    if (requireText) {
      input = el('input', {
        class: 'input input-sm', placeholder: requireText, style: 'margin-top:14px;',
        oninput: () => { okBtn.disabled = input.value.trim() !== requireText; }
      });
    }
    const back = el('div', {
      class: 'modal-back',
      onclick: (e) => { if (e.target === back) close(false); }
    }, el('div', { class: 'modal' },
      el('div', { class: 'modal-title' }, title),
      body ? el('div', { class: 'modal-body' }, body) : null,
      input,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => close(false) }, '취소'),
        okBtn)));

    document.addEventListener('keydown', onKey);
    document.body.append(back);
    (input || okBtn).focus();
  });
}

/** 입력 하나를 받는 모달. 취소하면 null. */
export function promptModal({ title, body, label, value = '', placeholder = '', confirmLabel = '저장' }) {
  return new Promise((resolve) => {
    const input = el('input', { class: 'input', value, placeholder });
    const close = (v) => { back.remove(); resolve(v); };
    const back = el('div', {
      class: 'modal-back', onclick: (e) => { if (e.target === back) close(null); }
    }, el('div', { class: 'modal' },
      el('div', { class: 'modal-title' }, title),
      body ? el('div', { class: 'modal-body', style: 'margin-bottom:14px;' }, body) : null,
      el('label', { class: 'field' }, el('span', {}, label), input),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => close(null) }, '취소'),
        el('button', { class: 'btn btn-primary', onclick: () => close(input.value.trim()) }, confirmLabel))));
    document.body.append(back);
    input.focus();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim()); });
  });
}

// ---------- 사람 표시 ----------
export const initial = (name) => (name || '?').trim().charAt(0);

/**
 * 멤버 아바타. status 는 'no' | 'maybe' | null(가능).
 * 가능=채운 이니셜 / 미정=색 테두리+? / 불가=빨강 점선+✕
 */
export function avatar(member, status = null, isMe = false, large = false) {
  const cls = ['avatar'];
  if (large) cls.push('avatar-lg');
  if (isMe) cls.push('avatar-me');
  const label = status === 'no' ? '불가' : status === 'maybe' ? '미정' : '가능';
  const title = `${member.display_name} · ${label}${isMe ? ' (나)' : ''}`;

  if (status === 'no') return el('div', { class: [...cls, 'avatar-no'].join(' '), title }, '✕');
  if (status === 'maybe') {
    return el('div', {
      class: [...cls, 'avatar-maybe'].join(' '), title,
      style: `border-color:${member.member_color};color:${member.member_color};`
    }, '?');
  }
  return el('div', {
    class: cls.join(' '), title, style: `background:${member.member_color};`
  }, initial(member.display_name));
}

export function avatarStack(members, large = false) {
  return el('div', { class: 'avatar-stack' }, members.map((m) => avatar(m, null, false, large)));
}

export function roleTag(role) {
  return role === 'president'
    ? el('span', { class: 'tag tag-president' }, '회장')
    : el('span', { class: 'tag' }, '회원');
}

// ---------- 날짜 ----------
// 서비스 기준은 한국 날짜입니다. 브라우저 TZ 를 믿으면 해외·UTC 설정 PC 에서 하루씩 밀립니다.
// (서버도 같은 기준을 씁니다 — server/lib/today.js)
export const todayISO = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export const thisMonth = () => todayISO().slice(0, 7);
export const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

export function monthLabel(month) {
  const [y, m] = month.split('-');
  return { month: `${Number(m)}월`, year: y };
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------- 페이지 머리 ----------
/** 뒤로 버튼 + 제목. 오른쪽에 넣을 것들은 extras 로 붙입니다. */
export function pageHead(title, { backHref = null, backLabel = '←', extras = [] } = {}) {
  return el('div', { class: 'row-between', style: 'margin-bottom:24px;' },
    el('div', { class: 'row' },
      backHref ? el('a', { class: 'btn', href: backHref }, backLabel) : null,
      el('div', { class: 'page-title' }, title)),
    el('div', { class: 'row' }, extras));
}

/** 계정 설정·콘솔·로그아웃이 있는 오른쪽 위 묶음. */
export function accountMenu(me, { onLogout }) {
  return el('div', { class: 'row' },
    me.is_service_admin ? el('a', { class: 'btn', href: '/admin.html' }, '★ 서비스 관리자') : null,
    el('a', { class: 'btn', href: '/account.html' }, `${me.display_name} 님`),
    el('button', { class: 'btn', onclick: onLogout }, '로그아웃'));
}

export function loadingBox(text = 'LOADING') {
  return el('div', { class: 'loading' }, text);
}

export function emptyBox(emoji, title, sub, action = null) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-emoji' }, emoji),
    el('div', { style: 'font-size:15px;font-weight:600;color:#5A616E;margin-bottom:6px;' }, title),
    sub ? el('div', { class: 'tiny' }, sub) : null,
    action ? el('div', { style: 'margin-top:18px;' }, action) : null);
}
