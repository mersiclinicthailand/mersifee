/* ============================================================================
 * DailyProcImport.tsx — ผู้จัดการสาขานำเข้า "รายงานค่าหัตถการ (ค่ามือ)" รายวัน
 *
 * อยู่ในหน้า ลงเวลาและลายเซ็นแพทย์ — แยกจากแท็บ "นำเข้าข้อมูล" ที่ HR ใช้ตรวจทานทั้งเดือน
 *
 * ทำงานอย่างไร
 *   · ไฟล์ของวันไหน แทนที่เฉพาะวันนั้น (ช่วงวันที่ = วันแรก–วันสุดท้ายที่มีในไฟล์)
 *     วันอื่นของเดือนไม่ถูกแตะ — นำเข้าวันละไฟล์ได้เรื่อย ๆ
 *   · ทุกไฟล์ถูกเก็บยอดแยกไว้ดูย้อนหลังได้ (ใคร นำเข้าเมื่อไร ยอดเท่าไร)
 *   · สิ้นเดือน HR นำเข้าไฟล์ทั้งเดือนที่แท็บ "นำเข้าข้อมูล" เพื่อตรวจทาน
 *     → แทนที่ข้อมูลรายวันทั้งหมด และเห็นส่วนต่างเทียบกับยอดรายวันที่สาขาส่งมา
 * ==========================================================================*/
import { useEffect, useMemo, useState } from 'react';
import { api, type ImportHistRow, type Workspace } from '../lib/api';
import { checkHeader, isDoctorName, parseProcFile, toProcPayload, type ProcParsed } from '../lib/parse';
import { docNick, suggestDoctor } from '../lib/names';
import { fmtMoney, toIsoDate, toThaiDate } from '../lib/core';
import { Card, Money, Note } from './ui';

const dShort = (iso?: string | null) => (iso ? toThaiDate(iso) : '—');

