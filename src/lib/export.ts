/* ============================================================================
 * export.ts — สร้างไฟล์ Excel ตามฟอร์มเดิม (08.ส.ค.-BN.xlsx)
 *
 * พอร์ตจาก buildCoverSheet_ / buildDoctorSheet_ ใน Code.gs แบบเซลล์ต่อเซลล์
 * ต่างกันแค่สร้างในเบราว์เซอร์ด้วย ExcelJS แทนที่จะสร้าง Google Sheet ชั่วคราว
 * ผลที่ได้: ไม่ติดเพดาน 6 นาทีของ Apps Script อีกต่อไป ส่งออก 14 สาขารวดเดียวได้
 *
 * กฎที่ห้ามพลาด:
 *   · ทุกคอลัมน์เป็นสูตรจริง แก้เวลาในไฟล์แล้วยอดคำนวณต่อได้ทั้งไฟล์
 *   · ใบปะหน้าอ้างแถว Total ของชีตแพทย์ที่คำนวณจากจำนวนเวรจริง ไม่ใช่แถว 15 ตายตัว
 *   · ยอดพิเศษใส่เป็นค่าคงที่ ไม่ทับด้วยสูตร ชม.×อัตรา
 *   · ค่ามือที่ไม่มีใบเวรต้องโผล่เป็นบรรทัดเตือน ไม่หายเงียบ
 * ==========================================================================*/
import type { Workbook, Worksheet, Cell } from 'exceljs';
import type { CalcResult, CalcLine } from './calc';
import { TH_MONTHS, ymThai, toMinutes, fmtMoney, num, pad2 } from './core';

const FONT = 'Angsana New';
const FMT_MONEY = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';
const FMT_TIME = 'h:mm "น."';
const FMT_INT = '0';
const FMT_LIC = '00000';
const CLR_HEAD = 'FF8B9677';
const CLR_HEAD_T = 'FFFFFFFF';
const CLR_TOTAL = 'FFF5F2E9';
const CLR_WARN = 'FFFDF2E3';
const BORDER_CLR = 'FF6E7A58';

export const APP_STAMP = 'Mersi Clinic (MersiFee v2.0 · Supabase + Cloudflare)';

/** ชื่อไฟล์ตามแบบเดิม: 08.ส.ค.-BN.xlsx */
export function buildFileName(fileCode: string, ym: string, ext = 'xlsx') {
  const p = ('' + ym).split('-');
  return pad2(p[1]) + '.' + TH_MONTHS[parseInt(p[1], 10) - 1] + '-' + fileCode + '.' + ext;
}

/** จำนวนบรรทัดข้อมูลในชีตแพทย์ (อย่างน้อย 11 บรรทัดเหมือนต้นฉบับ) */
export function docDataRows(L: CalcLine) {
  const n = L.rows.filter((r) => !r.error).length + (L.orphan || []).length;
  return Math.max(n, 11);
}
export const docTotalRow = (L: CalcLine) => 4 + docDataRows(L);

const hhmmToFrac = (hhmm: string) => {
  const m = toMinutes(hhmm);
  return m === null ? '' : m / 1440;
};

function styleRange(
  ws: Worksheet, r1: number, c1: number, r2: number, c2: number, fn: (c: Cell) => void,
) {
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) fn(ws.getCell(r, c));
}

const fill = (c: Cell, argb: string) => {
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
};

function box(ws: Worksheet, r1: number, c1: number, r2: number, c2: number) {
  const s = { style: 'thin' as const, color: { argb: BORDER_CLR } };
  styleRange(ws, r1, c1, r2, c2, (c) => {
    c.border = { top: s, left: s, bottom: s, right: s };
  });
}

/* ------------------------------ ใบปะหน้า ------------------------------ */

