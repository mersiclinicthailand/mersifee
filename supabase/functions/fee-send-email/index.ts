// ============================================================================
// fee-send-email — ส่งอีเมลหาแพทย์ผ่าน Resend
//   sign_invite : เชิญแพทย์กดลิงก์เซ็นรับรองรายได้ (ลิงก์มีอายุ 14 วัน)      — admin · hr
//   tax_detail  : สรุปยอดหักภาษี ณ ที่จ่ายของเดือน                          — admin · hr · acct
//   wht_cert    : ส่งหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) แนบ PDF     — admin · hr · acct
//   test        : ส่งเมลตัวอย่าง (ข้อมูลสมมติ) ถึงอีเมลที่ผู้ทดสอบกรอกเอง    — admin · hr · acct · it
//
// ต้องตั้ง secret: RESEND_API_KEY, FEE_MAIL_FROM, FEE_APP_URL
//
// ตารางในสคีมา fee เปิด FORCE ROW LEVEL SECURITY — กุญแจ service role อ่านไม่เห็นแถว
// ทุกงานที่แตะตารางจึงผ่าน RPC (supabase/mail_rpc.sql) ด้วย token ของคนที่กดส่ง
//
// ไฟล์นี้เป็นไฟล์เดียว วางใน Supabase Dashboard → Edge Functions → Edit ได้ทันที
// (ส่วนแม่แบบเมลด้านบนตรงกับ src/lib/mailtpl.ts ที่ใช้ทำหน้าตัวอย่าง)
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// ---8<--- แม่แบบอีเมล (เริ่ม) ---
// ============================================================================
// แม่แบบอีเมล Mersi Clinic — ใช้ร่วมกันทั้งเมลจริงและเมลทดสอบ
//
// เขียนแบบ "อีเมลปลอดภัย": ตาราง + inline style ล้วน (Gmail / Outlook / iPhone Mail
// ไม่รองรับ flex, grid, <style> ภายนอก) · โลโก้ดึงจากเว็บของระบบ (/logo.png)
// ไม่ฝังเป็น base64 เพราะ Gmail ตัดรูป base64 ทิ้ง
// ============================================================================

export const BRAND = {
  sage: '#8B9677', sageDk: '#6E7A5B', sageLt: '#E8EBE2',
  cream: '#F7F5EF', champagne: '#C8B68E', ink: '#23261F', ink2: '#5B6154', ink3: '#8A8F80',
  line: '#E6E3DA', page: '#EEF0EA',
};

const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MONTH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                       'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export const ymThai = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${TH_MONTH[m - 1]} ${String(y + 543).slice(-2)}`;
};
export const ymThaiFull = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${TH_MONTH_FULL[m - 1]} ${y + 543}`;
};
export const money = (n: number) =>
  Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** กัน HTML injection จากชื่อ/ข้อความที่มาจากฐานข้อมูล */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const FONT = `'Sarabun','IBM Plex Sans Thai','Noto Sans Thai',Tahoma,Arial,sans-serif`;
const B = BRAND;

export type MailKind = 'sign_invite' | 'tax_detail' | 'wht_cert';

export interface MailData {
  kind: MailKind;
  name: string;            // ชื่อเต็มของแพทย์
  licNo: string;
  branchTh: string;
  ym: string;              // YYYY-MM
  gross: number; tax: number; net: number;
  appUrl: string;          // ใช้หาโลโก้ และทำลิงก์
  signLink?: string;       // sign_invite
  fileName?: string;       // wht_cert
  note?: string;           // ข้อความเพิ่มเติมจากผู้ส่ง
  test?: boolean;          // เมลทดสอบ — มีแถบบอกชัด ๆ
  detail?: Detail | null;  // รายละเอียดที่ล็อกไว้ตอนอนุมัติ (ใบเวรรายวัน + ค่ามือทุกแถว)
}

/* รายละเอียดจาก snapshot ตอนอนุมัติ (ตรงกับ src/lib/snapshot.ts) */
export interface Detail {
  rate: number; taxBase: string; taxRate: number; taxBaseAmt: number;
  sumHrs: number; sumMins: number;
  shiftTotal: number; coverShift: number; handTotal: number;
  adjAdd: number; adjDeduct: number; adjList: { kind: string; amount: number; reason: string }[];
  gross: number; tax: number; deduct: number; net: number;
  payeeType?: string; payeeName?: string; bank?: string; bankAcc?: string;
  procCount: number;
  days: { d: string; in: string; out: string; brk: number; hrs: number; mins: number; rate: number;
          shift: number; hand: number; handRows: number; deduct: number; special: number | null;
          kind: string; note: string; grace: string }[];
  procs: { d: string; doc: string; c: string; q: number; f: number }[];
}

/* ---------------------------------- ชิ้นส่วน ---------------------------------- */

const p = (html: string, extra = '') =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.75;color:${B.ink2};${extra}">${html}</p>`;

