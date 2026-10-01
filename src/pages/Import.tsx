import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace, type ImportMode, type ImportHistRow } from '../lib/api';
import { docNick, suggestDoctor, splitName, type DocLite, type Suggestion } from '../lib/names';
import { useAuth } from '../lib/auth';
import {
  parseProcFile, parseShiftWorkbook, toProcPayload, toShiftPayload, checkHeader,
  isDoctorName, type ProcParsed, type ShiftParsed,
} from '../lib/parse';
import {
  Alerts, BranchMonthPicker, Card, Money, Note, Skeleton, Stat, useAsync, YmLabel,
} from '../components/ui';
import { fmtMoney, toIsoDate, toThaiDate, num, cellStr } from '../lib/core';

/* ---------------- ช่วยเรื่องช่วงวันที่ของเดือน/สัปดาห์ ---------------- */
const monthStart = (ym: string) => ym + '-01';
function monthEnd(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ym + '-' + String(d).padStart(2, '0');
}
/** สัปดาห์ของเดือนแบบตายตัว 1–7 · 8–14 · 15–21 · 22–28 · 29–สิ้นเดือน (ตรงกับรอบตัดยอดรายสัปดาห์) */
function weekBuckets(ym: string) {
  const last = Number(monthEnd(ym).slice(8));
  const out: { no: number; from: string; to: string }[] = [];
  for (let d = 1, no = 1; d <= last; d += 7, no++) {
    const e = Math.min(d + 6, last);
    out.push({ no, from: ym + '-' + String(d).padStart(2, '0'), to: ym + '-' + String(e).padStart(2, '0') });
  }
  return out;
}
const weekNoOf = (iso: string) => Math.min(5, Math.floor((Number(iso.slice(8)) - 1) / 7) + 1);
const dShort = (iso?: string | null) => (iso ? toThaiDate(iso) : '—');
const MODE_TH: Record<string, string> = {
  WEEK: 'รายสัปดาห์', MONTH_END: 'ปิดยอดสิ้นเดือน', FULL: 'ทั้งเดือน',
};
const STATUS_IMP: Record<string, { t: string; c: string }> = {
  OK: { t: 'ใช้อยู่', c: 'ok' },
  PARTIAL: { t: 'ถูกแทนบางส่วน', c: 'warn' },
  REPLACED: { t: 'ถูกแทนที่แล้ว', c: 'none' },
};

