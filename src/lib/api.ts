/* ============================================================================
 * api.ts — ชั้นเรียกข้อมูล
 * หลักการเดียวกับระบบเดิม แต่เร็วกว่ามาก:
 *   · หนึ่งหน้าจอ = หนึ่งคำขอ (RPC ตัวเดียวคืนทุกอย่างที่หน้านั้นต้องใช้)
 *   · แคชฝั่งเว็บผูกกับรอบ — สลับแท็บกลับมาที่เดิมไม่ยิงซ้ำ แก้ข้อมูลแล้วแคชหมดอายุทันที
 * ==========================================================================*/
import { supabase } from './supabase';
import type { CalcCtx, ShiftRow, DoctorRow, RateRow, SignRow, AdjustRow, ProcDayRow, PoolRateRow } from './calc';

export interface Me {
  username: string; name: string; role: string; roleTh: string;
  branches: string[]; allBranch: boolean; licNo: string | null;
  /** แท็บที่ IT กำหนดให้เห็นเป็นรายบุคคล — null = ใช้ค่าเริ่มต้นตามบทบาท */
  tabs: string[] | null;
}
export interface BranchInfo {
  code: string; nameTh: string; nameEn: string; fileCode: string; company: string;
}
export interface Boot { me: Me; branches: BranchInfo[]; config: Record<string, string> }

export interface PeriodRow {
  pid: string; branch: string; ym: string; status: string; cover_mode: string;
  submitted_by?: string; submitted_at?: string; reviewed_by?: string; reviewed_at?: string;
  approved_by?: string; approved_at?: string; paid_by?: string; paid_at?: string; paid_ref?: string;
  proc_rows: number; proc_sum: number; doc_count: number; shift_rows: number;
  unmatched: { name: string; count: number; sum: number }[];
  dup_groups: number; signed_docs: number; snapshot?: unknown; note?: string;
}

export interface Workspace {
  pid: string; branch: string; ym: string;
  period: PeriodRow | null;
  procDays: ProcDayRow[];
  shifts: ShiftRow[];
  doctors: DoctorRow[];
  rates: RateRow[];
  /** อัตราจากคลังรายชื่อแพทย์ ของแพทย์ที่อยู่ในรอบนี้ (ใช้เป็นอัตราสำรอง) */
  poolRates?: PoolRateRow[];
  adjusts: AdjustRow[];
  signs: SignRow[];
  aliases: { alias: string; licNo: string; branch: string; confirmedBy: string; confirmedAt: string }[];
  imports: ImportLog[];
  history: { step: string; action: string; actor: string; at: string; note: string }[];
}

export type ImportMode = 'WEEK' | 'MONTH_END' | 'FULL';
export interface ImportLog {
  id?: string;
  kind: string; fileName: string; rowsRead: number; rowsDoctor: number; rowsOther: number;
  sumDoctorFee: number; status: string; by: string; at: string; note: string;
  /** WEEK = รายสัปดาห์ (แทนเฉพาะช่วงวันที่) · MONTH_END = ปิดยอดสิ้นเดือน · FULL = ทั้งเดือนแบบเดิม */
  mode?: ImportMode; dateFrom?: string | null; dateTo?: string | null;
  /** ยอดค่ามือเดิมในช่วงวันที่เดียวกันก่อนนำเข้าไฟล์นี้ */
  prevSum?: number | null; label?: string;
}
export interface ImportHistRow extends ImportLog {
  id: string;
  doctors: { licNo: string; name: string; amount: number; rows: number; days: number }[];
}

export interface DoctorImportResult {
  dry: boolean; mode: string; rows: number;
  poolNew: number; poolChanged: number; poolSame: number; registered: number;
  docChanges: { licNo: string; who: string; field: string; old: string; new: string }[];
  docUpdated: number;
  notInFile: { licNo: string; who: string }[];
}

export type RegTodoKind = 'UNREGISTERED' | 'POOL' | 'UNKNOWN' | 'INCOMPLETE';
export interface RegTodo {
  key: string; licNo: string; kind: RegTodoKind; name: string; nick: string; inPool: boolean;
  branches: string[]; lastYm: string; days?: number;
  /** ช่องที่ยังว่าง: full_name · bank · bank_acc · id_card · address · email · payee_name · inactive */
  missing: string[];
  /** สาขา/เดือนที่มีงาน แต่ยังไม่มีอัตราที่มีผลในเดือนนั้น */
  rateGaps: { branch: string; ym: string }[];
}

