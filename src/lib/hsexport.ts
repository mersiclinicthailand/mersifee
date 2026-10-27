/* ============================================================================
 * hsexport.ts — ไฟล์ "นำเข้าข้อมูลจัดการวันทำงาน-วันหยุด" ของ HumanSoft จากตารางพยาบาล
 *
 * รูปแบบเดียวกับไฟล์ต้นแบบ นำเข้าข้อมูลวันทำงาน-วันหยุด_RM_11_2026.xlsx ทุกช่อง:
 *   ชีต 00000              แถว 1-2 ชื่อฟอร์ม · แถว 3 หัวคอลัมน์ รหัส · ชื่อพนักงาน · สาขา · แผนก · ตำแหน่ง ·
 *                          วันที่ dd/MM/yyyy ทั้งรอบเงินเดือน (26 เดือนก่อน → 25 เดือนนี้)
 *   ชีต Work Shift-Holiday ตารางรหัสกะ 00 / 01 / 03 / 04
 * ทุกช่องเป็นข้อความ (@) ฟอนต์ Cordia New เหมือนต้นแบบ
 *
 * วันที่มีเวรในตารางพยาบาล = 00-วันทำงาน · วันที่ไม่มีเวร = 03-วันหยุดพนักงาน
 * (ไม่ใช้ 01 นักขัตฤกษ์ — พนักงานคลินิกไม่มี เหมือนที่ MersiRoster ส่งออก)
 * ==========================================================================*/
import type { Workbook, Worksheet } from 'exceljs';
import type { Nurse, NurseRow } from './api';
import { pad2 } from './core';

export const HS_WORK = '00-วันทำงาน';
export const HS_OFF = '03-วันหยุดพนักงาน';
const HS_SHIFTS: [string, string][] = [
  ['00', '00-วันทำงาน'],
  ['01', '01-วันหยุดนักขัตฤกษ์'],
  ['03', '03-วันหยุดพนักงาน'],
  ['04', '04-วันหยุดพิเศษ(Beta)'],
];
const TITLE = 'นำเข้าข้อมูลจัดการวันทำงาน-วันหยุด';
const FONT = 'Cordia New';
const GREY = 'FFE0E0E0';

