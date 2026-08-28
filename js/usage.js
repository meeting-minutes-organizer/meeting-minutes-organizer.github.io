// 本機用量追蹤（非 Google 官方額度，只是這支手機記的次數 + 冷卻狀態）
const U = 'key_usage'; // { [key]: { date, count } }
const C = 'key_cooldown'; // { [key]: untilTs }

function read(k) {
  try {
    return JSON.parse(localStorage.getItem(k)) || {};
  } catch (_) {
    return {};
  }
}
function write(k, v) {
  localStorage.setItem(k, JSON.stringify(v));
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function recordUse(key) {
  if (!key) return;
  const u = read(U);
  const t = today();
  if (!u[key] || u[key].date !== t) u[key] = { date: t, count: 0 };
  u[key].count++;
  write(U, u);
}
export function recordCooldown(key, ms) {
  if (!key || !ms) return;
  const c = read(C);
  c[key] = Date.now() + ms;
  write(C, c);
}
// 回傳 { count, cooling }：count = 今日在本機的用量次數；cooling = 剩餘冷卻秒數（0 表示可用）
export function getKeyStatus(key) {
  const u = read(U);
  const c = read(C);
  const t = today();
  const count = u[key] && u[key].date === t ? u[key].count : 0;
  const until = c[key] || 0;
  const cooling = until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  return { count, cooling };
}
