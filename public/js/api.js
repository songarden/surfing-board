// 서버와 이야기하는 유일한 창구. 실패하면 서버가 준 한국어 메시지를 그대로 던집니다.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없는 응답 */ }
  if (!res.ok) {
    const err = new Error(data?.error || '요청을 처리하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
    err.status = res.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path, body) => request('DELETE', path, body)
};

/** 로그인 화면으로 보냅니다. 로그인 뒤 원래 보던 곳으로 돌아옵니다. */
export function toLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login.html?next=${next}`);
}

/** 로그인 필수 화면에서 씁니다. 세션이 없으면 로그인으로 보내고 멈춥니다. */
export async function requireMe() {
  try {
    return await api.get('/api/auth/me');
  } catch (err) {
    if (err.status === 401) { toLogin(); await new Promise(() => {}); }
    throw err;
  }
}

export const qs = (key) => new URLSearchParams(location.search).get(key);
