/* ============================================================================
 * calc.ts — เครื่องคำนวณค่าตอบแทนแพทย์ (พอร์ตตรงจาก calcCore_ ใน Code.gs)
 *
 * เป็นฟังก์ชันบริสุทธิ์ ไม่แตะฐานข้อมูล ไม่แตะ DOM — รันได้ทั้งในเบราว์เซอร์
 * และใน node เพื่อเทียบผลกับโค้ดเดิมทีละค่า (verify/parity.mjs)
 *
 * หลักการที่ห้ามเปลี่ยน:
 *   - ข้อมูลที่ยังไม่ส่ง ≠ ศูนย์
 *   - ค่ามือในรายงานต้นทางเป็น "ยอดของรายการ" ห้ามคูณจำนวนซ้ำ
 *   - ไม่มีอัตรา = หยุดคำนวณและแจ้งปัญหา ห้ามใช้ 0 แทน
 *   - ห้ามปัดเศษรายบรรทัด ปัดจุดเดียวตอนคำนวณภาษี
 * ==========================================================================*/

import {
  cellStr, num, r2, toIsoDate, toThaiDate, toMinutes, minutesToHHMM, fmtMoney, hash,
  MAX_SHIFT_MINUTES, TAX_BASE_DEFAULT, TAX_RATE_DEFAULT,
} from './core';

/* ---------------------------- ชนิดข้อมูล ---------------------------- */

export type Severity = 'block' | 'warn';
export type IssueCode =
  | 'NO_RATE' | 'RATE_OVERLAP' | 'PROC_NO_SHIFT' | 'SHIFT_NO_PROC' | 'UNMATCHED_NAME'
  | 'TIME_INVALID' | 'TIME_TOOLONG' | 'TIME_OVERLAP' | 'SPECIAL_NOREASON' | 'NO_PAYEE'
  | 'DUP_ROWS' | 'NO_IMPORT' | 'ZERO_CONFIRM' | 'NO_DOCTOR_SIGN' | 'SIGN_STALE' | 'CLOCK_OPEN';

export const ISSUE_CODES: Record<IssueCode, { sev: Severity; msg: string }> = {
  NO_RATE:          { sev: 'block', msg: 'ไม่พบอัตราค่าตอบแทนที่มีผลในวันที่ทำงาน' },
  RATE_OVERLAP:     { sev: 'block', msg: 'มีอัตราซ้อนช่วงวันที่เดียวกันมากกว่า 1 รายการ' },
  PROC_NO_SHIFT:    { sev: 'block', msg: 'มีรายการหัตถการในวันที่ไม่มีใบเวร' },
  SHIFT_NO_PROC:    { sev: 'warn',  msg: 'มีใบเวรแต่ไม่มีรายการหัตถการในวันนั้น' },
  UNMATCHED_NAME:   { sev: 'block', msg: 'ชื่อผู้ทำหัตถการยังไม่ได้จับคู่กับทะเบียนแพทย์' },
  TIME_INVALID:     { sev: 'block', msg: 'เวลาออกก่อนเวลาเข้า หรือเวลาไม่ถูกต้อง' },
  TIME_TOOLONG:     { sev: 'block', msg: 'ระยะเวลาทำงานเกิน 16 ชั่วโมง ต้องแยกกะ' },
  TIME_OVERLAP:     { sev: 'block', msg: 'ใบเวรทับซ้อนกัน (วัน/เวลาเดียวกัน)' },
  SPECIAL_NOREASON: { sev: 'block', msg: 'ยอดพิเศษต้องระบุเหตุผลกำกับ' },
  NO_PAYEE:         { sev: 'block', msg: 'ยังไม่ระบุผู้รับเงินของแพทย์รายนี้' },
  DUP_ROWS:         { sev: 'warn',  msg: 'พบแถวข้อมูลเหมือนกันหลายแถว ต้องตรวจเอกสารยืนยัน' },
  NO_IMPORT:        { sev: 'warn',  msg: 'ยังไม่ได้นำเข้ารายงานค่าหัตถการของรอบนี้' },
  ZERO_CONFIRM:     { sev: 'warn',  msg: 'รอบนี้ยอดเป็นศูนย์ ต้องให้สาขายืนยันว่าไม่มียอดจริง' },
  NO_DOCTOR_SIGN:   { sev: 'warn',  msg: 'แพทย์ยังไม่ได้เซ็นรับรองใบเวลาประจำเดือน' },
  SIGN_STALE:       { sev: 'warn',  msg: 'ใบเวรถูกแก้หลังจากแพทย์เซ็นรับรองแล้ว ต้องให้แพทย์เซ็นใหม่' },
  CLOCK_OPEN:       { sev: 'block', msg: 'มีการลงเวลาเข้าเวรที่ยังไม่ได้กดออกเวร' },
};