/** ป้ายข้อมูลเล็ก ๆ ใต้หัวเรื่อง: สาขา · รอบเดือน · เลข ว. */
const chips = (items: string[]) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:14px auto 0;">
    <tr>${items.map((t) => `
      <td style="padding:0 3px;">
        <span style="display:inline-block;font-family:${FONT};font-size:12px;color:${B.sageDk};
          background:#FFFFFF;border:1px solid ${B.line};border-radius:999px;padding:4px 11px;white-space:nowrap;">${t}</span>
      </td>`).join('')}
    </tr>
  </table>`;

/** การ์ดยอดเงิน — จ่ายสุทธิตัวใหญ่ อ่านง่ายบนมือถือ */
export const amountCard = (gross: number, tax: number, net: number) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="background:${B.cream};border:1px solid ${B.line};border-radius:14px;margin:6px 0 20px;">
    <tr><td style="padding:18px 20px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:${FONT};font-size:14px;color:${B.ink2};padding:6px 0;">รวมเงินได้</td>
          <td align="right" style="font-family:${FONT};font-size:15px;color:${B.ink};padding:6px 0;">${money(gross)} ฿</td>
        </tr>
        <tr>
          <td style="font-family:${FONT};font-size:14px;color:${B.ink2};padding:6px 0 12px;border-bottom:1px dashed ${B.champagne};">
            หักภาษี ณ ที่จ่าย</td>
          <td align="right" style="font-family:${FONT};font-size:15px;color:#A04A3C;padding:6px 0 12px;border-bottom:1px dashed ${B.champagne};">
            −${money(tax)} ฿</td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:10px 20px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:${FONT};font-size:14px;font-weight:700;color:${B.ink};">จ่ายสุทธิ</td>
          <td align="right" style="font-family:${FONT};font-size:26px;font-weight:700;color:${B.sageDk};letter-spacing:-.3px;">
            ${money(net)} <span style="font-size:15px;">฿</span></td>
        </tr>
      </table>
    </td></tr>
  </table>`;

/** ปุ่มแบบ "bulletproof" — กดได้ทุกแอปอีเมลรวม Outlook */
const button = (href: string, label: string) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 14px;">
    <tr><td align="center" bgcolor="${B.sage}" style="border-radius:12px;background:${B.sage};">
      <a href="${esc(href)}" target="_blank"
        style="display:inline-block;padding:15px 38px;font-family:${FONT};font-size:16px;font-weight:700;
               color:#FFFFFF;text-decoration:none;border-radius:12px;">${label}</a>
    </td></tr>
  </table>`;

const attachmentRow = (fileName: string) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="border:1px solid ${B.line};border-radius:12px;margin:0 0 18px;">
    <tr>
      <td width="52" align="center" style="padding:12px 0 12px 14px;">
        <span style="display:inline-block;background:#C9412F;color:#FFFFFF;font-family:Arial,sans-serif;font-size:11px;
          font-weight:700;border-radius:5px;padding:6px 7px;">PDF</span>
      </td>
      <td style="padding:12px 14px;font-family:${FONT};">
        <div style="font-size:14px;color:${B.ink};font-weight:600;word-break:break-all;">${esc(fileName)}</div>
        <div style="font-size:12px;color:${B.ink3};">แนบมากับอีเมลฉบับนี้ · เปิดได้จากไฟล์แนบด้านล่าง</div>
      </td>
    </tr>
  </table>`;

const noteBox = (note?: string) => (note ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
    <tr><td style="border-left:3px solid ${B.champagne};background:#FBFAF6;padding:12px 16px;
      font-family:${FONT};font-size:14px;line-height:1.7;color:${B.ink2};">${esc(note)}</td></tr>
  </table>` : '');

/* ------------------------------- รายละเอียดรายได้ ------------------------------- */

const TH_DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const dThai = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${TH_DOW[dow]} ${d} ${TH_MONTH[m - 1]}`;
};
const hm = (h: number, m: number) => `${h} ชม.${m ? ` ${m} น.` : ''}`;
const KIND_TH: Record<string, string> = {
  SHIFT: 'เวรปกติ', NIGHT: 'เวรดึก', MEETING: 'ประชุม', KOL: 'KOL', TRAIN: 'อบรม', COVER: 'เวรแทน',
};
const TAX_BASE_TH: Record<string, string> = { TOTAL: 'รวมเงินได้ทั้งหมด', SHIFT: 'เฉพาะค่าเวร', NONE: 'ไม่หักภาษี' };
export const maskAcc = (a?: string) => (a ? a.replace(/.(?=.{4})/g, (c) => (/\d/.test(c) ? 'x' : c)) : '');

const secTitle = (t: string, sub = '') => `
  <div style="font-family:${FONT};font-size:15px;font-weight:700;color:${B.ink};margin:26px 0 4px;">${t}</div>
  ${sub ? `<div style="font-family:${FONT};font-size:12.5px;color:${B.ink3};margin:0 0 10px;">${sub}</div>` : ''}`;

const kv = (k: string, v: string, strong = false, color = B.ink) => `
  <tr>
    <td style="font-family:${FONT};font-size:13.5px;color:${B.ink2};padding:6px 0;border-bottom:1px solid ${B.line};">${k}</td>
    <td align="right" style="font-family:${FONT};font-size:13.5px;color:${color};padding:6px 0;border-bottom:1px solid ${B.line};
      ${strong ? 'font-weight:700;' : ''}white-space:nowrap;">${v}</td>
  </tr>`;

