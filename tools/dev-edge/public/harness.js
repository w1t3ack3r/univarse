// Uses only same-origin fetch with default credentials — exactly what the real web app will do.
const $ = (id) => document.getElementById(id);
$('origin').textContent = location.origin;

async function call(method, path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  $('out').textContent = `${method} ${path} → ${res.status}\n${text}`;
  $('cookies').textContent = document.cookie || '(empty)';
}

$('btn-request').onclick = () => call('POST', '/auth/activation/request', { username: $('act-user').value });
$('btn-confirm').onclick = () =>
  call('POST', '/auth/activation/confirm', { username: $('act-user').value, code: $('act-code').value, password: $('act-pass').value });
$('btn-login').onclick = () => call('POST', '/auth/login', { username: $('login-user').value, password: $('login-pass').value });
$('btn-me').onclick = () => call('GET', '/auth/me');
$('btn-logout').onclick = () => call('POST', '/auth/logout');