export type ShiftKind = 'SHIFT' | 'SPECIAL' | 'NIGHT' | 'MEETING' | 'KOL';
export type TaxBase = 'TOTAL' | 'SHIFT' | 'NONE';
export type CoverMode = 'SHEET' | 'HOURS';

export interface ShiftRow {
  id?: string; licNo?: string; workDate?: unknown;
  timeIn?: unknown; timeOut?: unknown; breakMin?: unknown;
  specialAmt?: unknown; handOverride?: unknown; deductOther?: unknown;
  kind?: string; note?: string; source?: string; signId?: string; signedAt?: string;
}

export interface ProcRow {
  licNo?: string; empRaw?: string; billDate?: unknown; fee?: unknown; fingerprint?: string;
}

export interface ProcDayRow { licNo?: string; workDate?: unknown; amount?: unknown; rows?: unknown; }

export interface DoctorRow {
  licNo?: string; fullName?: string; nickName?: string; bank?: string; bankAcc?: string;
  idCard?: string; address?: string; contact?: string; payeeType?: string; payeeName?: string;
}

export interface RateRow {
  id?: string; licNo?: string; branch?: string; hourlyRate?: unknown;
  taxBase?: string; taxRate?: unknown; handMethod?: string; effFrom?: unknown; effTo?: unknown;
}

export interface SignRow {
  id?: string; licNo?: string; kind?: string; refId?: string; signerName?: string;
  signedAt?: string; method?: string; dataHash?: string; fileUrl?: string; by?: string; note?: string;
}

export interface AdjustRow { licNo?: string; kind?: string; amount?: unknown; reason?: string; }

export interface CalcCtx {
  branch: string;
  ym: string;
  coverMode?: CoverMode;
  procs?: ProcRow[];
  procDays?: ProcDayRow[] | null;
  unmatched?: { name: string; count: number; sum: number }[];
  dupGroups?: number;
  shifts: ShiftRow[];
  doctors: DoctorRow[];
  rates: RateRow[];
  adjusts?: AdjustRow[];
  signs?: SignRow[] | null;
  signMode?: string;
  graceEnable?: string;
  graceMin?: unknown;
  schedStart?: string;
  schedEnd?: string;
  graceEffDate?: string;
}

export interface Issue {
  id: string; code: string; severity: Severity; licNo: string; message: string; evidence: string;
}

export interface CalcDayRow {
  id?: string; date: string; dateTh?: string; error?: string;
  timeIn?: string; timeOut?: string; breakMin?: number; durMin?: number;
  hrs?: number; mins?: number; rate?: number; shiftPay?: number;
  handAuto?: number; handOverride?: number | null; handFee?: number; handRows?: number;
  deduct?: number; gross?: number; net?: number;
  special?: number | null; kind?: string; note?: string; graceNote?: string;
  source?: string; signed?: boolean; signedAt?: string;
}

export interface SignStatus {
  status: 'OK' | 'STALE' | 'NONE' | 'SKIP';
  id?: string; signedAt?: string; signerName?: string; method?: string; hash?: string;
  papers?: { id: string; signedAt: string; fileUrl: string; by: string; note: string }[];
}

export interface CalcLine {
  sign: SignStatus; signedRows: number; licNo: string;
  fullName: string; nickName: string; bank: string; bankAcc: string; idCard: string;
  address: string; contact: string; payeeType: string; payeeName: string;
  rate: number; taxBase: string; taxRate: number;
  rows: CalcDayRow[];
  orphan: { date: string; dateTh: string; amount: number; rows: number }[];
  sumHrs: number; sumMins: number;
  shiftTotal: number; coverShift: number; handTotal: number;
  gross: number; taxBaseAmt: number; taxAmt: number; deductTotal: number;
  adjAdd: number; adjDeduct: number; adjList: { kind: string; amount: number; reason: string }[];
  net: number;
  _raw: { shift: number; cover: number; hand: number; gross: number; deduct: number; net: number };
  procCount: number;
}

export interface CalcTotals {
  doctors: number; shiftTotal: number; handTotal: number; gross: number;
  tax: number; deduct: number; net: number; hrs: number; mins: number; procRows: number;
  signedDocs: number; signPending: number;
}

