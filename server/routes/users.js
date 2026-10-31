// 登录、退出，和管理员管成员的那几个接口。只有多人模式用得上。

import { HttpError, readJsonBody, route } from '../http.js';
import { allUsers, changeOwnPassword, clearedCookie, createUser, findUser, isHosted, login, logout, newPassword, removeUser, sessionCookie, updateUser, userView } from '../auth.js';
import { balanceOf, grantCredits, monthUsed } from '../credits.js';

route('POST', /^\/api\/login$/, async ({ req, res }) => {
  if (!isHosted()) throw new HttpError(400, 'invalid_request', '当前不需要登录');
  const { name, password } = await readJsonBody(req);
  const { user, token } = login(name, password);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  return { user: userView(user) };
}, 'open');

route('POST', /^\/api\/logout$/, async ({ req, res }) => {
  logout(req);
  res.setHeader('Set-Cookie', clearedCookie(req));
  return null;
}, 'open');

route('PUT', /^\/api\/me\/password$/, async ({ req, user }) => {
  if (!user) throw new HttpError(400, 'invalid_request', '当前不需要登录');
  const { current, next } = await readJsonBody(req);
  changeOwnPassword(user, current, next, req);
  return null;
});

// credits 是剩多少积分，monthUsed 是这个月花了多少。
route('GET', /^\/api\/users$/, async () => ({ items: allUsers().map((user) => ({ ...userView(user), credits: balanceOf(user.id), monthUsed: monthUsed(user.id) })) }), 'admin');

// 建账号、重置密码时，密码由这里随机生成，在返回里给管理员看这一次，之后查不到。
// 这里建的都是成员。管理员只能在服务器的命令行里建（pnpm user add <名称> --admin），页面上给不了。
route('POST', /^\/api\/users$/, async ({ req }) => {
  const { name } = await readJsonBody(req);
  const password = newPassword();
  return { user: userView(createUser({ name, password })), password };
}, 'admin');

// 给成员发积分；amount 是负数就是扣回。
route('POST', /^\/api\/users\/([\w-]+)\/credits$/, async ({ req, params, user: me }) => {
  const { amount } = await readJsonBody(req);
  return { credits: grantCredits(findUser(params[0]), amount, me) };
}, 'admin');

route('PUT', /^\/api\/users\/([\w-]+)$/, async ({ req, params }) => {
  const user = findUser(params[0]);
  const { disabled, resetPassword } = await readJsonBody(req);
  const password = resetPassword ? newPassword() : undefined;
  updateUser(user, { disabled, password });
  return { user: userView(user), ...(password ? { password } : {}) };
}, 'admin');

route('DELETE', /^\/api\/users\/([\w-]+)$/, async ({ params, user: me }) => {
  const user = findUser(params[0]);
  if (user === me) throw new HttpError(400, 'invalid_request', '不能删除自己的账号');
  removeUser(user);
  return null;
}, 'admin');
