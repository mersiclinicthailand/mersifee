/**
 * export.mjs — ตรวจไฟล์ Excel ที่ระบบสร้าง ว่าโครงและสูตรตรงกับฟอร์มเดิม
 *
 * สร้างไฟล์จริงด้วย ExcelJS แล้วอ่านกลับมาตรวจทีละเซลล์
 * ครอบคลุมกรณีที่เคยเป็นบั๊ก: แถว Total เลื่อนเมื่อแพทย์มีเวรเกิน 11 วัน
 */
import { calcCore } from './build/calc.js';
import { buildWorkbook, buildFileName, docTotalRow, csvCell } from './build/export.js';

const BR = { code: 'BN', nameEn: 'Bangna', fileCode: 'BN' };

const mkRates = (licNos, rate = 900) => licNos.map((licNo) => ({
  id: 'R' + licNo, licNo, branch: 'BN', hourlyRate: rate, taxBase: 'TOTAL',
  taxRate: 3, handMethod: 'SOURCE', effFrom: '2020-01-01', effTo: '',
}));
const mkDocs = (licNos) => licNos.map((licNo) => ({
  licNo, fullName: 'นายทดสอบ ' + licNo, nickName: 'เล่น' + licNo,
  bank: 'SCB', bankAcc: '0000000000', idCard: '0000000000000',
  address: 'ที่อยู่ทดสอบ', contact: 'a@b.c', payeeType: 'PERSON', payeeName: '',
}));
const S = (licNo, d, ti, to, extra = {}) => ({
  id: licNo + d, licNo, workDate: d, timeIn: ti, timeOut: to, breakMin: 0,
  specialAmt: '', handOverride: '', deductOther: 0, kind: 'SHIFT', note: '',
  source: 'MANUAL', signId: '', signedAt: '', ...extra,
});

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond || !detail ? '' : '\n      ' + detail));
  cond ? pass++ : fail++;
};
const f = (ws, addr) => {
  const v = ws.getCell(addr).value;
  return v && typeof v === 'object' && 'formula' in v ? '=' + v.formula : v;
};

async function load(blob) {
  const M = await import('exceljs'); const ExcelJS = M.default ?? M;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  return wb;
}

const line = '━'.repeat(72);

/* ---------- ชุดที่ 1: โครงไฟล์และสูตรใบปะหน้า ---------- */
console.log('\n' + line);
console.log('ชุดที่ 1 · โครงไฟล์และสูตรใบปะหน้า');
console.log(line);

const res1 = calcCore({
  branch: 'BN', ym: '2026-08', coverMode: 'SHEET',
  procDays: [
    { licNo: '56186', workDate: '2026-08-01', amount: 1800, rows: 8 },
    { licNo: '56186', workDate: '2026-08-08', amount: 14200, rows: 35 },
    { licNo: '80374', workDate: '2026-08-02', amount: 4900, rows: 21 },
  ],
  shifts: [
    S('56186', '2026-08-01', '12:00', '18:10'),
    S('56186', '2026-08-08', '12:00', '19:30'),
    S('56186', '2026-08-18', '09:00', '12:00',
      { specialAmt: '3750', kind: 'SPECIAL', note: 'เทรน KOL' }),
    S('80374', '2026-08-02', '12:00', '20:00'),
  ],
  doctors: mkDocs(['56186', '80374']), rates: mkRates(['56186', '80374']),
  adjusts: [], signs: [], signMode: 'OFF',
});

const wb1 = await load(await buildWorkbook(res1, BR, '2026-08'));
const cover = wb1.getWorksheet('ใบปะหน้า');

ok('ชื่อไฟล์ตามแบบเดิม', buildFileName('BN', '2026-08') === '08.ส.ค.-BN.xlsx', buildFileName('BN', '2026-08'));
ok('ชื่อไฟล์สาขาอื่น เดือนอื่น', buildFileName('RM2', '2026-12') === '12.ธ.ค.-RM2.xlsx');
ok('ชีตแรกคือใบปะหน้า', wb1.worksheets[0].name === 'ใบปะหน้า', wb1.worksheets[0].name);
ok('มีชีตครบทุกรหัส ว. (' + res1.lines.length + ')',
  res1.lines.every((L) => !!wb1.getWorksheet(L.licNo)));