export interface CalcResult {
  branch: string; ym: string; coverMode: CoverMode;
  lines: CalcLine[]; totals: CalcTotals; issues: Issue[]; blockers: number;
  unmatched: { name: string; count: number; sum: number }[];
  procTotalAll: number; procRowsAll: number; dupGroups: number;
}

/* ------------------------- อัตราค่าตอบแทน -------------------------- */

export interface PickedRate {
  rate: number; taxBase: string; taxRate: number; handMethod: string; id: string; ambiguous: boolean;
}

/** ลำดับการเลือกอัตรา: แพทย์+สาขา → แพทย์ → สาขา → อัตรากลาง
 *  ไม่พบอัตราที่มีผล → คืน null (ห้ามใช้ 0 แทน) */
export function pickRate(
  rates: RateRow[], licNo: string, branch: string, isoDate: string,
): PickedRate | null {
  const cand: RateRow[] = [];
  for (let i = 0; i < rates.length; i++) {
    const r = rates[i];
    const rl = cellStr(r.licNo), rb = cellStr(r.branch);
    if (rl !== licNo && rl !== '*') continue;
    if (rb !== '' && rb !== branch) continue;
    const f = toIsoDate(r.effFrom), t = toIsoDate(r.effTo);
    if (f && isoDate < f) continue;
    if (t && isoDate > t) continue;
    cand.push(r);
  }
  if (!cand.length) return null;
  const score = (r: RateRow) =>
    (cellStr(r.licNo) === licNo ? 2 : 0) + (cellStr(r.branch) === branch ? 1 : 0);
  cand.sort((a, b) => {
    const d = score(b) - score(a);
    if (d) return d;
    const fa = toIsoDate(a.effFrom), fb = toIsoDate(b.effFrom);
    return fb < fa ? -1 : (fb > fa ? 1 : 0);
  });
  const top = cand[0];
  let tie = 0;
  for (let j = 0; j < cand.length; j++) {
    if (score(cand[j]) === score(top) && toIsoDate(cand[j].effFrom) === toIsoDate(top.effFrom)) tie++;
  }
  return {
    rate: num(top.hourlyRate),
    taxBase: cellStr(top.taxBase) || TAX_BASE_DEFAULT,
    taxRate: (top.taxRate === '' || top.taxRate === undefined) ? TAX_RATE_DEFAULT : num(top.taxRate),
    handMethod: cellStr(top.handMethod) || 'SOURCE',
    id: cellStr(top.id),
    ambiguous: tie > 1,
  };
}

/* --------------------------- ลายเซ็นแพทย์ --------------------------- */

export function shiftSpan(x: ShiftRow) {
  const ti = toMinutes(x.timeIn);
  let to = toMinutes(x.timeOut);
  if (ti === null || to === null) return null;
  if (cellStr(x.kind) === 'NIGHT' && to <= ti) to += 1440;
  return { ti, to, dur: to - ti - num(x.breakMin) };
}

/** ลายนิ้วมือของใบเวรหนึ่งบรรทัด — ค่าใดเปลี่ยนหลังเซ็น ลายเซ็นเดิมใช้ไม่ได้ */
export function shiftHash(x: ShiftRow): string {
  return hash([
    cellStr(x.licNo), toIsoDate(x.workDate),
    minutesToHHMM(toMinutes(x.timeIn)), minutesToHHMM(toMinutes(x.timeOut)),
    num(x.breakMin), cellStr(x.specialAmt) === '' ? '' : num(x.specialAmt),
    cellStr(x.kind) || 'SHIFT',
  ].join('|')).substring(0, 16);
}

/** ลายนิ้วมือของใบเวรทั้งเดือนของแพทย์คนหนึ่ง */
export function monthHash(shifts: ShiftRow[], licNo: unknown): string {
  const parts = shifts
    .filter((x) => cellStr(x.licNo) === cellStr(licNo))
    .map(shiftHash).sort();
  return hash(parts.join(',') + '|' + parts.length).substring(0, 16);
}

