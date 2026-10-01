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
 * ไฟล์ "ตารางเวร" ที่ฝ่ายบุคคลทำทุกเดือน อ่านได้ 2 แบบ เลือกให้อัตโนมัติ
 *
 * แบบที่ 1 (ดีที่สุด) — ชีต "ข้อมูลรวม": ตารางแบนที่มีเลขใบประกอบมาให้ครบ
 *   วันที่ | กลุ่มดูแล | รหัสสาขา | ชื่อสาขา | ชื่อเล่นแพทย์ | เลขใบประกอบ | สถานะ | หมายเหตุ
 *   1 แถว = 1 สาขา 1 วัน 1 คน · สถานะ "ยกเลิก" คือเวรที่ถูกยกเลิก (มักมีแถวคนลงแทนคู่กัน)
 *
 * แบบที่ 2 (ไฟล์รุ่นเก่า) — ชีตกริด:
 *   A1 = "ตารางเวร <เดือนไทย> <พ.ศ.>" · แถว 2 = กลุ่ม Area Manager · แถว 3 = หัวสาขา "BN\nบางนา"
 *   แถว 4+ = "1 พฤ" แล้วตามด้วยชื่อหมอ — ไฟล์รุ่นใหม่เขียน "หมอออย\nว.68896" จึงดึงเลข ว. ออกมาด้วย
 *   ช่องที่เขียนว่า "ไม่มีแพทย์" ไม่เก็บเป็นแถว
 * ------------------------------------------------------------------------- */

export interface RosterParsedRow {
  workDate: string; branch: string; docLabel: string;
  /** เลข ว. ที่ไฟล์ระบุมาตรง ๆ (ว่าง = ไฟล์ไม่ได้ให้มา ต้องให้ระบบจับคู่จากชื่อ) */
  licNo: string;
  amGroup: string;
  /** "ยืนยัน" หรือ "ยกเลิก" — ไฟล์รุ่นเก่าไม่มีคอลัมน์นี้ ถือเป็น "ยืนยัน" */
  status: string;
  note: string;
}
export interface RosterParsed {
  ym: string;
  cols: { code: string; label: string; am: string }[];
  days: number;
  rows: RosterParsedRow[];
  /** อ่านมาจากชีตไหน — ใช้บอกผู้ใช้ว่าได้เลข ว. มาจากไฟล์หรือต้องจับคู่ชื่อเอง */
  source: 'SUMMARY' | 'GRID';
  withLic: number;
  cancelled: number;
}

/** คำที่ไฟล์เขียนไม่ตรงกับรหัสสาขาในระบบ (v2 ใช้ RM ตาม CRM) */
const ROSTER_BRANCH_FIX: Record<string, string> = { RM2: 'RM' };

/** "ว.68896" · "68896" · 68896 → "68896" (ตัดคำนำหน้าและช่องว่างทิ้ง) */
const licDigits = (v: unknown): string => {
  const t = cellText(v).replace(/[\s ]/g, '');
  const m = t.match(/(\d{4,})/);
  return m ? m[1] : '';
};

/** ช่องที่ไม่ใช่ชื่อหมอ — "OFF", "หยุด", "ไม่มีแพทย์", "-" ฯลฯ ไม่ต้องเก็บเป็นเวร */
export const isOffCell = (v: string) =>
  /^(|off\.?|day ?off|-|–|หยุด|ปิด|ปิดสาขา|ไม่มีแพทย์|ไม่มีหมอ|ว่าง)$/i.test((v || '').replace(/\s+/g, ' ').trim());

/** ชื่อในไฟล์เขียนเป็นชื่อเล่นล้วน ("ออย") — เก็บให้อยู่ในรูปเดียวกับไฟล์กริด ("หมอออย") */
const docLabelOf = (nick: string): string => {
  const t = nick.trim();
  if (!t) return '';
  return /^(หมอ|นพ\.|พญ\.|น\.พ\.|พ\.ญ\.|ทพ\.|ทพญ\.)/.test(t) ? t : `หมอ${t}`;
};