ok('A1 หัวรายงาน', String(cover.getCell('A1').value).includes('Mersi Clinic Bangna'),
  String(cover.getCell('A1').value));
ok('A2 เดือน พ.ศ.', cover.getCell('A2').value === 'ประจำเดือน สิงหาคม 2569', cover.getCell('A2').value);
ok('A3 หัวคอลัมน์แรก', cover.getCell('A3').value === 'ลำดับ');
ok('B3 รหัส ว.', cover.getCell('B3').value === 'รหัส ว.');
ok('J3 รวมค่าเวร 40(2)', String(cover.getCell('J3').value).includes('40(2)'));
ok('K3 ค่ามือ 40(6)', String(cover.getCell('K3').value).includes('40(6)'));
ok('H4/I4 ชม./นาที', cover.getCell('H4').value === 'ชม.' && cover.getCell('I4').value === 'นาที');
ok('B5 รหัส ว. เป็นตัวเลข', cover.getCell('B5').value === 56186, cover.getCell('B5').value);
ok('B5 รูปแบบตัวเลข 5 หลัก', cover.getCell('B5').numFmt === '00000');
ok('F5 เลขบัญชีเก็บเป็นข้อความ (กันเลข 0 นำหน้าหาย)', cover.getCell('F5').numFmt === '@');

const TR56186 = docTotalRow(res1.lines.find((L) => L.licNo === '56186'));
ok('H5 ชม. อ้างชีตแพทย์', f(cover, 'H5') === `='56186'!D${TR56186}`, f(cover, 'H5'));
ok('I5 นาที อ้างชีตแพทย์', f(cover, 'I5') === `='56186'!E${TR56186}`, f(cover, 'I5'));
ok('J5 ค่าเวร ผูกกับผลรวมชีตแพทย์ (โหมด SHEET)',
  f(cover, 'J5') === `='56186'!F${TR56186}`, f(cover, 'J5'));
ok('K5 ค่ามือ อ้างชีตแพทย์', f(cover, 'K5') === `='56186'!G${TR56186}`, f(cover, 'K5'));
ok('L5 รวมเงินได้ = J+K', f(cover, 'L5') === '=J5+K5', f(cover, 'L5'));
ok('M5 ภาษี ฐานรวมเงินได้', f(cover, 'M5') === '=ROUND(L5*3/100,2)', f(cover, 'M5'));
ok('N5 หักอื่น ๆ อ้างชีตแพทย์', f(cover, 'N5') === `='56186'!I${TR56186}`, f(cover, 'N5'));
ok('O5 สุทธิ = L−M−N (ต้นฉบับลืมลบ N)', f(cover, 'O5') === '=L5-M5-N5', f(cover, 'O5'));

const RT = 5 + res1.lines.length;
ok('ป้ายแถวรวม', cover.getCell(RT, 1).value === 'รวมหมอทั้งหมด');
ok('D13 นับจำนวนแพทย์', f(cover, `D${RT}`) === `=COUNT(B5:B${RT - 1})`, f(cover, `D${RT}`));
ok('J รวมค่าเวร', f(cover, `J${RT}`) === `=SUM(J5:J${RT - 1})`);
ok('O รวมสุทธิ', f(cover, `O${RT}`) === `=SUM(O5:O${RT - 1})`);
const sigRow = RT + 5;
ok('ช่องลงนาม 4 ช่อง',
  cover.getCell(sigRow, 3).value === 'จัดทำโดย'
  && cover.getCell(sigRow, 7).value === 'เจ้าหน้าที่บัญชี'
  && cover.getCell(sigRow, 12).value === 'เจ้าหน้าที่การเงิน'
  && cover.getCell(sigRow, 17).value === 'ผู้จัดการฝ่ายบัญชี');
ok('มีบรรทัดระบุที่มาของไฟล์ (ตรวจย้อนกลับได้)',
  String(cover.getCell(RT + 7, 1).value || '').includes('MersiFee'));