/** ที่มาของยอด — คำนวณให้เห็นทุกขั้น ตั้งแต่ชั่วโมงจนถึงยอดโอน */
function breakdown(d: Detail) {
  const rows = [
    kv(`ค่าเวร · ${hm(d.sumHrs, d.sumMins)} × ${money(d.rate)} บาท/ชม.`, `${money(d.coverShift)} ฿`),
    ...(Math.abs(d.coverShift - d.shiftTotal) > 0.004
      ? [kv('<span style="font-size:12px;">(ยอดตามใบเวร ก่อนปรับตามเงื่อนไขสัญญา)</span>', `${money(d.shiftTotal)} ฿`, false, B.ink3)] : []),
    kv(`ค่ามือ · ${d.procCount.toLocaleString('th-TH')} รายการ`, `${money(d.handTotal)} ฿`),
    ...d.adjList.map((a) => kv(`${a.amount >= 0 ? 'ปรับเพิ่ม' : 'ปรับลด'} · ${esc(a.reason || a.kind)}`,
      `${a.amount >= 0 ? '' : '−'}${money(Math.abs(a.amount))} ฿`, false, a.amount >= 0 ? B.ink : '#A04A3C')),
    kv('<b>รวมเงินได้</b>', `${money(d.gross)} ฿`, true),
    kv(`ฐานคิดภาษี · ${TAX_BASE_TH[d.taxBase] || d.taxBase}`, `${money(d.taxBaseAmt)} ฿`),
    kv(`หักภาษี ณ ที่จ่าย ${d.taxRate}%`, `−${money(d.tax)} ฿`, false, '#A04A3C'),
    ...(d.deduct ? [kv('หักอื่น ๆ (ดูหมายเหตุรายวัน)', `−${money(d.deduct)} ฿`, false, '#A04A3C')] : []),
    kv('<b>จ่ายสุทธิ</b>', `${money(d.net)} ฿`, true, B.sageDk),
  ];
  const bank = d.bankAcc
    ? `<div style="font-family:${FONT};font-size:12.5px;color:${B.ink3};margin-top:8px;">
         โอนเข้า ${esc(d.bank || '')} ${esc(maskAcc(d.bankAcc))}
         ${d.payeeType === 'COMPANY' && d.payeeName ? ` · ในนาม ${esc(d.payeeName)}` : ''}</div>` : '';
  return `${secTitle('① ที่มาของยอด', 'คำนวณจากใบเวรและรายงานค่าหัตถการที่อนุมัติแล้ว')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>${bank}`;
}

/** ใบเวรรายวัน — วันละบรรทัด */
function dayTable(d: Detail) {
  const th = (t: string, al = 'left') =>
    `<th align="${al}" style="font-family:${FONT};font-size:11.5px;font-weight:600;color:${B.ink3};padding:7px 6px;
      border-bottom:1px solid ${B.line};background:${B.cream};white-space:nowrap;">${t}</th>`;
  const td = (t: string, al = 'left', extra = '') =>
    `<td align="${al}" style="font-family:${FONT};font-size:12.5px;color:${B.ink};padding:7px 6px;border-bottom:1px solid ${B.line};${extra}">${t}</td>`;
  const body = d.days.map((r) => {
    const notes = [
      r.kind && r.kind !== 'SHIFT' ? KIND_TH[r.kind] || r.kind : '',
      r.grace, r.special !== null && r.special !== undefined ? `ยอดพิเศษ ${money(r.special)}` : '',
      r.deduct ? `หัก ${money(r.deduct)}` : '', r.note,
    ].filter(Boolean).map((x) => esc(x)).join(' · ');
    return `<tr>
      ${td(`<b>${dThai(r.d)}</b>`, 'left', 'white-space:nowrap;')}
      ${td(r.in && r.out ? `${r.in}–${r.out}${r.brk ? `<br><span style="color:${B.ink3};font-size:11px;">พัก ${r.brk} น.</span>` : ''}` : '—', 'left', 'white-space:nowrap;')}
      ${td(hm(r.hrs, r.mins), 'right', 'white-space:nowrap;')}
      ${td(money(r.shift), 'right')}
      ${td(`${money(r.hand)}${r.handRows ? `<br><span style="color:${B.ink3};font-size:11px;">${r.handRows} รายการ</span>` : ''}`, 'right')}
    </tr>${notes ? `<tr><td colspan="5" style="font-family:${FONT};font-size:11.5px;color:${B.ink2};padding:0 6px 7px;border-bottom:1px solid ${B.line};">↳ ${notes}</td></tr>` : ''}`;
  }).join('');
  return `${secTitle(`② ใบเวรรายวัน · ${d.days.length} วัน`, 'เวลาเข้า-ออกที่ใช้คิดค่าเวร และค่ามือของแต่ละวัน')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${B.line};border-radius:10px;">
      <tr>${th('วันที่')}${th('เวลา')}${th('ชั่วโมง', 'right')}${th('ค่าเวร', 'right')}${th('ค่ามือ', 'right')}</tr>
      ${body}
      <tr>${td('<b>รวม</b>')}${td('')}${td(`<b>${hm(d.sumHrs, d.sumMins)}</b>`, 'right', 'white-space:nowrap;')}
        ${td(`<b>${money(d.shiftTotal)}</b>`, 'right')}${td(`<b>${money(d.handTotal)}</b>`, 'right')}</tr>
    </table>`;
}

