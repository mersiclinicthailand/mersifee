import React, { useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace, type RosterMonth } from '../lib/api';
import { useAuth } from '../lib/auth';
import { monthHash, signStatus, type ShiftRow } from '../lib/calc';
import { cellStr, minutesToHHMM, toIsoDate, toThaiDate, toMinutes } from '../lib/core';
import {
  Alerts, BranchMonthPicker, Card, Note, SignaturePad, Skeleton, StatusPill, useAsync, YmLabel,
} from '../components/ui';

/** เวลาที่บันทึกคือเวลาของเครื่องที่เปิดหน้าจอ แต่แสดงตามเขตเวลาไทยเสมอ */
function nowHHMM() {
  const d = new Date();
  return minutesToHHMM(d.getHours() * 60 + d.getMinutes());
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

  /* ตารางแพทย์ของเดือนนี้ — ใช้กำหนดว่าใครควรอยู่เวรสาขานี้ (แคชตามเดือน สลับสาขาไม่ยิงซ้ำ) */
  useEffect(() => {
    setRoster(null);
    api.roster(scope.ym).then(setRoster).catch(() => setRoster({ ym: scope.ym, rows: [], names: {} }));
  }, [scope.ym]);

  const status = ws?.period?.status || 'NONE';
  const locked = ['APPROVED', 'PAID'].includes(status);
  const today = todayIso();
  const myLic = boot?.me.licNo;

  /** ตารางแพทย์เฉพาะสาขานี้ในเดือนนี้ — เป็นตัวกำหนดว่าใครควรมาลงเวลาที่สาขานี้ */
  const rosterHere = useMemo(
    () => (roster?.rows || []).filter((r) => r.branch === scope.branch),
    [roster, scope.branch],
  );
  /** เวรตามตารางของ "วันนี้" (ถ้าเดือนที่เลือกคือเดือนปัจจุบัน) */
  const todayPlan = useMemo(
    () => rosterHere.find((r) => r.workDate === today),
    [rosterHere, today],
  );
  /** เลข ว. ที่อยู่ในตารางสาขานี้ทั้งเดือน (เฉพาะชื่อที่จับคู่ทะเบียนแพทย์ได้) */
  const planLics = useMemo(
    () => new Set(rosterHere.map((r) => r.licNo).filter(Boolean)),
    [rosterHere],
  );
  /** ชื่อในตารางที่ยังจับคู่ทะเบียนแพทย์ไม่ได้ → ลงเวลาให้ไม่ได้ ต้องบอกให้รู้ */
  const planUnknown = useMemo(() => {
    const seen = new Set<string>();
    rosterHere.forEach((r) => { if (!r.licNo) seen.add(r.docLabel); });
    return [...seen];
  }, [rosterHere]);

  /** แพทย์ที่มีใบเวรของสาขานี้อยู่แล้ว (เผื่อคนที่ลงเวลาไว้แต่ไม่อยู่ในตาราง) */
  const onDuty = useMemo(
    () => new Set((ws?.shifts || []).map((s) => cellStr(s.licNo)).filter(Boolean)),
    [ws],
  );
  /** ยังไม่มีทั้งตารางแพทย์และใบเวลาของสาขานี้ → โชว์ทั้งทะเบียนไปก่อน ไม่งั้นลงเวลาไม่ได้เลย */
  const noPlan = planLics.size === 0;
  const noRoster = noPlan && onDuty.size === 0;
  const [showAll, setShowAll] = useState(false);

  const docs = useMemo(() => {
    const list = (ws?.doctors || []).filter((d) => {
      if (myLic) return d.licNo === myLic;                       // บัญชีแพทย์เห็นเฉพาะตัวเอง
      if (showAll || noRoster) return true;                      // กดดูทั้งทะเบียน / ยังไม่มีข้อมูลอะไรเลย
      if (!noPlan) return planLics.has(d.licNo || '') || onDuty.has(d.licNo || '');
      return onDuty.has(d.licNo || '');                          // ไม่มีตาราง → ใช้ใบเวรเดิม
    });
    // คนที่อยู่เวรตามตารางวันนี้ ขึ้นก่อนเสมอ
    return list.sort((a, b) => {
      const at = a.licNo === todayPlan?.licNo ? 0 : 1;
      const bt = b.licNo === todayPlan?.licNo ? 0 : 1;
      if (at !== bt) return at - bt;
      return (a.nickName || a.fullName || '').localeCompare(b.nickName || b.fullName || '', 'th');
    });
  }, [ws, myLic, onDuty, showAll, noRoster, noPlan, planLics, todayPlan]);

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

  const clockIn = (licNo: string) => writeShifts(
    (rows) => [...rows, {
      id: '', licNo, workDate: today, timeIn: nowHHMM(), timeOut: '', breakMin: 0,
      specialAmt: '', handOverride: '', deductOther: 0, kind: 'SHIFT', note: '', source: 'CLOCK',
    }],
    `บันทึกเข้าเวร ${nowHHMM()} น. แล้ว`,
  );

  const clockOut = (licNo: string) => writeShifts(
    (rows) => rows.map((s) => (
      cellStr(s.licNo) === licNo && toIsoDate(s.workDate) === today
        && cellStr(s.timeIn) && !cellStr(s.timeOut)
        ? { ...s, timeOut: nowHHMM() } : s
    )),
    `บันทึกออกเวร ${nowHHMM()} น. แล้ว`,
  );

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
              {scope.ym !== today.substring(0, 7) ? (
                <span className="pill none">
                  กำลังดูเดือนอื่น — ปุ่มลงเวลาใช้กับวันนี้เท่านั้น
                </span>
              ) : todayPlan ? (
                <span className="pill ok">
                  ตารางแพทย์วันนี้ · {scope.branch} = {todayPlan.docLabel}
                  {!todayPlan.licNo && ' (ยังไม่มีในทะเบียนแพทย์)'}
                </span>
              ) : !noPlan ? (
                <span className="pill none">ตารางแพทย์วันนี้ · {scope.branch} = ไม่มีแพทย์</span>
              ) : (
                <span className="pill warn">
                  ยังไม่มีตารางแพทย์ของสาขานี้ในเดือนนี้ — นำเข้าที่แท็บ “ตารางแพทย์”
                </span>
              )}
              {!noPlan && (
                <span className="pill none">อยู่ในตารางเดือนนี้ {planLics.size} คน</span>
              )}
              <div className="spacer" />
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                แสดงแพทย์ทุกคนในทะเบียน (กรณีมีหมอมาแทนเวรกะทันหัน)
              </label>
            </div>
            {planUnknown.length > 0 && (
              <Note tone="warn">
                ชื่อในตารางแพทย์ของสาขานี้ที่ยังไม่มีในทะเบียนแพทย์: <b>{planUnknown.join(' · ')}</b>
                {' '}— ลงเวลาให้ยังไม่ได้ ต้องเพิ่มเข้าทะเบียนแพทย์ (แท็บ “ทะเบียน”) ก่อน
              </Note>
            )}
          </>
        )}
        {!ws ? <Skeleton rows={4} /> : (
          <div className="grid g3">
            {board.map(({ doc, open, done }) => (
              <div key={doc.licNo} className="stat"
                style={doc.licNo === todayPlan?.licNo
                  ? { borderColor: 'var(--sage)', boxShadow: '0 0 0 2px var(--sage-lt) inset' } : undefined}
              >
                <div className="k">
                  {doc.licNo}
                  {doc.licNo === todayPlan?.licNo && (
                    <span className="pill ok" style={{ marginLeft: 6 }}>เวรวันนี้</span>
                  )}
                </div>
                <div style={{ fontWeight: 600 }}>{doc.nickName || doc.fullName}</div>
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
                </div>
                <div className="row">
                  {!open ? (
                    <button className="primary sm" disabled={busy || locked}
                      onClick={() => clockIn(doc.licNo!)}
                    >
                      เข้าเวร
                    </button>
                  ) : (
                    <button className="sm" disabled={busy || locked}
                      onClick={() => clockOut(doc.licNo!)}
                    >
                      ออกเวร
                    </button>
                  )}
                </div>
              </div>
            ))}
            {board.length === 0 && (
              <p className="muted">
                {noRoster
                  ? 'ยังไม่มีแพทย์ในทะเบียน — เพิ่มที่แท็บ “ทะเบียน” ก่อน'
                  : noPlan
                    ? 'ยังไม่มีตารางแพทย์ของสาขานี้ในเดือนนี้ และยังไม่มีใบเวร — นำเข้าตารางที่แท็บ “ตารางแพทย์” หรือติ๊ก “แสดงแพทย์ทุกคน” ด้านบน'
                    : 'ชื่อในตารางแพทย์ของสาขานี้ยังจับคู่กับทะเบียนแพทย์ไม่ได้ — ติ๊ก “แสดงแพทย์ทุกคน” ด้านบนเพื่อลงเวลาชั่วคราว'}
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
                        <td>{d.licNo} · {d.nickName || d.fullName}</td>
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
    </>
  );
}
