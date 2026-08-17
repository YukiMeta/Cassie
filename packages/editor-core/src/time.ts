/**
 * 时间统一用整数微秒（µs）存储。
 * 文档模型里不允许浮点时间 —— 保证序列化、diff 与回归测试的确定性。
 */
export type TimeUs = number;

export const US_PER_SECOND = 1_000_000;

export const us = (seconds: number): TimeUs => Math.round(seconds * US_PER_SECOND);

export const seconds = (t: TimeUs): number => t / US_PER_SECOND;

/** mm:ss.mmm */
export function formatTimecode(t: TimeUs): string {
  const totalMs = Math.round(t / 1000);
  const mm = Math.floor(totalMs / 60_000);
  const ss = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** 解析 "8" / "8.5" / "00:08.500" → µs；非法输入返回 null */
export function parseTimeUs(input: string): TimeUs | null {
  const s = input.trim();
  if (!s) return null;
  const colon = /^(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?$/.exec(s);
  if (colon) {
    const mm = Number(colon[1]);
    const ss = Number(colon[2]);
    const frac = colon[3] ?? "0";
    const ms = Number(frac.padEnd(3, "0").slice(0, 3));
    return (mm * 60 + ss) * US_PER_SECOND + ms * 1000;
  }
  const plain = /^(\d+(?:\.\d+)?)s?$/.exec(s);
  if (plain) return us(Number(plain[1]));
  return null;
}

export const clampUs = (t: TimeUs, lo: TimeUs, hi: TimeUs): TimeUs =>
  Math.max(lo, Math.min(hi, t));