/** ค่ามือรวมตามคอร์ส (แถวละเอียดทุกแถวอยู่ในไฟล์แนบ — ใส่ในเมลทั้งหมดจะยาวจน Gmail ตัดทิ้ง) */
function procSummary(d: Detail) {
  const g = new Map<string, { n: number; q: number; f: number }>();
  d.procs.forEach((p) => {
    const x = g.get(p.c) || { n: 0, q: 0, f: 0 };
    x.n += 1; x.q += p.q; x.f += p.f; g.set(p.c, x);
  });
  const list = [...g.entries()].sort((a, b) => b[1].f - a[1].f);
  const TOP = 25;
  const rows = list.slice(0, TOP).map(([c, x]) => `
    <tr>
      <td style="font-family:${FONT};font-size:12.5px;color:${B.ink};padding:6px 6px;border-bottom:1px solid ${B.line};">${esc(c)}</td>
      <td align="right" style="font-family:${FONT};font-size:12.5px;color:${B.ink2};padding:6px 6px;border-bottom:1px solid ${B.line};white-space:nowrap;">${x.n} ครั้ง</td>
      <td align="right" style="font-family:${FONT};font-size:12.5px;color:${B.ink};padding:6px 6px;border-bottom:1px solid ${B.line};white-space:nowrap;">${money(x.f)}</td>
    </tr>`).join('');
  const rest = list.slice(TOP);
  const restRow = rest.length ? `
    <tr><td style="font-family:${FONT};font-size:12px;color:${B.ink3};padding:6px;">และอีก ${rest.length} คอร์ส</td>
      <td align="right" style="font-family:${FONT};font-size:12px;color:${B.ink3};padding:6px;">${rest.reduce((a, [, x]) => a + x.n, 0)} ครั้ง</td>
      <td align="right" style="font-family:${FONT};font-size:12px;color:${B.ink3};padding:6px;">${money(rest.reduce((a, [, x]) => a + x.f, 0))}</td></tr>` : '';
  return `${secTitle(`③ ค่ามือแยกตามคอร์ส · ${d.procs.length.toLocaleString('th-TH')} รายการ`,
      'รายการทุกแถว (วันที่ · เลขที่เอกสาร · คอร์ส · จำนวน · ค่ามือ) อยู่ในไฟล์แนบ เปิดด้วย Excel ได้')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${B.line};border-radius:10px;">
      ${rows}${restRow}
      <tr><td style="font-family:${FONT};font-size:12.5px;font-weight:700;padding:7px 6px;">รวมค่ามือ</td><td></td>
        <td align="right" style="font-family:${FONT};font-size:12.5px;font-weight:700;padding:7px 6px;">${money(d.handTotal)}</td></tr>
    </table>`;
}

export function detailHtml(d?: Detail | null) {
  if (!d || !Array.isArray(d.days)) return '';
  return `${breakdown(d)}${dayTable(d)}${d.procs.length ? procSummary(d) : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;">
      <tr><td style="background:${B.sageLt};border-radius:10px;padding:12px 14px;font-family:${FONT};font-size:12.5px;line-height:1.7;color:${B.ink2};">
        📎 <b>ไฟล์แนบ</b> มีรายละเอียดครบทุกบรรทัด (ใบเวรรายวัน + ค่ามือทุกรายการพร้อมเลขที่เอกสาร) ไว้ตรวจเทียบกับบิลได้
        · หากพบรายการไม่ถูกต้อง กรุณา<b>ยังไม่ต้องเซ็น</b> และแจ้งฝ่ายบุคคล
      </td></tr>
    </table>`;
}

/** ไฟล์ CSV (เปิดใน Excel ภาษาไทยได้) — รายละเอียดครบทุกบรรทัด */
export function detailCsv(d: Detail, meta: { name: string; licNo: string; branchTh: string; ym: string }) {
  const q = (v: unknown) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const L: string[] = [];
  const row = (...a: unknown[]) => L.push(a.map(q).join(','));
  row('รายละเอียดค่าตอบแทนแพทย์ Mersi Clinic');
  row('แพทย์', meta.name); row('เลข ว.', meta.licNo); row('สาขา', meta.branchTh); row('รอบเดือน', ymThaiFull(meta.ym));
  row('');
  row('สรุปยอด');
  row('ค่าเวร', d.coverShift); row('ชั่วโมงรวม', `${d.sumHrs}:${String(d.sumMins).padStart(2, '0')}`); row('อัตรา/ชม.', d.rate);
  row('ค่ามือ', d.handTotal); row('จำนวนรายการค่ามือ', d.procCount);
  d.adjList.forEach((a) => row('ปรับปรุง', a.amount, a.reason || a.kind));
  row('รวมเงินได้', d.gross); row('ฐานคิดภาษี', d.taxBaseAmt, TAX_BASE_TH[d.taxBase] || d.taxBase);
  row(`ภาษีหัก ณ ที่จ่าย ${d.taxRate}%`, d.tax); row('หักอื่น ๆ', d.deduct); row('จ่ายสุทธิ', d.net);
  row('');
  row('ใบเวรรายวัน');
  row('วันที่', 'เข้า', 'ออก', 'พัก(นาที)', 'ชั่วโมง', 'นาที', 'อัตรา', 'ค่าเวร', 'ค่ามือ', 'จำนวนรายการ', 'หัก', 'ประเภท', 'หมายเหตุ');
  d.days.forEach((r) => row(r.d, r.in, r.out, r.brk, r.hrs, r.mins, r.rate, r.shift, r.hand, r.handRows, r.deduct,
    KIND_TH[r.kind] || r.kind, [r.grace, r.note, r.special !== null && r.special !== undefined ? `ยอดพิเศษ ${r.special}` : ''].filter(Boolean).join(' · ')));
  row('');
  row('รายการค่ามือทั้งหมด');
  row('วันที่ออกบิล', 'เลขที่เอกสาร', 'ชื่อคอร์ส', 'จำนวน', 'ค่ามือ');
  d.procs.forEach((p) => row(p.d, p.doc, p.c, p.q, p.f));
  row('', '', 'รวม', '', d.handTotal);
  return '﻿' + L.join('\r\n');
}