/* ---------- ชุดที่ 2: ชีตรายแพทย์ ---------- */
console.log('\n' + line);
console.log('ชุดที่ 2 · ชีตรายแพทย์ (สูตร เวลา และบรรทัดยอดพิเศษ)');
console.log(line);

const d1 = wb1.getWorksheet('56186');
ok('A1 รหัส ว.', d1.getCell('A1').value === 56186);
ok('H1 อัตรารายชั่วโมง', d1.getCell('H1').value === 900);
ok('G3 ค่ามือ/วัน', d1.getCell('G3').value === 'ค่ามือ/วัน');
// ExcelJS ตอนอ่านกลับจะแปลงตัวเลขที่จัดรูปแบบเป็นเวลาให้เป็น Date ให้เอง
// ค่าที่เขียนลงไฟล์จริงคือเศษของวัน (0.5) — ตรวจโดยแปลงกลับเป็นเศษของวัน
const dayFrac = (v) => {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
  return NaN;
};
ok('B4 เวลาเข้าเป็นเศษของวัน (12:00 = 0.5)',
  Math.abs(dayFrac(d1.getCell('B4').value) - 0.5) < 1e-6, String(d1.getCell('B4').value));
ok('B4 รูปแบบเวลาไทย', d1.getCell('B4').numFmt === 'h:mm "น."');
ok('D4 สูตรนับชั่วโมง', f(d1, 'D4') === '=HOUR(C4-B4)', f(d1, 'D4'));
ok('E4 สูตรนับนาที', f(d1, 'E4') === '=MINUTE(C4-B4)', f(d1, 'E4'));
ok('F4 สูตรค่าเวร อ้างอัตราที่ H1', f(d1, 'F4') === '=(E4*$H$1/60)+D4*$H$1', f(d1, 'F4'));
ok('G4 ค่ามือของวันนั้น (1 ส.ค. = 1,800)', d1.getCell('G4').value === 1800, d1.getCell('G4').value);
ok('H4 รวม = F+G', f(d1, 'H4') === '=+F4+G4');
ok('J4 สุทธิบรรทัด = H−I', f(d1, 'J4') === '=+H4-I4');
ok('แถว Total อยู่แถว 15 (เติมว่างถึง 11 บรรทัด)', TR56186 === 15, String(TR56186));
ok('A15 ป้าย Total', d1.getCell(TR56186, 1).value === 'Total');
ok('D15 รวมชั่วโมง', f(d1, `D${TR56186}`) === `=SUM(D4:D${TR56186 - 1})`);
ok('F15 รวมค่าเวร', f(d1, `F${TR56186}`) === `=SUM(F4:F${TR56186 - 1})`);
ok('J16 ภาษี ฐานรวมเงินได้ H15',
  f(d1, `J${TR56186 + 1}`) === `=ROUND(H${TR56186}*3/100,2)`, f(d1, `J${TR56186 + 1}`));
ok('J17 จ่ายสุทธิ',
  f(d1, `J${TR56186 + 2}`) === `=+J${TR56186}-J${TR56186 + 1}`);
ok('ป้ายภาษีบอกฐานให้ชัด',
  String(d1.getCell(TR56186 + 1, 1).value).includes('ฐาน: รวมเงินได้'),
  String(d1.getCell(TR56186 + 1, 1).value));

// บรรทัดยอดพิเศษ (เทรน KOL 3,750) ต้องเป็นค่าคงที่ ไม่ใช่สูตร ชม.×อัตรา
let kolRow = 0;
for (let r = 4; r < TR56186; r++) if (d1.getCell(r, 6).value === 3750) kolRow = r;
ok('พบบรรทัด KOL ที่ F เป็นค่าคงที่ 3,750 (ไม่ใช่สูตร)', kolRow > 0, 'แถว ' + kolRow);
ok('บรรทัด KOL ไม่มีสูตรค่าเวรทับ',
  kolRow > 0 && typeof d1.getCell(kolRow, 6).value === 'number');