export default function DailyProcImport(
  { branch, branchTh, ym, ws, onDone }: {
    branch: string; branchTh: string; ym: string; ws: Workspace | null; onDone: () => void;
  },
) {
  const [proc, setProc] = useState<ProcParsed | null>(null);
  const [hist, setHist] = useState<ImportHistRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [headerWarn, setHeaderWarn] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const loadHist = () => { api.importHistory(branch, ym).then(setHist).catch(() => setHist([])); };
  useEffect(loadHist, [branch, ym]); // eslint-disable-line react-hooks/exhaustive-deps

  const aliasMap = useMemo(() => {
    const m: Record<string, string> = {};
    (ws?.aliases || []).forEach((a) => { m[a.alias] = a.licNo; });
    return m;
  }, [ws]);
  const payload = useMemo(() => (proc ? toProcPayload(proc, aliasMap) : null), [proc, aliasMap]);
  const registry = useMemo(() => (ws?.doctors || []).filter((d) => d.licNo)
    .map((d) => ({ licNo: d.licNo!, fullName: d.fullName || '', nickName: d.nickName || '' })), [ws]);

  /** ช่วงวันที่ของไฟล์ (เฉพาะแถวแพทย์) */
  const range = useMemo(() => {
    if (!proc) return null;
    const ds = proc.rows.filter((r) => isDoctorName(r.emp)).map((r) => toIsoDate(r.billDate)).filter(Boolean).sort();
    if (!ds.length) return null;
    return { from: ds[0], to: ds[ds.length - 1], days: new Set(ds).size };
  }, [proc]);
  const wrongMonth = range && (range.from.slice(0, 7) !== ym || range.to.slice(0, 7) !== ym);

  /** สรุปรายแพทย์ในไฟล์ */
  const perDoc = useMemo(() => {
    if (!payload) return [];
    const m = new Map<string, { name: string; n: number; sum: number; matched: boolean }>();
    (payload.rows as { licNo: string; empRaw: string; fee: number }[]).forEach((r) => {
      const k = r.licNo || r.empRaw;
      const d = (ws?.doctors || []).find((x) => x.licNo === r.licNo);
      const cur = m.get(k) || { name: d ? (docNick(d.nickName) || d.fullName || r.licNo) : r.empRaw, n: 0, sum: 0, matched: !!r.licNo };
      cur.n += 1; cur.sum += r.fee; m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.sum - a.sum);
  }, [payload, ws]);

  async function pick(f: File | null) {
    if (!f) return;
    setProc(null); setErr(null); setMsg(null); setHeaderWarn(null);
    try {
      const p = await parseProcFile(f);
      setProc(p);
      const chk = checkHeader(p.header, branchTh, ym);
      if (!chk.ok) setHeaderWarn(chk.error!);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function doImport() {
    if (!proc || !payload || !range) return;
    if (wrongMonth) { setErr(`ไฟล์มีวันที่นอกเดือนที่เลือก — เลือกเดือนให้ตรงก่อน`); return; }
    setBusy(true); setErr(null);
    try {
      const label = range.from === range.to
        ? `รายวัน ${Number(range.from.slice(8))}` : `รายวัน ${Number(range.from.slice(8))}–${Number(range.to.slice(8))}`;
      const r = await api.importProc({
        branch, ym, rows: payload.rows, file: proc.fileName, hash: payload.fileHash,
        mode: 'WEEK', dateFrom: range.from, dateTo: range.to, label,
      });
      // ชื่อที่ชื่อ-นามสกุลตรงกับทะเบียนชัดเจน → จับคู่ให้เลย
      let auto = 0;
      for (const u of payload.unmatched as { name: string }[]) {
        const sg = suggestDoctor(u.name, registry);
        if (sg && sg.level === 'STRONG') { await api.saveAlias(u.name, sg.licNo, branch, ym); auto++; }
      }
      setMsg(`นำเข้าค่ามือ ${dShort(r.dateFrom)}${r.dateFrom !== r.dateTo ? ` – ${dShort(r.dateTo)}` : ''} แล้ว`
        + ` · แพทย์ ${r.rowsDoctor} รายการ · ${fmtMoney(r.sumDoctorFee)} บาท`
        + (Number(r.prevSum) ? ` (แทนที่ยอดเดิมของวันนั้น ${fmtMoney(r.prevSum)})` : '')
        + (auto ? ` · จับคู่ชื่อให้อัตโนมัติ ${auto} คน` : ''));
      setProc(null); setInputKey((k) => k + 1);
      loadHist(); onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const daily = (hist || []).filter((h) => (h.label || '').startsWith('รายวัน'));
  const hrCheck = (hist || []).find((h) => h.mode === 'MONTH_END' || h.mode === 'FULL');

  return (
    <Card title="📥 นำเข้ารายงานค่าหัตถการ (ค่ามือ) ประจำวัน"
      right={<span className="muted">สำหรับผู้จัดการสาขา · HR ตรวจทานทั้งเดือนที่แท็บ “นำเข้าข้อมูล”</span>}
    >
      <p className="muted" style={{ marginTop: 0 }}>
        ส่งออกไฟล์ “รายงานค่าหัตถการ(ค่ามือ)” ของวันนั้นจากระบบ MCS แล้วเลือกไฟล์ที่นี่ ·
        ไฟล์ของวันไหนแทนที่เฉพาะวันนั้น วันอื่นไม่ถูกแตะ · นำเข้าซ้ำวันเดิมได้ (ระบบเก็บประวัติทุกไฟล์)
      </p>
      <input key={inputKey} type="file" accept=".xlsx,.xls" disabled={busy}
        onChange={(e) => pick(e.target.files?.[0] || null)} />

      {err && <div style={{ marginTop: 10 }}><Note tone="bad">{err}</Note></div>}
      {msg && <div style={{ marginTop: 10 }}><Note tone="ok">{msg}</Note></div>}

      {proc && payload && (
        <div style={{ marginTop: 12 }}>
          {!range ? <Note tone="warn">ไม่พบรายการของแพทย์ในไฟล์นี้</Note> : (
            <>
              <Note tone={wrongMonth ? 'bad' : 'info'}>
                ไฟล์นี้: <b>{dShort(range.from)}{range.from !== range.to && <> – {dShort(range.to)}</>}</b>
                {' '}({range.days} วัน) · แพทย์ {payload.rows.length.toLocaleString()} รายการ ·
                ค่ามือรวม <b><Money v={payload.sumDoctorFee} /></b> บาท
                {wrongMonth && <> — <b>มีวันที่นอกเดือนที่เลือก</b> เปลี่ยนเดือนด้านบนให้ตรงก่อน</>}
              </Note>
              {headerWarn && <Note tone="warn">{headerWarn}</Note>}
              <div className="tablewrap" style={{ marginTop: 8 }}>
                <table>
                  <thead><tr><th>แพทย์</th><th className="n">รายการ</th><th className="n">ค่ามือ</th></tr></thead>
                  <tbody>
                    {perDoc.map((d, i) => (
                      <tr key={i}>
                        <td>{d.name}{!d.matched && <span className="pill warn" style={{ marginLeft: 6 }}>ยังจับคู่ชื่อไม่ได้</span>}</td>
                        <td className="n">{d.n}</td>
                        <td className="n"><Money v={d.sum} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {payload.unmatched.length > 0 && (
                <p className="muted" style={{ fontSize: '.85rem' }}>
                  ชื่อที่ยังจับคู่ไม่ได้ ระบบจะลองจับคู่จากทะเบียนให้ตอนนำเข้า ที่เหลือแจ้ง HR จับคู่ที่แท็บ “นำเข้าข้อมูล”
                </p>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" disabled={busy || !!wrongMonth} onClick={doImport}>
                  {busy ? 'กำลังนำเข้า…' : `นำเข้าค่ามือ ${dShort(range.from)}${range.from !== range.to ? ` – ${dShort(range.to)}` : ''}`}
                </button>
                <button disabled={busy} onClick={() => { setProc(null); setInputKey((k) => k + 1); }}>ยกเลิก</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---------- ประวัตินำเข้ารายวันของเดือนนี้ ---------- */}
      <div style={{ marginTop: 16 }}>
        <b style={{ fontSize: '.95rem' }}>นำเข้ารายวันของเดือนนี้ ({daily.length} ไฟล์)</b>
        {hrCheck && (
          <span className="pill ok" style={{ marginLeft: 8 }}>
            HR ตรวจทานทั้งเดือนแล้ว {dShort(String(hrCheck.at || '').slice(0, 10))}
          </span>
        )}
        {daily.length === 0 ? (
          <p className="muted" style={{ margin: '6px 0 0' }}>ยังไม่มีการนำเข้ารายวันในเดือนนี้</p>
        ) : (
          <div className="tablewrap" style={{ marginTop: 6, maxHeight: 300, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>วันที่ของไฟล์</th><th className="n">แพทย์</th><th className="n">ค่ามือ</th><th>สถานะ</th><th>นำเข้าโดย</th></tr>
              </thead>
              <tbody>
                {daily.map((h) => (
                  <tr key={h.id}>
                    <td>{dShort(h.dateFrom)}{h.dateFrom !== h.dateTo && <> – {dShort(h.dateTo)}</>}</td>
                    <td className="n">{h.rowsDoctor}</td>
                    <td className="n"><Money v={h.sumDoctorFee} /></td>
                    <td>
                      {h.status === 'OK' ? <span className="pill ok">ใช้อยู่</span>
                        : h.status === 'REPLACED' ? <span className="pill none">ถูกแทนที่</span>
                          : <span className="pill warn">{h.status}</span>}
                    </td>
                    <td className="muted">{h.by} · {String(h.at || '').replace('T', ' ').slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