/** OK = ลายเซ็นตรงกับข้อมูลปัจจุบัน · STALE = ข้อมูลเปลี่ยนหลังเซ็น · NONE = ยังไม่เซ็น */
export function signStatus(signs: SignRow[] | null | undefined, licNo: string, shifts: ShiftRow[]): SignStatus {
  let latest: SignRow | null = null;
  (signs || []).forEach((g) => {
    if (cellStr(g.licNo) !== cellStr(licNo) || cellStr(g.kind) !== 'MONTH') return;
    if (!latest || cellStr(g.signedAt) > cellStr(latest.signedAt)) latest = g;
  });
  const papers = (signs || [])
    .filter((g) => cellStr(g.licNo) === cellStr(licNo) && cellStr(g.kind) === 'PAPER')
    .map((g) => ({
      id: cellStr(g.id), signedAt: cellStr(g.signedAt), fileUrl: cellStr(g.fileUrl),
      by: cellStr(g.by), note: cellStr(g.note),
    }));
  if (!latest) return { status: 'NONE', papers };
  const L = latest as SignRow;
  const cur = monthHash(shifts, licNo);
  return {
    status: cellStr(L.dataHash) === cur ? 'OK' : 'STALE',
    id: cellStr(L.id), signedAt: cellStr(L.signedAt), signerName: cellStr(L.signerName),
    method: cellStr(L.method), hash: cellStr(L.dataHash), papers,
  };
}

/* ------------------- กฎปัดเศษ สาย/ออกก่อน/OT ≤15 นาที ------------------
 * ประกาศ HRM-098/2569 ข้อ 4.4 — ใช้เฉพาะเวรปกติ (kind='SHIFT')
 * ตั้งแต่วันที่มีผลเท่านั้น เวรก่อนหน้าคิดแบบเดิม (เวลาจริงล้วน)
 *  - สาย/ออกก่อน/OT "เดี่ยว ๆ" ≤15 นาที → ไม่คิด · >15 นาที → คิดเต็มตั้งแต่นาทีแรก
 *  - สาย + OT วันเดียวกัน → หักลบตามเวลาจริง ไม่ใช้เกณฑ์ปัด
 *  - มาก่อนเวลามาตรฐานไม่ได้เครดิตเพิ่ม
 * ------------------------------------------------------------------- */
export function graceAdjust(
  ti: number, to: number, breakMin: number, kindStr: string, dateIso: string, ctx: Partial<CalcCtx>,
): { dur: number; note: string } {
  const rawDur = Math.max(0, to - ti - breakMin);
  if (kindStr !== 'SHIFT') return { dur: rawDur, note: '' };
  if (!ctx || cellStr(ctx.graceEnable).toUpperCase() !== 'Y') return { dur: rawDur, note: '' };
  if (!ctx.graceEffDate || dateIso < ctx.graceEffDate) return { dur: rawDur, note: '' };

  const schedStart = toMinutes(ctx.schedStart), schedEnd = toMinutes(ctx.schedEnd);
  if (schedStart === null || schedEnd === null || schedEnd <= schedStart) return { dur: rawDur, note: '' };
  const grace = num(ctx.graceMin);
  const stdDur = schedEnd - schedStart;

  const lateMin = Math.max(0, ti - schedStart);
  const earlyOut = Math.max(0, schedEnd - to);
  const otMin = Math.max(0, to - schedEnd);

  if (lateMin > 0 && otMin > 0) {
    return { dur: rawDur, note: 'สาย ' + lateMin + ' น. / OT ' + otMin + ' น. (หักลบตามเวลาจริง)' };
  }

  const effLate = lateMin <= grace ? 0 : lateMin;
  const effEarly = earlyOut <= grace ? 0 : earlyOut;
  const effOT = otMin <= grace ? 0 : otMin;
  const dur = Math.max(0, stdDur - effLate - effEarly + effOT - breakMin);

  const notes: string[] = [];
  if (lateMin > 0) notes.push(effLate ? ('สาย หัก ' + effLate + ' น.') : ('สาย ' + lateMin + ' น. (≤' + grace + ' น. ไม่คิด)'));
  if (earlyOut > 0) notes.push(effEarly ? ('ออกก่อน หัก ' + effEarly + ' น.') : ('ออกก่อน ' + earlyOut + ' น. (≤' + grace + ' น. ไม่คิด)'));
  if (otMin > 0) notes.push(effOT ? ('OT จ่าย ' + effOT + ' น.') : ('OT ' + otMin + ' น. (≤' + grace + ' น. ไม่คิด)'));
  return { dur, note: notes.join(' · ') };
}

/* ============================ เครื่องคำนวณ ============================ */