function buildCoverSheet(
  ws: Worksheet, res: CalcResult, br: { code: string; nameEn: string }, ym: string,
) {
  const L = res.lines;
  const n = L.length;
  const R0 = 5;              // แถวข้อมูลแถวแรก
  const RT = R0 + n;         // แถวรวม
  const lastCol = 19;        // A..S

  ws.views = [{ state: 'frozen', ySplit: 4 }];

  ws.mergeCells(1, 1, 1, 16);
  const t1 = ws.getCell(1, 1);
  t1.value = 'รายงานเงินเดือนแพทย์  Mersi Clinic ' + (br.nameEn || br.code);
  t1.font = { name: FONT, size: 20, bold: true };
  t1.alignment = { horizontal: 'center' };

  ws.mergeCells(2, 1, 2, 16);
  const t2 = ws.getCell(2, 1);
  t2.value = 'ประจำเดือน ' + ymThai(ym);
  t2.font = { name: FONT, size: 16, bold: true };
  t2.alignment = { horizontal: 'center' };

  const H = ['ลำดับ', 'รหัส ว.', 'ชื่อ - สกุล', 'ชื่อเล่น', 'ธนาคาร', 'เลขบัญชี',
    'ค่าตอบแทน(ชม.)', 'ชม. ทำงาน', '', 'รวมค่าเวร\n40(2)', 'ค่ามือ\n40(6)',
    'รวมเงินได้', 'หัก ' + (L[0] ? L[0].taxRate : 3) + '%', 'หักอื่น ๆ\n(ถ้ามี)',
    'เงินได้หลังหักภาษี', 'บัตรประชาชน', 'ที่อยู่', 'เบอร์ติดต่อ/e-mail', 'หมายเหตุ'];
  H.forEach((v, i) => { ws.getCell(3, i + 1).value = v; });
  ws.getCell(4, 8).value = 'ชม.';
  ws.getCell(4, 9).value = 'นาที';

  [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    .forEach((c) => ws.mergeCells(3, c, 4, c));
  ws.mergeCells(3, 8, 3, 9);

  styleRange(ws, 3, 1, 4, lastCol, (c) => {
    c.font = { name: FONT, size: 16, bold: true, color: { argb: CLR_HEAD_T } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    fill(c, CLR_HEAD);
  });

  for (let i = 0; i < n; i++) {
    const r = R0 + i;
    const d = L[i];
    const q = "'" + d.licNo + "'";
    const TR = docTotalRow(d);                     // แถว Total ของชีตแพทย์คนนี้

    ws.getCell(r, 1).value = i + 1;
    const lic = ws.getCell(r, 2);
    lic.value = isNaN(Number(d.licNo)) ? d.licNo : Number(d.licNo);
    lic.numFmt = FMT_LIC;
    ws.getCell(r, 3).value = d.payeeType === 'COMPANY' && d.payeeName ? d.payeeName : d.fullName;
    ws.getCell(r, 4).value = d.nickName;
    ws.getCell(r, 5).value = d.bank;
    ws.getCell(r, 6).value = d.bankAcc;            // เก็บเป็นข้อความ กันเลข 0 นำหน้าหาย
    ws.getCell(r, 6).numFmt = '@';
    ws.getCell(r, 7).value = d.rate;
    ws.getCell(r, 7).numFmt = FMT_MONEY;
    ws.getCell(r, 8).value = { formula: `${q}!D${TR}` };
    ws.getCell(r, 8).numFmt = '0.00';
    ws.getCell(r, 9).value = { formula: `${q}!E${TR}` };
    ws.getCell(r, 9).numFmt = '0.00';

    // J รวมค่าเวร
    ws.getCell(r, 10).value = res.coverMode === 'HOURS'
      ? { formula: `(I${r}*(G${r}/60))+(H${r}*G${r})` }
      : { formula: `${q}!F${TR}` };
    ws.getCell(r, 11).value = { formula: `${q}!G${TR}` };        // K ค่ามือ
    ws.getCell(r, 12).value = { formula: `J${r}+K${r}` };        // L รวมเงินได้

    // M ภาษี — ฐานตามที่ตั้งไว้รายแพทย์
    const tb = d.taxBase, tr = d.taxRate;
    ws.getCell(r, 13).value = tb === 'NONE' ? 0
      : tb === 'SHIFT' ? { formula: `ROUND(J${r}*${tr}/100,2)` }
        : { formula: `ROUND(L${r}*${tr}/100,2)` };

    ws.getCell(r, 14).value = { formula: `${q}!I${TR}` };                // N หักอื่น ๆ
    ws.getCell(r, 15).value = { formula: `L${r}-M${r}-N${r}` };          // O สุทธิ (ต้นฉบับลืมลบ N)
    ws.getCell(r, 16).value = d.idCard;
    ws.getCell(r, 16).numFmt = '@';
    ws.getCell(r, 17).value = d.address;
    ws.getCell(r, 18).value = d.contact;

    const notes: string[] = [];
    if (d.taxBase === 'SHIFT') notes.push('ฐานภาษี: เฉพาะค่าเวร');
    if (d.taxBase === 'NONE') notes.push('ไม่หักภาษี ณ ที่จ่าย');
    if (d.payeeType === 'COMPANY') notes.push('จ่ายผ่านนิติบุคคล');
    if (d.adjAdd) notes.push('ปรับปรุงเพิ่ม ' + fmtMoney(d.adjAdd));
    if (d.adjDeduct) notes.push('ปรับปรุงหัก ' + fmtMoney(d.adjDeduct));
    if (d.sign?.status === 'OK') notes.push('แพทย์เซ็นรับรองใบเวลาแล้ว ' + (d.sign.signedAt || '').substring(0, 10));
    else if (d.sign?.status === 'STALE') notes.push('⚠️ ใบเวรแก้หลังแพทย์เซ็น');
    else if (d.sign?.status === 'NONE') notes.push('ยังไม่มีลายเซ็นแพทย์');
    ws.getCell(r, 19).value = notes.join(' · ');

    styleRange(ws, r, 10, r, 15, (c) => { c.numFmt = FMT_MONEY; });
    styleRange(ws, r, 1, r, 2, (c) => { c.alignment = { horizontal: 'center', vertical: 'middle' }; });
    styleRange(ws, r, 1, r, lastCol, (c) => {
      c.font = { name: FONT, size: 16 };
      c.alignment = { ...(c.alignment || {}), vertical: 'middle' };
    });
  }

  // แถวรวม
  ws.mergeCells(RT, 1, RT, 3);
  ws.getCell(RT, 1).value = 'รวมหมอทั้งหมด';
  ws.getCell(RT, 4).value = { formula: `COUNT(B${R0}:B${RT - 1})` };
  ws.getCell(RT, 4).alignment = { horizontal: 'center' };
  ws.getCell(RT, 5).value = 'คน';
  ['J', 'K', 'L', 'M', 'N', 'O'].forEach((c, idx) => {
    const cell = ws.getCell(RT, 10 + idx);
    cell.value = { formula: `SUM(${c}${R0}:${c}${RT - 1})` };
    cell.numFmt = FMT_MONEY;
  });
  styleRange(ws, RT, 1, RT, lastCol, (c) => {
    c.font = { name: FONT, size: 16, bold: true };
    fill(c, CLR_TOTAL);
  });

  box(ws, 3, 1, RT, lastCol);

  // ช่องลงนาม 4 ช่อง (เหมือนต้นฉบับ)
  const sg = RT + 4;
  ([[3, 'จัดทำโดย'], [7, 'เจ้าหน้าที่บัญชี'], [12, 'เจ้าหน้าที่การเงิน'], [17, 'ผู้จัดการฝ่ายบัญชี']] as [number, string][])
    .forEach(([col, label]) => {
      const a = ws.getCell(sg, col);
      a.value = '.................................................';
      a.alignment = { horizontal: 'center' };
      a.font = { name: FONT, size: 16 };
      const b = ws.getCell(sg + 1, col);
      b.value = label;
      b.alignment = { horizontal: 'center' };
      b.font = { name: FONT, size: 16 };
    });

  // บรรทัดที่มาของข้อมูล — ตรวจย้อนกลับได้
  const meta = sg + 3;
  const m1 = ws.getCell(meta, 1);
  m1.value = 'ออกโดยระบบค่าตอบแทนแพทย์ ' + APP_STAMP + ' · ' + new Date().toISOString().slice(0, 19)
    + ' · วิธีคิดค่าเวรใบปะหน้า: '
    + (res.coverMode === 'HOURS' ? 'ชม.×อัตรา (สูตรต้นฉบับ)' : 'ผูกกับแถว Total ของชีตแพทย์')
    + ' · รายการหัตถการที่นำมาคิด ' + res.totals.procRows + ' แถว';
  m1.font = { name: FONT, size: 12, color: { argb: 'FF6E7A58' } };

  if (res.blockers > 0) {
    const w = ws.getCell(meta + 1, 1);
    w.value = '⚠️ รอบนี้ยังมีปัญหาค้างที่ยังไม่แก้ — ไฟล์นี้ใช้ตรวจสอบเท่านั้น ยังไม่ใช่ยอดที่อนุมัติ';
    w.font = { name: FONT, size: 12, bold: true, color: { argb: 'FFB3261E' } };
    fill(w, CLR_WARN);
  }

  const W = [60, 75, 200, 70, 70, 120, 120, 75, 75, 100, 110, 100, 90, 90, 135, 140, 380, 200, 180];
  W.forEach((w, i) => { ws.getColumn(i + 1).width = w / 7; });
  for (let r = 1; r <= RT + 8; r++) ws.getRow(r).height = 22;
}

/* ---------------------------- ชีตรายแพทย์ ---------------------------- */

function buildDoctorSheet(ws: Worksheet, L: CalcLine) {
  const rows = L.rows.filter((r) => !r.error);
  const orph = L.orphan || [];
  const nData = docDataRows(L);
  const R0 = 4;
  const RT = docTotalRow(L);   // แถว Total — ต้องตรงกับที่ใบปะหน้าอ้างอิง
  const RX = RT + 1;           // แถวภาษี
  const RN = RT + 2;           // แถวจ่ายสุทธิ

  ws.views = [{ state: 'frozen', ySplit: 3 }];

  const lic = ws.getCell(1, 1);
  lic.value = isNaN(Number(L.licNo)) ? L.licNo : Number(L.licNo);
  lic.numFmt = FMT_LIC;
  lic.font = { name: FONT, size: 16, bold: true };
  lic.alignment = { horizontal: 'center' };

  ws.mergeCells(1, 2, 1, 7);
  const nm = ws.getCell(1, 2);
  nm.value = L.payeeType === 'COMPANY' && L.payeeName ? L.payeeName : L.fullName;
  nm.font = { name: FONT, size: 16, bold: true };

  ws.mergeCells(1, 8, 1, 10);
  const rt = ws.getCell(1, 8);
  rt.value = L.rate;
  rt.numFmt = FMT_MONEY;
  rt.font = { name: FONT, size: 18, bold: true };
  rt.alignment = { horizontal: 'center' };

  // หัวตาราง (แถว 2–3) เหมือนต้นฉบับ
  const twoRow: [number, string][] = [[1, 'วันที่ '], [2, 'เข้า'], [3, 'ออก'], [9, 'หักอื่นๆ'],
    [10, 'รวมเงินได้'], [11, 'หมายเหตุ']];
  twoRow.forEach(([c, v]) => { ws.mergeCells(2, c, 3, c); ws.getCell(2, c).value = v; });
  ws.mergeCells(2, 4, 2, 5); ws.getCell(2, 4).value = 'นับเวลาการทำงาน';
  ws.mergeCells(2, 6, 2, 8); ws.getCell(2, 6).value = 'รวมเงินได้';
  ws.getCell(3, 4).value = 'ชม.';
  ws.getCell(3, 5).value = 'นาที ';
  ws.getCell(3, 6).value = 'รวมเงิน';
  ws.getCell(3, 7).value = 'ค่ามือ/วัน';
  ws.getCell(3, 8).value = 'บาท';
  styleRange(ws, 2, 1, 3, 11, (c) => {
    c.font = { name: FONT, size: 16, bold: true, color: { argb: CLR_HEAD_T } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    fill(c, CLR_HEAD);
  });

  type Item = { t: 'S'; r: (typeof rows)[number] } | { t: 'O'; o: (typeof orph)[number] };
  const all: Item[] = [
    ...rows.map((r) => ({ t: 'S' as const, r })),
    ...orph.map((o) => ({ t: 'O' as const, o })),
  ];

  for (let i = 0; i < nData; i++) {
    const r = R0 + i;
    const item = all[i];
    const brk = item && item.t === 'S' ? num(item.r.breakMin) : 0;
    const span = brk ? `(C${r}-B${r}-${brk}/1440)` : `(C${r}-B${r})`;

    ws.getCell(r, 4).value = { formula: `HOUR${span}` };
    ws.getCell(r, 4).numFmt = FMT_INT;
    ws.getCell(r, 5).value = { formula: `MINUTE${span}` };
    ws.getCell(r, 5).numFmt = FMT_INT;
    ws.getCell(r, 8).value = { formula: `+F${r}+G${r}` };
    ws.getCell(r, 8).numFmt = FMT_MONEY;
    ws.getCell(r, 10).value = { formula: `+H${r}-I${r}` };
    ws.getCell(r, 10).numFmt = FMT_MONEY;
    ws.getCell(r, 6).numFmt = FMT_MONEY;
    ws.getCell(r, 7).numFmt = FMT_MONEY;
    ws.getCell(r, 9).numFmt = FMT_MONEY;
    styleRange(ws, r, 2, r, 3, (c) => {
      c.numFmt = FMT_TIME;
      c.alignment = { horizontal: 'center' };
    });
    ws.getCell(r, 1).alignment = { horizontal: 'center' };
    styleRange(ws, r, 4, r, 5, (c) => { c.alignment = { horizontal: 'center' }; });
    styleRange(ws, r, 1, r, 11, (c) => { if (!c.font) c.font = { name: FONT, size: 16 }; });

    if (!item) {
      // แถวว่างสำรอง — คงสูตรไว้ให้เติมมือได้เหมือนต้นฉบับ
      ws.getCell(r, 6).value = { formula: `(E${r}*$H$1/60)+D${r}*$H$1` };
      continue;
    }

    if (item.t === 'S') {
      const d = item.r;
      ws.getCell(r, 1).value = d.dateTh || '';
      if (d.timeIn) ws.getCell(r, 2).value = hhmmToFrac(d.timeIn);
      // เวรข้ามคืน: เวลาออกบวก 1 วัน เพื่อให้ HOUR/MINUTE ยังถูก (รูปแบบ h:mm แสดงเฉพาะเวลา)
      if (d.timeOut) {
        const plus = d.kind === 'NIGHT'
          && (toMinutes(d.timeOut) ?? 0) <= (toMinutes(d.timeIn || '') ?? 0) ? 1 : 0;
        ws.getCell(r, 3).value = (hhmmToFrac(d.timeOut) as number) + plus;
      }
      if (d.special !== null && d.special !== undefined) {
        ws.getCell(r, 6).value = d.special;     // ยอดพิเศษเป็นค่าคงที่ ไม่ทับด้วยสูตร
        fill(ws.getCell(r, 6), CLR_WARN);
      } else {
        ws.getCell(r, 6).value = { formula: `(E${r}*$H$1/60)+D${r}*$H$1` };
      }
      if (d.handOverride !== null && d.handOverride !== undefined) {
        ws.getCell(r, 7).value = d.handOverride;
        fill(ws.getCell(r, 7), CLR_WARN);
      } else if (d.handFee) {
        ws.getCell(r, 7).value = d.handFee;
      }
      if (d.deduct) ws.getCell(r, 9).value = d.deduct;

      const nt: string[] = [];
      if (d.kind === 'NIGHT') nt.push('เวรข้ามคืน');
      if (d.kind === 'MEETING') nt.push('ประชุมประจำเดือน');
      if (d.kind === 'KOL') nt.push('ค่าตอบแทน KOL');
      if (d.graceNote) nt.push(d.graceNote);
      if (d.note) nt.push(d.note);
      if (d.handRows) nt.push(d.handRows + ' รายการ');
      if (d.handOverride !== null && d.handOverride !== undefined) {
        nt.push('แก้ค่ามือจากต้นทาง ' + fmtMoney(d.handAuto));
      }
      if (d.signed) nt.push('✓ แพทย์เซ็นตอนออกเวร');
      else if (d.source === 'CLOCK') nt.push('ลงเวลาหน้าจอ');
      ws.getCell(r, 11).value = nt.join(' · ');
    } else {
      const o = item.o;
      ws.getCell(r, 1).value = o.dateTh;
      fill(ws.getCell(r, 1), CLR_WARN);
      ws.getCell(r, 6).value = { formula: `(E${r}*$H$1/60)+D${r}*$H$1` };
      ws.getCell(r, 7).value = o.amount;
      fill(ws.getCell(r, 7), CLR_WARN);
      ws.getCell(r, 11).value = '⚠️ มีค่ามือแต่ยังไม่มีใบเวร — ต้องเติมเวลาเข้า-ออก';
      fill(ws.getCell(r, 11), CLR_WARN);
    }
  }

  // Total
  ws.mergeCells(RT, 1, RT, 3);
  ws.getCell(RT, 1).value = 'Total';
  ['D', 'E', 'F', 'G', 'H', 'I', 'J'].forEach((c, idx) => {
    const cell = ws.getCell(RT, 4 + idx);
    cell.value = { formula: `SUM(${c}${R0}:${c}${RT - 1})` };
    cell.numFmt = idx < 2 ? FMT_INT : FMT_MONEY;
  });
  styleRange(ws, RT, 1, RT, 11, (c) => {
    c.font = { name: FONT, size: 16, bold: true };
    fill(c, CLR_TOTAL);
  });

  // ภาษี — ป้ายบอกฐานให้ชัดเสมอ
  const tb = L.taxBase, tr = L.taxRate;
  ws.mergeCells(RX, 1, RX, 9);
  ws.getCell(RX, 1).value = tb === 'NONE' ? 'ไม่หักภาษี ณ ที่จ่าย'
    : 'หักภาษี ณ ที่จ่าย ' + tr + '%' + (tb === 'SHIFT' ? ' (ฐาน: เฉพาะค่าเวร)' : ' (ฐาน: รวมเงินได้)');
  ws.getCell(RX, 10).value = tb === 'NONE' ? 0
    : tb === 'SHIFT' ? { formula: `ROUND(F${RT}*${tr}/100,2)` }
      : { formula: `ROUND(H${RT}*${tr}/100,2)` };
  ws.getCell(RX, 10).numFmt = FMT_MONEY;

  ws.mergeCells(RN, 1, RN, 9);
  ws.getCell(RN, 1).value = 'จ่ายสุทธิ';
  ws.getCell(RN, 10).value = { formula: `+J${RT}-J${RX}` };
  ws.getCell(RN, 10).numFmt = FMT_MONEY;
  styleRange(ws, RX, 1, RN, 10, (c) => {
    c.font = { name: FONT, size: 16, bold: true };
    fill(c, CLR_TOTAL);
  });

  box(ws, 2, 1, RN, 11);
  buildSignBlock(ws, L, RN + 2);

  const W = [130, 90, 90, 70, 80, 110, 110, 110, 95, 110, 300];
  W.forEach((w, i) => { ws.getColumn(i + 1).width = w / 7; });
  for (let r = 1; r <= RN + 10; r++) ws.getRow(r).height = 20;
}

/** ช่องลายเซ็นแพทย์ท้ายชีต — ถ้ายังไม่เซ็นหรือข้อมูลเปลี่ยนหลังเซ็น จะเป็นช่องว่าง
 *  พร้อมคำเตือน ไม่แกล้งทำเป็นเซ็นแล้ว */
function buildSignBlock(ws: Worksheet, L: CalcLine, r0: number) {
  const sg = L.sign || { status: 'SKIP' as const };
  ws.mergeCells(r0, 1, r0, 3);
  ws.getCell(r0, 1).value = 'ลายเซ็นแพทย์รับรองใบเวลา';
  ws.getCell(r0, 1).font = { name: FONT, size: 16, bold: true };
  ws.mergeCells(r0, 7, r0, 9);
  ws.getCell(r0, 7).value = 'ผู้ตรวจสอบ (สาขา/บัญชี)';
  ws.getCell(r0, 7).font = { name: FONT, size: 16, bold: true };

  const png = (sg as { png?: string }).png;
  if (sg.status === 'OK' && png) {
    try {
      const wb = ws.workbook as Workbook;
      const imgId = wb.addImage({ base64: png, extension: 'png' });
      ws.addImage(imgId, { tl: { col: 0.2, row: r0 }, ext: { width: 220, height: 84 } });
      for (let i = 1; i <= 3; i++) ws.getRow(r0 + i).height = 24;
    } catch { /* ใส่รูปไม่ได้ก็ยังออกไฟล์ได้ */ }
    ws.mergeCells(r0 + 4, 1, r0 + 4, 3);
    ws.getCell(r0 + 4, 1).value = '(' + (L.fullName || L.licNo) + ')';
    ws.getCell(r0 + 4, 1).alignment = { horizontal: 'center' };
    ws.mergeCells(r0 + 5, 1, r0 + 5, 6);
    const s = ws.getCell(r0 + 5, 1);
    s.value = 'เซ็นบนหน้าจอเมื่อ ' + (sg.signedAt || '') + ' · รหัสยืนยัน ' + (sg.hash || '');
    s.font = { name: FONT, size: 12, color: { argb: 'FF6E7A58' } };
  } else {
    ws.mergeCells(r0 + 3, 1, r0 + 3, 3);
    ws.getCell(r0 + 3, 1).value = '.................................................';
    ws.getCell(r0 + 3, 1).alignment = { horizontal: 'center' };
    ws.mergeCells(r0 + 4, 1, r0 + 4, 3);
    ws.getCell(r0 + 4, 1).value = '(' + (L.fullName || L.licNo) + ')';
    ws.getCell(r0 + 4, 1).alignment = { horizontal: 'center' };
    const warn = sg.status === 'STALE'
      ? '⚠️ ใบเวรถูกแก้หลังจากแพทย์เซ็นเมื่อ ' + (sg.signedAt || '') + ' — ต้องเซ็นใหม่'
      : sg.status === 'NONE'
        ? 'ยังไม่มีลายเซ็นอิเล็กทรอนิกส์ — ลงนามด้วยมือ หรือให้แพทย์เซ็นในระบบ' : '';
    if (warn) {
      ws.mergeCells(r0 + 5, 1, r0 + 5, 6);
      const w = ws.getCell(r0 + 5, 1);
      w.value = warn;
      w.font = { name: FONT, size: 12, color: { argb: 'FFB3261E' } };
    }
  }
  if (sg.papers && sg.papers.length) {
    ws.mergeCells(r0 + 6, 1, r0 + 6, 11);
    const p = ws.getCell(r0 + 6, 1);
    p.value = 'เอกสารแนบ (รูปใบลงเวลากระดาษ) ' + sg.papers.length + ' ไฟล์: '
      + sg.papers.map((x) => x.fileUrl).join(' ');
    p.font = { name: FONT, size: 12, color: { argb: 'FF6E7A58' } };
  }
  ws.mergeCells(r0 + 3, 7, r0 + 3, 9);
  ws.getCell(r0 + 3, 7).value = '.................................................';
  ws.getCell(r0 + 3, 7).alignment = { horizontal: 'center' };
  ws.mergeCells(r0 + 4, 7, r0 + 4, 9);
  ws.getCell(r0 + 4, 7).value = '(ผู้ตรวจสอบ)';
  ws.getCell(r0 + 4, 7).alignment = { horizontal: 'center' };
}

/* ----------------------------- ตัวเรียกใช้ ----------------------------- */

/** ExcelJS หนัก ~900KB — โหลดตอนกดส่งออกเท่านั้น ไม่ถ่วงหน้าแรก */
async function newWorkbook(): Promise<Workbook> {
  const mod = await import('exceljs');
  // exceljs เป็นแพ็กเกจแบบ CommonJS — ใน node ได้ namespace ที่มี default
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod);
  const wb = new ExcelJS.Workbook();
  wb.creator = APP_STAMP;
  wb.created = new Date();
  return wb;
}

/** สร้างสมุดงาน 1 สาขา: ใบปะหน้า + ชีตรายแพทย์ (ชื่อชีต = รหัส ว.) */
export async function buildWorkbook(
  res: CalcResult, br: { code: string; nameEn: string; fileCode: string }, ym: string,
): Promise<Blob> {
  const wb = await newWorkbook();
  const cover = wb.addWorksheet('ใบปะหน้า', { views: [{ state: 'frozen', ySplit: 4 }] });
  res.lines.forEach((L) => buildDoctorSheet(wb.addWorksheet(L.licNo), L));
  buildCoverSheet(cover, res, br, ym);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** ส่งออกหลายสาขาเป็นไฟล์เดียว — สาขาละ 1 ชุดชีต
 *  ระบบเดิมทำได้ครั้งละไม่เกิน 6 สาขาเพราะเพดาน 6 นาทีของ Apps Script
 *  ตัวนี้รันในเบราว์เซอร์ จึงทำครบ 14 สาขารวดเดียวได้ */
export async function buildMultiBranchWorkbook(
  items: { res: CalcResult; br: { code: string; nameEn: string; fileCode: string } }[],
  ym: string,
): Promise<Blob> {
  const wb = await newWorkbook();
  for (const it of items) {
    const cover = wb.addWorksheet(`ใบปะหน้า-${it.br.fileCode}`);
    it.res.lines.forEach((L) => buildDoctorSheet(wb.addWorksheet(`${it.br.fileCode}-${L.licNo}`), L));
    buildCoverSheet(cover, it.res, it.br, ym);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** CSV รายการหัตถการ — กัน formula injection */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : '' + v;
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function toCsv(headers: string[], rows: unknown[][]): Blob {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
