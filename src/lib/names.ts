/* ============================================================================
 * names.ts — ชื่อแพทย์: แสดงผล และจับคู่ชื่อในรายงานค่ามือกับทะเบียนแพทย์
 *
 * ชื่อในรายงานค่ามือจากระบบ MCS เขียนแบบ  "พญ.สิรีธร(หมอลูกหยี๋)  กิตติจารุกำจร"
 *   = คำนำหน้า + ชื่อจริง + (หมอ + ชื่อเล่น) + นามสกุล
 * บางแถวมีช่องว่างก่อนวงเล็บ บางแถวไม่มีวงเล็บเลย บางแถวนามสกุลสะกดเพี้ยนไป 1-2 ตัว
 *
 * ทะเบียนแพทย์เขียนแบบ  "นางสาวสิรีธร กิตติจารุกำจร" + ช่องชื่อเล่น "ลูกหยี๋"
 *
 * ระบบจับคู่ด้วย "ตารางจับคู่ชื่อ" (fee.alias) รายสาขา — สาขาที่เพิ่งเริ่มใช้จึงยังไม่มีคู่
 * ไฟล์นี้หาคู่ที่น่าจะถูกให้ก่อน เพื่อไม่ต้องให้คนเลือกเองทีละชื่อทีละสาขา
 * ==========================================================================*/

/** ชื่อเล่นสำหรับแสดงผล — มีคำว่า "หมอ" นำหน้าเสมอ (ข้อมูลในฐานเก็บแบบไม่มีคำนำหน้า) */
export function docNick(n?: string | null): string {
  const t = (n ?? '').toString().trim();
  if (!t) return '';
  return /^หมอ/.test(t) ? t : `หมอ${t}`;
}

/** ชื่อเล่นสำหรับเก็บลงฐาน — ตัด "หมอ" ออก ให้เก็บรูปเดียวกันทุกแถว */
export function rawNick(n?: string | null): string {
  return (n ?? '').toString().trim().replace(/^หมอ\s*/, '');
}

const TITLES = /^(นายแพทย์|แพทย์หญิง|นางสาว|นาง|นาย|น\.ส\.|นพ\.|พญ\.|น\.พ\.|พ\.ญ\.|ทพ\.|ทพญ\.|ดร\.)\s*/;

/** ตัดช่องว่างทุกชนิดและจุด ใช้เปรียบเทียบเท่านั้น */
const squash = (s: string) => s.replace(/[\s ​.]+/g, '');

export interface NameParts { first: string; last: string; nick: string }

/** แยกชื่อจากรายงานค่ามือ หรือจากทะเบียน ให้เป็น ชื่อ / นามสกุล / ชื่อเล่น */
export function splitName(raw: string): NameParts {
  let s = (raw || '').replace(/[ ​]/g, ' ').trim();
  let nick = '';
  const m = s.match(/\(\s*([^)]*?)\s*\)/);
  if (m) {
    nick = rawNick(m[1]);
    s = (s.slice(0, m.index) + ' ' + s.slice((m.index || 0) + m[0].length)).trim();
  }
  for (let i = 0; i < 2; i++) s = s.replace(TITLES, '');
  const parts = s.split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' '), nick };
}

/** ระยะแก้คำ (Levenshtein) — ใช้ยอมให้นามสกุลสะกดเพี้ยนเล็กน้อย */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export interface DocLite { licNo: string; fullName: string; nickName: string }

export type MatchLevel = 'STRONG' | 'LIKELY';
export interface Suggestion {
  licNo: string; fullName: string; nickName: string;
  level: MatchLevel;
  /** เหตุผลเป็นภาษาคน แสดงให้ผู้ใช้เห็นว่าทำไมถึงแนะนำคนนี้ */
  why: string;
}

/**
 * หาแพทย์ในรายชื่อที่น่าจะเป็นเจ้าของชื่อนี้
 *   STRONG — ชื่อจริงตรง และ (นามสกุลตรงหรือเพี้ยนไม่เกิน 2 ตัว หรือ ชื่อเล่นตรง)
 *   LIKELY — ชื่อจริงตรงคนเดียว หรือ ชื่อเล่นตรงคนเดียว
 * ถ้าคะแนนสูงสุดเสมอกันหลายคน ไม่แนะนำใครเลย (ให้คนเลือกเอง ดีกว่าเดาผิด)
 */
export function suggestDoctor(raw: string, docs: DocLite[]): Suggestion | null {
  const p = splitName(raw);
  const pf = squash(p.first), pl = squash(p.last), pn = squash(p.nick);
  if (!pf && !pn) return null;

  const scored = docs.map((d) => {
    const q = splitName(d.fullName);
    const qf = squash(q.first), ql = squash(q.last), qn = squash(rawNick(d.nickName));
    const firstOk = !!pf && pf === qf;
    const lastDist = pl && ql ? editDistance(pl, ql) : 99;
    const lastOk = lastDist === 0;
    const lastNear = lastDist <= 2 && Math.min(pl.length, ql.length) >= 4;
    const nickOk = !!pn && pn === qn;
    let score = 0; let why = '';
    if (firstOk && lastOk) { score = 4; why = 'ชื่อ-นามสกุลตรงกับทะเบียน'; }
    else if (firstOk && nickOk) { score = 3.5; why = 'ชื่อจริงและชื่อเล่นตรงกับทะเบียน'; }
    else if (firstOk && lastNear) { score = 3; why = `ชื่อจริงตรง นามสกุลสะกดต่างกันเล็กน้อย (${q.last})`; }
    else if (firstOk) { score = 2; why = 'ชื่อจริงตรง'; }
    else if (nickOk && lastNear) { score = 2.5; why = 'ชื่อเล่นและนามสกุลตรง'; }
    else if (nickOk) { score = 1; why = 'ชื่อเล่นตรง'; }
    return { d, score, why };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  const top = scored[0];
  const tie = scored.filter((x) => x.score === top.score && x.d.licNo !== top.d.licNo);
  if (tie.length) return null;
  // ตรงแค่ชื่อจริงหรือชื่อเล่นอย่างเดียว ต้องไม่มีคนอื่นตรงแบบเดียวกันด้วย
  if (top.score <= 2 && scored.filter((x) => x.score === top.score).length > 1) return null;

  return {
    licNo: top.d.licNo, fullName: top.d.fullName, nickName: top.d.nickName,
    level: top.score >= 3 ? 'STRONG' : 'LIKELY',
    why: top.why,
  };
}
