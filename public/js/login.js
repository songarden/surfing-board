import { api, qs } from './api.js';
import { $, brandMark, el, render, toastError } from './ui.js';

const next = qs('next') || '/clubs.html';
const app = $('#app');

const username = el('input', { class: 'input', autocomplete: 'username', placeholder: 'minsu' });
const password = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
const error = el('div', { class: 'error-text' });
const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '로그인');

const form = el('form', { onsubmit: onSubmit },
  el('div', { class: 'lead' }, '다시 오셨네요'),
  el('div', { class: 'muted', style: 'margin-bottom:24px;' }, '모임 날짜, 이제 단톡방에서 그만 정해요'),
  el('label', { class: 'field' }, el('span', {}, '아이디'), username),
  el('label', { class: 'field' }, el('span', {}, '비밀번호'), password),
  error,
  submit);

async function onSubmit(event) {
  event.preventDefault();
  error.textContent = '';
  submit.disabled = true;
  try {
    await api.post('/api/auth/login', { username: username.value.trim(), password: password.value });
    location.replace(next);
  } catch (err) {
    error.textContent = err.message;
    if (err.status >= 500) toastError(err);
    password.select();
  } finally {
    submit.disabled = false;
  }
}

render(app,
  el('div', { style: 'display:flex;justify-content:center;margin-bottom:30px;' }, brandMark()),
  el('div', { class: 'card card-lg' }, form),
  el('div', { class: 'tiny', style: 'text-align:center;margin-top:18px;' },
    '아직 계정이 없나요? ', el('a', { href: `/signup.html?next=${encodeURIComponent(next)}` }, '회원가입')));

username.focus();
