/* ============================================================================
 * parse.ts — อ่านไฟล์ Excel ในเบราว์เซอร์ (ไฟล์ต้นฉบับไม่ถูกอัปโหลดขึ้นเซิร์ฟเวอร์)
 * พอร์ตจากตัวอ่านเดิมใน Index.html ให้ได้ผลเท่าเดิมทุกกรณี
 * ==========================================================================*/
import { cellStr, toIsoDate, toMinutes, minutesToHHMM, num, hash, TH_MONTHS, ymThai, pad2, TH_MONTHS_FULL } from './core';

export interface ProcParsed {
  fileName: string; header: string;
  rows: {
    seq: number; billDate: string; hn: string; emp: string;
    course: string; qty: number; docNo: string; fee: number;
  }[];
}

export interface ShiftParsed {
  fileName: string;
  sheets: {
    licNo: string; hourlyRate: number;
    rows: {
      date: string; timeIn: string; timeOut: string;
      F: number; deductOther: number; note: string; specialAmt: number | '';
    }[];
  }[];
}

/** SheetJS ~900KB — โหลดเฉพาะตอนเข้าหน้านำเข้าข้อมูล ไม่ถ่วงหน้าแรก */
async function readWorkbook(file: File) {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  return { XLSX, wb: XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true }) };
}

const cellText = (v: unknown) => cellStr(v);

const timeOf = (v: unknown): string => {
  const m = toMinutes(v);
  return m === null ? '' : minutesToHHMM(m);
};

/** ชื่อที่ขึ้นต้นด้วยคำนำหน้าแพทย์เท่านั้นที่นับเข้ายอดแพทย์ */
export const DOCTOR_PREFIX = /^(นพ\.|พญ\.|น\.พ\.|พ\.ญ\.|ทพ\.|ทพญ\.)/;
export const isDoctorName = (s: string) => DOCTOR_PREFIX.test(('' + s).trim());
export const normName = (s: unknown) => ('' + (s ?? '')).replace(/\s+/g, ' ').trim();

/* ------------------------- รายงานค่าหัตถการ (ค่ามือ) ------------------------- */

export async function parseProcFile(file: File): Promise<ProcParsed> {
  const { XLSX, wb } = await readWorkbook(file);
  const ws0 = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws0, {
    header: 1, raw: true, defval: null, blankrows: true,
  }) as unknown[][];

  let hi = -1;
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const r = aoa[i] || [];
    for (let c = 0; c < r.length; c++) if (cellText(r[c]) === 'ลำดับ') { hi = i; break; }
    if (hi >= 0) break;
  }
  if (hi < 0) {
    throw new Error('ไม่พบหัวตาราง (ไม่เจอคอลัมน์ "ลำดับ") — อาจไม่ใช่ไฟล์รายงานค่าหัตถการ');
  }

  const head = (aoa[hi] || []).map(cellText);
  const col = (...names: string[]) => {
    for (const n of names) {
      const idx = head.indexOf(n);
      if (idx >= 0) return idx;
      for (let j = 0; j < head.length; j++) if (head[j].indexOf(n) === 0) return j;
    }
    return -1;
  };
  const C = {
    seq: col('ลำดับ'), date: col('วันที่ออกบิล', 'วันที่'), hn: col('HN'),
    emp: col('พนักงาน'), course: col('ชื่อคอร์ส'), qty: col('จำนวน'),
    doc: col('เลขที่เอกสาร'), fee: col('ค่ามือ/ค่าคอมฯ', 'ค่ามือ'),
  };
  if (C.emp < 0 || C.fee < 0 || C.date < 0) {
    throw new Error('หัวตารางไม่ครบ — ต้องมีคอลัมน์ วันที่ออกบิล / พนักงาน / ค่ามือ');
  }

  const rows: ProcParsed['rows'] = [];
  for (let k = hi + 1; k < aoa.length; k++) {
    const rr = aoa[k] || [];
    if (typeof rr[C.seq] !== 'number') continue;
    rows.push({
      seq: rr[C.seq] as number,
      billDate: cellText(rr[C.date]),
      hn: cellText(rr[C.hn]),
      emp: normName(cellText(rr[C.emp])),
      course: cellText(rr[C.course]),
      qty: Number(rr[C.qty]) || 0,
      docNo: cellText(rr[C.doc]),
      fee: Number(rr[C.fee]) || 0,
    });
  }
  if (!rows.length) throw new Error('ไม่พบรายการข้อมูลใต้หัวตาราง');

  const header = [0, 1, 2]
    .map((i) => ((aoa[i] || []).map(cellText).filter(Boolean)).join(' '))
    .join(' ');

  return { fileName: file.name, header, rows };
}