ok('บรรทัด KOL มีพื้นหลังเตือน',
  kolRow > 0 && d1.getCell(kolRow, 6).fill?.fgColor?.argb === 'FFFDF2E3');
ok('บรรทัด KOL มีหมายเหตุกำกับ',
  kolRow > 0 && String(d1.getCell(kolRow, 11).value).includes('เทรน KOL'),
  kolRow > 0 ? String(d1.getCell(kolRow, 11).value) : '');

/* ---------- ชุดที่ 3: กันบั๊กแถวรวมเลื่อน ---------- */
console.log('\n' + line);
console.log('ชุดที่ 3 · กันบั๊กแถวรวมเลื่อน — แพทย์ที่มีเวรมากกว่า 11 วัน');
console.log(line);

const many = Array.from({ length: 20 }, (_, i) =>
  S('99999', `2026-08-${String(i + 1).padStart(2, '0')}`, '12:00', '20:00'));
const res2 = calcCore({
  branch: 'BN', ym: '2026-08', coverMode: 'SHEET',
  procDays: many.map((s) => ({ licNo: '99999', workDate: s.workDate, amount: 100, rows: 1 })),
  shifts: many, doctors: mkDocs(['99999']), rates: mkRates(['99999']),
  adjusts: [], signs: [], signMode: 'OFF',
});
const wb2 = await load(await buildWorkbook(res2, BR, '2026-08'));
const c2 = wb2.getWorksheet('ใบปะหน้า');
const d2 = wb2.getWorksheet('99999');
const TR2 = docTotalRow(res2.lines[0]);

ok('20 เวร → แถว Total เลื่อนไปแถว 24', TR2 === 24, String(TR2));
ok('A24 ป้าย Total', d2.getCell(TR2, 1).value === 'Total');
ok('D24 รวมชั่วโมง ครอบคลุมทุกแถว', f(d2, `D${TR2}`) === `=SUM(D4:D${TR2 - 1})`);
ok('J25 ภาษีอ้างแถว Total ที่ถูก', f(d2, `J${TR2 + 1}`) === `=ROUND(H${TR2}*3/100,2)`);
ok('J26 จ่ายสุทธิอ้างแถวที่ถูก', f(d2, `J${TR2 + 2}`) === `=+J${TR2}-J${TR2 + 1}`);
ok('⭐ ใบปะหน้าอ้างแถว Total ที่ถูกต้อง (ไม่ใช่ 15 ตายตัว)',
  f(c2, 'J5') === `='99999'!F${TR2}`, f(c2, 'J5'));
ok('⭐ ใบปะหน้า H5 ก็อ้างแถวเดียวกัน', f(c2, 'H5') === `='99999'!D${TR2}`);
ok('⭐ ใบปะหน้า K5 ก็อ้างแถวเดียวกัน', f(c2, 'K5') === `='99999'!G${TR2}`);

/* ---------- ชุดที่ 4: โหมด HOURS และฐานภาษีแบบอื่น ---------- */
console.log('\n' + line);
console.log('ชุดที่ 4 · coverMode = HOURS และฐานภาษี SHIFT / NONE');
console.log(line);

const base = {
  branch: 'BN', ym: '2026-08',
  procDays: [{ licNo: '56186', workDate: '2026-08-01', amount: 1800, rows: 8 }],
  shifts: [S('56186', '2026-08-01', '12:00', '20:00')],
  doctors: mkDocs(['56186']), adjusts: [], signs: [], signMode: 'OFF',
};
const wbH = await load(await buildWorkbook(
  calcCore({ ...base, coverMode: 'HOURS', rates: mkRates(['56186']) }), BR, '2026-08'));
ok('coverMode=HOURS → J ใช้สูตร ชม.×อัตรา (ตรงไฟล์ต้นฉบับ)',
  f(wbH.getWorksheet('ใบปะหน้า'), 'J5') === '=(I5*(G5/60))+(H5*G5)',
  f(wbH.getWorksheet('ใบปะหน้า'), 'J5'));

const wbS = await load(await buildWorkbook(
  calcCore({ ...base, coverMode: 'SHEET',
    rates: mkRates(['56186']).map((r) => ({ ...r, taxBase: 'SHIFT' })) }), BR, '2026-08'));
