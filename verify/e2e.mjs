/**
 * e2e.mjs — ตรวจยอดปลายทาง: ข้อมูลที่อยู่ใน Postgres จริง → เครื่องคำนวณ → ต้องได้ยอดเดิม
 *
 * ข้อมูลด้านล่างคัดลอกมาจากผลลัพธ์จริงของ fee_workspace('BN','2026-08')
 * หลังนำเข้าผ่าน fee_import_proc / fee_save_shifts (เส้นทางเดียวกับที่หน้าเว็บใช้)
 * จุดสำคัญ: ชนิดข้อมูลเป็นแบบที่ Postgres คืนมาจริง (specialAmt เป็นข้อความ "3750.00",
 * workDate เป็น 'YYYY-MM-DD', hourlyRate เป็นตัวเลข) เพื่อทดสอบการแปลงชนิดด้วย
 */
import { calcCore } from './build/calc.js';

const procDays = [
  ['56186', '2026-08-01', 1800, 8], ['56186', '2026-08-08', 14200, 35],
  ['56186', '2026-08-15', 25850, 28], ['56186', '2026-08-22', 8050, 13],
  ['56186', '2026-08-29', 14600, 30], ['62658', '2026-08-25', 5300, 13],
  ['65212', '2026-08-04', 3400, 13], ['65212', '2026-08-18', 4050, 14],
  ['65477', '2026-08-09', 20800, 25], ['65477', '2026-08-10', 8550, 13],
  ['65477', '2026-08-16', 11250, 22], ['65477', '2026-08-17', 2700, 11],
  ['65477', '2026-08-20', 1250, 8], ['65477', '2026-08-23', 19250, 25],
  ['65477', '2026-08-24', 900, 4], ['65477', '2026-08-30', 7600, 13],
  ['65477', '2026-08-31', 11650, 21], ['77171', '2026-08-07', 4450, 18],
  ['80374', '2026-08-02', 4900, 21], ['81361', '2026-08-14', 3850, 19],
  ['81361', '2026-08-21', 3900, 21], ['81361', '2026-08-28', 5750, 23],
  ['81629', '2026-08-03', 2200, 11], ['81629', '2026-08-11', 5300, 8],
].map(([licNo, workDate, amount, rows]) => ({ licNo, workDate, amount, rows }));

const S = (licNo, workDate, timeIn, timeOut, specialAmt = '', kind = 'SHIFT', note = '') =>
  ({ id: licNo + workDate, licNo, workDate, timeIn, timeOut, breakMin: 0,
    specialAmt, handOverride: '', deductOther: 0, kind, note, source: 'IMPORT',
    signId: '', signedAt: '' });

const shifts = [
  S('56186', '2026-08-01', '12:00', '18:10'), S('56186', '2026-08-08', '12:00', '19:30'),
  S('56186', '2026-08-15', '12:00', '19:00'),
  S('56186', '2026-08-18', '09:00', '12:00', '3750.00', 'SPECIAL', 'เทรน KOL'),
  S('56186', '2026-08-22', '12:00', '19:00'), S('56186', '2026-08-29', '12:00', '20:00'),
  S('62658', '2026-08-25', '12:20', '20:24'),
  S('65212', '2026-08-04', '12:00', '20:50'), S('65212', '2026-08-18', '12:00', '20:20'),
  S('65477', '2026-08-09', '12:00', '21:50'), S('65477', '2026-08-10', '12:00', '20:00'),
  S('65477', '2026-08-16', '12:00', '21:57'), S('65477', '2026-08-17', '12:00', '19:30'),
  S('65477', '2026-08-18', '09:00', '12:00', '3750.00', 'SPECIAL', 'เทรน KOL'),
  S('65477', '2026-08-20', '12:00', '20:33'), S('65477', '2026-08-23', '12:00', '22:20'),
  S('65477', '2026-08-24', '12:00', '20:00'), S('65477', '2026-08-30', '12:00', '20:55'),
  S('65477', '2026-08-31', '12:00', '20:00'), S('77171', '2026-08-07', '12:00', '20:00'),
  S('80374', '2026-08-02', '12:00', '20:00'), S('81361', '2026-08-14', '12:00', '20:00'),
  S('81361', '2026-08-21', '12:00', '20:00'), S('81361', '2026-08-28', '12:00', '21:00'),
  S('81629', '2026-08-03', '12:00', '20:00'), S('81629', '2026-08-11', '12:00', '20:24'),
];

const RATE = { '56186': 900, '65212': 800, '81361': 850, '65477': 900,
  '62658': 700, '81629': 850, '80374': 700, '77171': 700 };

const rates = Object.entries(RATE).map(([licNo, hourlyRate]) => ({
  id: 'R' + licNo, licNo, branch: 'BN', hourlyRate,
  taxBase: 'TOTAL', taxRate: 3, handMethod: 'SOURCE', effFrom: '2020-01-01', effTo: '',
}));

