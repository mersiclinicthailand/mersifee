/***********************************************************************
 * Migrate.gs — ย้ายข้อมูลจาก MersiFee_DB (Google Sheet) เข้าระบบใหม่
 *
 * วิธีใช้ (ทำครั้งเดียว):
 *   1. เปิดชีต MersiFee_DB → ส่วนขยาย → Apps Script
 *   2. กด + ข้างคำว่า "ไฟล์" → สคริปต์ → ตั้งชื่อ Migrate → วางไฟล์นี้ทั้งไฟล์
 *   3. แก้ 2 บรรทัดด้านล่าง: USERNAME / PASSWORD ให้เป็นบัญชีผู้ดูแลของระบบใหม่
 *   4. เลือกฟังก์ชัน migrateToSupabase แล้วกด ▶ รัน
 *   5. ดูผลที่ "บันทึกการดำเนินการ" (View → Logs)
 *
 * รันซ้ำได้ ไม่สร้างข้อมูลซ้ำ — ทุกตารางเป็น upsert
 * ข้อมูลที่ย้าย: DOCTOR · DOCTOR_POOL · ALIAS · RATE · CONFIG · PERIOD · PROCDAY · SHIFT
 * ไม่ย้าย: USERS (บัญชีอยู่ที่ Supabase Auth ร่วมกับ Mersi CRM แล้ว)
 *          PROC แถวดิบ (ถ้าต้องการ ให้นำเข้าไฟล์ Excel ใหม่ในหน้า "นำเข้าข้อมูล")
 ***********************************************************************/

var SUPABASE_URL  = 'https://yrzgorkgxhjxwgpkdggo.supabase.co';
var SUPABASE_KEY  = 'sb_publishable_1HhSmwvXvNxuG95jKYRnWQ_U3lCRhgB';

var USERNAME = 'it';            // <<< ชื่อผู้ใช้ผู้ดูแลระบบใหม่
var PASSWORD = 'ใส่รหัสผ่าน';    // <<< รหัสผ่านของบัญชีนั้น

/* ------------------------------------------------------------------ */

function migrateToSupabase() {
  var token = signIn_();
  var payload = {
    doctor:  readTab_('DOCTOR'),
    pool:    readTab_('DOCTOR_POOL'),
    alias:   readTab_('ALIAS'),
    rate:    readTab_('RATE'),
    config:  readTab_('CONFIG'),
    period:  readTab_('PERIOD'),
    procDay: readTab_('PROCDAY'),
    shift:   readTab_('SHIFT')
  };

  // ทำความสะอาดก่อนส่ง — วันที่ให้เป็น ค.ศ. รูปแบบ ISO เสมอ
  ['period', 'procDay', 'shift'].forEach(function (k) {
    (payload[k] || []).forEach(function (r) {
      ['workDate', 'effFrom', 'effTo'].forEach(function (f) {
        if (r[f]) r[f] = isoDate_(r[f]);
      });
    });
  });
  (payload.rate || []).forEach(function (r) {
    r.effFrom = isoDate_(r.effFrom);
    r.effTo   = r.effTo ? isoDate_(r.effTo) : '';
  });

  Logger.log('กำลังส่ง: ' + Object.keys(payload).map(function (k) {
    return k + ' ' + (payload[k] || []).length + ' แถว';
  }).join(' · '));

  // ส่งเป็นก้อน ๆ กันคำขอใหญ่เกินไป (บัญชีหมอสำรองอาจมีหลายร้อยแถว)
  var result = {};
  sendChunks_(token, 'doctor',  payload.doctor,  300, result);
  sendChunks_(token, 'alias',   payload.alias,   500, result);
  sendChunks_(token, 'rate',    payload.rate,    500, result);
  sendChunks_(token, 'config',  payload.config,  500, result);
  sendChunks_(token, 'pool',    payload.pool,    300, result);
  sendChunks_(token, 'period',  payload.period,  200, result);
  sendChunks_(token, 'procDay', payload.procDay, 800, result);
  sendChunks_(token, 'shift',   payload.shift,   500, result);

  Logger.log('เสร็จแล้ว — ' + JSON.stringify(result));
  try {
    SpreadsheetApp.getUi().alert('ย้ายข้อมูลเรียบร้อย\n\n' +
      Object.keys(result).map(function (k) { return k + ': ' + result[k] + ' แถว'; }).join('\n'));
  } catch (e) { /* รันจากตัวแก้ไขโค้ดก็ไม่มี UI */ }
  return result;
}