export function calcCore(ctx: CalcCtx): CalcResult {
  const branch = ctx.branch;
  const ym = ctx.ym;
  const coverMode: CoverMode = ctx.coverMode || 'SHEET';
  const issues: Issue[] = [];
  let iid = 0;

  function issue(code: string, licNo?: string, extra?: string, evidence?: string, sevOverride?: Severity) {
    const def = ISSUE_CODES[code as IssueCode] || { sev: 'warn' as Severity, msg: code };
    issues.push({
      id: 'IS' + (++iid), code, severity: sevOverride || def.sev, licNo: licNo || '',
      message: def.msg + (extra ? ' — ' + extra : ''), evidence: evidence || '',
    });
  }

  /* ---------- 1) ดัชนีค่ามือรายแพทย์รายวัน ----------
     รับได้ 2 แบบ: procDays (ยอดรายวันที่สรุปไว้ = ทางเร็ว) หรือ procs (แถวดิบ)
     ผลลัพธ์ต้องเท่ากันเป๊ะทั้งสองทาง */
  const handByKey: Record<string, number> = {};
  const handRows: Record<string, number> = {};
  const unmatched: Record<string, { name: string; count: number; sum: number }> = {};
  let procTotalAll = 0;
  let procRowsAll = 0;
  let dupGroups = ctx.dupGroups || 0;
  let hasImport: boolean;

  if (ctx.procDays) {
    hasImport = ctx.procDays.length > 0 || !!(ctx.unmatched && ctx.unmatched.length);
    ctx.procDays.forEach((d) => {
      const k = cellStr(d.licNo) + '|' + toIsoDate(d.workDate);
      const amt = num(d.amount);
      handByKey[k] = r2((handByKey[k] || 0) + amt);
      handRows[k] = (handRows[k] || 0) + num(d.rows);
      procTotalAll += amt;
      procRowsAll += num(d.rows);
    });
    (ctx.unmatched || []).forEach((u) => {
      unmatched[u.name] = { name: u.name, count: num(u.count), sum: num(u.sum) };
      procTotalAll += num(u.sum);
      procRowsAll += num(u.count);
    });
  } else {
    const fpCount: Record<string, number> = {};
    const procs = ctx.procs || [];
    hasImport = procs.length > 0;
    procRowsAll = procs.length;
    procs.forEach((p) => {
      const fee = num(p.fee);
      procTotalAll += fee;
      const lic = cellStr(p.licNo);
      const d = toIsoDate(p.billDate);
      if (!lic) {
        const nm2 = cellStr(p.empRaw);
        if (!unmatched[nm2]) unmatched[nm2] = { name: nm2, count: 0, sum: 0 };
        unmatched[nm2].count++;
        unmatched[nm2].sum = r2(unmatched[nm2].sum + fee);
        return;
      }
      const k = lic + '|' + d;
      handByKey[k] = r2((handByKey[k] || 0) + fee);
      handRows[k] = (handRows[k] || 0) + 1;
      const fp = cellStr(p.fingerprint);
      if (fp) fpCount[fp] = (fpCount[fp] || 0) + 1;
    });
    Object.keys(fpCount).forEach((fp) => { if (fpCount[fp] > 1) dupGroups++; });
  }

  Object.keys(unmatched).forEach((nm) => {
    issue('UNMATCHED_NAME', '', '"' + nm + '" จำนวน ' + unmatched[nm].count +
      ' รายการ รวม ' + fmtMoney(unmatched[nm].sum) + ' บาท', nm);
  });

  if (dupGroups) {
    issue('DUP_ROWS', '', 'พบ ' + dupGroups + ' กลุ่มที่ วันที่/เลขเอกสาร/แพทย์/คอร์ส/จำนวน/ค่ามือ ตรงกัน ' +
      '(อาจเป็นคนละรายการจริง ระบบไม่ลบให้อัตโนมัติ)', '');
  }
  if (!hasImport) issue('NO_IMPORT', '', '', '');

  /* ---------- 2) จัดกลุ่มใบเวรรายแพทย์ ---------- */
  const byDoc: Record<string, ShiftRow[]> = {};
  ctx.shifts.forEach((sh) => {
    const lic = cellStr(sh.licNo);
    if (!lic) return;
    if (!byDoc[lic]) byDoc[lic] = [];
    byDoc[lic].push(sh);
  });
  Object.keys(handByKey).forEach((k) => {
    const lic = k.split('|')[0];
    if (!byDoc[lic]) byDoc[lic] = [];
  });

  const docIndex: Record<string, DoctorRow> = {};
  ctx.doctors.forEach((d) => { docIndex[cellStr(d.licNo)] = d; });

  /* ---------- 3) คำนวณรายแพทย์ ---------- */
  const lines: CalcLine[] = [];
  Object.keys(byDoc).sort().forEach((lic) => {
    const d = docIndex[lic] || {};
    const shifts = byDoc[lic].slice().sort((a, b) => {
      const da = toIsoDate(a.workDate), db = toIsoDate(b.workDate);
      if (da !== db) return da < db ? -1 : 1;
      return (toMinutes(a.timeIn) || 0) - (toMinutes(b.timeIn) || 0);
    });

    const rows: CalcDayRow[] = [];
    let sumHrs = 0, sumMins = 0, shiftTotal = 0, handTotal = 0, deductTotal = 0;
    let rateUsed: number | null = null;
    let taxBase: string | null = null;
    let taxRate: number | null = null;
    const usedKeys: Record<string, boolean> = {};

    shifts.forEach((sh) => {
      const date = toIsoDate(sh.workDate);
      const pick = pickRate(ctx.rates, lic, branch, date);
      if (!pick) {
        issue('NO_RATE', lic, toThaiDate(date), date);
        rows.push({ date, error: 'ไม่มีอัตรา' });
        return;
      }
      if (pick.ambiguous) issue('RATE_OVERLAP', lic, toThaiDate(date), date);
      if (rateUsed === null) { rateUsed = pick.rate; taxBase = pick.taxBase; taxRate = pick.taxRate; }

      const ti = toMinutes(sh.timeIn);
      let to = toMinutes(sh.timeOut);
      const special = (sh.specialAmt === '' || sh.specialAmt === null || sh.specialAmt === undefined)
        ? null : num(sh.specialAmt);
      const isNight = cellStr(sh.kind) === 'NIGHT';
      const shKind = cellStr(sh.kind) || 'SHIFT';
      let dur = 0, hrs = 0, mins = 0, graceNote = '';
      if (ti !== null && to !== null) {
        if (isNight && to <= ti) to += 1440;
        if (to <= ti) issue('TIME_INVALID', lic, toThaiDate(date), date);
        const rawDurCheck = Math.max(0, to - ti - num(sh.breakMin));
        if (rawDurCheck > MAX_SHIFT_MINUTES) issue('TIME_TOOLONG', lic, toThaiDate(date), date);
        const ga = graceAdjust(ti, to, num(sh.breakMin), shKind, date, ctx);
        dur = ga.dur;
        graceNote = ga.note;
        hrs = Math.floor(dur / 60);
        mins = dur % 60;
      } else if (ti !== null && to === null && special === null) {
        issue('CLOCK_OPEN', lic, toThaiDate(date) + ' เข้า ' + minutesToHHMM(ti), date);
      }

      // ห้ามปัดเศษรายบรรทัด — ปัดจุดเดียวตอนคำนวณภาษี
      const shiftPay = special !== null ? Number(special) : ((mins * pick.rate / 60) + hrs * pick.rate);
      if (special !== null && !cellStr(sh.note)) issue('SPECIAL_NOREASON', lic, toThaiDate(date), date);

      const key = lic + '|' + date;
      const auto = handByKey[key] || 0;
      usedKeys[key] = true;
      const ov = (sh.handOverride === '' || sh.handOverride === null || sh.handOverride === undefined)
        ? null : num(sh.handOverride);
      const handFee = ov !== null ? Number(ov) : auto;
      if (auto === 0 && ov === null && cellStr(sh.kind) !== 'SPECIAL') {
        issue('SHIFT_NO_PROC', lic, toThaiDate(date), date);
      }

      const deduct = num(sh.deductOther);
      const gross = shiftPay + handFee;
      const net = gross - deduct;

      sumHrs += hrs; sumMins += mins;
      shiftTotal += shiftPay;
      handTotal += handFee;
      deductTotal += deduct;

      rows.push({
        id: cellStr(sh.id), date, dateTh: toThaiDate(date),
        timeIn: minutesToHHMM(ti), timeOut: to === null ? '' : minutesToHHMM(to % 1440),
        breakMin: num(sh.breakMin), durMin: dur, hrs, mins,
        rate: pick.rate, shiftPay: r2(shiftPay),
        handAuto: r2(auto), handOverride: ov, handFee: r2(handFee), handRows: handRows[key] || 0,
        deduct, gross: r2(gross), net: r2(net),
        special, kind: cellStr(sh.kind) || 'SHIFT', note: cellStr(sh.note),
        graceNote,
        source: cellStr(sh.source) || 'MANUAL', signed: !!cellStr(sh.signId),
        signedAt: cellStr(sh.signedAt),
      });
    });

    // ค่ามือในวันที่ไม่มีใบเวร → ต้องบล็อกก่อนอนุมัติ ไม่ให้ยอดหายเงียบ
    const orphan: CalcLine['orphan'] = [];
    Object.keys(handByKey).forEach((k) => {
      if (k.split('|')[0] !== lic) return;
      if (usedKeys[k]) return;
      const dt = k.split('|')[1];
      orphan.push({ date: dt, dateTh: toThaiDate(dt), amount: handByKey[k], rows: handRows[k] });
      issue('PROC_NO_SHIFT', lic, toThaiDate(dt) + ' ยอด ' + fmtMoney(handByKey[k]) + ' บาท', dt);
    });

    if (rateUsed === null) {
      const pk = pickRate(ctx.rates, lic, branch, ym + '-01');
      if (pk) { rateUsed = pk.rate; taxBase = pk.taxBase; taxRate = pk.taxRate; }
    }
    if (rateUsed === null) { rateUsed = 0; taxBase = TAX_BASE_DEFAULT; taxRate = TAX_RATE_DEFAULT; }

    const rateUsedN = rateUsed as number;
    const taxBaseS = taxBase as string;
    const taxRateN = taxRate as number;

    const coverShift = coverMode === 'HOURS'
      ? ((sumMins * rateUsedN / 60) + sumHrs * rateUsedN)
      : shiftTotal;
    const gross = coverShift + handTotal;
    const base = taxBaseS === 'TOTAL' ? gross : (taxBaseS === 'SHIFT' ? coverShift : 0);
    const taxAmt = taxBaseS === 'NONE' ? 0 : r2(base * taxRateN / 100);
    const net = gross - taxAmt - deductTotal;

    let adjAdd = 0, adjDed = 0;
    const adjList: CalcLine['adjList'] = [];
    (ctx.adjusts || []).forEach((a) => {
      if (cellStr(a.licNo) !== lic) return;
      const amt = num(a.amount);
      if (cellStr(a.kind) === 'DEDUCT') adjDed += amt; else adjAdd += amt;
      adjList.push({ kind: cellStr(a.kind), amount: amt, reason: cellStr(a.reason) });
    });

    if (!cellStr(d.fullName)) issue('NO_PAYEE', lic, 'รหัส ว. ' + lic + ' ยังไม่มีในทะเบียนแพทย์', lic);

    let sign: SignStatus = { status: 'SKIP' };
    if (ctx.signs && shifts.length) {
      const signMode = ('' + (ctx.signMode || 'WARN')).toUpperCase();
      sign = signStatus(ctx.signs, lic, shifts);
      if (signMode !== 'OFF') {
        const sev: Severity = signMode === 'BLOCK' ? 'block' : 'warn';
        if (sign.status === 'NONE') issue('NO_DOCTOR_SIGN', lic, cellStr(d.nickName || d.fullName || lic), lic, sev);
        if (sign.status === 'STALE') {
          issue('SIGN_STALE', lic, cellStr(d.nickName || d.fullName || lic) +
            ' (เซ็นเมื่อ ' + sign.signedAt + ')', lic, sev);
        }
      }
    }

    lines.push({
      sign,
      signedRows: rows.filter((r) => r.signed).length,
      licNo: lic,
      fullName: cellStr(d.fullName), nickName: cellStr(d.nickName),
      bank: cellStr(d.bank), bankAcc: cellStr(d.bankAcc), idCard: cellStr(d.idCard),
      address: cellStr(d.address), contact: cellStr(d.contact),
      payeeType: cellStr(d.payeeType) || 'PERSON', payeeName: cellStr(d.payeeName),
      rate: rateUsedN, taxBase: taxBaseS, taxRate: taxRateN,
      rows, orphan,
      sumHrs, sumMins,
      shiftTotal: r2(shiftTotal), coverShift: r2(coverShift), handTotal: r2(handTotal),
      gross: r2(gross), taxBaseAmt: r2(base), taxAmt, deductTotal: r2(deductTotal),
      adjAdd: r2(adjAdd), adjDeduct: r2(adjDed), adjList,
      net: r2(net + adjAdd - adjDed),
      _raw: {
        shift: shiftTotal, cover: coverShift, hand: handTotal, gross,
        deduct: deductTotal, net: net + adjAdd - adjDed,
      },
      procCount: rows.reduce((a, r) => a + (r.handRows || 0), 0),
    });
  });

  /* ---------- 4) ยอดรวมทั้งรอบ ---------- */
  const T: CalcTotals = {
    doctors: lines.length, shiftTotal: 0, handTotal: 0, gross: 0,
    tax: 0, deduct: 0, net: 0, hrs: 0, mins: 0, procRows: 0,
    signedDocs: 0, signPending: 0,
  };
  lines.forEach((L) => {
    T.shiftTotal += L._raw.cover;
    T.handTotal += L._raw.hand;
    T.gross += L._raw.gross;
    T.tax += L.taxAmt;
    T.deduct += L._raw.deduct;
    T.net += L._raw.net;
    T.hrs += L.sumHrs; T.mins += L.sumMins;
    T.procRows += L.procCount;
  });
  (['shiftTotal', 'handTotal', 'gross', 'tax', 'deduct', 'net'] as const).forEach((k) => {
    T[k] = r2(T[k]);
  });

  T.signedDocs = lines.filter((L) => L.sign && L.sign.status === 'OK').length;
  T.signPending = lines.filter((L) => L.sign && (L.sign.status === 'NONE' || L.sign.status === 'STALE')).length;

  const blockers = issues.filter((x) => x.severity === 'block');
  if (T.gross === 0 && !hasImport) issue('ZERO_CONFIRM', '', '', '');

  return {
    branch, ym, coverMode,
    lines, totals: T, issues, blockers: blockers.length,
    unmatched: Object.keys(unmatched).map((k) => unmatched[k]),
    procTotalAll: r2(procTotalAll),
    procRowsAll,
    dupGroups,
  };
}

