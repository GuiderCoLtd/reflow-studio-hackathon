// Login / logout.
import { html, icon, documentShell } from '../lib/ui.mjs';
import { logoMark } from '../lib/icons.mjs';
import { authenticate } from '../lib/data.mjs';
import { sessionCookie, clearSessionCookie } from '../lib/http.mjs';

function loginView({ email = '', error = '' } = {}) {
  return documentShell({
    title: '로그인',
    bodyClass: 'login-body',
    body: html`<div class="login">
  <div class="login-side">
    <p class="login-logo">${logoMark(24)}<span>도담워크</span></p>
    <main class="login-main">
      <form class="login-form" method="post" action="/login" novalidate aria-labelledby="login-title">
        <h1 id="login-title">로그인</h1>
        <p class="login-sub">회사 이메일로 도담워크에 로그인하세요.</p>
        ${error ? html`<div class="banner banner-error" role="alert">${icon('alertCircle', { size: 18 })}<p>${error}</p></div>` : ''}
        <div class="field">
          <label class="label" for="email">이메일</label>
          <input class="input input-lg" id="email" name="email" type="email" value="${email}" placeholder="name@company.com" autocomplete="username"${error ? html` aria-invalid="true"` : ''}>
        </div>
        <div class="field">
          <label class="label" for="password">비밀번호</label>
          <input class="input input-lg" id="password" name="password" type="password" placeholder="비밀번호를 입력하세요" autocomplete="current-password"${error ? html` aria-invalid="true"` : ''}>
        </div>
        <button type="submit" class="btn btn-primary btn-lg btn-block">로그인</button>
        <p class="login-help">계정이 없다면 회사 관리자에게 초대를 요청하세요.</p>
      </form>
    </main>
    <p class="login-foot">© 2026 도담워크</p>
  </div>
  <div class="login-photo">
    <img src="/static/img/office-seongsu-1600.jpg" alt="" width="1600" height="1067">
    <p class="login-photo-copy">작은 회사의 하루를 단정하게 정리해요</p>
  </div>
</div>`,
  });
}

export function loginGet(ctx) {
  if (ctx.user) return ctx.redirect('/', { status: 302 });
  ctx.send(200, loginView());
}

export function loginPost(ctx) {
  const email = String(ctx.body.email || '').trim();
  const user = authenticate(email, ctx.body.password);
  if (!user) return ctx.send(401, loginView({ email, error: '이메일 또는 비밀번호가 올바르지 않아요. 다시 확인해 주세요.' }));
  ctx.redirect('/', { cookies: [sessionCookie(user.id)] });
}

export function logout(ctx) {
  ctx.redirect('/login', { status: 302, cookies: [clearSessionCookie()] });
}