/** ล็อกอินเข้า Supabase ด้วยชื่อผู้ใช้เดียวกับที่ใช้ในเว็บ */
function signIn_() {
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_KEY },
    payload: JSON.stringify({
      email: USERNAME.trim().toLowerCase() + '@mersi.local',
      password: PASSWORD
    }),
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200 || !body.access_token) {
    throw new Error('เข้าสู่ระบบไม่สำเร็จ — ตรวจ USERNAME / PASSWORD\n' + res.getContentText());
  }
  return body.access_token;
}

/** ส่งทีละก้อน แล้วรวมจำนวนแถวที่เขียนได้ */
function sendChunks_(token, key, rows, size, out) {
  rows = rows || [];
  if (!rows.length) { out[key] = 0; return; }
  var total = 0;
  for (var i = 0; i < rows.length; i += size) {
    var part = {};
    part[key] = rows.slice(i, i + size);
    var r = callRpc_(token, 'fee_migrate', { p: part });
    total += Number(r[key] || 0);
    Logger.log('  ' + key + ' ' + Math.min(i + size, rows.length) + '/' + rows.length);
  }
  out[key] = total;
}

function callRpc_(token, fn, args) {
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    payload: JSON.stringify(args),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('เรียก ' + fn + ' ไม่สำเร็จ (HTTP ' + res.getResponseCode() + ')\n' +
                    res.getContentText().substring(0, 500));
  }
  return JSON.parse(res.getContentText()) || {};
}

/** อ่านชีตหนึ่งแท็บเป็น array ของ object โดยใช้แถวแรกเป็นชื่อคอลัมน์ */
function readTab_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) { Logger.log('ข้ามชีต ' + name + ' (ไม่พบ)'); return []; }
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  var head = vals[0].map(function (h) { return ('' + h).trim(); });
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    var o = {}, any = false;
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      var v = vals[r][c];
      if (Object.prototype.toString.call(v) === '[object Date]') v = isoDate_(v);
      else v = ('' + (v === null || v === undefined ? '' : v)).trim();
      o[head[c]] = v;
      if (v !== '') any = true;
    }
    if (any) out.push(o);
  }
  return out;
}

/** วันที่ทุกแบบ → 'YYYY-MM-DD' (ค.ศ.) — ปี >= 2400 ถือเป็น พ.ศ. แล้วลบ 543 */
function isoDate_(v) {
  if (!v) return '';
  var TH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var y = v.getFullYear();
    if (y >= 2400) y -= 543;
    return y + '-' + p2(v.getMonth() + 1) + '-' + p2(v.getDate());
  }
  var s = ('' + v).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    var yy = parseInt(m[1], 10);
    if (yy >= 2400) yy -= 543;
    return yy + '-' + p2(parseInt(m[2], 10)) + '-' + p2(parseInt(m[3], 10));
  }
  m = s.match(/^(\d{1,2})\s+(\S+)\s+(\d{4})$/);
  if (m) {
    var mi = TH.indexOf(m[2]);
    if (mi >= 0) {
      var y2 = parseInt(m[3], 10);
      if (y2 >= 2400) y2 -= 543;
      return y2 + '-' + p2(mi + 1) + '-' + p2(parseInt(m[1], 10));
    }
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    var y3 = parseInt(m[3], 10);
    if (y3 >= 2400) y3 -= 543;
    return y3 + '-' + p2(parseInt(m[2], 10)) + '-' + p2(parseInt(m[1], 10));
  }
  return s;
}

/** ตรวจก่อนย้ายจริง — นับแถวแต่ละชีตโดยไม่ส่งอะไรออกไป */
function previewMigration() {
  ['DOCTOR','DOCTOR_POOL','ALIAS','RATE','CONFIG','PERIOD','PROCDAY','SHIFT','PROC','USERS']
    .forEach(function (n) {
      Logger.log(n + ': ' + readTab_(n).length + ' แถว');
    });
}
