/* ============================================================================
 * core.ts — ยูทิลิตี้พื้นฐาน: ตัวเลข วันที่ไทย เวลา แฮช
 * พอร์ตตรงจาก Code.gs (Apps Script) ให้ผลลัพธ์เหมือนเดิมทุกกรณี
 * มีชุดทดสอบเทียบกับโค้ดเดิมใน verify/parity.mjs
 * ==========================================================================*/

export const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export const TH_MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

export const MAX_SHIFT_MINUTES = 16 * 60;
export const TAX_RATE_DEFAULT = 3;
export const TAX_BASE_DEFAULT = 'TOTAL';

export const GRACE_MIN_DEFAULT = 15;
export const SCHED_START_DEFAULT = '12:00';
export const SCHED_END_DEFAULT = '20:00';
export const GRACE_EFFDATE_DEFAULT = '2026-09-01';

export const pad2 = (n: unknown) => {
  const v = parseInt(String(n), 10);
  return (v < 10 ? '0' : '') + v;
};

export const pad4 = (n: unknown) => {
  let s = '' + parseInt(String(n), 10);
  while (s.length < 4) s = '0' + s;
  return s;
};

/** แปลงค่าจากฐานข้อมูลเป็นข้อความอย่างปลอดภัย (Date → yyyy-MM-dd) */
export function cellStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const d = v as Date;
    return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  return ('' + v).trim();
}

export function num(v: unknown): number {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(('' + v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/** ปัดทศนิยม 2 ตำแหน่งแบบเสถียร (กัน floating point) */
export function r2(n: unknown): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** "31 ส.ค. 2569" / "2026-08-31" / Date → "2026-08-31" (ค.ศ. เสมอ)
 *  ปี >= 2400 ถือเป็น พ.ศ. แล้วลบ 543 — ไม่ลบทุกค่าแบบเหมาเข่ง */
export function toIsoDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const d = v as Date;
    let y = d.getFullYear();
    if (y >= 2400) y -= 543;
    return pad4(y) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  const s = ('' + v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    let yy = parseInt(m[1], 10);
    if (yy >= 2400) yy -= 543;
    return pad4(yy) + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  }
  m = s.match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4})$/); // 31 ส.ค. 2569
  if (m) {
    let mi = TH_MONTHS.indexOf(m[2]);
    if (mi < 0) mi = TH_MONTHS_FULL.indexOf(m[2]);
    if (mi >= 0) {
      let y2 = parseInt(m[3], 10);
      if (y2 >= 2400) y2 -= 543;
      return pad4(y2) + '-' + pad2(mi + 1) + '-' + pad2(m[1]);
    }
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // 31/08/2569
  if (m) {
    let y3 = parseInt(m[3], 10);
    if (y3 >= 2400) y3 -= 543;
    return pad4(y3) + '-' + pad2(m[2]) + '-' + pad2(m[1]);
  }
  return '';
}

/** "2026-08-31" → "31 ส.ค. 2569" */
export function toThaiDate(iso: unknown): string {
  if (!iso) return '';
  const p = ('' + iso).split('-');
  if (p.length !== 3) return '' + iso;
  return parseInt(p[2], 10) + ' ' + TH_MONTHS[parseInt(p[1], 10) - 1] + ' ' + (parseInt(p[0], 10) + 543);
}

/** "2026-08" → "สิงหาคม 2569" */
export function ymThai(ym: unknown): string {
  if (!ym) return '';
  const p = ('' + ym).split('-');
  if (p.length < 2) return '' + ym;
  return TH_MONTHS_FULL[parseInt(p[1], 10) - 1] + ' ' + (parseInt(p[0], 10) + 543);
}

/** "12:00" / Date / 0.5 (Excel serial) → นาทีตั้งแต่เที่ยงคืน */
export function toMinutes(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const d = v as Date;
    return d.getHours() * 60 + d.getMinutes();
  }
  if (typeof v === 'number') {
    if (v > 0 && v < 1) return Math.round(v * 24 * 60);
    return Math.round(v);
  }
  const s = ('' + v).trim().replace(/\s*น\.?\s*$/, '');
  const m = s.match(/^(\d{1,2})[:.](\d{1,2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

export function minutesToHHMM(mins: number | null | undefined | ''): string {
  if (mins === null || mins === undefined || (mins as unknown) === '') return '';
  const h = Math.floor((mins as number) / 60);
  const m = (mins as number) % 60;
  return pad2(h) + ':' + pad2(m);
}

export function fmtMoney(n: unknown): string {
  const v = r2(n);
  const s = Math.abs(v).toFixed(2).split('.');
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-' : '') + s.join('.');
}

export const pidOf = (branch: string, ym: string) => branch + '-' + ('' + ym).replace('-', '');

export function addDays(iso: string, n: number): string {
  const p = ('' + iso).split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/* ---- SHA-256 hex (เท่ากับ hash_ ใน Apps Script) ----
 * ใช้ในเบราว์เซอร์ผ่าน Web Crypto (async) และใน node ผ่าน node:crypto
 * ที่นี่ทำแบบ sync ด้วยการ implement SHA-256 ตรง ๆ เพราะ monthHash ถูกเรียกในลูปคำนวณ */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

export function sha256hex(msg: string): string {
  const bytes = new TextEncoder().encode(msg);
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const total = withOne + ((56 - (withOne % 64)) + 64) % 64 + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296), false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => ('0000000' + x.toString(16)).slice(-8)).join('');
}

export const hash = sha256hex;
