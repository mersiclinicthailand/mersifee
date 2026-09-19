/**
 * parity.mjs — พิสูจน์ว่าเครื่องคำนวณตัวใหม่ (TypeScript) ให้ผลเท่าของเดิม (Apps Script) ทุกค่า
 *
 * วิธี: โหลด Code.gs ตัวจริงเข้า VM พร้อม stub ของ Apps Script แล้วเรียก calcCore_
 *       เทียบกับ calcCore ของ TS ที่คอมไพล์แล้ว ด้วย deep-equal ทั้งก้อน
 *       ข้อมูลที่ใช้: ไฟล์จริงของบางนา ส.ค. 2569 + ชุดกรณีขอบสังเคราะห์
 *
 * รัน: node verify/parity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LEGACY = process.env.LEGACY_CODE || '/mnt/user-data/uploads/MersiFee/Code.gs';
const FIXTURE = process.env.FIXTURE || '/mnt/user-data/uploads/MersiFee/test/fixture_bn_2026-08.json';

/* ---------- 1) โหลดโค้ดเดิมเข้า sandbox ---------- */
const sandbox = {
  console,
  Utilities: {
    formatDate: (d, _tz, fmt) => {
      const p2 = (n) => (n < 10 ? '0' : '') + n;
      const s = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      return fmt && fmt.indexOf('HH') >= 0
        ? s + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
        : s;
    },
    computeDigest: (_a, s) =>
      Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((x) => (x > 127 ? x - 256 : x)),
    getUuid: () => crypto.randomUUID(),
    DigestAlgorithm: { SHA_256: 1 },
    Charset: { UTF_8: 1 },
  },
  SpreadsheetApp: {}, CacheService: {}, PropertiesService: {}, Session: {},
  DriveApp: {}, UrlFetchApp: {}, ScriptApp: {}, HtmlService: {}, LockService: {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(LEGACY, 'utf8'), sandbox, { filename: 'Code.gs' });

/* ---------- 2) โหลดตัวใหม่ (TS ที่คอมไพล์เป็น ESM แล้ว) ---------- */
const NEW = await import(path.join(ROOT, 'verify/build/calc.js'));

/* ---------- 3) ประกอบข้อมูลจริงของบางนา ---------- */
const FX = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const ALIAS = {
  'นพ.กฤชทร(หมอเต้ย) รัตนาภิรตานนท์': '56186', 'พญ.ประภัสรา(หมอออน) ลิปภานนท์': '80374',
  'พญ.นารา(หมอจ๋า) เจริญพงศ์': '81629', 'นพ.ภาสภาวิต(หมอโอ๊ต) ปภาภูติวัฒน์': '65212',
  'พญ.พฤษ์ไพลิน ต้นติศิลปะพงศ์': '77171', 'พญ.ผกาพัฒน์(หมอหลี) สุธีวรนันท์': '65477',
  'นพ.จิรภัทร(หมอปีโป้) ต้นชนะชัย': '81361', 'นพ.จารุพัฒน์(หมอมิก) วัฒน์ศิริธรรม': '62658',
};

const procs = FX.procs
  .filter((r) => sandbox.isDoctorName_(String(r.emp || '').trim()))
  .map((r) => ({
    billDate: sandbox.toIsoDate_(r.billDate),
    empRaw: String(r.emp).trim(),
    licNo: ALIAS[String(r.emp).trim()] || '',
    fee: sandbox.num_(r.fee),
    fingerprint: [r.billDate, r.docNo, r.emp, r.course, r.qty, r.fee].join('|'),
  }));

const shifts = [];
FX.sheets.forEach((sh) => sh.rows.forEach((r) => {
  const isSpecial = !!(r.note && String(r.note).trim());
  shifts.push({
    id: 'S' + shifts.length, licNo: sh.licNo, workDate: r.date, timeIn: r.timeIn,
    timeOut: r.timeOut, breakMin: 0,
    specialAmt: isSpecial ? sandbox.num_(r.F) : '',
    handOverride: '', deductOther: sandbox.num_(r.I),
    kind: isSpecial ? 'SPECIAL' : 'SHIFT', note: isSpecial ? String(r.note) : '',
  });
}));

const doctors = FX.cover.map((c) => ({
  licNo: String(c.licNo), fullName: c.fullName,
  nickName: String(c.nickName) === '0' ? '' : String(c.nickName),
  bank: c.bank, bankAcc: String(c.bankAcc), idCard: String(c.idCard),
  address: c.address, contact: c.contact,
  payeeType: String(c.fullName).indexOf('บริษัท') === 0 ? 'COMPANY' : 'PERSON',
  payeeName: String(c.fullName).indexOf('บริษัท') === 0 ? c.fullName : '',
  status: 'ACTIVE', note: '',
}));

const rates = FX.cover.map((c) => ({
  id: 'R' + c.licNo, licNo: String(c.licNo), branch: 'BN', hourlyRate: c.rate,
  taxBase: 'TOTAL', taxRate: 3, handMethod: 'SOURCE',
  effFrom: '2020-01-01', effTo: '', approvedBy: 'admin', note: '',
}));

/* ---------- 4) กรณีทดสอบ ---------- */
const clone = (o) => JSON.parse(JSON.stringify(o));
const BASE = { branch: 'BN', ym: '2026-08', procs, shifts, doctors, rates, adjusts: [] };

/** ยอดรายวันที่สรุปไว้ (ทางเร็วที่ระบบใช้จริง) — ต้องให้ผลเท่าการไล่บวกแถวดิบ */
function makeProcDays(ps) {
  const m = {};
  const un = {};
  ps.forEach((p) => {
    if (!p.licNo) {
      if (!un[p.empRaw]) un[p.empRaw] = { name: p.empRaw, count: 0, sum: 0 };
      un[p.empRaw].count++;
      un[p.empRaw].sum = Math.round((un[p.empRaw].sum + p.fee) * 100) / 100;
      return;
    }
    const k = p.licNo + '|' + p.billDate;
    if (!m[k]) m[k] = { licNo: p.licNo, workDate: p.billDate, amount: 0, rows: 0 };
    m[k].amount = Math.round((m[k].amount + p.fee) * 100) / 100;
    m[k].rows++;
  });
  return { procDays: Object.keys(m).sort().map((k) => m[k]), unmatched: Object.values(un) };
}

const NIGHT_SHIFTS = [
  { id: 'N1', licNo: '56186', workDate: '2026-08-20', timeIn: '22:00', timeOut: '02:00',
    breakMin: 0, specialAmt: '', handOverride: '', deductOther: 0, kind: 'NIGHT', note: '' },
];

const SIGNS = [
  { id: 'G1', licNo: '56186', kind: 'MONTH', signedAt: '2026-09-01T10:00:00',
    signerName: 'หมอเต้ย', method: 'DRAW', dataHash: sandbox.monthHash_(shifts, '56186') },
  { id: 'G2', licNo: '80374', kind: 'MONTH', signedAt: '2026-09-01T10:05:00',
    signerName: 'หมอออน', method: 'DRAW', dataHash: 'ผิดแน่นอน' },
  { id: 'G3', licNo: '56186', kind: 'PAPER', signedAt: '2026-09-02T09:00:00',
    fileUrl: 'https://drive/x', by: 'bn.staff', note: 'กระดาษ' },
];

const CASES = [
  ['บางนา ส.ค. 69 · แถวดิบ · โหมด SHEET', { ...clone(BASE), coverMode: 'SHEET' }],
  ['บางนา ส.ค. 69 · แถวดิบ · โหมด HOURS', { ...clone(BASE), coverMode: 'HOURS' }],
  ['บางนา ส.ค. 69 · ทางเร็ว (ยอดรายวันสรุปแล้ว)',
    { ...clone(BASE), procs: undefined, ...makeProcDays(procs), coverMode: 'SHEET' }],
  ['ชื่อจับคู่ไม่ได้ 1 คน (ยอดต้องไม่เข้าแพทย์)',
    { ...clone(BASE), procs: procs.map((p, i) => (i % 7 === 0 ? { ...p, licNo: '' } : p)) }],
  ['ไม่มีอัตราเลย → NO_RATE ทุกบรรทัด', { ...clone(BASE), rates: [] }],
  ['ลบใบเวร 1 วัน → PROC_NO_SHIFT', { ...clone(BASE), shifts: shifts.slice(1) }],
  ['ไม่มีข้อมูลนำเข้าเลย → NO_IMPORT', { ...clone(BASE), procs: [] }],
  ['ไม่มีทั้งใบเวรและหัตถการ → ZERO_CONFIRM', { ...clone(BASE), procs: [], shifts: [] }],
  ['ยอดพิเศษไม่มีเหตุผล → SPECIAL_NOREASON',
    { ...clone(BASE), shifts: shifts.map((s) => (s.kind === 'SPECIAL' ? { ...s, note: '' } : s)) }],
  ['เวรยาว 22 ชม. → TIME_TOOLONG',
    { ...clone(BASE), shifts: [{ ...shifts[0], timeOut: '23:59', timeIn: '01:00' }, ...shifts.slice(1)] }],
  ['เวรข้ามคืน 22:00–02:00 = 4 ชม.', { ...clone(BASE), shifts: [...shifts, ...NIGHT_SHIFTS] }],
  ['ลงเวลาเข้าแล้วไม่กดออก → CLOCK_OPEN',
    { ...clone(BASE), shifts: [{ ...shifts[0], timeOut: '', source: 'CLOCK' }, ...shifts.slice(1)] }],
  ['ลายเซ็น OK / STALE / NONE · โหมด WARN',
    { ...clone(BASE), signs: clone(SIGNS), signMode: 'WARN' }],
  ['ลายเซ็น · โหมด BLOCK (ต้องขึ้นเป็นระดับบล็อก)',
    { ...clone(BASE), signs: clone(SIGNS), signMode: 'BLOCK' }],
  ['ลายเซ็น · โหมด OFF (ต้องไม่ออกปัญหาเลย)',
    { ...clone(BASE), signs: clone(SIGNS), signMode: 'OFF' }],
  ['กฎปัดเศษ ≤15 นาที เปิดใช้ ตั้งแต่ 1 ก.ย. 69',
    { ...clone(BASE), graceEnable: 'Y', graceMin: 15, schedStart: '12:00', schedEnd: '20:00',
      graceEffDate: '2026-08-01' }],
  ['กฎปัดเศษ · วันที่มีผลอยู่หลังรอบนี้ (ต้องคิดแบบเดิม)',
    { ...clone(BASE), graceEnable: 'Y', graceMin: 15, schedStart: '12:00', schedEnd: '20:00',
      graceEffDate: '2026-09-01' }],
  ['ฐานภาษี SHIFT ทุกคน',
    { ...clone(BASE), rates: rates.map((r) => ({ ...r, taxBase: 'SHIFT' })) }],
  ['ฐานภาษี NONE ทุกคน',
    { ...clone(BASE), rates: rates.map((r) => ({ ...r, taxBase: 'NONE' })) }],
  ['อัตราซ้อนช่วงวันที่ → RATE_OVERLAP',
    { ...clone(BASE), rates: [...rates, ...rates.map((r) => ({ ...r, id: r.id + 'b' }))] }],
  ['รายการปรับปรุงเพิ่ม/หักจากรอบก่อน',
    { ...clone(BASE), adjusts: [
      { licNo: '56186', kind: 'ADD', amount: 1500, reason: 'ตกเบิกรอบ ก.ค.' },
      { licNo: '56186', kind: 'DEDUCT', amount: 260.5, reason: 'หักคืนรอบ ก.ค.' },
      { licNo: '65477', kind: 'DEDUCT', amount: 1000, reason: 'ปรับปรุง' }] }],
  ['แก้ค่ามือรายวันด้วยมือ (handOverride)',
    { ...clone(BASE), shifts: shifts.map((s, i) => (i % 5 === 0 ? { ...s, handOverride: 999 } : s)) }],
  ['หักอื่น ๆ รายบรรทัด',
    { ...clone(BASE), shifts: shifts.map((s, i) => (i % 3 === 0 ? { ...s, deductOther: 120.25 } : s)) }],
  ['แพทย์ไม่มีในทะเบียน → NO_PAYEE', { ...clone(BASE), doctors: doctors.slice(0, 3) }],
];

/* ---------- 5) เทียบผล ---------- */
function diff(a, b, p = '', out = []) {
  if (out.length > 12) return out;
  const ta = a === null ? 'null' : typeof a;
  const tb = b === null ? 'null' : typeof b;
  if (ta !== tb) { out.push(`${p}: ชนิดต่างกัน ${ta} ≠ ${tb}`); return out; }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { out.push(`${p}: array ≠ non-array`); return out; }
    if (a.length !== b.length) out.push(`${p}.length: ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${p}[${i}]`, out);
    return out;
  }
  if (a && b && ta === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    keys.forEach((k) => diff(a[k], b[k], p ? `${p}.${k}` : k, out));
    return out;
  }
  if (ta === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    if (Math.abs(a - b) > 1e-9) out.push(`${p}: ${a} ≠ ${b}`);
    return out;
  }
  if (a !== b) out.push(`${p}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return out;
}

let pass = 0, fail = 0;
const line = '━'.repeat(72);
console.log('\n' + line);
console.log('เทียบเครื่องคำนวณตัวใหม่ (TypeScript) กับตัวเดิม (Apps Script) — ข้อมูลจริงบางนา ส.ค. 2569');
console.log(line);

for (const [name, ctx] of CASES) {
  let oldRes, newRes, err = null;
  try { oldRes = sandbox.calcCore_(clone(ctx)); } catch (e) { err = 'เดิม: ' + e.message; }
  try { newRes = NEW.calcCore(clone(ctx)); } catch (e) { err = (err ? err + ' / ' : '') + 'ใหม่: ' + e.message; }
  if (err) { console.log('  ✗ ' + name + '\n      ' + err); fail++; continue; }
  const d = diff(oldRes, newRes);
  if (d.length) {
    console.log('  ✗ ' + name);
    d.forEach((x) => console.log('      ' + x));
    fail++;
  } else {
    const t = newRes.totals;
    console.log('  ✓ ' + name +
      `\n      แพทย์ ${t.doctors} · ค่าเวร ${t.shiftTotal.toLocaleString()} · ค่ามือ ${t.handTotal.toLocaleString()}` +
      ` · รวม ${t.gross.toLocaleString()} · ภาษี ${t.tax.toLocaleString()} · สุทธิ ${t.net.toLocaleString()}` +
      ` · ปัญหา ${newRes.issues.length} (บล็อก ${newRes.blockers})`);
    pass++;
  }
}

/* ---------- 6) ยูทิลิตี้ระดับล่าง ---------- */
console.log('\n' + line);
console.log('เทียบยูทิลิตี้พื้นฐานทีละค่า');
console.log(line);
const UNIT = [
  ['toIsoDate', 'toIsoDate_', ['31 ส.ค. 2569'], ['1 ม.ค. 2570'], ['2569-08-09'], ['2026-08-09'],
    ['09/08/2569'], [''], ['ขยะ'], [new Date(2026, 7, 31)]],
  ['toThaiDate', 'toThaiDate_', ['2026-08-31'], ['2027-01-01'], ['']],
  ['ymThai', 'ymThai_', ['2026-08'], ['2026-12']],
  ['toMinutes', 'toMinutes_', ['12:30 น.'], ['12.30'], [0.5], ['23:59'], [''], ['ขยะ']],
  ['minutesToHHMM', 'minutesToHHMM_', [750], [0], [1439], ['']],
  ['num', 'num_', ['1,234.56'], [''], ['abc'], [42]],
  ['r2', 'r2_', [1.005], [2.675], [191550.004999]],
  ['fmtMoney', 'fmtMoney_', [1234567.891], [-50], [0]],
  ['hash', 'hash_', ['abc'], ['ทดสอบภาษาไทย'], ['']],
];
for (const [newName, oldName, ...args] of UNIT) {
  let bad = 0;
  for (const a of args) {
    const o = sandbox[oldName](...a);
    const n = NEW[newName] ? NEW[newName](...a) : (await import(path.join(ROOT, 'verify/build/core.js')))[newName](...a);
    if (JSON.stringify(o) !== JSON.stringify(n)) {
      console.log(`  ✗ ${newName}(${JSON.stringify(a[0])}) → เดิม ${JSON.stringify(o)} ≠ ใหม่ ${JSON.stringify(n)}`);
      bad++;
    }
  }
  if (bad) fail++; else { console.log(`  ✓ ${newName} — ตรงกันทุกค่า (${args.length} กรณี)`); pass++; }
}

console.log('\n' + line);
console.log(`สรุป:  ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
console.log(line);
console.log(fail ? '❌ ยังไม่ตรง' : '✅ เครื่องคำนวณตัวใหม่ให้ผลเท่าของเดิมทุกค่า');
process.exit(fail ? 1 : 0);