const doctors = Object.keys(RATE).map((licNo) => ({
  licNo, fullName: 'แพทย์ ' + licNo, nickName: '', bank: '', bankAcc: '',
  idCard: '', address: '', contact: '', payeeType: 'PERSON', payeeName: '',
}));

/* ค่าตั้งต้นเหมือนที่อยู่ในตาราง fee.config จริง */
const ctx = {
  branch: 'BN', ym: '2026-08', coverMode: 'SHEET',
  procDays, unmatched: [], dupGroups: 0, shifts, doctors, rates, adjusts: [],
  signs: [], signMode: 'WARN',
  graceEnable: 'Y', graceMin: 15, schedStart: '12:00', schedEnd: '20:00',
  graceEffDate: '2026-09-01',           // รอบ ส.ค. อยู่ก่อนวันมีผล → คิดแบบเดิม
};

const EXPECT = {
  'ค่าเวรรวม': 176545, 'ค่ามือรวม': 191550, 'รวมเงินได้': 368095,
  'ภาษี': 11042.85, 'จ่ายสุทธิ': 357052.15, 'จำนวนแพทย์': 8,
  'รายการหัตถการที่นับได้': 417,
};

const res = calcCore(ctx);
const got = {
  'ค่าเวรรวม': res.totals.shiftTotal, 'ค่ามือรวม': res.totals.handTotal,
  'รวมเงินได้': res.totals.gross, 'ภาษี': res.totals.tax,
  'จ่ายสุทธิ': res.totals.net, 'จำนวนแพทย์': res.totals.doctors,
  'รายการหัตถการที่นับได้': res.totals.procRows,
};

const line = '━'.repeat(72);
console.log('\n' + line);
console.log('ตรวจยอดปลายทาง — ข้อมูลจาก Postgres จริง ผ่านเครื่องคำนวณตัวใหม่');
console.log(line);
let bad = 0;
for (const k of Object.keys(EXPECT)) {
  const ok = Math.abs(got[k] - EXPECT[k]) < 0.005;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(28)} = ${got[k].toLocaleString()}` +
    (ok ? '' : `   (ควรเป็น ${EXPECT[k].toLocaleString()})`));
}

/* ยอดรายแพทย์ต้องตรงใบปะหน้าต้นฉบับทุกคน (โหมด SHEET) */
const PER_DOC = {
  '56186': { hrs: 38, mins: 40, shift: 35850, hand: 64500, gross: 100350 },
  '65212': { hrs: 16, mins: 70, shift: 13733.33, hand: 7450, gross: 21183.33 },
  '81361': { hrs: 25, mins: 0, shift: 21250, hand: 13500, gross: 34750 },
  '65477': { hrs: 78, mins: 245, shift: 74925, hand: 83950, gross: 158875 },
  '62658': { hrs: 8, mins: 4, shift: 5646.67, hand: 5300, gross: 10946.67 },
  '81629': { hrs: 16, mins: 24, shift: 13940, hand: 7500, gross: 21440 },
  '80374': { hrs: 8, mins: 0, shift: 5600, hand: 4900, gross: 10500 },
  '77171': { hrs: 8, mins: 0, shift: 5600, hand: 4450, gross: 10050 },
};
console.log('\n  เทียบรายแพทย์กับชีตต้นฉบับ (D15/E15/F15/G15/H15)');
for (const L of res.lines) {
  const e = PER_DOC[L.licNo];
  if (!e) { console.log(`  ✗ ไม่คาดว่าจะมีแพทย์ ${L.licNo}`); bad++; continue; }
  const ok = L.sumHrs === e.hrs && L.sumMins === e.mins
    && Math.abs(L.coverShift - e.shift) < 0.005
    && Math.abs(L.handTotal - e.hand) < 0.005
    && Math.abs(L.gross - e.gross) < 0.005;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${L.licNo} · ${L.sumHrs} ชม. ${L.sumMins} นาที · ` +
    `ค่าเวร ${L.coverShift.toLocaleString()} · ค่ามือ ${L.handTotal.toLocaleString()} · ` +
    `รวม ${L.gross.toLocaleString()}` +
    (ok ? '' : `   (ควรเป็น ${e.hrs}/${e.mins}/${e.shift}/${e.hand}/${e.gross})`));
}

console.log(`\n  ปัญหาที่ตรวจพบ ${res.issues.length} รายการ (บล็อก ${res.blockers})`);
res.issues.forEach((i) => console.log(`     · [${i.severity}] ${i.code} ${i.message}`));

console.log('\n' + line);
console.log(bad ? `❌ ไม่ตรง ${bad} รายการ` : '✅ ยอดปลายทางตรงกับไฟล์ต้นฉบับทุกค่า');
console.log(line);
process.exit(bad ? 1 : 0);