/** ตรวจว่าหัวรายงานตรงกับสาขา/เดือนที่เลือกหรือไม่ — เลือกผิดคือยอดไปผิดสาขา */
export function checkHeader(header: string, branchNameTh: string, ym: string):
{ ok: boolean; error?: string } {
  const h = ('' + header).replace(/\s+/g, ' ');
  if (branchNameTh && h.indexOf(branchNameTh) < 0) {
    return {
      ok: false,
      error: `หัวรายงานไม่พบชื่อสาขา "${branchNameTh}" — อาจเลือกสาขาผิด\nหัวรายงาน: ${h.substring(0, 160)}`,
    };
  }
  const p = ('' + ym).split('-');
  const thMon = TH_MONTHS[parseInt(p[1], 10) - 1];
  const thYear = parseInt(p[0], 10) + 543;
  if (h.indexOf(thMon) < 0 || h.indexOf('' + thYear) < 0) {
    return {
      ok: false,
      error: `หัวรายงานไม่ตรงกับเดือน ${ymThai(ym)}\nหัวรายงาน: ${h.substring(0, 160)}`,
    };
  }
  return { ok: true };
}

/** แปลงแถวที่อ่านได้เป็นรูปแบบที่ส่งเข้าฐานข้อมูล พร้อมจับคู่ชื่อกับทะเบียน */
export function toProcPayload(
  parsed: ProcParsed, aliasMap: Record<string, string>,
) {
  const rows: Record<string, unknown>[] = [];
  const unmatchedMap: Record<string, { name: string; count: number; sum: number }> = {};
  const fpCount: Record<string, number> = {};
  let rowsOther = 0;

  parsed.rows.forEach((r, k) => {
    const emp = normName(r.emp);
    if (!emp) return;
    const isDoc = isDoctorName(emp);
    if (!isDoc) { rowsOther++; return; }

    const iso = toIsoDate(r.billDate);
    const fee = num(r.fee);
    const fp = hash([iso, r.docNo, emp, r.course, num(r.qty), fee].join('|')).substring(0, 16);
    fpCount[fp] = (fpCount[fp] || 0) + 1;
    const licNo = aliasMap[emp] || '';
    if (!licNo) {
      if (!unmatchedMap[emp]) unmatchedMap[emp] = { name: emp, count: 0, sum: 0 };
      unmatchedMap[emp].count++;
      unmatchedMap[emp].sum = Math.round((unmatchedMap[emp].sum + fee) * 100) / 100;
    }
    rows.push({
      billDate: iso, hn: r.hn, empRaw: emp, licNo, course: r.course,
      qty: num(r.qty), docNo: r.docNo, fee, isDoctor: true,
      srcRow: num(r.seq) || (k + 1), fingerprint: fp,
    });
  });

  const dupGroups = Object.values(fpCount).filter((n) => n > 1).length;
  // ลายนิ้วมือไฟล์ — ใช้กันไฟล์เดียวกันหลุดไปเข้ารอบอื่น
  const fileHash = hash(
    parsed.fileName + '::' + parsed.rows.length + '::'
    + parsed.rows.map((r) => r.docNo + '|' + num(r.fee)).join(','),
  );

  return {
    rows, rowsOther, dupGroups, fileHash,
    unmatched: Object.values(unmatchedMap),
    sumDoctorFee: rows.reduce((a, r) => a + (r.fee as number), 0),
  };
}

/* ------------------------- ใบเวรจากไฟล์ Excel เดิม ------------------------- */

export async function parseShiftWorkbook(file: File): Promise<ShiftParsed> {
  const { XLSX, wb } = await readWorkbook(file);
  const sheets: ShiftParsed['sheets'] = [];

  wb.SheetNames.forEach((nm) => {
    if (!/^\d{4,7}$/.test(nm.trim())) return;          // ชื่อชีต = รหัส ว.
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[nm], {
      header: 1, raw: true, defval: null, blankrows: true,
    }) as unknown[][];
    const rate = Number((aoa[0] || [])[7]) || 0;
    const rows: ShiftParsed['sheets'][number]['rows'] = [];
    for (let r = 3; r < aoa.length; r++) {
      const a = aoa[r] || [];
      if (cellText(a[0]) === 'Total') break;
      if (a[0] === null || a[0] === undefined || cellText(a[0]) === '') continue;
      rows.push({
        date: cellText(a[0]), timeIn: timeOf(a[1]), timeOut: timeOf(a[2]),
        F: Number(a[5]) || 0, deductOther: Number(a[8]) || 0,
        note: cellText(a[10]), specialAmt: '',
      });
    }
    if (rows.length) sheets.push({ licNo: nm.trim(), hourlyRate: rate, rows });
  });

  if (!sheets.length) {
    throw new Error('ไม่พบชีตรายแพทย์ (ชื่อชีตต้องเป็นรหัส ว. ที่เป็นตัวเลข)');
  }

  // บรรทัดที่ยอดในไฟล์ไม่ตรงกับ ชม.×อัตรา = ยอดพิเศษที่เคยพิมพ์ทับ (เช่น เทรน KOL)
  sheets.forEach((s) => {
    s.rows.forEach((r) => {
      const ti = toMinutes(r.timeIn), to = toMinutes(r.timeOut);
      const calc = (ti !== null && to !== null && to > ti) ? (to - ti) * s.hourlyRate / 60 : 0;
      r.specialAmt = (Math.abs(calc - r.F) > 0.02 && r.F > 0) ? r.F : '';
    });
  });

  return { fileName: file.name, sheets };
}

