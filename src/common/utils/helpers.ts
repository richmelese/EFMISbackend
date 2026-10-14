import * as crypto from 'crypto';
import type { Request, Response } from 'express';

export const sha256 = (input: unknown): string =>
  crypto.createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex');

/** Local "YYYY-MM-DD HH:mm:ss" — the timestamp format used across the frontend data. */
export function nowStamp(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Format a Date (or null) as "YYYY-MM-DD HH:mm:ss" for API output. */
export const stamp = (d?: Date | null): string | null => (d ? nowStamp(new Date(d)) : null);

export const today = (): string => nowStamp().slice(0, 10);

/** Parse "YYYY-MM-DD HH:mm[:ss]" (local) or ISO into a Date. */
export const parseStamp = (s: string): Date => new Date(s.includes('T') ? s : s.replace(' ', 'T'));

export const randomDigits = (n: number): string => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');

export const shortId = (prefix: string): string => `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

export const round = (v: unknown, d = 2): number => Math.round((Number(v) || 0) * 10 ** d) / 10 ** d;

export const fmtMT = (n: number): string => `${Math.round(n).toLocaleString('en-US')} MT`;

/**
 * Optional server-side paging. The body stays an array (matching the frontend data shapes);
 * totals are exposed through X-Total-Count / X-Page / X-Page-Size headers.
 */
export function paginate<T>(req: Request, res: Response, items: T[]): T[] {
  const page = parseInt(String(req.query.page ?? ''), 10);
  if (!page) return items;
  const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize ?? ''), 10) || 50, 1), 500);
  res.setHeader('X-Total-Count', String(items.length));
  res.setHeader('X-Page', String(page));
  res.setHeader('X-Page-Size', String(pageSize));
  return items.slice((page - 1) * pageSize, page * pageSize);
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
}

export const daysSince = (d: Date | string): number => (Date.now() - new Date(d).getTime()) / 864e5;