/** หา index ของคอลัมน์จากข้อความหัวตาราง (ยอมให้สลับคอลัมน์หรือมีช่องว่างเกิน) */
function headIndex(head: unknown[], ...names: string[]): number {
  for (let c = 0; c < head.length; c++) {
    const h = cellText(head[c]).replace(/\s+/g, '');
    if (names.some((n) => h === n.replace(/\s+/g, ''))) return c;
  }
  return -1;
}

export async function parseRosterFile(file: File): Promise<RosterParsed> {
  const { XLSX, wb } = await readWorkbook(file);
  const sumName = wb.SheetNames.find((n) => /ข้อมูลรวม/.test(n));
  const gridName = wb.SheetNames.find((n) => /ตารางเวร/.test(n)) || wb.SheetNames[0];
  const aoaOf = (n: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], {
    header: 1, raw: true, defval: null, blankrows: true,
  });

  /* ---- หัวสาขา/กลุ่ม AM อ่านจากชีตกริดเสมอ (ชีตข้อมูลรวมไม่ได้เรียงสาขาไว้) ---- */
  const grid = wb.Sheets[gridName] ? aoaOf(gridName) : [];
  const gridTitle = cellText((grid[0] || [])[0]);
  let ymTitle = '';
  for (let i = 0; i < 12; i++) {
    if (gridTitle.includes(TH_MONTHS_FULL[i])) {
      const y = (gridTitle.match(/(\d{4})/) || [])[1];
      if (y) ymTitle = `${Number(y) - 543}-${pad2(i + 1)}`;
      break;
    }
  }
  const amRow = (grid[1] || []) as unknown[];
  const headRow = (grid[2] || []) as unknown[];
  const cols: { c: number; code: string; label: string; am: string }[] = [];
  let curAm = '';
  for (let c = 1; c < headRow.length; c++) {
    const h = cellText(headRow[c]);
    if (!h) continue;
    if (cellText(amRow[c])) curAm = cellText(amRow[c]);
    const raw = h.split(/[\n\r]/)[0].trim().toUpperCase();
    cols.push({ c, code: ROSTER_BRANCH_FIX[raw] || raw, label: h.replace(/[\n\r]+/g, ' ').trim(), am: curAm });
  }

  const rows: RosterParsedRow[] = [];
  const days = new Set<string>();
  let source: RosterParsed['source'] = 'GRID';
  let ym = ymTitle;

  if (sumName) {
    /* ------------------------------ ชีต "ข้อมูลรวม" ------------------------------ */
    source = 'SUMMARY';
    const aoa = aoaOf(sumName);
    const head = (aoa[0] || []) as unknown[];
    const iDate = headIndex(head, 'วันที่');
    const iAm = headIndex(head, 'กลุ่มดูแล', 'กลุ่ม');
    const iCode = headIndex(head, 'รหัสสาขา', 'สาขา');
    const iNick = headIndex(head, 'ชื่อเล่นแพทย์', 'ชื่อแพทย์', 'ชื่อเล่น');
    const iLic = headIndex(head, 'เลขใบประกอบ', 'เลข ว.', 'เลขว.', 'licNo');
    const iSt = headIndex(head, 'สถานะ');
    const iNote = headIndex(head, 'หมายเหตุ');
    if (iDate < 0 || iCode < 0 || iNick < 0) {
      throw new Error('ชีต "ข้อมูลรวม" ต้องมีคอลัมน์ วันที่ · รหัสสาขา · ชื่อเล่นแพทย์');
    }
    const ymCount = new Map<string, number>();
    for (let r = 1; r < aoa.length; r++) {
      const a = (aoa[r] || []) as unknown[];
      const iso = toIsoDate(a[iDate]);
      const code0 = cellText(a[iCode]).trim().toUpperCase();
      const nick = cellText(a[iNick]).trim();
      if (!iso || !code0 || !nick || isOffCell(nick)) continue;
      const branch = ROSTER_BRANCH_FIX[code0] || code0;
      const key = iso.substring(0, 7);
      ymCount.set(key, (ymCount.get(key) || 0) + 1);
      days.add(iso);
      rows.push({
        workDate: iso,
        branch,
        docLabel: docLabelOf(nick),
        licNo: iLic >= 0 ? licDigits(a[iLic]) : '',
        amGroup: iAm >= 0 ? cellText(a[iAm]).trim() : (cols.find((c) => c.code === branch)?.am || ''),
        status: iSt >= 0 ? (cellText(a[iSt]).trim() || 'ยืนยัน') : 'ยืนยัน',
        note: iNote >= 0 ? cellText(a[iNote]).trim() : '',
      });
    }
    if (!ym) {
      // ไม่มีหัวตารางให้อ่าน — ใช้เดือนที่พบมากที่สุดในข้อมูล
      let best = ''; let n = 0;
      ymCount.forEach((v, k) => { if (v > n) { n = v; best = k; } });
      ym = best;
    }
    if (!ym) throw new Error('อ่านเดือนจากไฟล์ไม่ได้ — ตรวจคอลัมน์ "วันที่" ในชีต "ข้อมูลรวม"');
    // กันข้อมูลเดือนอื่นหลุดเข้ามาปนในไฟล์เดียวกัน
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].workDate.substring(0, 7) !== ym) rows.splice(i, 1);
    }
  } else {
    /* -------------------------------- ชีตกริด -------------------------------- */
    if (!ym) {
      throw new Error('อ่านเดือนจากหัวตารางไม่ได้ — ช่อง A1 ต้องเป็นเช่น "ตารางเวร ตุลาคม 2569"');
    }
    if (!cols.length) throw new Error('ไม่พบหัวสาขาในแถวที่ 3 ของไฟล์');
    for (let r = 3; r < grid.length; r++) {
      const a = (grid[r] || []) as unknown[];
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
        if (isOffCell(v)) return;
        // ไฟล์รุ่นใหม่เขียนเลข ว. ไว้บรรทัดที่สองของช่อง · บางไฟล์เขียนเวลาเข้างาน เช่น "14.00-20.00"
        const parts = v.split(/[\n\r]+/).map((t) => t.trim()).filter(Boolean);
        const label = parts[0] || v;
        if (isOffCell(label)) return;
        const rest = parts.slice(1);
        const lic = rest.map((t) => (/^ว\.?\s*\d/.test(t) || /^\d{4,6}$/.test(t) ? licDigits(t) : '')).find(Boolean) || '';
        const extra = rest.filter((t) => !(/^ว\.?\s*\d/.test(t) || /^\d{4,6}$/.test(t))).join(' ');
        rows.push({
          workDate: iso, branch: col.code, docLabel: label,
          licNo: lic, amGroup: col.am, status: 'ยืนยัน', note: extra,
        });
      });
    }
  }

  if (!rows.length) {
    throw new Error('ไม่พบเวรในไฟล์ — ตรวจว่ามีชีต "ข้อมูลรวม" หรือชีตตารางเวรที่วันที่เริ่มแถว 4');
  }

  return {
    ym,
    cols: cols.map(({ code, label, am: g }) => ({ code, label, am: g })),
    days: days.size,
    rows,
    source,
    withLic: rows.filter((r) => r.licNo).length,
    cancelled: rows.filter((r) => r.status === 'ยกเลิก').length,
  };
}