export interface DashRow {
  code: string; nameTh: string; nameEn: string; status: string;
  procRows: number; procSum: number; doctors: number; shiftRows: number;
  signedDocs: number; unmatched: number; paidRef: string; submittedBy: string; approvedAt: string;
}
export interface Dash {
  ym: string; rows: DashRow[];
  totalProcSum: number; totalDoctors: number; totalBranches: number;
}

export interface MailRow {
  licNo: string; name: string; nick: string;
  email: string | null;
  gross: number; tax: number; net: number;
  signed: boolean;
  lastMail: string | null; lastTaxMail: string | null;
}
export interface ClockSign {
  id: number; licNo: string; workDate: string; mode: 'IN' | 'OUT'; time: string;
  supervisor: string; signedAt: string; by: string;
}

export interface MailTargets {
  pid: string; branch: string; ym: string; status: string; rows: MailRow[];
}

export interface PoolRow {
  licNo: string; name: string; nick: string;
  bank: string; bankAcc: string;
  email: string | null; contact: string;
  source: string; payeeType: string; payeeName: string;
}
export interface PoolSearch {
  /** จำนวนที่ยังไม่ได้ขึ้นทะเบียนทั้งคลัง (ไม่สนคำค้น) */
  pool: number;
  /** จำนวนที่ตรงคำค้น — อาจมากกว่า rows.length เพราะจำกัดจำนวนแถวที่ส่งกลับ */
  found: number;
  rows: PoolRow[];
}

export interface RosterRow {
  branch: string; workDate: string; docLabel: string;
  /** จับคู่ทะเบียนแพทย์ได้ (ว่าง = ยังจับคู่ไม่ได้) */
  licNo: string;
  /** ไม่อยู่ในทะเบียน แต่เจอในคลังรายชื่อแพทย์ */
  poolLic: string;
  amGroup: string;
  /** "ยืนยัน" = ขึ้นเวรจริง · "ยกเลิก" = เวรถูกยกเลิกและไม่มีคนลงแทน */
  status: string;
  /** ที่มาของการเปลี่ยนเวร เช่น "ลงแทนหมอหลี (เดิม: หมอหลี — หมอติดธุระ)" */
  note: string;
}
export interface RosterMonth {
  ym: string;
  rows: RosterRow[];
  /** เลข ว. → ชื่อเต็ม (เฉพาะคนที่จับคู่ทะเบียนได้) */
  names: Record<string, string>;
}
export interface RosterImportResult {
  ym: string; saved: number; removed: number; matched: number; pooled: number;
  /** เวรที่ยกเลิกแล้วไม่มีคนลงแทน */
  cancelled: number;
  /** วันที่ไฟล์มี 2 แถว (ยกเลิก + คนลงแทน) แล้วระบบรวมให้เหลือแถวเดียว */
  merged: number;
  /** แถวที่ได้เลข ว. มาจากไฟล์ตรง ๆ (ไม่ต้องเดาจากชื่อ) */
  fromFileLic: number;
  /** แพทย์ที่ระบบขึ้นทะเบียนให้อัตโนมัติ (-1 = ขึ้นทะเบียนไม่สำเร็จ) */
  registered: number;
  unmatched: { name: string; count: number }[];
  badBranch: { code: string; count: number }[];
  /** ชื่อในไฟล์กับชื่อในทะเบียนไม่ตรงกัน — ไม่ใช่ข้อผิดพลาด แต่ควรตรวจ */
  mismatch: { licNo: string; file: string; registry: string }[];
}

export interface SignView {
  licNo: string; name: string; branch: string; branchTh: string; ym: string;
  gross: number; tax: number; net: number;
  payeeType: string; payeeName: string; bank: string; bankAcc: string;
  signedAt: string | null;
}

