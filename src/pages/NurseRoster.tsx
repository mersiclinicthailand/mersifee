/* ============================================================================
 * NurseRoster.tsx — ตารางพยาบาล (แผนขึ้นเวรพยาบาลรายเดือน)
 *
 * หน้าตาเหมือนตารางแพทย์ (ปฏิทินรายสาขา + ตารางรวมทุกสาขา) แต่ "ไม่เกี่ยวกับค่าตอบแทน"
 *   · นำเข้าไฟล์ mersi_ตารางเวรพยาบาล_YYYY-MM.xlsx (แทนที่ทั้งเดือน)
 *   · คลิกช่องเพื่อเปลี่ยนพยาบาล / ลบเวร · โหมด "สลับเวร" คลิก 2 ช่องเพื่อสลับกัน
 *   · ส่งออกไฟล์ นำเข้าข้อมูลวันทำงาน-วันหยุด ของ HumanSoft (รอบ 26 → 25)
 *   · ทะเบียนพยาบาล: รหัสพนักงาน HumanSoft / ชื่อ-สกุล / สาขาต้นสังกัด ไว้ใช้ตอนส่งออก
 * ฝ่ายบุคคล/บัญชี/IT/ผู้ดูแลระบบ แก้ได้ · บทบาทอื่นดูและส่งออกได้อย่างเดียว (บังคับจริงที่ RPC)
 * ==========================================================================*/
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Scope } from '../App';
import { api, type Nurse, type NurseImportResult, type NurseMonth, type NurseRow } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseNurseRosterFile, type NurseParsed } from '../lib/parse';
import { buildHsLines, buildHsWorkbook, hsFileName, prevYm } from '../lib/hsexport';
import { download } from '../lib/export';
import { Alerts, BranchMonthPicker, Card, Note, Skeleton, Stat, useAsync, YmLabel } from '../components/ui';
import { pad2 } from '../lib/core';

const DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

const daysInMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const thaiDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${TH_MONTH[m - 1]} ${y + 543}`;
};
const shortDay = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

/** สีประจำคน — คิดจากเลขใบประกอบ (หรือชื่อ) คนเดิมได้สีเดิมทุกเดือน */
const HUES = [4, 20, 36, 48, 86, 120, 150, 172, 192, 210, 230, 256, 280, 310, 334];
function nurseColor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = HUES[h % HUES.length];
  return {
    background: `hsl(${hue} 60% 95%)`,
    borderColor: `hsl(${hue} 42% 80%)`,
    color: `hsl(${hue} 52% 28%)`,
  };
}
const nurseLabel = (n: Nurse) => `พว.${n.nick || n.fullName.split(' ')[0] || n.licNo}`;

interface Cell { branch: string; date: string; row?: NurseRow }

export default function NurseRoster({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [view, setView] = useState<'cal' | 'grid'>('cal');
  const [data, setData] = useState<NurseMonth | null>(null);
  const [parsed, setParsed] = useState<NurseParsed | null>(null);
  const [done, setDone] = useState<NurseImportResult | null>(null);
  const [panel, setPanel] = useState<'' | 'import' | 'export' | 'registry'>('');
  const [edit, setEdit] = useState<Cell | null>(null);
  /** โหมดสลับเวร: null = ปิด · {} = เปิดแต่ยังไม่เลือก · มี branch = เลือกช่องแรกแล้ว */
  const [swap, setSwap] = useState<Partial<Cell> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const role = boot?.me.role;
  const mayEdit = ['admin', 'hr', 'acct', 'it'].includes(role || '');

  const load = () => {
    setData(null);
    api.nurseRoster(scope.ym).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(load, [scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  const at = useMemo(() => {
    const m = new Map<string, NurseRow>();
    (data?.rows || []).forEach((r) => m.set(`${r.workDate}|${r.branch}`, r));
    return m;
  }, [data]);

  const byLic = useMemo(() => new Map((data?.nurses || []).map((n) => [n.licNo, n])), [data]);

  /* คอลัมน์ตารางรวม: เรียงตามกลุ่ม Area Manager แล้วตามลำดับในไฟล์ */
  const cols = useMemo(() => {
    const seen = new Map<string, string>();
    (data?.rows || []).forEach((r) => { if (!seen.has(r.branch)) seen.set(r.branch, r.amGroup || ''); });
    (boot?.branches || []).forEach((b) => { if (!seen.has(b.code)) seen.set(b.code, '~'); });
    const list = [...seen].map(([code, am]) => ({ code, am }));
    list.sort((a, b) => (a.am === b.am ? 0 : a.am < b.am ? -1 : 1));
    return list;
  }, [data, boot]);

  const branchName = (code: string) => boot?.branches.find((b) => b.code === code)?.nameTh || code;

  const summary = useMemo(() => {
    const per = new Map<string, { label: string; licNo: string; n: number; br: Map<string, number> }>();
    (data?.rows || []).forEach((r) => {
      const k = r.licNo || r.label;
      const cur = per.get(k) || { label: r.label, licNo: r.licNo, n: 0, br: new Map() };
      cur.n += 1;
      cur.br.set(r.branch, (cur.br.get(r.branch) || 0) + 1);
      per.set(k, cur);
    });
    return [...per.values()].sort((a, b) => b.n - a.n);
  }, [data]);

  const unknown = (data?.rows || []).filter((r) => !r.licNo).length;

  /* ---------------------------- นำเข้าไฟล์ ---------------------------- */
  async function pick(file?: File | null) {
    if (!file) return;
    setParsed(null); setDone(null); setMsg(null);
    await run(async () => {
      const p = await parseNurseRosterFile(file);
      const known = new Set((boot?.branches || []).map((b) => b.code));
      const bad = [...new Set(p.rows.map((r) => r.branch).filter((c) => !known.has(c)))];
      if (bad.length) {
        throw new Error(`ไฟล์มีรหัสสาขาที่ระบบไม่รู้จัก: ${bad.join(', ')} — แก้รหัสในไฟล์ให้ตรงกับทะเบียนสาขาก่อนนำเข้า`);
      }
      setParsed(p);
    });
  }
  const saveImport = () => {
    if (!parsed) return;
    run(async () => {
      const r = await api.nurseImport(parsed.ym, parsed.rows);
      setDone(r); setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      if (r.ym === scope.ym) load(); else scope.setYm(r.ym);
    }, 'บันทึกตารางพยาบาลเรียบร้อย');
  };

  /* ------------------------- แก้ / สลับเวร ------------------------- */
  const clickCell = (c: Cell) => {
    if (!mayEdit) return;
    if (!swap) { setEdit(c); return; }
    if (!swap.branch) {
      if (!c.row) { setErr('เลือกช่องแรกเป็นช่องที่มีพยาบาลก่อน แล้วค่อยเลือกช่องที่จะสลับด้วย'); return; }
      setErr(null);
      setSwap(c);
      return;
    }
    if (swap.branch === c.branch && swap.date === c.date) { setSwap({}); return; }   // คลิกซ้ำ = ยกเลิกช่องแรก
    const a = swap as Cell;
    run(async () => {
      await api.nurseSwap({ branch: a.branch, date: a.date }, { branch: c.branch, date: c.date });
      setSwap({});
      load();
    }, c.row
      ? `สลับ ${a.row?.label} (${a.branch} ${shortDay(a.date)}) ⇄ ${c.row.label} (${c.branch} ${shortDay(c.date)}) แล้ว`
      : `ย้าย ${a.row?.label} จาก ${a.branch} ${shortDay(a.date)} → ${c.branch} ${shortDay(c.date)} แล้ว`);
  };

  const saveCell = (licNo?: string, label?: string) => {
    if (!edit) return;
    run(async () => {
      await api.nurseSet(edit.branch, edit.date, licNo, label);
      setEdit(null);
      load();
    }, licNo || label ? 'บันทึกเวรแล้ว' : 'ลบเวรแล้ว');
  };

  const isSel = (branch: string, date: string) => swap?.branch === branch && swap?.date === date;

  const nDays = daysInMonth(scope.ym);
  const today = todayIso();
  const firstDow = new Date(`${scope.ym}-01T00:00:00`).getDay();

  const chip = (r: NurseRow, small?: boolean) => {
    const n = r.licNo ? byLic.get(r.licNo) : undefined;
    const tip = [
      n ? `${n.fullName || r.label} (ใบประกอบ ${r.licNo})${n.hsCode ? ` · HumanSoft ${n.hsCode}` : ''}`
        : 'ยังไม่รู้จักชื่อนี้ในทะเบียนพยาบาล — ส่งออก HumanSoft ไม่ได้',
      r.note,
    ].filter(Boolean).join('\n');
    return (
      <span className={`chip${small ? ' sm' : ''}`} style={nurseColor(r.licNo || r.label)} title={tip}>
        <span className="t">{r.label}</span>
        {r.licNo ? <span className="lic">{r.licNo}</span> : <span className="mk">?</span>}
        {r.note && <span className="mk">✎</span>}
      </span>
    );
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg">
          <button className={view === 'cal' ? 'on' : ''} onClick={() => setView('cal')}>ปฏิทิน</button>
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')}>ตารางรวม</button>
        </div>
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm} hideBranch={view === 'grid'}
        />
        <div className="spacer" />
        {mayEdit && (
          <button className={`sm${swap ? ' primary' : ''}`} disabled={busy || !data?.rows.length}
            title="คลิกช่องแรก แล้วคลิกช่องที่จะสลับด้วย (ต่างวันหรือต่างสาขาก็ได้ · ช่องว่าง = ย้ายเวร)"
            onClick={() => { setSwap(swap ? null : {}); setErr(null); }}
          >
            {swap ? '✓ เลิกสลับเวร' : '⇄ สลับเวร'}
          </button>
        )}
        <button className="sm" onClick={() => setPanel(panel === 'export' ? '' : 'export')}>
          ↓ ส่งออก HumanSoft
        </button>
        {mayEdit && (
          <button className="sm" onClick={() => setPanel(panel === 'registry' ? '' : 'registry')}>
            ทะเบียนพยาบาล
          </button>
        )}
        {mayEdit && (
          <button className="sm" onClick={() => setPanel(panel === 'import' ? '' : 'import')}>
            {panel === 'import' ? 'ปิดการนำเข้า' : '↑ นำเข้าไฟล์ตารางพยาบาล'}
          </button>
        )}
      </div>

      <Alerts err={err} msg={msg} />

      {swap && (
        <Note tone="warn">
          <b>โหมดสลับเวร</b> —{' '}
          {swap.branch
            ? <>เลือกแล้ว: <b>{swap.row?.label}</b> {swap.branch} {thaiDay(swap.date!)} · คลิกช่องที่จะสลับด้วย
              (ช่องว่าง = ย้ายเวรไปช่องนั้น · คลิกช่องเดิมซ้ำ = ยกเลิก)</>
            : <>คลิกช่องแรกที่มีพยาบาล แล้วคลิกช่องที่จะสลับด้วย — ต่างวันหรือต่างสาขาก็ได้
              {view === 'cal' && ' (สลับข้ามสาขา ใช้มุมมอง "ตารางรวม" จะง่ายกว่า)'}</>}
        </Note>
      )}

      {mayEdit && panel === 'import' && (
        <Card title="นำเข้าตารางพยาบาลรายเดือน"
          right={<span className="muted">ไฟล์ mersi_ตารางเวรพยาบาล_YYYY-MM.xlsx · อ่านเดือนจากหัวตารางเอง</span>}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls"
            onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
          {parsed && (
            <>
              <div className="grid stats" style={{ marginTop: 12 }}>
                <Stat k="เดือนในไฟล์" v={<YmLabel ym={parsed.ym} />} />
                <Stat k="จำนวนวัน" v={parsed.days} />
                <Stat k="สาขาที่มีเวร" v={new Set(parsed.rows.map((r) => r.branch)).size} />
                <Stat k="เวรที่อ่านได้" v={parsed.rows.length} />
                <Stat k="พยาบาล" v={parsed.nurses} />
                <Stat k="มีเลขใบประกอบในไฟล์" v={`${parsed.withLic} / ${parsed.rows.length}`}
                  tone={parsed.withLic === parsed.rows.length ? 'ok' : 'warn'} />
              </div>
              <Note tone={parsed.source === 'SUMMARY' ? 'ok' : 'warn'}>
                {parsed.source === 'SUMMARY'
                  ? <>อ่านจากชีต <b>ข้อมูลรวม</b> — ได้เลขใบประกอบของพยาบาลมาจากไฟล์โดยตรง</>
                  : <>ไฟล์นี้ไม่มีชีต <b>ข้อมูลรวม</b> ระบบจึงอ่านจากตารางปฏิทินแทน</>}
              </Note>
              {parsed.ym !== scope.ym && (
                <Note tone="warn">
                  ไฟล์นี้เป็นเดือน <b><YmLabel ym={parsed.ym} /></b> ไม่ตรงกับเดือนที่เลือกอยู่
                  ระบบจะบันทึกเข้าเดือนของไฟล์ แล้วสลับหน้าจอไปเดือนนั้นให้
                </Note>
              )}
              <Note tone="warn">จะ<b>แทนที่</b>ตารางพยาบาลของ <YmLabel ym={parsed.ym} /> ทั้งเดือน (รวมช่องที่แก้มือไว้)</Note>
              <button className="primary" onClick={saveImport} disabled={busy}>
                บันทึกตารางพยาบาล {parsed.rows.length} เวร
              </button>
            </>
          )}
          {done && (
            <Note tone={done.unmatched.length ? 'warn' : 'ok'}>
              บันทึก <b><YmLabel ym={done.ym} /></b> แล้ว {done.saved} เวร
              {done.removed > 0 && <> (แทนที่ของเดิม {done.removed} เวร)</>}
              {' '}· รู้ว่าเป็นใคร {done.matched} เวร
              {done.registered > 0 && (
                <><br />ขึ้นทะเบียนพยาบาลใหม่ให้อัตโนมัติ <b>{done.registered} คน</b> — กรอก
                  <b> รหัสพนักงาน HumanSoft / ชื่อ-สกุล / สาขาต้นสังกัด</b> ที่ปุ่ม <b>ทะเบียนพยาบาล</b> ก่อนส่งออก</>
              )}
              {done.unmatched.length > 0 && (
                <><br />ยังไม่มีในทะเบียนพยาบาล: {done.unmatched.map((u) => `${u.name} (${u.count})`).join(', ')}</>
              )}
            </Note>
          )}
        </Card>
      )}

      {panel === 'export' && (
        <ExportCard ym={scope.ym} cur={data} branchName={branchName} mayEdit={mayEdit}
          openRegistry={() => setPanel('registry')} />
      )}

      {mayEdit && panel === 'registry' && data && (
        <RegistryCard nurses={data.nurses} branches={boot?.branches || []} onSaved={load} />
      )}

      {/* ---------------------------- ปฏิทิน ---------------------------- */}
      {view === 'cal' && (
        <Card
          title={<>ตารางพยาบาล · {TH_MONTH[Number(scope.ym.split('-')[1]) - 1]} {Number(scope.ym.split('-')[0]) + 543}
            <span className="muted" style={{ fontWeight: 400 }}> · {scope.branch} {branchName(scope.branch)}</span></>}
          right={<span className="muted">{mayEdit ? (swap ? 'โหมดสลับเวร' : 'คลิกวันไหนก็แก้เวรได้') : 'ดูอย่างเดียว'}</span>}
        >
          {!data ? <Skeleton rows={6} /> : (
            <>
              <div className="cal">
                {DOW.map((d, i) => (
                  <div key={d} className={`dow${i === 0 || i === 6 ? ' we' : ''}`}>{d}</div>
                ))}
                {Array.from({ length: firstDow }).map((_, i) => (
                  <div key={`pad${i}`} className="cell pad" />
                ))}
                {Array.from({ length: nDays }, (_, i) => i + 1).map((d) => {
                  const iso = `${scope.ym}-${pad2(d)}`;
                  const dow = new Date(`${iso}T00:00:00`).getDay();
                  const r = at.get(`${iso}|${scope.branch}`);
                  const cls = `cell${dow === 0 || dow === 6 ? ' we' : ''}${iso === today ? ' today' : ''}`
                    + `${isSel(scope.branch, iso) ? ' sel' : ''}`;
                  const inner = (
                    <>
                      <span className="d">
                        {d}
                        {iso === today && <span className="dn">วันนี้</span>}
                      </span>
                      {r ? chip(r) : <span className="none">ไม่มีพยาบาล</span>}
                    </>
                  );
                  return mayEdit
                    ? (
                      <button key={iso} className={cls} onClick={() => clickCell({ branch: scope.branch, date: iso, row: r })}>
                        {inner}
                      </button>
                    )
                    : <div key={iso} className={cls}>{inner}</div>;
                })}
              </div>
              <div className="legend" style={{ marginTop: 12 }}>
                <span><b>เลข 10 หลัก</b> เลขใบประกอบวิชาชีพของพยาบาลคนนั้น</span>
                <span><b>✎</b> มีหมายเหตุ เช่น สลับเวรมาจากช่องอื่น</span>
                <span><b>?</b> ยังไม่รู้จักชื่อในทะเบียนพยาบาล</span>
                <span>ตารางพยาบาลไม่นำไปคำนวณค่าตอบแทน</span>
              </div>
            </>
          )}
        </Card>
      )}

      {/* --------------------------- ตารางรวม --------------------------- */}
      {view === 'grid' && (
        <Card title={<>ตารางพยาบาลรวมทุกสาขา · <YmLabel ym={scope.ym} /></>}
          right={<span className="muted">{mayEdit ? (swap ? 'โหมดสลับเวร' : 'คลิกช่องเพื่อแก้') : 'ดูอย่างเดียว'}</span>}>
          {!data ? <Skeleton rows={6} /> : data.rows.length === 0 ? (
            <p className="muted">ยังไม่มีตารางพยาบาลของเดือนนี้{mayEdit && ' — นำเข้าไฟล์ตารางพยาบาลด้านบนเพื่อเริ่ม'}</p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>วันที่</th>
                    {cols.map((c) => (
                      <th key={c.code} className={c.code === scope.branch ? 'on' : undefined}>
                        {c.code}<br /><span className="muted">{branchName(c.code)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: nDays }, (_, i) => i + 1).map((d) => {
                    const iso = `${scope.ym}-${pad2(d)}`;
                    const dow = new Date(`${iso}T00:00:00`).getDay();
                    return (
                      <tr key={iso} className={iso === today ? 'today' : undefined}>
                        <td className="tnum" style={dow === 0 || dow === 6 ? { color: 'var(--bad)' } : undefined}>
                          <b>{d}</b> {DOW[dow]}
                        </td>
                        {cols.map((c) => {
                          const r = at.get(`${iso}|${c.code}`);
                          return (
                            <td key={c.code}
                              className={isSel(c.code, iso) ? 'sel' : undefined}
                              style={mayEdit ? { cursor: 'pointer' } : undefined}
                              onClick={mayEdit ? () => clickCell({ branch: c.code, date: iso, row: r }) : undefined}
                            >
                              {r ? chip(r, true) : <span className="muted">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ----------------------------- สรุป ----------------------------- */}
      {data && data.rows.length > 0 && (
        <>
          <div className="grid stats">
            <Stat k="เวรทั้งเดือน" v={data.rows.length} />
            <Stat k="พยาบาลในตาราง" v={summary.length} />
            <Stat k="ยังไม่รู้จักชื่อ" v={unknown} tone={unknown ? 'warn' : undefined}
              s={unknown ? 'เพิ่มในทะเบียนพยาบาล' : 'ครบทุกชื่อ'} />
          </div>

          <Card title={<>จำนวนเวรต่อพยาบาล · <YmLabel ym={scope.ym} /></>}>
            <div className="tablewrap">
              <table>
                <thead><tr><th>พยาบาล</th><th>รหัส HumanSoft</th><th>สาขาที่ขึ้นเวร</th><th className="n">จำนวนเวร</th></tr></thead>
                <tbody>
                  {summary.map((v) => {
                    const n = v.licNo ? byLic.get(v.licNo) : undefined;
                    return (
                      <tr key={v.licNo || v.label}>
                        <td>
                          <span className="chip" style={nurseColor(v.licNo || v.label)}><span className="t">{v.label}</span></span>
                          {n?.fullName && <span className="muted"> {n.fullName}</span>}
                        </td>
                        <td>{n?.hsCode || <span className="pill warn">ยังไม่มีรหัส</span>}</td>
                        <td className="muted">
                          {[...v.br.entries()].sort((a, b) => b[1] - a[1]).map(([b, k]) => `${b} ${k}`).join(' · ')}
                        </td>
                        <td className="n tnum">{v.n}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {edit && data && (
        <EditDialog
          cell={edit} busy={busy} nurses={data.nurses.filter((n) => n.active)} rows={data.rows}
          branchTh={branchName(edit.branch)}
          onClose={() => setEdit(null)}
          onSave={saveCell}
          onSwap={() => { setSwap(edit); setEdit(null); }}
        />
      )}
    </>
  );
}

/* ------------------------- กล่องแก้เวรรายวัน ------------------------- */
function EditDialog(
  { cell, busy, nurses, rows, branchTh, onClose, onSave, onSwap }:
  {
    cell: Cell; busy: boolean; nurses: Nurse[]; rows: NurseRow[]; branchTh: string;
    onClose: () => void; onSave: (licNo?: string, label?: string) => void; onSwap: () => void;
  },
) {
  const [text, setText] = useState('');
  /** พยาบาลที่มีเวรสาขาอื่นในวันเดียวกันแล้ว — เตือนก่อนเลือกซ้ำ */
  const busyOn = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => {
      if (r.workDate === cell.date && r.branch !== cell.branch && r.licNo) m.set(r.licNo, r.branch);
    });
    return m;
  }, [rows, cell]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(35,38,31,.45)', zIndex: 60,
      display: 'grid', placeItems: 'center', padding: 16,
    }}
    >
      <div className="card" style={{ maxWidth: 480, width: '100%', margin: 0 }}>
        <h3 style={{ marginBottom: 2 }}>{thaiDay(cell.date)}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          สาขา {cell.branch} · {branchTh}
          {cell.row && <> — เวรเดิม: <b>{cell.row.label}</b></>}
          {cell.row?.note && <><br />หมายเหตุ: {cell.row.note}</>}
        </p>

        <div className="field">
          <label>เลือกพยาบาล</label>
          <div className="picks">
            {nurses.length === 0 && <span className="muted">ยังไม่มีพยาบาลในทะเบียน — นำเข้าไฟล์ตารางพยาบาลก่อน</span>}
            {nurses.map((n) => {
              const other = busyOn.get(n.licNo);
              const cur = cell.row?.licNo === n.licNo;
              return (
                <button key={n.licNo} type="button" disabled={busy || cur}
                  title={other ? `มีเวรที่ ${other} วันนี้อยู่แล้ว` : n.fullName || n.licNo}
                  onClick={() => {
                    if (other && !window.confirm(`${nurseLabel(n)} มีเวรที่สาขา ${other} วันนี้อยู่แล้ว — ยังต้องการลงเวรซ้ำอีกสาขาหรือไม่?\n(ถ้าต้องการสลับ ให้ใช้ปุ่ม "สลับกับช่องอื่น")`)) return;
                    onSave(n.licNo);
                  }}
                >
                  <span className="chip" style={nurseColor(n.licNo)}>
                    <span className="t">{nurseLabel(n)}</span>
                    {other && <span className="mk">มีเวร {other}</span>}
                    {cur && <span className="mk">✓</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>หรือพิมพ์ชื่อเอง (คนที่ยังไม่อยู่ในทะเบียน)</label>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="เช่น พว.ฟิล์ม" />
        </div>

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <div className="row">
            <button className="danger" disabled={busy || !cell.row} onClick={() => onSave()}>ลบเวรวันนี้</button>
            <button disabled={busy || !cell.row} onClick={onSwap} title="เลือกอีกช่องเพื่อสลับพยาบาลกัน">
              ⇄ สลับกับช่องอื่น
            </button>
          </div>
          <div className="row">
            <button onClick={onClose} disabled={busy}>ยกเลิก</button>
            <button className="primary" disabled={busy || !text.trim()} onClick={() => onSave(undefined, text.trim())}>
              บันทึก
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------- ส่งออก HumanSoft --------------------------- */
function ExportCard(
  { ym, cur, branchName, mayEdit, openRegistry }:
  {
    ym: string; cur: NurseMonth | null; branchName: (c: string) => string; mayEdit: boolean;
    openRegistry: () => void;
  },
) {
  const [prev, setPrev] = useState<NurseMonth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pym = prevYm(ym);

  useEffect(() => {
    setPrev(null);
    api.nurseRoster(pym).then(setPrev).catch((e) => setErr(e.message));
  }, [pym]);

  const built = useMemo(() => {
    if (!cur || !prev) return null;
    return buildHsLines(ym, cur.nurses, [...prev.rows, ...cur.rows], branchName);
  }, [ym, cur, prev, branchName]);

  const noCode = built?.lines.filter((l) => !l.code) || [];
  const unknownRows = [...(prev?.rows || []), ...(cur?.rows || [])]
    .filter((r) => !r.licNo && built?.days.includes(r.workDate));
  const [y, m] = ym.split('-').map(Number);
  const pm = Number(pym.slice(5, 7));

  const go = async () => {
    if (!built) return;
    setBusy(true); setErr(null);
    try {
      download(await buildHsWorkbook(built.days, built.lines), hsFileName(ym));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="ส่งออกไฟล์นำเข้า HumanSoft (วันทำงาน-วันหยุด)"
      right={<span className="muted">รูปแบบเดียวกับ นำเข้าข้อมูลวันทำงาน-วันหยุด_RM_11_2026.xlsx</span>}>
      <Alerts err={err} msg={null} />
      {!built ? <Skeleton rows={3} /> : (
        <>
          <p style={{ marginTop: 0 }}>
            รอบเงินเดือน <b>26 {TH_MONTH[pm - 1]} – 25 {TH_MONTH[m - 1]} {y + 543}</b> ({built.days.length} วัน)
            · พยาบาล <b>{built.lines.length} คน</b>
            <br /><span className="muted">วันที่มีเวร = <b>00-วันทำงาน</b> · วันที่ไม่มีเวร = <b>03-วันหยุดพนักงาน</b></span>
          </p>
          {prev && prev.rows.length === 0 && (
            <Note tone="warn">
              ยังไม่มีตารางพยาบาลเดือน <b><YmLabel ym={pym} /></b> — วันที่ 26–{daysInMonth(pym)} {TH_MONTH[pm - 1]}
              จะเป็น "วันหยุดพนักงาน" ทุกคน · นำเข้าตารางเดือนก่อนด้วยถ้าต้องการให้ครบรอบ
            </Note>
          )}
          {cur && cur.rows.length === 0 && (
            <Note tone="warn">ยังไม่มีตารางพยาบาลเดือน <b><YmLabel ym={ym} /></b></Note>
          )}
          {noCode.length > 0 && (
            <Note tone="warn">
              ยังไม่มี<b>รหัสพนักงาน HumanSoft</b> {noCode.length} คน: {noCode.map((l) => l.name).join(', ')}
              {' '}— HumanSoft จะนำเข้าแถวเหล่านี้ไม่ได้
              {mayEdit && <> · <button className="sm" onClick={openRegistry}>กรอกที่ทะเบียนพยาบาล</button></>}
            </Note>
          )}
          {unknownRows.length > 0 && (
            <Note tone="warn">
              มี {unknownRows.length} เวรที่ยังไม่รู้ว่าเป็นพยาบาลคนไหน ({[...new Set(unknownRows.map((r) => r.label))].join(', ')})
              — ไม่ถูกนับในไฟล์
            </Note>
          )}
          <div className="tablewrap" style={{ marginBottom: 12 }}>
            <table>
              <thead>
                <tr><th>รหัส</th><th>ชื่อพนักงาน</th><th>สาขา</th><th>แผนก</th><th>ตำแหน่ง</th>
                  <th className="n">วันทำงาน</th><th className="n">วันหยุด</th></tr>
              </thead>
              <tbody>
                {built.lines.map((l) => (
                  <tr key={l.licNo}>
                    <td>{l.code || <span className="pill warn">ไม่มีรหัส</span>}</td>
                    <td>{l.name}</td><td>{l.branch || '—'}</td><td>{l.dept}</td><td>{l.position}</td>
                    <td className="n tnum">{l.workDays}</td>
                    <td className="n tnum">{built.days.length - l.workDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="primary" disabled={busy || !built.lines.length} onClick={go}>
            ↓ ดาวน์โหลด {hsFileName(ym)}
          </button>
        </>
      )}
    </Card>
  );
}

/* ---------------------------- ทะเบียนพยาบาล ---------------------------- */
const EMPTY: Nurse = {
  licNo: '', nick: '', fullName: '', hsCode: '', homeBranch: '',
  dept: 'แผนกบริการ', position: 'พยาบาล(Nurse)', phone: '', active: true,
};

function RegistryCard(
  { nurses, branches, onSaved }:
  { nurses: Nurse[]; branches: { code: string; nameTh: string }[]; onSaved: () => void },
) {
  const [list, setList] = useState<Nurse[]>(() => nurses.map((n) => ({ ...n })));
  const [adding, setAdding] = useState<Nurse | null>(null);
  const { busy, err, msg, run } = useAsync();
  useEffect(() => setList(nurses.map((n) => ({ ...n }))), [nurses]);

  const orig = useMemo(() => new Map(nurses.map((n) => [n.licNo, JSON.stringify(n)])), [nurses]);
  const dirty = (n: Nurse) => orig.get(n.licNo) !== JSON.stringify(n);
  const put = (i: number, k: keyof Nurse, v: string | boolean) =>
    setList((l) => l.map((n, j) => (j === i ? { ...n, [k]: v } : n)));

  const save = (n: Nurse, isNew = false) => run(async () => {
    await api.nurseSave(n);
    if (isNew) setAdding(null);
    onSaved();
  }, `บันทึก พว.${n.nick || n.licNo} แล้ว`);

  const row = (n: Nurse, set: (k: keyof Nurse, v: string | boolean) => void, action: React.ReactNode, isNew = false) => (
    <tr key={isNew ? 'new' : n.licNo} style={n.active ? undefined : { opacity: 0.55 }}>
      <td>
        {isNew
          ? <input value={n.licNo} onChange={(e) => set('licNo', e.target.value)} placeholder="เลขใบประกอบ" style={{ width: 120 }} />
          : <span className="tnum">{n.licNo}</span>}
      </td>
      <td><input value={n.nick} onChange={(e) => set('nick', e.target.value)} style={{ width: 70 }} /></td>
      <td><input value={n.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="นางสาว... ..." style={{ width: 190 }} /></td>
      <td>
        <input value={n.hsCode} onChange={(e) => set('hsCode', e.target.value.toUpperCase())} placeholder="RM690901"
          style={{ width: 100, borderColor: n.hsCode ? undefined : 'var(--warn, #C6A058)' }} />
      </td>
      <td>
        <select value={n.homeBranch} onChange={(e) => set('homeBranch', e.target.value)}>
          <option value="">—</option>
          {branches.map((b) => <option key={b.code} value={b.code}>{b.code} · {b.nameTh}</option>)}
        </select>
      </td>
      <td><input value={n.dept} onChange={(e) => set('dept', e.target.value)} style={{ width: 100 }} /></td>
      <td><input value={n.position} onChange={(e) => set('position', e.target.value)} style={{ width: 200 }} /></td>
      <td><input value={n.phone} onChange={(e) => set('phone', e.target.value)} style={{ width: 100 }} /></td>
      <td style={{ textAlign: 'center' }}>
        <input type="checkbox" checked={n.active} onChange={(e) => set('active', e.target.checked)} />
      </td>
      <td>{action}</td>
    </tr>
  );

  return (
    <Card title="ทะเบียนพยาบาล"
      right={<span className="muted">ข้อมูลที่ใช้ในไฟล์ HumanSoft · ชื่อ-สกุลให้ใส่แบบเดียวกับใน HumanSoft</span>}>
      <Alerts err={err} msg={msg} />
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>เลขใบประกอบ</th><th>ชื่อเล่น</th><th>ชื่อ-นามสกุล</th><th>รหัส HumanSoft</th>
              <th>สาขาต้นสังกัด</th><th>แผนก</th><th>ตำแหน่ง</th><th>เบอร์โทร</th><th>ยังทำงาน</th><th />
            </tr>
          </thead>
          <tbody>
            {list.map((n, i) => row(n, (k, v) => put(i, k, v),
              <button className="sm primary" disabled={busy || !dirty(n)} onClick={() => save(n)}>บันทึก</button>))}
            {adding && row(adding, (k, v) => setAdding({ ...adding, [k]: v }),
              <div className="row">
                <button className="sm primary" disabled={busy || !/\d{5,}/.test(adding.licNo)} onClick={() => save(adding, true)}>เพิ่ม</button>
                <button className="sm" onClick={() => setAdding(null)}>ยกเลิก</button>
              </div>, true)}
          </tbody>
        </table>
      </div>
      {!adding && <button className="sm" style={{ marginTop: 8 }} onClick={() => setAdding({ ...EMPTY })}>+ เพิ่มพยาบาล</button>}
      <p className="muted" style={{ marginBottom: 0 }}>
        พยาบาลที่ไม่ได้ติ๊ก "ยังทำงาน" จะไม่อยู่ในไฟล์ HumanSoft (ยกเว้นมีเวรในรอบนั้น) และไม่ขึ้นให้เลือกตอนแก้เวร
      </p>
    </Card>
  );
}