/* ------------------------- ทะเบียนแพทย์ (Data หมอ Update) -------------------------
 * ไฟล์ master รายชื่อแพทย์ของ HR — หัวตาราง: การันตีหมอ · วันเกิด · เลขว. · เลขบัตรประชาชน ·
 * ชื่อ-นามสกุล · ชื่อเล่น · เบอร์ติดต่อ · ที่อยู่ · ธนาคาร · เลขบัญชี · สาขา · Mail · หมายเหตุ
 * อ่านตามชื่อหัวคอลัมน์ (สลับลำดับคอลัมน์ได้) และข้ามแถวที่ไม่ใช่แพทย์จริง
 * --------------------------------------------------------------------------------*/
export interface DoctorImportRow {
  lic_no: string; full_name: string; nick_name: string; birth_date: string | null;
  id_card: string; contact: string; address: string; bank: string; bank_acc: string;
  source_branch: string; email: string; note: string; rate_code: string; rate_hourly: number | null;
}
export interface DoctorParsed {
  fileName: string; sheet: string; total: number;
  rows: DoctorImportRow[];
  skipped: { row: number; reason: string; name: string; lic: string }[];
  dups: { lic: string; rows: number[] }[];
  warnings: { row: number; lic: string; text: string }[];
}

const clean = (v: unknown) => cellStr(v).replace(/\s+/g, ' ').trim();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

