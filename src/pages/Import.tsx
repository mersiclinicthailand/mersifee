import { useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace } from '../lib/api';
import { docNick, suggestDoctor, splitName, type DocLite, type Suggestion } from '../lib/names';
import { useAuth } from '../lib/auth';
import {
  parseProcFile, parseShiftWorkbook, toProcPayload, toShiftPayload, checkHeader,
  isDoctorName, type ProcParsed, type ShiftParsed,
} from '../lib/parse';
import {
  Alerts, BranchMonthPicker, Card, Money, Note, Skeleton, Stat, useAsync, YmLabel,
} from '../components/ui';
import { fmtMoney } from '../lib/core';

export default function Import({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [proc, setProc] = useState<ProcParsed | null>(null);
  const [shift, setShift] = useState<ShiftParsed | null>(null);
  const [skipHeader, setSkipHeader] = useState(false);
  const [headerWarn, setHeaderWarn] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const branchInfo = boot?.branches.find((b) => b.code === scope.branch);

  /* ทะเบียนแพทย์ทั้งหมด — ใช้แนะนำคู่ของชื่อที่ยังจับคู่ไม่ได้ (โหลดครั้งเดียว) */
  const [registry, setRegistry] = useState<DocLite[] | null>(null);
  const loadRegistry = () => api.listDoctors()
    .then((d) => setRegistry(((d || []) as { lic_no: string; full_name: string; nick_name: string }[])
      .filter((x) => x.lic_no)
      .map((x) => ({ licNo: x.lic_no, fullName: x.full_name || '', nickName: x.nick_name || '' }))))
    .catch(() => setRegistry([]));
  useEffect(() => { loadRegistry(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* คู่ที่ระบบแนะนำ ต่อชื่อ — มาจากทะเบียนก่อน ถ้าไม่เจอค่อยค้นคลังรายชื่อแพทย์ */
  type Sug = Suggestion & { source: 'REG' | 'POOL' };
  const [sugg, setSugg] = useState<Record<string, Sug | null>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});

  const reload = () => {
    setWs(null);
    api.workspace(scope.branch, scope.ym).then(setWs).catch((e) => setErr(e.message));
  };
  useEffect(reload, [scope.branch, scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  const aliasMap = useMemo(() => {
    const m: Record<string, string> = {};
    (ws?.aliases || []).forEach((a) => { m[a.alias] = a.licNo; });
    return m;
  }, [ws]);

  const payload = useMemo(
    () => (proc ? toProcPayload(proc, aliasMap) : null),
    [proc, aliasMap],
  );

  const docRows = proc ? proc.rows.filter((r) => isDoctorName(r.emp)) : [];
  const unmatchedNow = ws?.period?.unmatched || [];

  useEffect(() => {
    if (!registry) return;
    const names = unmatchedNow.map((u) => u.name).filter((n) => !(n in sugg));
    if (!names.length) return;
    let alive = true;
    (async () => {
      const next: Record<string, Sug | null> = {};
      for (const n of names) {
        const s = suggestDoctor(n, registry);
        if (s) { next[n] = { ...s, source: 'REG' }; continue; }
        // ไม่อยู่ในทะเบียน → ค้นคลังรายชื่อแพทย์ด้วยชื่อจริง
        const first = splitName(n).first;
        let pooled: Sug | null = null;
        if (first) {
          try {
            const r = await api.poolSearch(first, 30);
            const p = suggestDoctor(n, r.rows.map((x) => ({ licNo: x.licNo, fullName: x.name, nickName: x.nick })));
            if (p) pooled = { ...p, source: 'POOL' };
          } catch { /* ค้นคลังไม่ได้ ก็ให้คนเลือกเอง */ }
        }
        next[n] = pooled;
      }
      if (!alive) return;
      setSugg((o) => ({ ...o, ...next }));
      setChoice((o) => {
        const c = { ...o };
        Object.entries(next).forEach(([n, v]) => { if (v && !c[n]) c[n] = v.licNo; });
        return c;
      });
    })();
    return () => { alive = false; };
  }, [registry, unmatchedNow]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = ws?.period?.status || 'NONE';
  const locked = ['APPROVED', 'PAID'].includes(status);

  async function pickProc(f: File | null) {
    if (!f) return;
    setProc(null); setShift(null); setHeaderWarn(null); setErr(null); setMsg(null);
    await run(async () => {
      const p = await parseProcFile(f);
      setProc(p);
      const chk = checkHeader(p.header, branchInfo?.nameTh || '', scope.ym);
      if (!chk.ok) setHeaderWarn(chk.error!);
    });
  }

  async function doImportProc() {
    if (!proc || !payload) return;
    if (headerWarn && !skipHeader) {
      setErr('หัวรายงานไม่ตรงกับสาขา/เดือนที่เลือก — ถ้ายืนยันว่าถูกต้อง ให้ติ๊ก “ข้ามการตรวจหัวรายงาน”');
      return;
    }
    await run(async () => {
      const r = await api.importProc({
        branch: scope.branch, ym: scope.ym, rows: payload.rows,
        file: proc.fileName, hash: payload.fileHash,
        unmatched: payload.unmatched, dupGroups: payload.dupGroups,
      });
      // จับคู่ให้อัตโนมัติเฉพาะชื่อที่ "ชื่อ-นามสกุลตรงกับทะเบียน" ชัดเจน
      // ที่เหลือ (ตรงแค่บางส่วน หรือต้องดึงจากคลัง) ปล่อยให้คนกดยืนยันเอง
      const auto: string[] = [];
      for (const u of payload.unmatched as { name: string }[]) {
        const sg = registry ? suggestDoctor(u.name, registry) : null;
        if (sg && sg.level === 'STRONG') {
          await api.saveAlias(u.name, sg.licNo, scope.branch, scope.ym);
          auto.push(`${docNick(sg.nickName) || sg.fullName} (ว.${sg.licNo})`);
        }
      }
      setProc(null);
      reload();
      setMsg(`นำเข้าแล้ว · อ่าน ${r.rowsRead.toLocaleString()} แถว · แถวแพทย์ ${r.rowsDoctor.toLocaleString()} แถว · ค่ามือ ${fmtMoney(r.sumDoctorFee)} บาท`
        + (auto.length ? ` · จับคู่ชื่อให้อัตโนมัติ ${auto.length} คน: ${auto.join(', ')}` : ''));
    });
  }

  async function pickShift(f: File | null) {
    if (!f) return;
    setProc(null); setShift(null); setErr(null); setMsg(null);
    await run(async () => setShift(await parseShiftWorkbook(f)));
  }

  async function doImportShift() {
    if (!shift) return;
    await run(async () => {
      const rows = toShiftPayload(shift);
      const r = await api.saveShifts(scope.branch, scope.ym, rows);
      setShift(null);
      reload();
      setMsg(`นำเข้าใบเวร ${r.saved} รายการแล้ว`);
    });
  }

  async function doRematch() {
    await run(async () => {
      const r = await api.rematch(scope.branch, scope.ym);
      reload();
      setMsg(`จับคู่ใหม่แล้ว · แก้ ${r.matched} รายการ · ยังจับคู่ไม่ได้ ${(r.unmatched as unknown[]).length} ชื่อ`);
    });
  }

  /** ผูกชื่อ 1 ชื่อ — ถ้าเป็นแพทย์จากคลังรายชื่อ ขึ้นทะเบียนให้ก่อน (ไม่งั้นผูกไม่ได้) */
  async function linkOne(name: string, licNo: string) {
    const s = sugg[name];
    if (s && s.source === 'POOL' && s.licNo === licNo
        && !(registry || []).some((d) => d.licNo === licNo)) {
      await api.poolPromote([licNo]);
    }
    await api.saveAlias(name, licNo, scope.branch, scope.ym);
  }

  async function linkAlias(name: string, licNo: string) {
    if (!licNo) return;
    await run(async () => {
      await linkOne(name, licNo);
      loadRegistry();
      reload();
      setMsg(`จับคู่ "${name}" กับรหัส ว. ${licNo} แล้ว — ยอดของรอบนี้ถูกจับคู่ใหม่ให้ทันที`);
    });
  }

  /** ยืนยันทุกชื่อตามที่เลือกไว้ในตาราง (ค่าเริ่มต้นคือคู่ที่ระบบแนะนำ) */
  async function linkAll() {
    const todo = unmatchedNow.filter((u) => choice[u.name]);
    if (!todo.length) { setErr('ยังไม่มีชื่อที่เลือกคู่ไว้'); return; }
    await run(async () => {
      for (const u of todo) await linkOne(u.name, choice[u.name]);
      loadRegistry();
      reload();
      setMsg(`จับคู่แล้ว ${todo.length} ชื่อ — ยอดของรอบนี้ถูกจับคู่ใหม่ให้ทันที`);
    });
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>นำเข้าข้อมูล</h1>
        <div className="spacer" />
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} msg={msg} />

      {locked && (
        <Note tone="warn">
          รอบนี้สถานะ “{status === 'PAID' ? 'บันทึกจ่ายแล้ว' : 'อนุมัติแล้ว'}” — ถูกล็อก นำเข้าข้อมูลใหม่ไม่ได้
          ต้องให้ผู้อนุมัติตีกลับก่อน หรือทำเป็นรายการปรับปรุงในรอบถัดไป
        </Note>
      )}

      {/* ---------- ชื่อที่ยังจับคู่ไม่ได้ ---------- */}
      {unmatchedNow.length > 0 && (
        <Card
          title={<>⚠️ ชื่อที่ยังจับคู่ไม่ได้ ({unmatchedNow.length} ชื่อ)</>}
          right={
            <div className="row" style={{ gap: 6 }}>
              <button className="primary" onClick={linkAll}
                disabled={busy || locked || !unmatchedNow.some((u) => choice[u.name])}
              >
                ✓ จับคู่ตามที่เลือก ({unmatchedNow.filter((u) => choice[u.name]).length})
              </button>
              <button onClick={doRematch} disabled={busy}>🔄 จับคู่ใหม่ทั้งรอบ</button>
            </div>
          }
        >
          <Note tone="bad">
            ยอดของชื่อเหล่านี้<b>ยังไม่เข้ายอดแพทย์คนใด</b> และรอบนี้ส่งตรวจไม่ได้จนกว่าจะจับคู่ครบ
            — จับคู่แล้วระบบจับคู่รายการของรอบนี้ใหม่ให้ทันที ไม่ต้องอัปโหลดไฟล์ซ้ำ
          </Note>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>ชื่อในรายงานต้นทาง</th><th className="n">รายการ</th><th className="n">ยอดรวม</th>
                  <th>ระบบแนะนำ</th><th>จับคู่กับ</th><th></th>
                </tr>
              </thead>
              <tbody>
                {unmatchedNow.map((u) => {
                  const s = sugg[u.name];
                  const regList = registry || [];
                  const poolOpt = s && s.source === 'POOL' && !regList.some((d) => d.licNo === s.licNo);
                  return (
                    <tr key={u.name}>
                      <td>{u.name}</td>
                      <td className="n">{u.count}</td>
                      <td className="n"><Money v={u.sum} /></td>
                      <td>
                        {s === undefined ? <span className="muted">กำลังหา…</span>
                          : s === null ? <span className="pill none">ไม่พบคนที่ตรง — เลือกเอง</span>
                            : (
                              <span className={`pill ${s.level === 'STRONG' ? 'ok' : 'warn'}`}
                                title={s.why}
                              >
                                {docNick(s.nickName) || s.fullName} · ว.{s.licNo}
                                {s.source === 'POOL' && ' · จากคลังรายชื่อ'}
                              </span>
                            )}
                        {s && <div className="muted" style={{ fontSize: '.78rem' }}>{s.why}</div>}
                      </td>
                      <td>
                        <select
                          value={choice[u.name] || ''}
                          onChange={(e) => setChoice((c) => ({ ...c, [u.name]: e.target.value }))}
                          disabled={busy || locked}
                        >
                          <option value="">— เลือกแพทย์ —</option>
                          {poolOpt && (
                            <option value={s!.licNo}>
                              ★ {s!.licNo} · {docNick(s!.nickName) || s!.fullName} (จากคลัง — จะขึ้นทะเบียนให้)
                            </option>
                          )}
                          {regList.map((d) => (
                            <option key={d.licNo} value={d.licNo}>
                              {d.licNo} · {docNick(d.nickName) || d.fullName}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button className="sm" disabled={busy || locked || !choice[u.name]}
                          onClick={() => linkAlias(u.name, choice[u.name])}
                        >
                          จับคู่
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid g2">
        {/* ---------- รายงานค่าหัตถการ ---------- */}
        <Card title="① รายงานค่าหัตถการ (ค่ามือ)">
          <p className="muted" style={{ marginTop: 0 }}>
            ไฟล์ที่ส่งออกจากระบบ MCS · อ่านในเบราว์เซอร์ ไฟล์ต้นฉบับไม่ถูกอัปโหลดขึ้นเซิร์ฟเวอร์
          </p>
          <input
            type="file" accept=".xlsx,.xls" disabled={busy || locked}
            onChange={(e) => pickProc(e.target.files?.[0] || null)}
          />

          {proc && payload && (
            <>
              <div className="grid g4" style={{ margin: '13px 0' }}>
                <Stat k="แถวทั้งหมด" v={proc.rows.length.toLocaleString()} />
                <Stat k="แถวแพทย์" v={docRows.length.toLocaleString()} />
                <Stat k="แถวพนักงานอื่น" v={payload.rowsOther.toLocaleString()} s="แยกออกจากยอดแพทย์" />
                <Stat k="ค่ามือแพทย์รวม" v={<Money v={payload.sumDoctorFee} />} s="บาท" />
              </div>

              <Note tone="info">
                <b>หัวรายงานในไฟล์:</b> {proc.header.substring(0, 220)}
              </Note>

              {headerWarn && (
                <>
                  <Note tone="bad">{headerWarn}</Note>
                  <label className="inline-field" style={{ marginBottom: 10 }}>
                    <input
                      type="checkbox" checked={skipHeader}
                      onChange={(e) => setSkipHeader(e.target.checked)}
                    />
                    <span>ข้ามการตรวจหัวรายงาน (ยืนยันว่าเลือกสาขา/เดือนถูกแล้ว)</span>
                  </label>
                </>
              )}

              {payload.unmatched.length > 0 && (
                <Note tone="warn">
                  ในไฟล์นี้มี {payload.unmatched.length} ชื่อที่ยังไม่มีในตารางจับคู่ของสาขานี้
                  {registry && (() => {
                    const strong = (payload.unmatched as { name: string }[])
                      .map((u) => suggestDoctor(u.name, registry))
                      .filter((x) => x && x.level === 'STRONG').length;
                    return strong > 0
                      ? <> — ในจำนวนนี้ <b>{strong} ชื่อ</b> ชื่อ-นามสกุลตรงกับทะเบียนแพทย์ ระบบจะจับคู่ให้อัตโนมัติตอนกดนำเข้า</>
                      : null;
                  })()}
                  {' '}· ชื่อที่เหลือจับคู่ได้หลังนำเข้า (ระบบจะแนะนำคู่ให้)
                </Note>
              )}
              {payload.dupGroups > 0 && (
                <Note tone="warn">
                  พบ {payload.dupGroups} กลุ่มที่ วันที่/เลขเอกสาร/แพทย์/คอร์ส/จำนวน/ค่ามือ ตรงกันทุกช่อง
                  — อาจเป็นบริการคนละครั้งจริง ระบบเก็บทุกแถวไว้ให้ตรวจเอกสาร ไม่ลบให้อัตโนมัติ
                </Note>
              )}

              <Note tone="warn">
                จะนำเข้าเป็นข้อมูลของ <b>{branchInfo?.nameTh} · <YmLabel ym={scope.ym} /></b> และ
                <b>แทนที่</b>ข้อมูลค่าหัตถการเดิมของรอบนี้ทั้งหมด
              </Note>

              <div className="row">
                <button className="primary" onClick={doImportProc} disabled={busy || locked}>
                  นำเข้า {docRows.length.toLocaleString()} รายการแพทย์
                </button>
                <button onClick={() => setPreview(!preview)}>
                  {preview ? 'ซ่อนตัวอย่าง' : 'ดูตัวอย่าง 30 แถวแรก'}
                </button>
              </div>

              {preview && (
                <div className="tablewrap" style={{ marginTop: 12 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>ลำดับ</th><th>วันที่</th><th>พนักงาน</th><th>ชื่อคอร์ส</th>
                        <th className="n">จำนวน</th><th>เอกสาร</th><th className="n">ค่ามือ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proc.rows.slice(0, 30).map((r, i) => (
                        <tr key={i} style={isDoctorName(r.emp) ? undefined : { opacity: .45 }}>
                          <td className="n">{r.seq}</td>
                          <td>{r.billDate}</td>
                          <td>{r.emp}</td>
                          <td>{r.course.substring(0, 46)}</td>
                          <td className="n">{r.qty}</td>
                          <td>{r.docNo}</td>
                          <td className="n"><Money v={r.fee} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted">
                    แถวจาง = พนักงานที่ไม่ใช่แพทย์ · ระบบแยกออกจากยอดแพทย์แต่ยังนับจำนวนไว้ให้ตรวจ
                  </p>
                </div>
              )}
            </>
          )}
        </Card>

        {/* ---------- ใบเวรจากไฟล์เดิม ---------- */}
        <Card title="② ใบเวรจากไฟล์ Excel เดิม (ถ้ามี)">
          <p className="muted" style={{ marginTop: 0 }}>
            ไฟล์แบบ <code>08.ส.ค.-BN.xlsx</code> — ระบบอ่านชีตที่ชื่อเป็นรหัส ว. แล้วดึงเวลาเข้า-ออก
          </p>
          <input
            type="file" accept=".xlsx,.xls" disabled={busy || locked}
            onChange={(e) => pickShift(e.target.files?.[0] || null)}
          />

          {shift && (
            <>
              <div className="grid g4" style={{ margin: '13px 0' }}>
                <Stat k="ชีตแพทย์" v={shift.sheets.length} />
                <Stat k="ใบเวรทั้งหมด" v={shift.sheets.reduce((a, s) => a + s.rows.length, 0)} />
                <Stat
                  k="บรรทัดยอดพิเศษ"
                  v={shift.sheets.reduce((a, s) => a + s.rows.filter((r) => r.specialAmt !== '').length, 0)}
                  s="จะมีพื้นหลังเตือนในไฟล์ส่งออก"
                />
                <Stat k="อัตราที่พบในไฟล์" v={shift.sheets.filter((s) => s.hourlyRate > 0).length} />
              </div>
              <Note tone="warn">
                จะ<b>แทนที่</b>ใบเวรเดิมของ {branchInfo?.nameTh} · <YmLabel ym={scope.ym} /> ทั้งหมด ·
                อัตรารายชั่วโมงในไฟล์จะ<b>ไม่</b>ถูกบันทึกเป็นอัตราในทะเบียนอัตโนมัติ
                ต้องไปตั้งที่ ทะเบียน → อัตราและสัญญา เอง
              </Note>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>รหัส ว.</th><th className="n">อัตรา/ชม.</th><th className="n">จำนวนเวร</th><th>วันที่</th></tr>
                  </thead>
                  <tbody>
                    {shift.sheets.map((s) => (
                      <tr key={s.licNo}>
                        <td>{s.licNo}</td>
                        <td className="n"><Money v={s.hourlyRate} /></td>
                        <td className="n">{s.rows.length}</td>
                        <td className="muted">
                          {s.rows.slice(0, 6).map((r) => r.date).join(', ')}
                          {s.rows.length > 6 ? ' …' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="primary" style={{ marginTop: 11 }} onClick={doImportShift} disabled={busy || locked}>
                นำเข้าใบเวร {shift.sheets.reduce((a, s) => a + s.rows.length, 0)} รายการ
              </button>
            </>
          )}
        </Card>
      </div>

      {/* ---------- ประวัติการนำเข้า ---------- */}
      <Card title="ประวัติการนำเข้าของรอบนี้">
        {!ws ? <Skeleton rows={3} /> : ws.imports.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>ยังไม่มีการนำเข้าข้อมูลในรอบนี้</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>ชนิด</th><th>ไฟล์</th><th className="n">อ่านได้</th><th className="n">แถวแพทย์</th>
                  <th className="n">ค่ามือรวม</th><th>สถานะ</th><th>โดย</th><th>เมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {ws.imports.map((im, i) => (
                  <tr key={i} style={im.status === 'REPLACED' ? { opacity: .5 } : undefined}>
                    <td>{im.kind === 'PROC' ? 'ค่าหัตถการ' : 'ใบเวร'}</td>
                    <td>{im.fileName}</td>
                    <td className="n">{im.rowsRead.toLocaleString()}</td>
                    <td className="n">{im.rowsDoctor.toLocaleString()}</td>
                    <td className="n"><Money v={im.sumDoctorFee} /></td>
                    <td>
                      <span className={`pill ${im.status === 'OK' ? 'ok' : 'none'}`}>
                        {im.status === 'OK' ? 'ใช้อยู่' : 'ถูกแทนที่'}
                      </span>
                    </td>
                    <td>{im.by}</td>
                    <td className="muted">{(im.at || '').replace('T', ' ').substring(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
