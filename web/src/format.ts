// 时间、时长、文件大小的写法。

export function fmtTime(ms?: number) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

// 时长（秒）写成 0:02 / 1:30，给播放器、剪辑器这类按秒工作的场景用。区别于上面的 fmtTime（按毫秒格式化日期）。
export function fmtClock(seconds?: number) {
  if (!Number.isFinite(seconds as number) || (seconds as number) < 0) return '0:00';
  const s = Math.floor(seconds as number);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtBytes(n?: number) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// 金额。不到一毛的多留一位小数，不然语音这种几厘钱的会显示成 0.00。
export const fmtYuan = (yuan: number) => `¥${yuan.toFixed(yuan > 0 && yuan < 0.1 ? 3 : 2)}`;
// 积分：成员的余额和花费，以及 MiniMax 订阅 Key 的余额。
export const fmtCredits = (credits: number) => `${Math.round(credits).toLocaleString('zh-CN')} 积分`;
export const fmtUsd = (usd: number) => `$${usd.toFixed(2)}`;
// 估算的费用，算不出来就不显示。
export const fmtCost = (yuan: number | null) => (yuan == null ? null : `约 ${fmtYuan(yuan)}`);