/** base64 ของข้อความ UTF-8 (ใช้แนบไฟล์) */
export function b64utf8(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------------------------------- โครงเมล ---------------------------------- */

function layout(o: {
  appUrl: string; preheader: string; eyebrow: string; title: string;
  chipItems: string[]; body: string; test?: boolean;
}) {
  const logo = o.appUrl ? `${o.appUrl}/logo.png` : '';
  const testBar = o.test ? `
    <tr><td style="background:#FFF4D6;border-bottom:1px solid #EBD9A8;padding:10px 20px;text-align:center;
      font-family:${FONT};font-size:13px;color:#7A5A12;">
      🧪 <b>อีเมลทดสอบ</b> — ยอดเงินและชื่อในเมลนี้เป็นข้อมูลตัวอย่าง ไม่ได้ส่งถึงแพทย์จริง
    </td></tr>` : '';

  return `<!doctype html>
<html lang="th" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:${B.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(o.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${B.page};">
    <tr><td align="center" style="padding:28px 12px 36px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="max-width:560px;background:#FFFFFF;border-radius:18px;overflow:hidden;
               border:1px solid ${B.line};box-shadow:0 6px 24px rgba(35,38,31,.06);">
        ${testBar}
        <!-- หัวเมล -->
        <tr><td align="center" style="background:${B.cream};padding:30px 24px 24px;border-bottom:1px solid ${B.line};">
          ${logo
            ? `<img src="${esc(logo)}" width="84" height="84" alt="Mersi Clinic"
                 style="display:block;width:84px;height:84px;border:0;margin:0 auto 14px;border-radius:50%;">`
            : `<div style="font-family:Georgia,serif;font-size:30px;color:${B.sageDk};margin:0 0 10px;">Mersi</div>`}
          <div style="font-family:${FONT};font-size:12px;letter-spacing:2px;color:${B.champagne};text-transform:uppercase;">
            ${esc(o.eyebrow)}</div>
          <div style="font-family:${FONT};font-size:21px;font-weight:700;color:${B.ink};margin-top:4px;">${esc(o.title)}</div>
          ${chips(o.chipItems)}
        </td></tr>
        <!-- เนื้อหา -->
        <tr><td style="padding:28px 28px 8px;">${o.body}</td></tr>
        <!-- ท้ายเมล -->
        <tr><td style="padding:4px 28px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="border-top:1px solid ${B.line};padding-top:16px;font-family:${FONT};font-size:13px;line-height:1.7;color:${B.ink2};">
              ขอแสดงความนับถือ<br>
              <b style="color:${B.ink};">Mersi Clinic</b> · ฝ่ายบุคคลและฝ่ายบัญชี
            </td></tr>
          </table>
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td align="center" style="padding:16px 20px 0;font-family:${FONT};font-size:11.5px;line-height:1.7;color:${B.ink3};">
          อีเมลฉบับนี้ส่งจากระบบค่าตอบแทนแพทย์ของ Mersi Clinic โดยอัตโนมัติ กรุณาอย่าตอบกลับ<br>
          ข้อมูลในอีเมลเป็นความลับเฉพาะผู้รับ หากได้รับโดยไม่ทราบที่มา กรุณาแจ้งฝ่ายบุคคลและลบอีเมลนี้
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* --------------------------------- เมลแต่ละแบบ --------------------------------- */

export function buildMail(d: MailData): { subject: string; html: string } {
  const month = ymThai(d.ym);
  const monthFull = ymThaiFull(d.ym);
  const chipItems = [`สาขา${esc(d.branchTh)}`, `รอบ ${esc(monthFull)}`, `ว.${esc(d.licNo)}`];
  const hello = p(`เรียน <b style="color:${B.ink};">${esc(d.name)}</b>`, 'margin-bottom:10px;');
  const pre = d.test ? '[ทดสอบ] ' : '';

  if (d.kind === 'sign_invite') {
    return {
      subject: `${pre}ขอความอนุเคราะห์เซ็นรับรองรายได้ ${month} · ${d.branchTh}`,
      html: layout({
        appUrl: d.appUrl, test: d.test, chipItems,
        preheader: `ยอดสุทธิ ${money(d.net)} บาท — กดเพื่อตรวจสอบและเซ็นรับรอง ใช้เวลาไม่ถึง 1 นาที`,
        eyebrow: 'Income Confirmation', title: 'เซ็นรับรองรายได้ประจำเดือน',
        body: `${hello}
          ${p(`ยอดค่าตอบแทนประจำเดือน <b>${esc(monthFull)}</b> สาขา<b>${esc(d.branchTh)}</b>
            ได้รับการอนุมัติเรียบร้อยแล้ว ขอความอนุเคราะห์อาจารย์ตรวจสอบยอดด้านล่าง แล้วกดปุ่มเพื่อเซ็นรับรองครับ`)}
          ${amountCard(d.gross, d.tax, d.net)}
          ${noteBox(d.note)}
          ${button(d.signLink || '#', 'ตรวจสอบและเซ็นรับรอง')}
          ${detailHtml(d.detail)}
          ${d.detail ? button(d.signLink || '#', 'ตรวจครบแล้ว · เซ็นรับรอง') : ''}
          ${p(`เซ็นด้วยนิ้วบนมือถือได้เลย ไม่ต้องล็อกอิน · ลิงก์นี้ใช้ได้เฉพาะอาจารย์ท่านเดียว มีอายุ 14 วัน
            กรุณาอย่าส่งต่อให้ผู้อื่น`, `font-size:12.5px;color:${B.ink3};text-align:center;`)}`,
      }),
    };
  }

  if (d.kind === 'wht_cert') {
    const file = d.fileName || `50ทวิ_${d.licNo}_${month}.pdf`;
    return {
      subject: `${pre}หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ${month} · ${d.branchTh}`,
      html: layout({
        appUrl: d.appUrl, test: d.test, chipItems,
        preheader: `50 ทวิ ประจำเดือน ${monthFull} · ภาษีหัก ณ ที่จ่าย ${money(d.tax)} บาท (ไฟล์แนบ)`,
        eyebrow: 'Withholding Tax Certificate', title: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย',
        body: `${hello}
          ${p(`ฝ่ายบัญชีขอส่ง <b>หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)</b> สำหรับค่าตอบแทนประจำเดือน
            <b>${esc(monthFull)}</b> สาขา<b>${esc(d.branchTh)}</b> ตามไฟล์แนบครับ`)}
          ${attachmentRow(file)}
          ${amountCard(d.gross, d.tax, d.net)}
          ${d.detail && Array.isArray(d.detail.days) ? breakdown(d.detail) : ''}
          ${noteBox(d.note)}
          ${p(`กรุณาเก็บไฟล์นี้ไว้ใช้ยื่นแบบภาษีเงินได้บุคคลธรรมดาประจำปี
            หากยอดไม่ตรงกับที่ได้รับ กรุณาติดต่อฝ่ายบัญชีครับ`, `font-size:13px;`)}`,
      }),
    };
  }

  return {
    subject: `${pre}รายละเอียดการหักภาษี ณ ที่จ่าย ${month} · ${d.branchTh}`,
    html: layout({
      appUrl: d.appUrl, test: d.test, chipItems,
      preheader: `สรุปภาษีหัก ณ ที่จ่ายเดือน ${monthFull}: ${money(d.tax)} บาท · สุทธิ ${money(d.net)} บาท`,
      eyebrow: 'Tax Summary', title: 'รายละเอียดการหักภาษี ณ ที่จ่าย',
      body: `${hello}
        ${p(`สรุปการหักภาษี ณ ที่จ่ายสำหรับค่าตอบแทนประจำเดือน <b>${esc(monthFull)}</b>
          สาขา<b>${esc(d.branchTh)}</b> ดังนี้ครับ`)}
        ${amountCard(d.gross, d.tax, d.net)}
        ${d.detail && Array.isArray(d.detail.days) ? breakdown(d.detail) : ''}
        ${noteBox(d.note)}
        ${p(`หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ฝ่ายบัญชีจะจัดส่งให้ตามรอบ
          หากมีข้อสงสัยกรุณาติดต่อฝ่ายบัญชีได้เลยครับ`, `font-size:13px;`)}`,
    }),
  };
}

/** ข้อมูลตัวอย่างสำหรับเมลทดสอบ — ทุกตัวเลขบวกกันได้จริง */
export function sampleDetail(ym: string): Detail {
  const days = [2, 5, 9, 12, 16, 19, 23, 30].map((dd, i) => ({
    d: `${ym}-${String(dd).padStart(2, '0')}`, in: i === 3 ? '12:10' : '12:00', out: '20:00', brk: 0,
    hrs: 8, mins: 0, rate: 900, shift: i === 7 ? 5400 : 7200, hand: 0, handRows: 0, deduct: 0, special: null,
    kind: 'SHIFT', note: '', grace: i === 3 ? 'สาย 10 นาที ไม่เกิน 15 นาที นับเต็มชั่วโมง' : '',
  }));
  days[7] = { ...days[7], hrs: 6, out: '18:00', note: 'ออกก่อนเวลา (แจ้งล่วงหน้า)' };
  const courses = [['Toxin MBTox 50 Unit', 300], ['Filler Juvederm 1cc', 1500], ['ULTRATIGHT MPT 100 Shots', 1800],
    ['Treatment RF 30 นาที', 150], ['Sculptra 1 ขวด', 3000], ['Botox กราม 50 Unit', 400]] as const;
  const procs: Detail['procs'] = [];
  let left = 34800;
  let k = 0;
  while (left > 0) {
    const [c, f0] = courses[k % courses.length];
    const f = Math.min(f0, left);
    const day = days[k % days.length];
    procs.push({ d: day.d, doc: `CD${String(3800 + k).padStart(6, '0')}`, c, q: 1, f });
    day.hand += f; day.handRows += 1; left -= f; k++;
  }
  return {
    rate: 900, taxBase: 'SHIFT', taxRate: 3, taxBaseAmt: 55800, sumHrs: 62, sumMins: 0,
    shiftTotal: 55800, coverShift: 55800, handTotal: 34800, adjAdd: 8700, adjDeduct: 0,
    adjList: [{ kind: 'ADD', amount: 8700, reason: 'ค่าเดินทางต่างสาขา (ตัวอย่าง)' }],
    gross: 99300, tax: 1674, deduct: 0, net: 97626,
    payeeType: 'PERSON', payeeName: '', bank: 'SCB', bankAcc: '118-219790-7',
    procCount: procs.length, days, procs,
  };
}

// ---8<--- แม่แบบอีเมล (จบ) ---

// ============================================================================
// ตัวรับคำสั่งส่งเมล
// ============================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-application-name',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

/** PDF ตัวอย่างเล็ก ๆ สำหรับเมลทดสอบ 50 ทวิ (ถ้าผู้ทดสอบไม่ได้แนบไฟล์เอง) */
const SAMPLE_PDF = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAyMjUgPj4Kc3RyZWFtCkJUIC9GMSAyMCBUZiA2MCA3NjAgVGQgKE1lcnNpIENsaW5pYyAtIFNBTVBMRSA1MCBUYXdpKSBUaiAwIC0zMCBUZCAvRjEgMTIgVGYgKFRoaXMgaXMgYSB0ZXN0IGF0dGFjaG1lbnQgZnJvbSB0aGUgTWVyc2lGZWUgZW1haWwgdGVzdC4pIFRqIDAgLTE4IFRkIChUaGUgcmVhbCBmaWxlIGlzIHRoZSB3aXRoaG9sZGluZyB0YXggY2VydGlmaWNhdGUgaXNzdWVkIGJ5IEFjY291bnRpbmcuKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDUxNyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjU4NwolJUVPRgo=';

async function sendResend(apiKey: string, from: string, to: string, subject: string, html: string,
  attachments: { filename: string; content: string }[] = []) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, ...(attachments.length ? { attachments } : {}) }),
    });
    const jr = await r.json().catch(() => ({}));
    return { ok: r.ok, id: jr?.id || '', error: r.ok ? '' : (jr?.message || jr?.error?.message || `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, id: '', error: e instanceof Error ? e.message : String(e) };
  }
}