ok('ฐานภาษี SHIFT → M อ้าง J', f(wbS.getWorksheet('ใบปะหน้า'), 'M5') === '=ROUND(J5*3/100,2)',
  f(wbS.getWorksheet('ใบปะหน้า'), 'M5'));

const wbN = await load(await buildWorkbook(
  calcCore({ ...base, coverMode: 'SHEET',
    rates: mkRates(['56186']).map((r) => ({ ...r, taxBase: 'NONE' })) }), BR, '2026-08'));
const cN = wbN.getWorksheet('ใบปะหน้า');
const dN = wbN.getWorksheet('56186');
ok('ฐานภาษี NONE → M เป็น 0 ไม่ใช่สูตร', cN.getCell('M5').value === 0, cN.getCell('M5').value);
ok('ป้ายในชีตแพทย์บอกว่าไม่หักภาษี',
  dN.getCell(docTotalRow(calcCore({ ...base, coverMode: 'SHEET',
    rates: mkRates(['56186']).map((r) => ({ ...r, taxBase: 'NONE' })) }).lines[0]) + 1, 1).value
    === 'ไม่หักภาษี ณ ที่จ่าย');

/* ---------- ชุดที่ 5: ค่ามือที่ไม่มีใบเวรต้องไม่หายเงียบ ---------- */
console.log('\n' + line);
console.log('ชุดที่ 5 · ค่ามือที่ไม่มีใบเวรต้องโผล่ในไฟล์ + กัน CSV formula injection');
console.log(line);

const resO = calcCore({
  branch: 'BN', ym: '2026-08', coverMode: 'SHEET',
  procDays: [
    { licNo: '56186', workDate: '2026-08-01', amount: 1800, rows: 8 },
    { licNo: '56186', workDate: '2026-08-09', amount: 20800, rows: 25 },  // ไม่มีใบเวร
  ],
  shifts: [S('56186', '2026-08-01', '12:00', '20:00')],
  doctors: mkDocs(['56186']), rates: mkRates(['56186']),
  adjusts: [], signs: [], signMode: 'OFF',
});
const wbO = await load(await buildWorkbook(resO, BR, '2026-08'));
const dO = wbO.getWorksheet('56186');
let warnRow = 0;
for (let r = 4; r < 16; r++) {
  if (String(dO.getCell(r, 11).value || '').includes('ยังไม่มีใบเวร')) warnRow = r;
}
ok('มีบรรทัดเตือน "มีค่ามือแต่ยังไม่มีใบเวร" ในชีตแพทย์', warnRow > 0, 'แถว ' + warnRow);
ok('บรรทัดนั้นแสดงยอดค่ามือ 20,800', warnRow > 0 && dO.getCell(warnRow, 7).value === 20800);
ok('ใบปะหน้ามีคำเตือนว่ารอบนี้ยังมีปัญหาค้าง', (() => {
  const c = wbO.getWorksheet('ใบปะหน้า');
  const rt = 5 + resO.lines.length;
  return String(c.getCell(rt + 8, 1).value || '').includes('ใช้ตรวจสอบเท่านั้น');
})());

ok('ค่าขึ้นต้นด้วย = ถูกเติม \' นำหน้า', csvCell('=1+1') === '"\'=1+1"', csvCell('=1+1'));
ok('ค่าขึ้นต้นด้วย @ ถูกเติม \' นำหน้า', csvCell('@SUM(A1)') === '"\'@SUM(A1)"');
ok('เครื่องหมายคำพูดถูก escape', csvCell('ชื่อ "เล่น"') === '"ชื่อ ""เล่น"""');
ok('ค่าปกติไม่ถูกแตะ', csvCell('หมอเต้ย') === '"หมอเต้ย"');

console.log('\n' + line);
console.log(`สรุปผลทดสอบตัวส่งออก:  ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
console.log(line);
console.log(fail ? '❌ พบปัญหา' : '✅ ผ่านทั้งหมด');
process.exit(fail ? 1 : 0);