/** "22 กรกฎาคม 2537" / "22 ก.ค. 2537" / Date → YYYY-MM-DD (ค.ศ.) */
function thaiBirth(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getFullYear() > 2400 ? v.getFullYear() - 543 : v.getFullYear();
    return `${y}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  }
  const m = clean(v).match(/^(\d{1,2})\s*([^\s\d]+)\s*(\d{4})$/);
  if (!m) return null;
  let mi = TH_MONTHS_FULL.indexOf(m[2]);
  if (mi < 0) mi = TH_MONTHS.indexOf(m[2]);
  if (mi < 0) return null;
  let y = Number(m[3]); if (y > 2400) y -= 543;
  const d = Number(m[1]);
  if (d < 1 || d > 31) return null;
  return `${y}-${pad2(mi + 1)}-${pad2(d)}`;
}

/** เบอร์โทรที่ Excel เก็บเป็นตัวเลขจะหายเลข 0 นำหน้า → เติมคืน */
function phone(v: unknown): string {
  if (typeof v === 'number') {
    const s = String(Math.round(v));
    return (s.length === 9 || s.length === 8) ? '0' + s : s;
  }
  return clean(v);
}

export function parseDoctorAoa(aoa: unknown[][], fileName: string, sheet: string): DoctorParsed {
  let hi = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const r = (aoa[i] || []).map(clean);
    if (r.some((x) => /^เลข\s*ว/.test(x)) && r.some((x) => /ชื่อ.?นามสกุล|ชื่อ-สกุล/.test(x))) { hi = i; break; }
  }
  if (hi < 0) throw new Error('ไม่พบหัวตาราง — ต้องมีคอลัมน์ "เลขว." และ "ชื่อ-นามสกุล"');
  const head = (aoa[hi] || []).map(clean);
  const col = (...re: RegExp[]) => head.findIndex((h) => re.some((r) => r.test(h)));
  const C = {
    rate: col(/^การันตี/, /อัตรา/), birth: col(/^วันเกิด/), lic: col(/^เลข\s*ว/),
    idc: col(/บัตรประชาชน/), name: col(/ชื่อ.?นามสกุล/, /ชื่อ-สกุล/), nick: col(/^ชื่อเล่น/),
    tel: col(/^เบอร์/, /โทร/), addr: col(/^ที่อยู่/), bank: col(/^ธนาคาร$/), acc: col(/^เลขบัญชี/),
    br: col(/^สาขา/), mail: col(/^mail$/i, /^e-?mail/i, /อีเมล/), note: col(/^หมายเหตุ/),
  };
  const at = (r: unknown[], i: number) => (i >= 0 ? r[i] : null);

  const byLic: Record<string, { row: number; data: DoctorImportRow; filled: number }> = {};
  const dupRows: Record<string, number[]> = {};
  const skipped: DoctorParsed['skipped'] = [];
  const warnings: DoctorParsed['warnings'] = [];
  let total = 0;

  for (let k = hi + 1; k < aoa.length; k++) {
    const r = aoa[k] || [];
    const name = clean(at(r, C.name));
    let lic = clean(at(r, C.lic)).replace(/^ว\.?\s*/, '');
    if (typeof at(r, C.lic) === 'number') lic = String(Math.round(at(r, C.lic) as number));
    if (!name && !lic) continue;
    total++;
    const rowNo = k + 1;
    if (!lic) { skipped.push({ row: rowNo, reason: 'ไม่มีเลข ว.', name, lic }); continue; }
    if (!/^\d{3,6}(-\d{1,2})?$/.test(lic)) {
      skipped.push({ row: rowNo, reason: 'ไม่ใช่เลข ว. (เช่น แถวแขวน/Agency)', name, lic });
      continue;
    }
    if (!name) { skipped.push({ row: rowNo, reason: 'ไม่มีชื่อ-นามสกุล', name, lic }); continue; }

    const rate = clean(at(r, C.rate));
    const mRate = rate.match(/^(\d+)\s*\/\s*hr/i);
    let email = clean(at(r, C.mail));
    const note = clean(at(r, C.note));
    if (!EMAIL_RE.test(email) && EMAIL_RE.test(note)) email = note;   // บางแถวพิมพ์อีเมลไว้ช่องหมายเหตุ
    if (email && !EMAIL_RE.test(email)) {                            // หลายอีเมลในช่องเดียว → ใช้อันแรก
      const first = email.split(/[\s,;/]+/).find((x) => EMAIL_RE.test(x));
      if (first) {
        warnings.push({ row: rowNo, lic, text: `มีหลายอีเมลในช่องเดียว — ใช้ ${first}` });
        email = first;
      }
    }
    if (email && !EMAIL_RE.test(email)) {
      warnings.push({ row: rowNo, lic, text: `อีเมลไม่ถูกรูปแบบ "${email}" — ไม่นำเข้าช่องอีเมล` });
      email = '';
    }
    const idRaw = at(r, C.idc);
    let idCard = typeof idRaw === 'number' ? String(Math.round(idRaw)) : clean(idRaw);
    // เลขผู้เสียภาษีนิติบุคคลขึ้นต้นด้วย 0 — Excel ที่เก็บเป็นตัวเลขจะตัด 0 ทิ้งเหลือ 12 หลัก
    if (typeof idRaw === 'number' && idCard.length === 12) idCard = '0' + idCard;
    if (idCard && idCard.replace(/\D/g, '').length !== 13) {
      warnings.push({ row: rowNo, lic, text: `เลขบัตรประชาชนไม่ครบ 13 หลัก (${idCard})` });
    }
    const accRaw = at(r, C.acc);
    const acc = typeof accRaw === 'number' ? String(Math.round(accRaw)) : clean(accRaw);
    if (typeof accRaw === 'number' && acc.length < 10) {
      warnings.push({ row: rowNo, lic, text: `เลขบัญชีเก็บเป็นตัวเลขใน Excel (${acc}) — อาจหายเลข 0 นำหน้า ตรวจกับสมุดบัญชี` });
    }
    const birthRaw = at(r, C.birth);
    const data: DoctorImportRow = {
      lic_no: lic, full_name: name, nick_name: clean(at(r, C.nick)),
      birth_date: thaiBirth(birthRaw), id_card: idCard, contact: phone(at(r, C.tel)),
      address: clean(at(r, C.addr)), bank: clean(at(r, C.bank)), bank_acc: acc,
      source_branch: clean(at(r, C.br)), email, note: EMAIL_RE.test(note) ? '' : note,
      rate_code: rate, rate_hourly: mRate ? Number(mRate[1]) : null,
    };
    const filled = Object.values(data).filter((v) => v !== '' && v !== null).length;
    if (byLic[lic]) {
      (dupRows[lic] = dupRows[lic] || [byLic[lic].row]).push(rowNo);
      // เลข ว. ซ้ำ → เก็บแถวที่ข้อมูลครบกว่า (เท่ากัน = แถวล่าง)
      if (filled >= byLic[lic].filled) byLic[lic] = { row: rowNo, data, filled };
    } else {
      byLic[lic] = { row: rowNo, data, filled };
    }
  }
  const rows = Object.values(byLic).map((x) => x.data);
  if (!rows.length) throw new Error('ไม่พบแถวแพทย์ที่มีเลข ว. ในไฟล์');
  return {
    fileName, sheet, total, rows, skipped, warnings,
    dups: Object.entries(dupRows).map(([lic, rs]) => ({ lic, rows: rs })),
  };
}

export async function parseDoctorFile(file: File): Promise<DoctorParsed> {
  const { XLSX, wb } = await readWorkbook(file);
  let last: unknown = null;
  // ชีตแรกที่มีหัวตารางแพทย์ (ปกติคือ "หมอทุกสาขา")
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) as unknown[][];
    try { return parseDoctorAoa(aoa, file.name, name); } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error('อ่านไฟล์ทะเบียนแพทย์ไม่ได้');
}
