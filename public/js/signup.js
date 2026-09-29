import { api, qs } from './api.js';
import { $, brandMark, el, passwordInput, render } from './ui.js';

const next = qs('next') || '/clubs.html';
const app = $('#app');

const username = el('input', { class: 'input', autocomplete: 'username', placeholder: '영문 소문자·숫자 3~24자' });
const displayName = el('input', { class: 'input', placeholder: '달력에 보일 이름' });
const [passwordBox, password] = passwordInput({ autocomplete: 'new-password', placeholder: '8자 이상' });
const error = el('div', { class: 'error-text' });
const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '가입하고 시작하기');

async function onSubmit(event) {
  event.preventDefault();
  error.textContent = '';
  submit.disabled = true;
  try {
    await api.post('/api/auth/signup', {
      username: username.value.trim(),
      display_name: displayName.value.trim(),
      password: password.value
    });
    location.replace(next);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

render(app,
  el('div', { style: 'display:flex;justify-content:center;margin-bottom:30px;' }, brandMark()),
  el('div', { class: 'card card-lg' },
    el('form', { onsubmit: onSubmit },
      el('div', { class: 'lead' }, '처음이시죠'),
      el('div', { class: 'muted', style: 'margin-bottom:24px;' }, '가입한 뒤 초대 링크로 동아리에 들어갈 수 있어요'),
      el('label', { class: 'field' }, el('span', {}, '아이디 · 나중에 바꿀 수 없어요'), username),
      el('label', { class: 'field' }, el('span', {}, '표시 이름'), displayName),
      el('label', { class: 'field' }, el('span', {}, '비밀번호'), passwordBox),
      error,
      submit)),
  el('div', { class: 'tiny', style: 'text-align:center;margin-top:18px;' },
    '이미 계정이 있나요? ', el('a', { href: `/login.html?next=${encodeURIComponent(next)}` }, '로그인')));

username.focus();