/** รอบเงินเดือนที่จบในเดือน ym: 26 ของเดือนก่อน → 25 ของเดือนนี้ (ISO yyyy-mm-dd) */
export function hsCycleDays(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number);
  const out: string[] = [];
  const d = new Date(y, m - 2, 26);
  const end = new Date(y, m - 1, 25);
  while (d <= end) {
    out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** เดือนก่อนหน้า "2026-11" → "2026-10" */
export function prevYm(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export interface HsLine {
  licNo: string; code: string; name: string; branch: string; dept: string; position: string;
  /** ค่าต่อวันตามลำดับ hsCycleDays */
  days: string[];
  workDays: number;
}

/** แปลงตารางพยาบาลเป็นบรรทัด HumanSoft — 1 บรรทัด = พยาบาล 1 คน */
export function buildHsLines(
  ym: string, nurses: Nurse[], rows: NurseRow[], branchTh: (code: string) => string,
): { days: string[]; lines: HsLine[] } {
  const days = hsCycleDays(ym);
  const inCycle = new Set(days);
  const work = new Map<string, Set<string>>();          // เลขใบประกอบ → วันที่มีเวร
  rows.forEach((r) => {
    if (!r.licNo || !inCycle.has(r.workDate)) return;
    if (!work.has(r.licNo)) work.set(r.licNo, new Set());
    work.get(r.licNo)!.add(r.workDate);
  });
  const people = nurses
    .filter((n) => n.active || work.has(n.licNo))
    .sort((a, b) => (a.homeBranch || 'ZZ').localeCompare(b.homeBranch || 'ZZ')
      || (a.hsCode || a.licNo).localeCompare(b.hsCode || b.licNo));
  const lines = people.map((n) => {
    const mine = work.get(n.licNo) || new Set<string>();
    const nick = n.nick ? `(${n.nick})` : '';
    const name = n.fullName
      ? (n.fullName.includes('(') || !nick ? n.fullName : `${n.fullName} ${nick}`)
      : `พว.${n.nick}`;
    return {
      licNo: n.licNo,
      code: n.hsCode,
      name,
      branch: n.homeBranch ? branchTh(n.homeBranch) : '',
      dept: n.dept,
      position: n.position,
      days: days.map((d) => (mine.has(d) ? HS_WORK : HS_OFF)),
      workDays: mine.size,
    };
  });
  return { days, lines };
}

/* ------------------------------------------------------------ สร้างไฟล์ -- */

function textCell(ws: Worksheet, r: number, c: number, v: string, opt: {
  size: number; bold?: boolean; grey?: boolean; h?: 'left' | 'center'; v?: 'middle' | 'bottom';
}) {
  const cell = ws.getCell(r, c);
  cell.value = v;
  cell.numFmt = '@';
  cell.font = { name: FONT, size: opt.size, bold: !!opt.bold };
  cell.alignment = { horizontal: opt.h || 'center', vertical: opt.v || 'middle' };
  const s = { style: 'thin' as const };
  cell.border = { top: s, left: s, bottom: s, right: s };
  if (opt.grey) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
}

/** แถวชื่อฟอร์ม — ชีต 00000 มี 2 แถว (24pt + 15pt) · ชีตรหัสกะมีแถวเดียว */
function titleRows(ws: Worksheet, lastCol: number, twoRows: boolean) {
  ws.mergeCells(1, 1, 1, lastCol);
  if (twoRows) ws.mergeCells(2, 1, 2, lastCol);
  for (let c = 1; c <= lastCol; c++) {
    textCell(ws, 1, c, '', { size: 24, bold: true, grey: true });
    if (twoRows) textCell(ws, 2, c, '', { size: 15, bold: true, grey: true });
  }
  // ช่องที่ถูกรวมใช้ค่าร่วมกับช่องแรก — ใส่ชื่อฟอร์มหลังจัดรูปแบบครบ ไม่งั้นค่าว่างจะเขียนทับ
  ws.getCell(1, 1).value = TITLE;
  if (twoRows) ws.getCell(2, 1).value = TITLE;
  ws.getRow(1).height = 34.5;
  ws.getRow(2).height = 21.75;
}

async function newWorkbook(): Promise<Workbook> {
  const mod = await import('exceljs');
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mersi Clinic (MersiFee · ตารางพยาบาล)';
  wb.created = new Date();
  return wb;
}

export async function buildHsWorkbook(days: string[], lines: HsLine[]): Promise<Blob> {
  const wb = await newWorkbook();

  /* ---------- ชีต 00000 ---------- */
  const ws = wb.addWorksheet('00000');
  const head = ['รหัส', 'ชื่อพนักงาน', 'สาขา', 'แผนก', 'ตำแหน่ง', ...days.map(ddmmyyyy)];
  titleRows(ws, head.length, true);
  head.forEach((h, i) => textCell(ws, 3, i + 1, h, { size: 15, bold: true, grey: true }));
  ws.getRow(3).height = 21.75;
  lines.forEach((L, i) => {
    const r = 4 + i;
    [L.code, L.name, L.branch, L.dept, L.position, ...L.days].forEach((v, c) => {
      textCell(ws, r, c + 1, v, { size: 16, h: c === 1 ? 'left' : 'center', v: 'bottom' });
    });
    ws.getRow(r).height = 24;
  });
  ws.getColumn(1).width = 18.25;
  ws.getColumn(2).width = 40;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 34;
  for (let c = 6; c <= head.length; c++) ws.getColumn(c).width = 19;

  /* ---------- ชีต Work Shift-Holiday ---------- */
  const ws2 = wb.addWorksheet('Work Shift-Holiday');
  titleRows(ws2, 2, false);
  textCell(ws2, 2, 1, 'รหัสกะการทำงาน-วันหยุด', { size: 15, bold: true, grey: true });
  textCell(ws2, 2, 2, 'ชื่อกะการทำงาน-วันหยุด', { size: 15, bold: true, grey: true });
  HS_SHIFTS.forEach(([code, name], i) => {
    textCell(ws2, 3 + i, 1, code, { size: 16, v: 'bottom' });
    textCell(ws2, 3 + i, 2, name, { size: 16, h: 'left', v: 'bottom' });
  });
  ws2.getColumn(1).width = 18.25;
  ws2.getColumn(2).width = 30;

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** ชื่อไฟล์ตามต้นแบบ: นำเข้าข้อมูลวันทำงาน-วันหยุด_พยาบาล_11_2026.xlsx */
export const hsFileName = (ym: string) =>
  `นำเข้าข้อมูลวันทำงาน-วันหยุด_พยาบาล_${ym.slice(5, 7)}_${ym.slice(0, 4)}.xlsx`;