/* ---------------------------- แคชในหน่วยความจำ ---------------------------- */
const cache = new Map<string, unknown>();
export const dropCache = (prefix?: string) => {
  if (!prefix) { cache.clear(); return; }
  [...cache.keys()].forEach((k) => { if (k.startsWith(prefix)) cache.delete(k); });
};

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  // ฟังก์ชัน fee_* ทั้งหมดอยู่ที่ schema public (เรียกผ่าน PostgREST เป็น rpc ปกติ)
  // ส่วน client หลักตั้ง default schema เป็น fee ไว้สำหรับ .from() ตารางตรง ๆ ด้านล่าง
  const { data, error } = await supabase.schema('public').rpc(fn, args);
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
  return data as T;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;
  const v = await load();
  cache.set(key, v);
  return v;
}

/* --------------------------------- อ่าน --------------------------------- */
export const api = {
  bootstrap: () => rpc<Boot>('fee_bootstrap'),

  dashboard: (ym: string) => cached(`dash:${ym}`, () => rpc<Dash>('fee_dashboard', { p_ym: ym })),

  workspace: (branch: string, ym: string) =>
    cached(`ws:${branch}:${ym}`, () => rpc<Workspace>('fee_workspace', { p_branch: branch, p_ym: ym })),

  doctorSummary: (ym: string) => rpc<unknown[]>('fee_doctor_summary', { p_ym: ym }),

  /** ประกอบ ctx สำหรับเครื่องคำนวณจากข้อมูลที่โหลดมาครั้งเดียว */
  toCalcCtx(ws: Workspace, config: Record<string, string>): CalcCtx {
    return {
      branch: ws.branch, ym: ws.ym,
      coverMode: ((ws.period?.cover_mode || config.COVER_SHIFT_SOURCE || 'SHEET') as 'SHEET' | 'HOURS'),
      procDays: ws.procDays,
      unmatched: ws.period?.unmatched || [],
      dupGroups: ws.period?.dup_groups || 0,
      shifts: ws.shifts,
      doctors: ws.doctors,
      rates: ws.rates,
      poolRates: ws.poolRates || [],
      defaultRate: config.DEFAULT_HOURLY_RATE || '',
      adjusts: ws.adjusts,
      signs: ws.signs,
      signMode: config.REQUIRE_DOCTOR_SIGN || 'WARN',
      graceEnable: config.GRACE_ENABLE || 'Y',
      graceMin: config.GRACE_MIN || 15,
      schedStart: config.SCHED_START || '12:00',
      schedEnd: config.SCHED_END || '20:00',
      graceEffDate: config.GRACE_EFFDATE || '2026-09-01',
    };
  },

  /* -------------------------------- เขียน -------------------------------- */
  /** นำเข้ารายงานค่าหัตถการ
   *  WEEK = แทนที่เฉพาะแถวในช่วงวันที่ dateFrom–dateTo (สัปดาห์อื่นของเดือนอยู่ครบ)
   *  MONTH_END = ปิดยอดสิ้นเดือน แทนที่ทั้งเดือน · ทุกไฟล์ถูกเก็บยอดไว้ดูย้อนหลังได้ตลอด */
  async importProc(p: {
    branch: string; ym: string; rows: unknown[]; file: string; hash: string;
    mode: ImportMode; dateFrom?: string; dateTo?: string; label?: string;
  }) {
    const r = await rpc('fee_import_proc2', {
      p_branch: p.branch, p_ym: p.ym, p_rows: p.rows, p_file: p.file, p_hash: p.hash,
      p_mode: p.mode, p_from: p.dateFrom || null, p_to: p.dateTo || null, p_label: p.label || '',
    });
    dropCache();
    return r as {
      pid: string; rowsRead: number; rowsDoctor: number; rowsOther: number; sumDoctorFee: number;
      prevSum: number; mode: ImportMode; dateFrom: string; dateTo: string;
    };
  },

  importHistory: (branch: string, ym: string) =>
    rpc<ImportHistRow[]>('fee_import_history', { p_branch: branch, p_ym: ym }),

  async saveAlias(alias: string, licNo: string, branch: string, ym: string) {
    const r = await rpc('fee_save_alias', { p_alias: alias, p_lic: licNo, p_branch: branch, p_ym: ym });
    dropCache();
    return r;
  },

  async rematch(branch: string, ym: string) {
    const r = await rpc('fee_rematch', { p_branch: branch, p_ym: ym });
    dropCache();
    return r as { matched: number; unmatched: unknown[] };
  },

  async saveShifts(branch: string, ym: string, rows: unknown[]) {
    const r = await rpc('fee_save_shifts', { p_branch: branch, p_ym: ym, p_rows: rows });
    dropCache();
    return r as { saved: number };
  },

  async workflow(branch: string, ym: string, action: string, note = '', snapshot: unknown = null) {
    const r = await rpc('fee_workflow', {
      p_branch: branch, p_ym: ym, p_action: action, p_note: note, p_snapshot: snapshot,
    });
    dropCache();
    return r as { pid: string; status: string };
  },

  async signMonth(p: {
    branch: string; ym: string; licNo: string; hash: string; png: string;
    signer: string; method?: string; device?: string;
  }) {
    const r = await rpc('fee_sign_month', {
      p_branch: p.branch, p_ym: p.ym, p_lic: p.licNo, p_hash: p.hash, p_png: p.png,
      p_signer: p.signer, p_method: p.method || 'DRAW', p_device: p.device || navigator.userAgent.slice(0, 80),
    });
    dropCache();
    return r;
  },

  /* ------------------------- ตารางที่แก้ตรงได้ (RLS คุม) ------------------------- */
  async listDoctors() {
    const { data, error } = await supabase.from('doctor').select('*').order('lic_no');
    if (error) throw new Error(error.message);
    return data;
  },
  async saveDoctor(d: Record<string, unknown>) {
    const { error } = await supabase.from('doctor').upsert({ ...d, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    dropCache();
  },
  /* ------------------------------ ตารางแพทย์ ------------------------------
   * แผนขึ้นเวรรายเดือนของทุกสาขา — อ่านได้ทุกคนที่ใช้ระบบ
   * นำเข้าผ่าน RPC เพื่อให้จับคู่ชื่อเล่นเป็นเลข ว. และแทนที่ทั้งเดือนในครั้งเดียว
   */
  roster: (ym: string) => cached(`roster:${ym}`, () => rpc<RosterMonth>('fee_roster_get', { p_ym: ym })),

  /** เพิ่ม/แก้/ลบ เวรทีละช่องจากหน้าปฏิทิน — ส่ง label ว่าง = ลบ (ไม่มีแพทย์) */
  async rosterSet(branch: string, workDate: string, label: string, licNo?: string) {
    const r = await rpc<{ cleared: boolean; ym: string; licNo?: string; poolLic?: string }>(
      'fee_roster_set',
      { p_branch: branch, p_date: workDate, p_label: label, p_lic: licNo || null },
    );
    dropCache('roster:'); dropCache('todo');
    return r;
  },

  /** จับคู่ชื่อในตารางแพทย์ใหม่ทั้งเดือน + ลบช่อง OFF ที่หลุดเข้ามา (ไม่ต้องนำเข้าไฟล์ซ้ำ) */
  /** ผูก "ชื่อในตารางแพทย์" ที่ยังไม่รู้ว่าใคร เข้ากับแพทย์ในทะเบียน (ทุกช่องที่เขียนชื่อนี้) */
  async rosterAssignLabel(label: string, licNo: string) {
    const r = await rpc<{ updated: number; aliases: number }>('fee_roster_assign_label', { p_label: label, p_lic: licNo });
    dropCache('roster:'); dropCache('todo');
    return r;
  },

  async rosterRematch(ym: string) {
    const r = await rpc<{ removedOff: number; matched: number; stillUnknown: number }>(
      'fee_roster_rematch', { p_ym: ym });
    dropCache('roster:'); dropCache('todo');
    return r;
  },

  async rosterImport(ym: string, rows: unknown[]) {
    const r = await rpc<RosterImportResult>('fee_roster_import', { p_ym: ym, p_rows: rows });
    dropCache('roster:'); dropCache('todo');
    return r;
  },

  /* --------------------- คลังรายชื่อแพทย์ (doctor_pool) ---------------------
   * คลังนี้ย้ายมาจากระบบเดิมพร้อมกัน แต่ไม่เคยมีหน้าจอให้ใช้
   * ค้นหาและขึ้นทะเบียนผ่าน RPC เท่านั้น เพื่อให้มี audit ทุกครั้งที่เขียนทะเบียน
   */
  poolSearch: (q: string, limit = 50) =>
    rpc<PoolSearch>('fee_pool_search', { p_q: q, p_limit: limit }),

  async poolPromote(licNos: string[]) {
    const r = await rpc<{ added: number; skipped: number; missing: number }>(
      'fee_pool_promote', { p_lic_nos: licNos },
    );
    dropCache();
    return r;
  },

  /** นำเข้าทะเบียนแพทย์จากไฟล์ Excel "Data หมอ Update"
   *  dry = true → คืนผลเปรียบเทียบอย่างเดียว · skip = ["เลข ว.|ชื่อช่อง"] ที่ไม่ต้องแก้ */
  async doctorImport(rows: unknown[], mode: 'FILL' | 'OVERWRITE' | 'NONE', dry: boolean, file: string, skip: string[] = []) {
    const r = await rpc<DoctorImportResult>('fee_doctor_import', {
      p_rows: rows, p_doc_mode: mode, p_dry: dry, p_file: file, p_skip: skip,
    });
    if (!dry) dropCache();
    return r;
  },

  /** แพทย์ที่ต้องขึ้นทะเบียน / กรอกข้อมูลให้ครบ / ตั้งอัตรา (ดูจากงานจริง 3 เดือนล่าสุด) */
  registryTodo: () => cached('todo', () => rpc<RegTodo[]>('fee_registry_todo')),

  async listRates() {
    const { data, error } = await supabase.from('rate').select('*').order('lic_no').order('eff_from');
    if (error) throw new Error(error.message);
    return data;
  },
  async saveRate(r: Record<string, unknown>) {
    const { error } = await supabase.from('rate').upsert(r);
    if (error) throw new Error(error.message);
    dropCache();
  },
  async deleteRate(id: string) {
    const { error } = await supabase.from('rate').delete().eq('id', id);
    if (error) throw new Error(error.message);
    dropCache();
  },
  async listConfig() {
    const { data, error } = await supabase.from('config').select('*').order('key');
    if (error) throw new Error(error.message);
    return data;
  },
  async saveConfig(key: string, value: string) {
    const { error } = await supabase.from('config')
      .update({ value, updated_at: new Date().toISOString() }).eq('key', key);
    if (error) throw new Error(error.message);
    dropCache();
  },
  async listStaff() {
    const { data, error } = await supabase.from('staff').select('*');
    if (error) throw new Error(error.message);
    const ids = (data || []).map((s: { id: string }) => s.id);
    const { data: profs } = await supabase.schema('public').from('profiles')
      .select('id, username, display_name, active, last_login').in('id', ids);
    const byId = new Map((profs || []).map((p: { id: string }) => [p.id, p]));
    return (data || []).map((s: { id: string }) => ({ ...s, profile: byId.get(s.id) }));
  },
  async saveStaff(s: Record<string, unknown>) {
    const { error } = await supabase.from('staff').upsert(s);
    if (error) throw new Error(error.message);
    dropCache();
  },
  async listAudit(limit = 200) {
    const { data, error } = await supabase.from('audit').select('*')
      .order('at', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return data;
  },
  /* ----------------------------- ส่งอีเมลหาแพทย์ -----------------------------
   * รายชื่อปลายทางอ่านผ่าน RPC ปกติ ส่วนการส่งจริงต้องผ่าน Edge Function
   * เพราะกุญแจของผู้ให้บริการอีเมลอยู่ฝั่งเซิร์ฟเวอร์เท่านั้น
   */
  emailTargets: (branch: string, ym: string) =>
    rpc<MailTargets>('fee_email_targets', { p_branch: branch, p_ym: ym }),

  async sendMail(
    action: 'sign_invite' | 'tax_detail' | 'wht_cert', branch: string, ym: string, licNos: string[],
    extra?: { attachments?: Record<string, { filename: string; content: string }>; note?: string },
  ) {
    const { data, error } = await supabase.functions.invoke('fee-send-email', {
      body: { action, branch, ym, licNos, ...(extra || {}) },
    });
    if (error) {
      let detail = '';
      const ctx = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context;
      try { detail = (await ctx?.json?.())?.error || ''; } catch { /* ไม่มีตัวข้อความ */ }
      throw new Error(detail || error.message);
    }
    if (data?.error) throw new Error(data.error);
    return data as {
      ok: true; sent: number; total: number;
      results: { licNo: string; ok: boolean; error?: string }[];
      logError?: string;
    };
  },

  /** ส่งเมลตัวอย่าง (ข้อมูลสมมติ) ถึงอีเมลที่กรอก — ไว้ดูหน้าตาเมลจริงและทดสอบว่าส่งได้ */
  async sendTest(
    kind: 'sign_invite' | 'tax_detail' | 'wht_cert', testTo: string, branch: string, ym: string,
    testFile?: { filename: string; content: string },
  ) {
    const { data, error } = await supabase.functions.invoke('fee-send-email', {
      body: { action: 'test', kind, testTo, branch, ym, ...(testFile ? { testFile } : {}) },
    });
    if (error) {
      let detail = '';
      const ctx = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context;
      try { detail = (await ctx?.json?.())?.error || ''; } catch { /* ไม่มีตัวข้อความ */ }
      throw new Error(detail || error.message);
    }
    if (data?.error) throw new Error(data.error);
    return data as { ok: true; to: string };
  },

  /* -------------------- ลายเซ็นแพทย์ตอนเข้า/ออกเวร -------------------- */
  clockSignAdd: (p: {
    branch: string; licNo: string; date: string; mode: 'IN' | 'OUT'; time: string; png: string; supervisor: string;
  }) => rpc<{ id: number }>('fee_clock_sign_add', {
    p_branch: p.branch, p_lic: p.licNo, p_date: p.date, p_mode: p.mode, p_time: p.time,
    p_png: p.png, p_supervisor: p.supervisor,
  }),
  clockSignList: (branch: string, ym: string) =>
    rpc<ClockSign[]>('fee_clock_sign_list', { p_branch: branch, p_ym: ym }).catch(() => [] as ClockSign[]),
  clockSignPng: (id: number) => rpc<string>('fee_clock_sign_png', { p_id: id }),

  /* ------------- หน้าเซ็นของแพทย์ (เรียกได้โดยไม่ต้องล็อกอิน) ------------- */
  signOpen: (token: string) => rpc<SignView>('fee_sign_open', { p_token: token }),
  /** รายละเอียดทั้งหมดที่ล็อกไว้ตอนอนุมัติ (ใบเวรรายวัน + ค่ามือทุกแถว) — null ถ้าเป็นรอบที่อนุมัติก่อนมีระบบนี้ */
  signDetail: (token: string) =>
    rpc<import('./mailtpl').Detail | null>('fee_sign_detail', { p_token: token }).catch(() => null),
  signSubmit: (token: string, png: string) =>
    rpc<{ ok: true; signedAt: string }>('fee_sign_submit', {
      p_token: token, p_png: png, p_device: navigator.userAgent.slice(0, 120),
    }),

  /* --------------------- จัดการบัญชีผู้ใช้ (เฉพาะ IT) ---------------------
   * การสร้าง/ลบบัญชีต้องใช้กุญแจระดับเซิร์ฟเวอร์ จึงทำผ่าน Edge Function
   * ไม่ใช่จากเบราว์เซอร์ตรง ๆ — ฟังก์ชันนั้นตรวจซ้ำอีกชั้นว่าคนเรียกเป็น IT จริง
   */
  async adminUser(
    action: 'create' | 'delete' | 'reset_password',
    payload: Record<string, unknown>,
  ) {
    const { data, error } = await supabase.functions.invoke('fee-admin-users', {
      body: { action, ...payload },
    });
    if (error) {
      // ข้อความจริงอยู่ในตัว response ไม่ใช่ error.message ที่เป็นแค่ "non-2xx"
      let detail = '';
      const ctx = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context;
      try { detail = (await ctx?.json?.())?.error || ''; } catch { /* ไม่มีตัวข้อความ */ }
      throw new Error(detail || error.message);
    }
    if (data?.error) throw new Error(data.error);
    dropCache();
    return data as { ok: true; id?: string; username?: string };
  },

  /** รายการหัตถการดิบของรอบ — อ่านเฉพาะตอนต้องตรวจย้อนกลับ/ส่งออก CSV */
  async listProc(pid: string) {
    const { data, error } = await supabase.from('proc').select('*').eq('pid', pid).order('id');
    if (error) throw new Error(error.message);
    return data;
  },
};