export default function Import({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [proc, setProc] = useState<ProcParsed | null>(null);
  const [shift, setShift] = useState<ShiftParsed | null>(null);
  const [skipHeader, setSkipHeader] = useState(false);
  const [headerWarn, setHeaderWarn] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  /* โหมดนำเข้า: รายสัปดาห์ (แทนเฉพาะช่วงวันที่) / ปิดยอดสิ้นเดือน (แทนทั้งเดือน) */
  const [mode, setMode] = useState<ImportMode>('WEEK');
  const [dFrom, setDFrom] = useState('');
  const [dTo, setDTo] = useState('');
  const [label, setLabel] = useState('');
  const [hist, setHist] = useState<ImportHistRow[] | null>(null);
  const [openHist, setOpenHist] = useState<string | null>(null);
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
    setHist(null);
    api.workspace(scope.branch, scope.ym).then(setWs).catch((e) => setErr(e.message));
    api.importHistory(scope.branch, scope.ym).then(setHist).catch(() => setHist([]));
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

  /* ช่วงวันที่จริงในไฟล์ (เฉพาะแถวแพทย์) */
  const fileRange = useMemo(() => {
    if (!payload) return null;
    const ds = (payload.rows as { billDate: string }[]).map((r) => r.billDate).filter(Boolean).sort();
    return ds.length ? { min: ds[0], max: ds[ds.length - 1] } : null;
  }, [payload]);
  const effFrom = mode === 'WEEK' ? dFrom : monthStart(scope.ym);
  const effTo = mode === 'WEEK' ? dTo : monthEnd(scope.ym);
  const outOfRange = useMemo(() => {
    if (!payload || !effFrom || !effTo) return 0;
    return (payload.rows as { billDate: string }[])
      .filter((r) => r.billDate && (r.billDate < effFrom || r.billDate > effTo)).length;
  }, [payload, effFrom, effTo]);

  /* ยอดค่ามือปัจจุบันแยกรายแพทย์ × สัปดาห์ */
  const weekly = useMemo(() => {
    if (!ws) return null;
    const weeks = weekBuckets(scope.ym);
    const nick: Record<string, string> = {};
    ws.doctors.forEach((d) => { nick[cellStr(d.licNo)] = docNick(cellStr(d.nickName)) || cellStr(d.fullName); });
    const byDoc: Record<string, number[]> = {};
    const tot = weeks.map(() => 0);
    ws.procDays.forEach((d) => {
      const iso = toIsoDate(d.workDate);
      if (!iso.startsWith(scope.ym)) return;
      const lic = cellStr(d.licNo);
      const w = weekNoOf(iso) - 1;
      if (!byDoc[lic]) byDoc[lic] = weeks.map(() => 0);
      byDoc[lic][w] += num(d.amount);
      tot[w] += num(d.amount);
    });
    const rows = Object.keys(byDoc).map((lic) => ({
      lic, name: nick[lic] || lic, w: byDoc[lic], sum: byDoc[lic].reduce((a, b) => a + b, 0),
    })).sort((a, b) => b.sum - a.sum);
    return { weeks, rows, tot, sum: tot.reduce((a, b) => a + b, 0) };
  }, [ws, scope.ym]);
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
      // ตั้งช่วงวันที่ตามไฟล์ — ครอบทั้งเดือนจริง ๆ ให้แนะนำโหมดปิดยอดสิ้นเดือน
      const ds = p.rows.filter((r) => isDoctorName(r.emp)).map((r) => toIsoDate(r.billDate))
        .filter((x) => x && x.startsWith(scope.ym)).sort();
      const ms = monthStart(scope.ym), me = monthEnd(scope.ym);
      const lo = ds[0] || ms, hi = ds[ds.length - 1] || me;
      const fullMonth = /ถึงวันที่\s*(\d+)/.test(p.header)
        ? Number((p.header.match(/ถึงวันที่\s*(\d+)/) || [])[1]) === Number(me.slice(8)) && Number(lo.slice(8)) <= 7
        : (Number(lo.slice(8)) <= 3 && Number(hi.slice(8)) >= Number(me.slice(8)) - 2);
      setMode(fullMonth ? 'MONTH_END' : 'WEEK');
      // ช่วงสัปดาห์: ขยายให้เต็มสัปดาห์มาตรฐาน (1–7, 8–14, …) ที่ครอบวันในไฟล์
      const wb = weekBuckets(scope.ym);
      const f0 = wb.find((w) => lo >= w.from && lo <= w.to)?.from || lo;
      const t0 = wb.find((w) => hi >= w.from && hi <= w.to)?.to || hi;
      setDFrom(f0 < ms ? ms : f0);
      setDTo(t0 > me ? me : t0);
      const wFrom = weekNoOf(f0 < ms ? ms : f0), wTo = weekNoOf(t0 > me ? me : t0);
      setLabel(fullMonth ? 'ปิดยอดสิ้นเดือน'
        : (wFrom === wTo ? `สัปดาห์ที่ ${wFrom}` : `สัปดาห์ที่ ${wFrom}–${wTo}`));
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
    if (mode === 'WEEK' && (!dFrom || !dTo || dFrom > dTo)) {
      setErr('เลือกช่วงวันที่ของสัปดาห์ให้ถูกต้องก่อน');
      return;
    }
    if (outOfRange > 0) {
      setErr(`ไฟล์มี ${outOfRange} แถวที่วันที่อยู่นอกช่วงที่เลือก — ขยายช่วงวันที่ หรือเลือก “ปิดยอดสิ้นเดือน”`);
      return;
    }
    await run(async () => {
      const r = await api.importProc({
        branch: scope.branch, ym: scope.ym, rows: payload.rows,
        file: proc.fileName, hash: payload.fileHash,
        mode, dateFrom: effFrom, dateTo: effTo, label,
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
      const diff = num(r.sumDoctorFee) - num(r.prevSum);
      setMsg(`นำเข้า${MODE_TH[r.mode] || ''}แล้ว (${dShort(r.dateFrom)} – ${dShort(r.dateTo)})`
        + ` · อ่าน ${r.rowsRead.toLocaleString()} แถว · แถวแพทย์ ${r.rowsDoctor.toLocaleString()} แถว · ค่ามือ ${fmtMoney(r.sumDoctorFee)} บาท`
        + (num(r.prevSum) ? ` · ยอดเดิมช่วงนี้ ${fmtMoney(r.prevSum)} → ต่าง ${diff >= 0 ? '+' : ''}${fmtMoney(diff)}` : '')
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

              {/* ---------- ชนิดการนำเข้า ---------- */}
              <div className="card" style={{ padding: 12, margin: '0 0 12px', background: 'var(--soft, transparent)' }}>
                <div className="row" style={{ gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
                  <label className="inline-field">
                    <input type="radio" name="impmode" checked={mode === 'WEEK'}
                      onChange={() => setMode('WEEK')} />
                    <span><b>รายสัปดาห์</b> — แทนที่เฉพาะช่วงวันที่ที่เลือก</span>
                  </label>
                  <label className="inline-field">
                    <input type="radio" name="impmode" checked={mode === 'MONTH_END'}
                      onChange={() => setMode('MONTH_END')} />
                    <span><b>ปิดยอดสิ้นเดือน</b> — ไฟล์ทั้งเดือน แทนที่ทั้งเดือน</span>
                  </label>
                </div>
                {mode === 'WEEK' && (
                  <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <label className="inline-field">
                      <span>ตั้งแต่</span>
                      <input type="date" value={dFrom} min={monthStart(scope.ym)} max={monthEnd(scope.ym)}
                        onChange={(e) => setDFrom(e.target.value)} />
                    </label>
                    <label className="inline-field">
                      <span>ถึง</span>
                      <input type="date" value={dTo} min={monthStart(scope.ym)} max={monthEnd(scope.ym)}
                        onChange={(e) => setDTo(e.target.value)} />
                    </label>
                    <div className="row" style={{ gap: 4 }}>
                      {weekBuckets(scope.ym).map((w) => (
                        <button key={w.no} className="sm" type="button"
                          onClick={() => { setDFrom(w.from); setDTo(w.to); setLabel(`สัปดาห์ที่ ${w.no}`); }}
                        >
                          สัปดาห์ {w.no}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <label className="inline-field" style={{ marginTop: 8 }}>
                  <span>ชื่อรอบ</span>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="เช่น สัปดาห์ที่ 2" />
                </label>
                {fileRange && (
                  <div className="muted" style={{ fontSize: '.82rem', marginTop: 6 }}>
                    วันที่ในไฟล์: {dShort(fileRange.min)} – {dShort(fileRange.max)}
                  </div>
                )}
              </div>

              {outOfRange > 0 && (
                <Note tone="bad">
                  ไฟล์มี {outOfRange} แถวที่วันที่อยู่นอกช่วง {dShort(effFrom)} – {dShort(effTo)}
                  — ขยายช่วงวันที่ หรือเลือก “ปิดยอดสิ้นเดือน”
                </Note>
              )}

              <Note tone="warn">
                จะนำเข้าเป็นข้อมูลของ <b>{branchInfo?.nameTh} · <YmLabel ym={scope.ym} /></b>{' '}
                {mode === 'WEEK' ? (
                  <>และ<b>แทนที่เฉพาะวันที่ {dShort(effFrom)} – {dShort(effTo)}</b> — ข้อมูลวันอื่นของเดือนยังอยู่ครบ</>
                ) : (
                  <>และ<b>แทนที่</b>ข้อมูลค่าหัตถการทั้งเดือน (ปิดยอดสิ้นเดือน)</>
                )}
                {' '}· ยอดของไฟล์ที่นำเข้าก่อนหน้าทุกครั้งยังเก็บไว้ดูย้อนหลังได้ที่ “ประวัติการนำเข้า”
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

      {/* ---------- ยอดค่ามือรายสัปดาห์ (ข้อมูลที่ใช้คำนวณอยู่ตอนนี้) ---------- */}
      <Card title="ยอดค่ามือรายสัปดาห์ (ข้อมูลปัจจุบันของรอบนี้)">
        {!weekly ? <Skeleton rows={3} /> : weekly.rows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>ยังไม่มีข้อมูลค่าหัตถการในรอบนี้</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>แพทย์</th>
                  {weekly.weeks.map((w) => (
                    <th key={w.no} className="n">
                      สัปดาห์ {w.no}<div className="muted" style={{ fontWeight: 400, fontSize: '.75rem' }}>
                        {Number(w.from.slice(8))}–{Number(w.to.slice(8))}
                      </div>
                    </th>
                  ))}
                  <th className="n">รวมเดือน</th>
                </tr>
              </thead>
              <tbody>
                {weekly.rows.map((r) => (
                  <tr key={r.lic}>
                    <td>{r.name} <span className="muted">ว.{r.lic}</span></td>
                    {r.w.map((v, i) => <td key={i} className="n"><Money v={v} dash /></td>)}
                    <td className="n"><b><Money v={r.sum} /></b></td>
                  </tr>
                ))}
                <tr className="total">
                  <td>รวม</td>
                  {weekly.tot.map((v, i) => <td key={i} className="n"><Money v={v} dash /></td>)}
                  <td className="n"><Money v={weekly.sum} /></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {unmatchedNow.length > 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>
            ไม่รวมยอดของชื่อที่ยังจับคู่ไม่ได้ {unmatchedNow.length} ชื่อ
          </p>
        )}
      </Card>

      {/* ---------- ประวัติการนำเข้า (เก็บยอดทุกไฟล์ถาวร) ---------- */}
      <Card title="ประวัติการนำเข้าของรอบนี้ · ยอดแต่ละสัปดาห์เก็บไว้ถาวร">
        {!ws ? <Skeleton rows={3} /> : ws.imports.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>ยังไม่มีการนำเข้าข้อมูลในรอบนี้</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>ชนิด</th><th>รอบ / ช่วงวันที่</th><th>ไฟล์</th><th className="n">แถวแพทย์</th>
                  <th className="n">ค่ามือของไฟล์</th><th className="n">ยอดเดิมในช่วง</th><th className="n">ต่าง</th>
                  <th>สถานะ</th><th>โดย</th><th>เมื่อ</th><th></th>
                </tr>
              </thead>
              <tbody>
                {ws.imports.map((im, i) => {
                  const st = STATUS_IMP[im.status] || { t: im.status, c: 'none' };
                  const h = im.id ? (hist || []).find((x) => x.id === im.id) : undefined;
                  const isOpen = !!im.id && openHist === im.id;
                  const hasPrev = im.prevSum !== null && im.prevSum !== undefined;
                  const diff = num(im.sumDoctorFee) - num(im.prevSum);
                  return (
                    <Fragment key={im.id || i}>
                      <tr style={im.status === 'REPLACED' ? { opacity: .62 } : undefined}>
                        <td>
                          {im.kind === 'PROC' ? (MODE_TH[im.mode || 'FULL'] || 'ค่าหัตถการ') : 'ใบเวร'}
                        </td>
                        <td>
                          {im.label && <b>{im.label}<br /></b>}
                          <span className="muted">{dShort(im.dateFrom)} – {dShort(im.dateTo)}</span>
                        </td>
                        <td>{im.fileName}</td>
                        <td className="n">{im.rowsDoctor.toLocaleString()}</td>
                        <td className="n"><Money v={im.sumDoctorFee} /></td>
                        <td className="n">{hasPrev ? <Money v={im.prevSum as number} dash /> : '—'}</td>
                        <td className="n">
                          {hasPrev && num(im.prevSum) !== 0
                            ? <span className={diff === 0 ? 'muted' : ''}>{diff > 0 ? '+' : ''}{fmtMoney(diff)}</span>
                            : '—'}
                        </td>
                        <td><span className={`pill ${st.c}`}>{st.t}</span></td>
                        <td>{im.by}</td>
                        <td className="muted">{(im.at || '').replace('T', ' ').substring(0, 16)}</td>
                        <td>
                          {h && h.doctors.length > 0 && (
                            <button className="sm" onClick={() => setOpenHist(isOpen ? null : im.id!)}>
                              {isOpen ? 'ซ่อน' : 'รายแพทย์'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && h && (
                        <tr>
                          <td colSpan={11} style={{ background: 'var(--soft, transparent)' }}>
                            <table>
                              <thead>
                                <tr><th>แพทย์</th><th className="n">วัน</th><th className="n">รายการ</th><th className="n">ค่ามือ</th></tr>
                              </thead>
                              <tbody>
                                {h.doctors.map((d) => (
                                  <tr key={d.licNo + d.name}>
                                    <td>
                                      {docNick(d.name) || d.name}{' '}
                                      {d.licNo ? <span className="muted">ว.{d.licNo}</span>
                                        : <span className="pill warn">ยังไม่จับคู่</span>}
                                    </td>
                                    <td className="n">{d.days}</td>
                                    <td className="n">{d.rows}</td>
                                    <td className="n"><Money v={d.amount} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          ไฟล์ที่ “ถูกแทนที่แล้ว” ไม่ถูกนำไปคำนวณ แต่ยอดรายแพทย์ของไฟล์นั้นยังเก็บไว้ในระบบตลอด
          กด “รายแพทย์” เพื่อดูยอดของแต่ละสัปดาห์ย้อนหลัง
        </p>
      </Card>
    </>
  );
}