/** แปลงใบเวรที่อ่านจากไฟล์เป็นแถวที่ส่งเข้าฐานข้อมูล */
export function toShiftPayload(parsed: ShiftParsed) {
  const out: Record<string, unknown>[] = [];
  parsed.sheets.forEach((s) => {
    s.rows.forEach((r) => {
      const d = toIsoDate(r.date);
      if (!d) return;
      out.push({
        licNo: s.licNo, workDate: d, timeIn: r.timeIn, timeOut: r.timeOut,
        breakMin: 0,
        specialAmt: r.specialAmt === '' ? '' : String(r.specialAmt),
        handOverride: '',
        deductOther: r.deductOther,
        kind: r.specialAmt === '' ? 'SHIFT' : 'SPECIAL',
        note: r.note || (r.specialAmt === '' ? '' : 'ยอดพิเศษจากไฟล์เดิม'),
        source: 'IMPORT',
      });
    });
  });
  return out;
}

/* --------------------------- ตารางแพทย์ (ตารางเวร) ---------------------------
 * โครงไฟล์ "ตารางเวร-YYYY-MM.xlsx" ที่ฝ่ายบุคคลทำทุกเดือน:
 *   A1        = "ตารางเวร <เดือนไทย> <พ.ศ.>"
 *   แถว 2     = กลุ่ม Area Manager (ผสานเซลล์ — ค่าอยู่ที่คอลัมน์แรกของกลุ่ม)
 *   แถว 3     = หัวสาขา "BN\nบางนา"
 *   แถว 4+    = "1 พฤ" แล้วตามด้วยชื่อหมอของแต่ละสาขา
 * ช่องที่เขียนว่า "ไม่มีแพทย์" ไม่เก็บเป็นแถว
 * ------------------------------------------------------------------------- */

export interface RosterParsed {
  ym: string;
  cols: { code: string; label: string; am: string }[];
  days: number;
  rows: { workDate: string; branch: string; docLabel: string; amGroup: string }[];
}

/** คำที่ไฟล์เขียนไม่ตรงกับรหัสสาขาในระบบ (v2 ใช้ RM ตาม CRM) */
const ROSTER_BRANCH_FIX: Record<string, string> = { RM2: 'RM' };

export async function parseRosterFile(file: File): Promise<RosterParsed> {
  const { XLSX, wb } = await readWorkbook(file);
  const name = wb.SheetNames.find((n) => /ตารางเวร/.test(n)) || wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
    header: 1, raw: true, defval: null, blankrows: true,
  });

  const title = cellText((aoa[0] || [])[0]);
  let ym = '';
  for (let i = 0; i < 12; i++) {
    if (title.includes(TH_MONTHS_FULL[i])) {
      const y = (title.match(/(\d{4})/) || [])[1];
      if (y) ym = `${Number(y) - 543}-${pad2(i + 1)}`;
      break;
    }
  }
  if (!ym) {
    throw new Error('อ่านเดือนจากหัวตารางไม่ได้ — ช่อง A1 ต้องเป็นเช่น "ตารางเวร ตุลาคม 2569"');
  }

  const am = (aoa[1] || []) as unknown[];
  const head = (aoa[2] || []) as unknown[];
  const cols: { c: number; code: string; label: string; am: string }[] = [];
  let curAm = '';
  for (let c = 1; c < head.length; c++) {
    const h = cellText(head[c]);
    if (!h) continue;
    if (cellText(am[c])) curAm = cellText(am[c]);
    const raw = h.split(/[\n\r]/)[0].trim().toUpperCase();
    cols.push({ c, code: ROSTER_BRANCH_FIX[raw] || raw, label: h.replace(/[\n\r]+/g, ' ').trim(), am: curAm });
  }
  if (!cols.length) throw new Error('ไม่พบหัวสาขาในแถวที่ 3 ของไฟล์');

  const rows: RosterParsed['rows'] = [];
  const days = new Set<string>();
  for (let r = 3; r < aoa.length; r++) {
    const a = (aoa[r] || []) as unknown[];
    const dtxt = cellText(a[0]);
    if (!dtxt) continue;
    const m = dtxt.match(/\d+/);
    if (!m) continue;
    const d = Number(m[0]);
    if (!d || d > 31) continue;
    const iso = `${ym}-${pad2(d)}`;
    days.add(iso);
    cols.forEach((col) => {
      const v = cellText(a[col.c]);
      if (!v || v === 'ไม่มีแพทย์' || v === '-') return;
      rows.push({ workDate: iso, branch: col.code, docLabel: v, amGroup: col.am });
    });
  }
  if (!rows.length) throw new Error('ไม่พบเวรในไฟล์ — ตรวจว่าวันที่เริ่มที่แถว 4 และมีชื่อแพทย์ในตาราง');

  return { ym, cols: cols.map(({ code, label, am: g }) => ({ code, label, am: g })), days: days.size, rows };
}