// ครอบทั้งหมดด้วย try/catch — ถ้าโค้ดพังกลางทาง ต้องตอบกลับพร้อม CORS header เสมอ
// ไม่งั้นเบราว์เซอร์จะเห็นแค่ "Failed to send a request to the Edge Function" โดยไม่รู้สาเหตุ
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    return await handle(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('fee-send-email crashed:', msg);
    return json({ error: `ระบบส่งเมลขัดข้อง: ${msg}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'ต้องเรียกด้วย POST' }, 405);

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('FEE_MAIL_FROM') || 'Mersi Clinic <onboarding@resend.dev>';
  const appUrl = (Deno.env.get('FEE_APP_URL') || 'https://mersiclinicfee.mersiclinic-digitalmarketing.workers.dev')
    .replace(/\/+$/, '');
  if (!apiKey) {
    return json({ error: 'ยังไม่ได้ตั้งค่า RESEND_API_KEY ที่ Supabase — ตั้งก่อนจึงจะส่งเมลได้' }, 400);
  }

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'ไม่ได้ล็อกอิน' }, 401);

  // client ที่ "เป็นตัวคนกด" — RPC จะเห็น auth.uid() ของคนนั้น แล้วตรวจสิทธิ์เอง
  const asUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    // โปรเจกต์รุ่นใหม่บางตัวไม่มี SUPABASE_ANON_KEY — ใช้คีย์ publishable ที่หน้าเว็บส่งมาใน header แทน
    Deno.env.get('SUPABASE_ANON_KEY') || req.headers.get('apikey') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false }, global: { headers: { Authorization: auth } } },
  );

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const branch = String(body.branch || '');
  const ym = String(body.ym || '');
  const note = String(body.note || '').slice(0, 1000);

  /* ------------------------------ เมลทดสอบ ------------------------------ */
  if (action === 'test') {
    const kind = String(body.kind || 'sign_invite') as MailKind;
    const to = String(body.testTo || '').trim().toLowerCase();
    if (!['sign_invite', 'tax_detail', 'wht_cert'].includes(kind)) return json({ error: 'ชนิดเมลไม่ถูกต้อง' }, 400);
    if (!EMAIL_RE.test(to)) return json({ error: 'อีเมลปลายทางไม่ถูกต้อง' }, 400);

    const { data: role, error: rErr } = await asUser.rpc('fee_admin_role');
    if (rErr) return json({ error: rErr.message }, 403);
    if (!['admin', 'hr', 'acct', 'it'].includes(String(role || ''))) {
      return json({ error: 'ส่งเมลทดสอบได้เฉพาะฝ่ายบุคคล ฝ่ายบัญชี หรือผู้ดูแลระบบ' }, 403);
    }

    const { data: br } = await asUser.from('branches').select('name_th').eq('code', branch).maybeSingle();
    const f = body.testFile && body.testFile.content ? body.testFile : null;
    const sample = sampleDetail(/^\d{4}-\d{2}$/.test(ym) ? ym : '2026-08');
    const mail = buildMail({
      kind, test: true, appUrl, note, detail: sample,
      name: 'นพ.ตัวอย่าง ทดสอบระบบ', licNo: '00000',
      branchTh: br?.name_th || branch || 'บางนา',
      ym: /^\d{4}-\d{2}$/.test(ym) ? ym : '2026-08',
      gross: sample.gross, tax: sample.tax, net: sample.net,
      signLink: `${appUrl}/sign/demo`,
      fileName: f ? String(f.filename) : 'ตัวอย่าง_50ทวิ.pdf',
    });
    const att = kind === 'wht_cert'
      ? [{ filename: f ? String(f.filename) : 'ตัวอย่าง_50ทวิ.pdf', content: f ? String(f.content) : SAMPLE_PDF }]
      : [];
    att.push({
      filename: 'ตัวอย่าง_รายละเอียดค่าตอบแทน.csv',
      content: b64utf8(detailCsv(sample, { name: 'นพ.ตัวอย่าง ทดสอบระบบ', licNo: '00000', branchTh: br?.name_th || branch, ym })),
    });
    const r = await sendResend(apiKey, from, to, mail.subject, mail.html, att);
    if (!r.ok) return json({ error: `ผู้ให้บริการอีเมลปฏิเสธ: ${r.error}` }, 502);
    return json({ ok: true, sent: 1, total: 1, results: [{ licNo: 'TEST', ok: true }], to });
  }

  /* ------------------------------ เมลจริง ------------------------------ */
  const lics: string[] = Array.isArray(body.licNos) ? body.licNos.map(String) : [];
  // wht_cert: { [licNo]: { filename, content(base64) } } — แนบได้คนละ 1 ไฟล์
  const files: Record<string, { filename: string; content: string }> =
    body.attachments && typeof body.attachments === 'object' ? body.attachments : {};

  if (!branch || !ym) return json({ error: 'ต้องระบุสาขาและเดือน' }, 400);
  if (!lics.length) return json({ error: 'ยังไม่ได้เลือกแพทย์' }, 400);

  const { data: ctx, error: pErr } = await asUser.rpc('fee_mail_prepare', {
    p_action: action, p_branch: branch, p_ym: ym, p_lics: lics,
  });
  if (pErr) return json({ error: pErr.message }, 403);

  const pid: string = ctx.pid;
  const branchTh: string = ctx.branchTh;
  const results: { licNo: string; ok: boolean; error?: string }[] = [];
  const log: Record<string, unknown>[] = [];

  for (const d of (ctx.rows || []) as {
    licNo: string; name: string; email: string; gross: number; tax: number; net: number; inRound: boolean;
    detail?: Detail | null;
  }[]) {
    const licNo = String(d.licNo);
    const email = String(d.email || '');

    if (!EMAIL_RE.test(email)) { results.push({ licNo, ok: false, error: 'ไม่มีอีเมลในทะเบียน' }); continue; }
    if (!d.inRound) { results.push({ licNo, ok: false, error: 'ไม่พบยอดของแพทย์ในรอบที่อนุมัติ' }); continue; }

    let signLink = '';
    let fileName = '';
    const attachments: { filename: string; content: string }[] = [];

    if (action === 'sign_invite') {
      // token สุ่ม 32 ไบต์ — เก็บเฉพาะ hash ลงฐานข้อมูล ตัวจริงอยู่ในอีเมลเท่านั้น
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const plain = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const { error: tErr } = await asUser.rpc('fee_mail_token', {
        p_pid: pid, p_lic: licNo, p_hash: hash, p_expires: expires,
      });
      if (tErr) { results.push({ licNo, ok: false, error: `สร้างลิงก์ไม่สำเร็จ: ${tErr.message}` }); continue; }
      signLink = `${appUrl}/sign/${plain}`;
    } else if (action === 'wht_cert') {
      const f = files[licNo];
      if (!f || !f.content) { results.push({ licNo, ok: false, error: 'ยังไม่ได้แนบไฟล์ 50 ทวิ ของแพทย์คนนี้' }); continue; }
      if (f.content.length > 8 * 1024 * 1024 * 1.37) { results.push({ licNo, ok: false, error: 'ไฟล์ใหญ่เกิน 8MB' }); continue; }
      fileName = String(f.filename || `50ทวิ_${licNo}_${ym}.pdf`).replace(/[\\/:*?"<>|]+/g, '_');
      attachments.push({ filename: fileName, content: f.content });
    }

    const mail = buildMail({
      kind: action as MailKind, appUrl, note, name: d.name, licNo, branchTh, ym,
      gross: d.gross, tax: d.tax, net: d.net, signLink, fileName, detail: d.detail || null,
    });
    // แนบไฟล์รายละเอียดทุกบรรทัด ให้แพทย์เปิดตรวจใน Excel ได้
    if (d.detail && Array.isArray(d.detail.days)) {
      attachments.push({
        filename: `รายละเอียดค่าตอบแทน_ว.${licNo}_${ymThai(ym).replace(' ', '')}.csv`,
        content: b64utf8(detailCsv(d.detail, { name: d.name, licNo, branchTh, ym })),
      });
    }
    const r = await sendResend(apiKey, from, email, mail.subject, mail.html, attachments);
    log.push({ licNo, toEmail: email, subject: mail.subject, ok: r.ok, providerId: r.id, error: r.error });
    results.push({ licNo, ok: r.ok, error: r.error || undefined });
  }

  // บันทึกผลลงฐาน — ถ้าบันทึกไม่ได้ เมลก็ส่งไปแล้ว จึงไม่ตีกลับทั้งคำสั่ง แค่แจ้งเตือน
  let logError: string | undefined;
  if (results.length) {
    const { error: lErr } = await asUser.rpc('fee_mail_record', { p_pid: pid, p_action: action, p_rows: log });
    if (lErr) logError = `ส่งเมลแล้ว แต่บันทึกประวัติไม่สำเร็จ: ${lErr.message}`;
  }

  const sent = results.filter((r) => r.ok).length;
  return json({ ok: true, sent, total: results.length, results, logError });
}