/** ตรวจความถูกต้องของใบเวรชุดหนึ่ง — ใช้ร่วมกันทั้งกรอกมือ นำเข้าไฟล์ และลงเวลาหน้าจอ */
export function validateShifts(shifts: ShiftRow[]): string[] {
  const errs: string[] = [];
  const seen: Record<string, [number, number][]> = {};
  (shifts || []).forEach((x, idx) => {
    const lic = cellStr(x.licNo);
    const d = toIsoDate(x.workDate);
    const tag = 'แถว ' + (idx + 1) + (d ? ' (' + toThaiDate(d) + ')' : '');
    if (!lic || !d) { errs.push(tag + ': ต้องระบุแพทย์และวันที่'); return; }
    const sp = cellStr(x.specialAmt) === '' ? null : num(x.specialAmt);
    const span = shiftSpan(x);
    const ti = toMinutes(x.timeIn), to = toMinutes(x.timeOut);
    if (span === null) {
      if (ti !== null && to === null && cellStr(x.source) === 'CLOCK') {
        // ลงเวลาเข้าแล้วยังไม่ออก — เก็บได้ แต่เครื่องคำนวณจะแจ้ง CLOCK_OPEN
      } else if (sp === null) { errs.push(tag + ': ต้องระบุเวลาเข้า-ออก หรือยอดพิเศษ'); return; }
    } else {
      if (span.to <= span.ti) {
        errs.push(tag + ': เวลาออกต้องหลังเวลาเข้า (ถ้าออกหลังเที่ยงคืน ให้เลือกประเภท "เวรข้ามคืน")');
        return;
      }
      if (span.dur <= 0) { errs.push(tag + ': เวลาพักมากกว่าเวลาทำงาน'); return; }
      if (span.dur > MAX_SHIFT_MINUTES) {
        errs.push(tag + ': ทำงาน ' + (span.dur / 60).toFixed(1) + ' ชม. เกิน 16 ชม. ต้องแยกกะ');
        return;
      }
    }
    if (sp !== null && !cellStr(x.note)) { errs.push(tag + ': ยอดพิเศษต้องระบุเหตุผลในช่องหมายเหตุ'); return; }
    if (span !== null) {
      const key = lic + '|' + d;
      if (!seen[key]) seen[key] = [];
      for (let j = 0; j < seen[key].length; j++) {
        const o = seen[key][j];
        if (span.ti < o[1] && o[0] < span.to) {
          errs.push(tag + ': เวลาทับซ้อนกับเวรอื่นของแพทย์คนเดียวกัน');
          return;
        }
      }
      seen[key].push([span.ti, span.to]);
    }
  });
  return errs;
}
