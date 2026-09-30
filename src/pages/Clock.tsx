import React, { useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace, type RosterMonth } from '../lib/api';
import { useAuth } from '../lib/auth';
import { monthHash, signStatus, type ShiftRow } from '../lib/calc';
import { cellStr, minutesToHHMM, toIsoDate, toThaiDate, toMinutes } from '../lib/core';
import {
  Alerts, BranchMonthPicker, Card, Note, SignaturePad, Skeleton, StatusPill, useAsync, YmLabel,
} from '../components/ui';
import { docNick } from '../lib/names';

/** เวลาที่บันทึกคือเวลาของเครื่องที่เปิดหน้าจอ แต่แสดงตามเขตเวลาไทยเสมอ */
function nowHHMM() {
  const d = new Date();
  return minutesToHHMM(d.getHours() * 60 + d.getMinutes());
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------------- ผู้ดูแลการลงเวลา ----------------------
 * เก็บไว้ในหมายเหตุของใบเวร แบบอ่านออกทั้งคนและเครื่อง:
 *   "เข้า 12:00 ดูแลโดย คุณเอ · ออก 20:05 ดูแลโดย คุณบี"
 * ถ้าเวลาที่เลือกต่างจากเวลาที่กดจริงเกิน 5 นาที ต่อท้าย "(กด 12:34)" ไว้ตรวจย้อนได้
 */
const SUP_KEY = 'fee.supervisors';
const loadSup = (): string[] => { try { return JSON.parse(localStorage.getItem(SUP_KEY) || '[]'); } catch { return []; } };
const saveSup = (name: string) => {
  try {
    const list = [name, ...loadSup().filter((x) => x !== name)].slice(0, 20);
    localStorage.setItem(SUP_KEY, JSON.stringify(list));
  } catch { /* ไม่เป็นไร */ }
};
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export function supervisorsOf(note: string) {
  const inM = note.match(/เข้า (\d{1,2}:\d{2}) ดูแลโดย ([^·(]+)/);
  const outM = note.match(/ออก (\d{1,2}:\d{2}) ดูแลโดย ([^·(]+)/);
  return { in: inM ? inM[2].trim() : '', out: outM ? outM[2].trim() : '' };
}
const KINDS = [
  { v: 'SHIFT', t: 'เวรปกติ' }, { v: 'NIGHT', t: 'เวรข้ามคืน' },
  { v: 'MEETING', t: 'ประชุมประจำเดือน' }, { v: 'KOL', t: 'ค่าตอบแทน KOL' },
];
interface Dlg { mode: 'in' | 'out'; licNo: string; name: string; time: string; by: string;
  kind: string; brk: string; note: string; timeIn?: string }

export default function Clock({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [roster, setRoster] = useState<RosterMonth | null>(null);
  const [clock, setClock] = useState(nowHHMM());
  const [signFor, setSignFor] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  useEffect(() => {
    const t = setInterval(() => setClock(nowHHMM()), 15000);
    return () => clearInterval(t);
  }, []);

  const load = () => {
    setWs(null);
    api.workspace(scope.branch, scope.ym).then(setWs).catch((e) => setErr(e.message));
  };
  useEffect(load, [scope.branch, scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ตารางแพทย์ของ "เดือนที่วันนี้อยู่" — กระดานลงเวลาเป็นของวันนี้เสมอ
     ไม่ผูกกับเดือนที่เลือกดู (แคชตามเดือน สลับสาขาไม่ยิงซ้ำ) */
  const todayYm = todayIso().substring(0, 7);
  useEffect(() => {
    setRoster(null);
    api.roster(todayYm).then(setRoster).catch(() => setRoster({ ym: todayYm, rows: [], names: {} }));
  }, [todayYm]);

  const status = ws?.period?.status || 'NONE';
  const locked = ['APPROVED', 'PAID'].includes(status);
  const today = todayIso();
  const myLic = boot?.me.licNo;

  /** เวรตามตารางของ "สาขานี้ วันนี้" — ตัวกำหนดว่ากระดานลงเวลาจะมีใครบ้าง
   *  ตารางแพทย์เก็บ 1 สาขา 1 วัน 1 แถว แต่เขียนเผื่อไว้เป็นหลายแถวได้ */
  const todayPlans = useMemo(
    () => (roster?.rows || []).filter((r) => r.branch === scope.branch && r.workDate === today),
    [roster, scope.branch, today],
  );
  /** เวรที่ยกเลิกแล้วไม่มีคนลงแทน — ไม่นับเป็นคนที่ต้องมาลงเวลา แต่ต้องแจ้งให้เห็น */
  const cancelled = useMemo(() => todayPlans.filter((r) => r.status === 'ยกเลิก'), [todayPlans]);
  const activePlans = useMemo(() => todayPlans.filter((r) => r.status !== 'ยกเลิก'), [todayPlans]);
  /** เลข ว. ของแพทย์ที่มีเวรวันนี้ที่สาขานี้ */
  const planLics = useMemo(
    () => new Set(activePlans.map((r) => r.licNo).filter(Boolean)),
    [activePlans],
  );
  /** มีเวรวันนี้ แต่ยังไม่มีเลข ว. ในระบบ → ลงเวลาให้ไม่ได้ ต้องบอกให้รู้ */
  const planUnknown = useMemo(
    () => activePlans.filter((r) => !r.licNo).map((r) => r.docLabel),
    [activePlans],
  );

  /** แพทย์ที่มีใบเวลาของ "วันนี้" อยู่แล้ว — คนที่ถูกเพิ่มหรือแก้ไขด้วยมือต้องคงอยู่บนกระดาน */
  const onDuty = useMemo(() => new Set(
    (ws?.shifts || [])
      .filter((s) => toIsoDate(s.workDate) === today)
      .map((s) => cellStr(s.licNo)).filter(Boolean),
  ), [ws, today]);

  /** ไม่มีทั้งเวรตามตารางและใบเวลาของวันนี้ → เปิดให้เลือกจากทะเบียนทั้งหมด
   *  (เช่น สาขายังไม่ได้นำเข้าตาราง หรือมีหมอมาแทนกะทันหัน) */
  const onBoard = planLics.size + onDuty.size;
  const noRoster = (roster?.rows || []).length === 0;
  const [showAll, setShowAll] = useState(false);
  const viewingToday = scope.ym === today.substring(0, 7);

  const docs = useMemo(() => {
    const list = (ws?.doctors || []).filter((d) => {
      if (myLic) return d.licNo === myLic;                 // บัญชีแพทย์เห็นเฉพาะตัวเอง
      if (showAll) return true;                            // กดขอดูทั้งทะเบียน
      const lic = d.licNo || '';
      return planLics.has(lic) || onDuty.has(lic);         // มีเวรวันนี้ หรือถูกเพิ่ม/แก้ไขไว้แล้ว
    });
    // คนที่อยู่เวรตามตารางวันนี้ ขึ้นก่อนเสมอ
    return list.sort((a, b) => {
      const at = planLics.has(a.licNo || '') ? 0 : 1;
      const bt = planLics.has(b.licNo || '') ? 0 : 1;
      if (at !== bt) return at - bt;
      return (a.nickName || a.fullName || '').localeCompare(b.nickName || b.fullName || '', 'th');
    });
  }, [ws, myLic, onDuty, showAll, planLics]);

  /** สถานะวันนี้ของแพทย์แต่ละคน: ยังไม่เข้า / อยู่ในเวร / ออกแล้ว */
  const board = useMemo(() => docs.map((d) => {
    const rows = (ws?.shifts || []).filter(
      (s) => cellStr(s.licNo) === d.licNo && toIsoDate(s.workDate) === today,
    );
    const open = rows.find((s) => cellStr(s.timeIn) && !cellStr(s.timeOut));
    const done = rows.filter((s) => cellStr(s.timeIn) && cellStr(s.timeOut));
    return { doc: d, open, done, rows };
  }), [docs, ws, today]);

  /** เขียนใบเวรทั้งรอบกลับไป โดยแก้เฉพาะบรรทัดที่เกี่ยวข้อง */
  async function writeShifts(mutate: (rows: ShiftRow[]) => ShiftRow[], okMsg: string) {
    if (!ws) return;
    await run(async () => {
      const next = mutate(ws.shifts.map((s) => ({ ...s })));
      await api.saveShifts(scope.branch, scope.ym, next.map((s) => ({
        id: s.id, licNo: s.licNo, workDate: toIsoDate(s.workDate),
        timeIn: cellStr(s.timeIn), timeOut: cellStr(s.timeOut),
        breakMin: Number(s.breakMin) || 0,
        specialAmt: cellStr(s.specialAmt), handOverride: cellStr(s.handOverride),
        deductOther: Number(s.deductOther) || 0, kind: cellStr(s.kind) || 'SHIFT',
        note: cellStr(s.note), source: cellStr(s.source) || 'MANUAL',
        signId: s.signId || '', signedAt: s.signedAt || '',
      })));
      load();
      setMsg(okMsg);
    });
  }

  /* ---------- กล่องลงเวลา: เลือกเวลา + ผู้ดูแล ---------- */
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [supList, setSupList] = useState<string[]>(loadSup);
  const defaultBy = () => supList[0] || boot?.me.name || '';

  const openIn = (licNo: string, name: string) => setDlg({
    mode: 'in', licNo, name, time: nowHHMM(), by: defaultBy(), kind: 'SHIFT', brk: '0', note: '',
  });
  const openOut = (licNo: string, name: string, open: ShiftRow) => setDlg({
    mode: 'out', licNo, name, time: nowHHMM(), by: defaultBy(), kind: cellStr(open.kind) || 'SHIFT',
    brk: String(Number(open.breakMin) || 0), note: '', timeIn: cellStr(open.timeIn),
  });

  /** ข้อความหมายเหตุที่บันทึกคู่กับเวลา */
  const stamp = (mode: 'in' | 'out', time: string, by: string, extra: string) => {
    const real = nowHHMM();
    const off = Math.abs(toMin(real) - toMin(time)) > 5 ? ` (กด ${real})` : '';
    return [`${mode === 'in' ? 'เข้า' : 'ออก'} ${time} ดูแลโดย ${by}${off}`, extra.trim()].filter(Boolean).join(' · ');
  };

  const dlgError = (d: Dlg): string => {
    if (!/^\d{1,2}:\d{2}$/.test(d.time)) return 'เลือกเวลาให้ครบ';
    if (!d.by.trim()) return 'กรอกชื่อผู้ดูแลการลงเวลา';
    if (d.mode === 'out' && d.timeIn && d.kind !== 'NIGHT' && toMin(d.time) <= toMin(d.timeIn)) {
      return `เวลาออกต้องหลังเวลาเข้า (${d.timeIn}) — ถ้าเป็นเวรข้ามคืน เลือกประเภท “เวรข้ามคืน”`;
    }
    if (Number(d.brk) < 0 || Number.isNaN(Number(d.brk))) return 'เวลาพักไม่ถูกต้อง';
    return '';
  };

  const confirmDlg = () => {
    if (!dlg) return;
    const e = dlgError(dlg);
    if (e) { setErr(e); return; }
    const by = dlg.by.trim();
    saveSup(by); setSupList(loadSup());
    const d = dlg;
    setDlg(null);
    if (d.mode === 'in') {
      writeShifts(
        (rows) => [...rows, {
          id: '', licNo: d.licNo, workDate: today, timeIn: d.time, timeOut: '', breakMin: 0,
          specialAmt: '', handOverride: '', deductOther: 0, kind: d.kind, source: 'CLOCK',
          note: stamp('in', d.time, by, d.note),
        }],
        `บันทึกเข้าเวร ${d.name} ${d.time} น. · ดูแลโดย ${by}`,
      );
    } else {
      writeShifts(
        (rows) => rows.map((s) => (
          cellStr(s.licNo) === d.licNo && toIsoDate(s.workDate) === today
            && cellStr(s.timeIn) && !cellStr(s.timeOut)
            ? {
              ...s, timeOut: d.time, breakMin: Number(d.brk) || 0, kind: d.kind,
              note: [cellStr(s.note), stamp('out', d.time, by, d.note)].filter(Boolean).join(' · '),
            } : s
        )),
        `บันทึกออกเวร ${d.name} ${d.time} น. · ดูแลโดย ${by}`,
      );
    }
  };

  /** เซ็นรับรองใบเวลาทั้งเดือน — ลายเซ็นผูกกับลายนิ้วมือของใบเวรทั้งเดือน
   *  ถ้าใครแก้เวลาหลังเซ็น สถานะจะกลายเป็น “ต้องเซ็นใหม่” ทันที */
  async function doSign(licNo: string) {
    if (!png || !ws) { setErr('กรุณาเซ็นในกรอบก่อน'); return; }
    const doc = ws.doctors.find((d) => d.licNo === licNo);
    await run(async () => {
      const h = monthHash(ws.shifts, licNo);
      await api.signMonth({
        branch: scope.branch, ym: scope.ym, licNo, hash: h, png,
        signer: doc?.fullName || licNo,
      });
      setSignFor(null); setPng(null);
      load();
      setMsg('บันทึกลายเซ็นรับรองใบเวลาประจำเดือนแล้ว');
    });
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ลงเวลาและลายเซ็นแพทย์</h1>
        {ws && <StatusPill s={status} />}
        <div className="spacer" />
        <span className="pill rev tnum" style={{ fontSize: '1rem' }}>🕐 {clock} น.</span>
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} msg={msg} />

      {locked && <Note tone="warn">รอบนี้ถูกล็อกแล้ว บันทึกเวลาหรือลายเซ็นเพิ่มไม่ได้</Note>}

      {/* ---------- กระดานลงเวลาวันนี้ ---------- */}
      <Card title={<>ลงเวลาวันนี้ · {toThaiDate(today)}</>}>
        <p className="muted" style={{ marginTop: 0 }}>
          เปิดหน้าจอนี้ค้างไว้ที่เคาน์เตอร์ — แพทย์กดเข้า/ออกเวรเอง
          ระบบบันทึกบัญชีที่เปิดหน้าจอไว้เป็นพยานทุกครั้ง
        </p>
        {!myLic && (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              {activePlans.length > 0 ? (
                <span className="pill ok">
                  เวรวันนี้ · {scope.branch} = {activePlans.map((r) => r.docLabel).join(' · ')}
                </span>
              ) : noRoster ? (
                <span className="pill warn">
                  ยังไม่มีตารางแพทย์ของเดือนนี้ — นำเข้าที่แท็บ “ตารางแพทย์”
                </span>
              ) : cancelled.length > 0 ? (
                <span className="pill warn">
                  เวรวันนี้ · {scope.branch} = ยกเลิก ({cancelled.map((r) => r.docLabel).join(' · ')})
                </span>
              ) : (
                <span className="pill none">ตารางแพทย์วันนี้ · {scope.branch} = ไม่มีแพทย์</span>
              )}
              {onDuty.size > 0 && planLics.size < onDuty.size && (
                <span className="pill rev">มีคนลงเวลานอกตาราง {onDuty.size - planLics.size} คน</span>
              )}
              {!viewingToday && (
                <span className="pill warn">
                  กำลังดูเดือนอื่น — เปลี่ยนเดือนเป็นเดือนปัจจุบันก่อนจึงจะกดลงเวลาได้
                </span>
              )}
              <div className="spacer" />
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                เพิ่มแพทย์นอกตาราง (หมอมาแทนเวรกะทันหัน)
              </label>
            </div>
            {cancelled.length > 0 && activePlans.length > 0 && (
              <Note tone="info">
                วันนี้มีการเปลี่ยนเวร: <b>{cancelled.map((r) => r.docLabel).join(' · ')}</b> ยกเลิก
                {cancelled.some((r) => r.note) && <> ({cancelled.map((r) => r.note).filter(Boolean).join(' · ')})</>}
              </Note>
            )}
            {activePlans.some((r) => r.note) && (
              <Note tone="info">
                หมายเหตุเวรวันนี้: {activePlans.map((r) => r.note).filter(Boolean).join(' · ')}
              </Note>
            )}
            {planUnknown.length > 0 && (
              <Note tone="warn">
                แพทย์ที่มีเวรวันนี้แต่ยังไม่มีในทะเบียนแพทย์: <b>{planUnknown.join(' · ')}</b>
                {' '}— ลงเวลาให้ยังไม่ได้ ต้องเพิ่มเข้าทะเบียนแพทย์ (แท็บ “ทะเบียน”) ก่อน
              </Note>
            )}
          </>
        )}
        {!ws ? <Skeleton rows={4} /> : (
          <div className="grid g3">
            {board.map(({ doc, open, done }) => (
              <div key={doc.licNo} className="stat"
                style={planLics.has(doc.licNo || '')
                  ? { borderColor: 'var(--sage)', boxShadow: '0 0 0 2px var(--sage-lt) inset' } : undefined}
              >
                <div className="k">
                  ว.{doc.licNo}
                  {planLics.has(doc.licNo || '')
                    ? <span className="pill ok" style={{ marginLeft: 6 }}>เวรวันนี้</span>
                    : <span className="pill none" style={{ marginLeft: 6 }}>นอกตาราง</span>}
                </div>
                <div style={{ fontWeight: 600 }}>{docNick(doc.nickName) || doc.fullName}</div>
                <div className="s" style={{ marginBottom: 8 }}>
                  {open ? (
                    <span className="pill rev">อยู่ในเวร · เข้า {cellStr(open.timeIn)} น.</span>
                  ) : done.length ? (
                    <span className="pill ok">
                      ออกแล้ว {done.map((s) => `${cellStr(s.timeIn)}–${cellStr(s.timeOut)}`).join(', ')}
                    </span>
                  ) : (
                    <span className="pill none">ยังไม่ลงเวลา</span>
                  )}
                  {[...(open ? [open] : []), ...done].map((sh, i) => {
                    const sp = supervisorsOf(cellStr(sh.note));
                    return (sp.in || sp.out) ? (
                      <div key={i} className="muted" style={{ fontSize: '.78rem', marginTop: 4 }}>
                        👤 ผู้ดูแล{sp.in && <> · เข้า: <b>{sp.in}</b></>}{sp.out && <> · ออก: <b>{sp.out}</b></>}
                      </div>
                    ) : null;
                  })}
                </div>
                <div className="row">
                  {!open ? (
                    <button className="primary sm" disabled={busy || locked || !viewingToday}
                      onClick={() => openIn(doc.licNo!, docNick(doc.nickName) || doc.fullName || doc.licNo!)}
                    >
                      เข้าเวร
                    </button>
                  ) : (
                    <button className="sm" disabled={busy || locked || !viewingToday}
                      onClick={() => openOut(doc.licNo!, docNick(doc.nickName) || doc.fullName || doc.licNo!, open)}
                    >
                      ออกเวร
                    </button>
                  )}
                </div>
              </div>
            ))}
            {board.length === 0 && (
              <p className="muted">
                {(ws?.doctors || []).length === 0
                  ? 'ยังไม่มีแพทย์ในทะเบียน — เพิ่มที่แท็บ “ทะเบียน” ก่อน'
                  : noRoster
                    ? 'ยังไม่มีตารางแพทย์ของเดือนนี้ — นำเข้าที่แท็บ “ตารางแพทย์” หรือติ๊ก “เพิ่มแพทย์นอกตาราง” ด้านบน'
                    : cancelled.length > 0
                      ? 'เวรวันนี้ของสาขานี้ถูกยกเลิก และยังไม่มีใครลงเวลา — ถ้ามีหมอมาแทน ให้ติ๊ก “เพิ่มแพทย์นอกตาราง” ด้านบน'
                      : onBoard === 0 && planUnknown.length === 0
                        ? `วันนี้สาขา ${scope.branch} ไม่มีแพทย์ตามตาราง — ถ้ามีหมอมาลงเวร ให้ติ๊ก “เพิ่มแพทย์นอกตาราง” ด้านบน`
                        : 'แพทย์ที่มีเวรวันนี้ยังไม่มีในทะเบียนแพทย์ — ติ๊ก “เพิ่มแพทย์นอกตาราง” ด้านบนเพื่อลงเวลาชั่วคราว'}
              </p>
            )}
          </div>
        )}
      </Card>

      {/* ---------- รับรองใบเวลาประจำเดือน ---------- */}
      <Card title={<>รับรองใบเวลาประจำเดือน · <YmLabel ym={scope.ym} /></>}>
        {!ws ? <Skeleton rows={4} /> : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>แพทย์</th><th className="n">จำนวนเวร</th><th>สถานะลายเซ็น</th>
                  <th>เซ็นเมื่อ</th><th></th>
                </tr>
              </thead>
              <tbody>
                {(ws.doctors || [])
                  .filter((d) => (myLic ? d.licNo === myLic : true))
                  .filter((d) => ws.shifts.some((s) => cellStr(s.licNo) === d.licNo))
                  .map((d) => {
                  const mine = ws.shifts.filter((s) => cellStr(s.licNo) === d.licNo);
                  const st = signStatus(ws.signs, d.licNo!, mine);
                  const cls = st.status === 'OK' ? 'ok' : st.status === 'STALE' ? 'warn' : 'none';
                  const txt = st.status === 'OK' ? 'เซ็นแล้ว'
                    : st.status === 'STALE' ? 'ต้องเซ็นใหม่ (ข้อมูลเปลี่ยน)' : 'ยังไม่เซ็น';
                  return (
                    <React.Fragment key={d.licNo}>
                      <tr>
                        <td>{d.licNo} · {docNick(d.nickName) || d.fullName}</td>
                        <td className="n">{mine.length}</td>
                        <td><span className={`pill ${cls}`}>{txt}</span></td>
                        <td className="muted">{(st.signedAt || '').replace('T', ' ').substring(0, 16) || '—'}</td>
                        <td>
                          <button className="sm" disabled={locked}
                            onClick={() => { setSignFor(signFor === d.licNo ? null : d.licNo!); setPng(null); }}
                          >
                            {signFor === d.licNo ? 'ปิด' : 'ดู + เซ็นรับรอง'}
                          </button>
                        </td>
                      </tr>
                      {signFor === d.licNo && (
                        <tr className="sub">
                          <td colSpan={5}>
                            <div className="grid g2">
                              <div>
                                <h4>ใบเวลาที่จะรับรอง ({mine.length} วัน)</h4>
                                <div className="tablewrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                                  <table>
                                    <thead>
                                      <tr><th>วันที่</th><th>เข้า</th><th>ออก</th><th className="n">ชม.</th><th>หมายเหตุ</th></tr>
                                    </thead>
                                    <tbody>
                                      {mine.map((s, i) => {
                                        const ti = toMinutes(s.timeIn), to = toMinutes(s.timeOut);
                                        const dur = ti !== null && to !== null
                                          ? ((to >= ti ? to : to + 1440) - ti - (Number(s.breakMin) || 0)) : 0;
                                        return (
                                          <tr key={i}>
                                            <td>{toThaiDate(toIsoDate(s.workDate))}</td>
                                            <td>{cellStr(s.timeIn)}</td>
                                            <td>{cellStr(s.timeOut) || <span className="pill block">ยังไม่ออก</span>}</td>
                                            <td className="n">{dur ? (dur / 60).toFixed(2) : '—'}</td>
                                            <td className="muted">{cellStr(s.note)}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                              <div>
                                <h4>ลายเซ็นแพทย์</h4>
                                <SignaturePad onChange={setPng} />
                                {st.status === 'STALE' && (
                                  <Note tone="warn">
                                    ใบเวรถูกแก้หลังจากเซ็นครั้งก่อน — ต้องให้แพทย์ตรวจและเซ็นใหม่
                                  </Note>
                                )}
                                <button className="primary" style={{ marginTop: 8 }}
                                  disabled={busy || !png || locked}
                                  onClick={() => doSign(d.licNo!)}
                                >
                                  บันทึกลายเซ็นรับรอง
                                </button>
                                <p className="muted" style={{ marginBottom: 0 }}>
                                  ลายเซ็นผูกกับข้อมูลใบเวรทั้งเดือน ณ ตอนเซ็น —
                                  ถ้ามีการแก้เวลาภายหลัง ระบบจะขึ้นว่า “ต้องเซ็นใหม่” ทันที
                                  ไม่ปล่อยให้ดูเหมือนเซ็นแล้ว
                                </p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    
      {/* ---------- กล่องลงเวลา ---------- */}
      {dlg && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(35,38,31,.45)', zIndex: 60,
          display: 'grid', placeItems: 'center', padding: 16 }}
          onClick={(e) => { if (e.target === e.currentTarget) setDlg(null); }}
        >
          <div className="card" style={{ maxWidth: 420, width: '100%', margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>
              {dlg.mode === 'in' ? '🟢 เข้าเวร' : '🔴 ออกเวร'} · {dlg.name}
            </h3>
            <p className="muted" style={{ marginTop: -6 }}>
              {toThaiDate(today)} · สาขา {scope.branch}
              {dlg.mode === 'out' && dlg.timeIn && <> · เข้าเวร {dlg.timeIn} น.</>}
            </p>

            <div className="field">
              <label>{dlg.mode === 'in' ? 'เวลาเข้าเวร' : 'เวลาออกเวร'}</label>
              <div className="row" style={{ gap: 6 }}>
                <input type="time" value={dlg.time} step={60} style={{ fontSize: '1.3rem', flex: 1 }}
                  onChange={(e) => setDlg({ ...dlg, time: e.target.value })} />
                <button className="sm" onClick={() => setDlg({ ...dlg, time: nowHHMM() })}>ตอนนี้</button>
              </div>
            </div>

            <div className="field">
              <label>ผู้ดูแลการลงเวลา (ผู้ที่อยู่ด้วยตอนหมอลงเวลา)</label>
              <input list="fee-sup" value={dlg.by} placeholder="ชื่อพนักงานเคาน์เตอร์ / ผู้จัดการสาขา"
                onChange={(e) => setDlg({ ...dlg, by: e.target.value })} />
              <datalist id="fee-sup">{supList.map((x) => <option key={x} value={x} />)}</datalist>
            </div>

            <div className="row" style={{ gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>ประเภทเวร</label>
                <select value={dlg.kind} onChange={(e) => setDlg({ ...dlg, kind: e.target.value })}>
                  {KINDS.map((k) => <option key={k.v} value={k.v}>{k.t}</option>)}
                </select>
              </div>
              {dlg.mode === 'out' && (
                <div className="field" style={{ width: 120 }}>
                  <label>พัก (นาที)</label>
                  <input type="number" min={0} step={5} value={dlg.brk}
                    onChange={(e) => setDlg({ ...dlg, brk: e.target.value })} />
                </div>
              )}
            </div>

            <div className="field">
              <label>หมายเหตุ (ไม่บังคับ)</label>
              <input value={dlg.note} placeholder="เช่น มาแทนหมอ… / รถติด / ออกก่อนเวลาแจ้งล่วงหน้า"
                onChange={(e) => setDlg({ ...dlg, note: e.target.value })} />
            </div>

            {dlgError(dlg) && <Note tone="warn">{dlgError(dlg)}</Note>}
            {Math.abs(toMin(nowHHMM()) - toMin(dlg.time || '0:0')) > 5 && !dlgError(dlg) && (
              <Note tone="info">
                เวลาที่เลือกต่างจากเวลาตอนนี้ ({nowHHMM()} น.) — ระบบจะบันทึกเวลาที่กดจริงคู่ไว้ให้ตรวจย้อนได้
              </Note>
            )}

            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <button onClick={() => setDlg(null)}>ยกเลิก</button>
              <button className="primary" disabled={busy || !!dlgError(dlg)} onClick={confirmDlg}>
                ยืนยัน{dlg.mode === 'in' ? 'เข้าเวร' : 'ออกเวร'} {dlg.time} น.
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
