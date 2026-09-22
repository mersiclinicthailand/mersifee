/* ============================================================================
 * Roster.tsx — ตารางแพทย์ (แผนขึ้นเวรรายเดือน)
 *
 * 2 มุมมอง:
 *   ปฏิทิน    — เดือนละหน้า ดูทีละสาขา คลิกช่องไหนก็แก้เวรวันนั้นได้ทันที
 *   ตารางรวม  — 14 สาขาเรียงเป็นคอลัมน์ เทียบทั้งเดือนในจอเดียว คลิกแก้ได้เหมือนกัน
 *
 * สีประจำแพทย์คิดจากชื่อ (hash → เฉดสี) คนเดิมได้สีเดิมทุกเดือนทุกหน้าจอ
 * ฝ่ายบุคคล/บัญชี/ผู้ดูแลระบบ แก้ได้ · บทบาทอื่นดูอย่างเดียว (บังคับจริงที่ RPC)
 * ==========================================================================*/
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Scope } from '../App';
import { api, type RosterMonth, type RosterRow, type RosterImportResult } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseRosterFile, type RosterParsed } from '../lib/parse';
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

/** สีประจำแพทย์ — คนเดิมได้เฉดเดิมเสมอ อ่านง่ายทั้งพื้นอ่อนและตัวอักษรเข้ม */
const HUES = [4, 20, 36, 48, 86, 120, 150, 172, 192, 210, 230, 256, 280, 310, 334];
function docColor(label: string) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  const hue = HUES[h % HUES.length];
  return {
    background: `hsl(${hue} 60% 95%)`,
    borderColor: `hsl(${hue} 42% 80%)`,
    color: `hsl(${hue} 52% 28%)`,
  };
}

interface DocOpt { lic_no: string; full_name: string; nick_name: string }
interface EditCell { branch: string; date: string; row?: RosterRow }

export default function Roster({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [view, setView] = useState<'cal' | 'grid'>('cal');
  const [data, setData] = useState<RosterMonth | null>(null);
  const [parsed, setParsed] = useState<RosterParsed | null>(null);
  const [done, setDone] = useState<RosterImportResult | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [edit, setEdit] = useState<EditCell | null>(null);
  const [docs, setDocs] = useState<DocOpt[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const role = boot?.me.role;
  const mayEdit = ['admin', 'hr', 'acct', 'it'].includes(role || '');

  const load = () => {
    setData(null);
    api.roster(scope.ym).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(load, [scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ทะเบียนแพทย์ไว้ให้เลือกตอนแก้ — โหลดครั้งเดียวเมื่อเปิดกล่องแก้ไขครั้งแรก */
  useEffect(() => {
    if (!edit || docs || !mayEdit) return;
    api.listDoctors()
      .then((d) => setDocs((d as DocOpt[]).filter((x) => x.lic_no)))
      .catch(() => setDocs([]));
  }, [edit, docs, mayEdit]);

  const at = useMemo(() => {
    const m = new Map<string, RosterRow>();
    (data?.rows || []).forEach((r) => m.set(`${r.workDate}|${r.branch}`, r));
    return m;
  }, [data]);

  /* คอลัมน์ตารางรวม: เรียงตามกลุ่ม Area Manager แล้วตามลำดับในไฟล์ */
  const cols = useMemo(() => {
    const seen = new Map<string, string>();
    (data?.rows || []).forEach((r) => { if (!seen.has(r.branch)) seen.set(r.branch, r.amGroup || ''); });
    const list = [...seen].map(([code, am]) => ({ code, am }));
    list.sort((a, b) => (a.am === b.am ? 0 : a.am < b.am ? -1 : 1));
    return list.length ? list : (boot?.branches || []).map((b) => ({ code: b.code, am: '' }));
  }, [data, boot]);

  const branchName = (code: string) => boot?.branches.find((b) => b.code === code)?.nameTh || code;

  const summary = useMemo(() => {
    const per = new Map<string, { n: number; licNo: string; poolLic: string }>();
    let matched = 0, pooled = 0, unknown = 0;
    (data?.rows || []).forEach((r) => {
      const cur = per.get(r.docLabel) || { n: 0, licNo: r.licNo, poolLic: r.poolLic };
      cur.n += 1;
      per.set(r.docLabel, cur);
      if (r.licNo) matched += 1; else if (r.poolLic) pooled += 1; else unknown += 1;
    });
    return { matched, pooled, unknown, docs: [...per.entries()].sort((a, b) => b[1].n - a[1].n) };
  }, [data]);

  /* ---------------------------- นำเข้าไฟล์ ---------------------------- */
  async function pick(file?: File | null) {
    if (!file) return;
    setParsed(null); setDone(null); setMsg(null);
    await run(async () => {
      const p = await parseRosterFile(file);
      const known = new Set((boot?.branches || []).map((b) => b.code));
      const bad = p.cols.filter((c) => !known.has(c.code));
      if (bad.length) {
        throw new Error(`ไฟล์มีรหัสสาขาที่ระบบไม่รู้จัก: ${bad.map((b) => b.label).join(', ')} — `
          + 'แก้รหัสในไฟล์ให้ตรงกับทะเบียนสาขาก่อนนำเข้า');
      }
      setParsed(p);
    });
  }
  const saveImport = () => {
    if (!parsed) return;
    run(async () => {
      const r = await api.rosterImport(parsed.ym, parsed.rows);
      setDone(r); setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      if (r.ym === scope.ym) load(); else scope.setYm(r.ym);
    }, 'บันทึกตารางแพทย์เรียบร้อย');
  };

  /* ------------------------- แก้เวรทีละช่อง ------------------------- */
  const saveCell = (label: string, licNo?: string) => {
    if (!edit) return;
    run(async () => {
      await api.rosterSet(edit.branch, edit.date, label, licNo);
      setEdit(null);
      load();
    }, label ? 'บันทึกเวรแล้ว' : 'ลบเวรแล้ว');
  };

  const nDays = daysInMonth(scope.ym);
  const today = todayIso();
  const firstDow = new Date(`${scope.ym}-01T00:00:00`).getDay();

  const chip = (r: RosterRow, small?: boolean) => (
    <span className={`chip${small ? ' sm' : ''}`} style={docColor(r.docLabel)}
      title={r.licNo ? `${data?.names[r.licNo] || ''} (ว. ${r.licNo})`
        : r.poolLic ? `อยู่ในคลังรายชื่อแพทย์ (ว. ${r.poolLic})` : 'ยังไม่รู้จักชื่อนี้ในระบบ'}
    >
      <span className="t">{r.docLabel}</span>
      {!r.licNo && <span className="mk">{r.poolLic ? '○' : '?'}</span>}
    </span>
  );

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
          <button className="sm" onClick={() => setShowImport((v) => !v)}>
            {showImport ? 'ปิดการนำเข้า' : '↑ นำเข้าไฟล์ตารางเวร'}
          </button>
        )}
      </div>

      <Alerts err={err} msg={msg} />

      {mayEdit && showImport && (
        <Card title="นำเข้าตารางเวรรายเดือน"
          right={<span className="muted">ไฟล์ ตารางเวร-YYYY-MM.xlsx · อ่านเดือนจากหัวตารางเอง</span>}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls"
            onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
          {parsed && (
            <>
              <div className="grid stats" style={{ marginTop: 12 }}>
                <Stat k="เดือนในไฟล์" v={<YmLabel ym={parsed.ym} />} />
                <Stat k="จำนวนวัน" v={parsed.days} />
                <Stat k="สาขาในไฟล์" v={parsed.cols.length} />
                <Stat k="เวรที่อ่านได้" v={parsed.rows.length} />
              </div>
              {parsed.ym !== scope.ym && (
                <Note tone="warn">
                  ไฟล์นี้เป็นเดือน <b><YmLabel ym={parsed.ym} /></b> ไม่ตรงกับเดือนที่เลือกอยู่
                  ระบบจะบันทึกเข้าเดือนของไฟล์ แล้วสลับหน้าจอไปเดือนนั้นให้
                </Note>
              )}
              <Note tone="warn">จะ<b>แทนที่</b>ตารางแพทย์ของ <YmLabel ym={parsed.ym} /> ทั้งเดือน</Note>
              <button className="primary" onClick={saveImport} disabled={busy}>
                บันทึกตารางแพทย์ {parsed.rows.length} เวร
              </button>
            </>
          )}
          {done && (
            <Note tone="ok">
              บันทึก <b><YmLabel ym={done.ym} /></b> แล้ว {done.saved} เวร
              {done.removed > 0 && <> (แทนที่ของเดิม {done.removed} เวร)</>}
              <br />จับคู่ทะเบียนแพทย์ได้ {done.matched} เวร · เจอในคลังรายชื่อ {done.pooled} เวร
              {done.unmatched.length > 0
                ? <><br />ชื่อที่ยังไม่รู้จัก: {done.unmatched.map((u) => `${u.name} (${u.count})`).join(', ')}</>
                : <><br />จับคู่ชื่อได้ครบทุกชื่อ</>}
            </Note>
          )}
        </Card>
      )}

      {/* ---------------------------- ปฏิทิน ---------------------------- */}
      {view === 'cal' && (
        <Card
          title={<>{TH_MONTH[Number(scope.ym.split('-')[1]) - 1]} {Number(scope.ym.split('-')[0]) + 543}
            <span className="muted" style={{ fontWeight: 400 }}> · {scope.branch} {branchName(scope.branch)}</span></>}
          right={<span className="muted">{mayEdit ? 'คลิกวันไหนก็แก้เวรได้' : 'ดูอย่างเดียว'}</span>}
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
                  const cls = `cell${dow === 0 || dow === 6 ? ' we' : ''}${iso === today ? ' today' : ''}`;
                  const inner = (
                    <>
                      <span className="d">
                        {d}
                        {iso === today && <span className="dn">วันนี้</span>}
                      </span>
                      {r ? chip(r) : <span className="none">ไม่มีแพทย์</span>}
                    </>
                  );
                  return mayEdit
                    ? (
                      <button key={iso} className={cls} onClick={() => setEdit({ branch: scope.branch, date: iso, row: r })}>
                        {inner}
                      </button>
                    )
                    : <div key={iso} className={cls}>{inner}</div>;
                })}
              </div>
              <div className="legend" style={{ marginTop: 12 }}>
                <span><b>○</b> อยู่ในคลังรายชื่อแพทย์ ยังไม่ขึ้นทะเบียน</span>
                <span><b>?</b> ยังไม่รู้จักชื่อนี้ในระบบ</span>
                <span>ชี้ที่ชื่อเพื่อดูชื่อเต็มและเลข ว.</span>
              </div>
            </>
          )}
        </Card>
      )}

      {/* --------------------------- ตารางรวม --------------------------- */}
      {view === 'grid' && (
        <Card title={<>ตารางรวมทุกสาขา · <YmLabel ym={scope.ym} /></>}
          right={<span className="muted">{mayEdit ? 'คลิกช่องเพื่อแก้' : 'ดูอย่างเดียว'}</span>}>
          {!data ? <Skeleton rows={6} /> : data.rows.length === 0 ? (
            <p className="muted">ยังไม่มีตารางแพทย์ของเดือนนี้{mayEdit && ' — นำเข้าไฟล์ตารางเวรด้านบนเพื่อเริ่ม'}</p>
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
                    const we = dow === 0 || dow === 6;
                    return (
                      <tr key={iso} className={iso === today ? 'today' : undefined}>
                        <td className="tnum" style={we ? { color: 'var(--bad)' } : undefined}>
                          <b>{d}</b> {DOW[dow]}
                        </td>
                        {cols.map((c) => {
                          const r = at.get(`${iso}|${c.code}`);
                          return (
                            <td key={c.code}
                              style={mayEdit ? { cursor: 'pointer' } : undefined}
                              onClick={mayEdit ? () => setEdit({ branch: c.code, date: iso, row: r }) : undefined}
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
            <Stat k="แพทย์ในตาราง" v={summary.docs.length} />
            <Stat k="จับคู่ทะเบียนแพทย์ได้" v={summary.matched} s="ใช้เทียบกับใบเวรจริงได้" />
            <Stat k="ยังไม่รู้จักชื่อ" v={summary.unknown}
              tone={summary.unknown ? 'warn' : undefined}
              s={summary.unknown ? 'เพิ่มในทะเบียน/ชื่อต้นทางเพื่อให้เทียบได้' : 'ครบทุกชื่อ'} />
          </div>

          <Card title={<>จำนวนเวรต่อแพทย์ · <YmLabel ym={scope.ym} /></>}>
            <div className="tablewrap">
              <table>
                <thead><tr><th>แพทย์</th><th>สถานะ</th><th className="n">จำนวนเวร</th></tr></thead>
                <tbody>
                  {summary.docs.map(([label, v]) => (
                    <tr key={label}>
                      <td>
                        <span className="chip" style={docColor(label)}><span className="t">{label}</span></span>
                        {v.licNo && data.names[v.licNo] && (
                          <span className="muted"> {data.names[v.licNo]}</span>
                        )}
                      </td>
                      <td>
                        {v.licNo ? <span className="pill ok">ทะเบียนแพทย์ · ว. {v.licNo}</span>
                          : v.poolLic ? <span className="pill none">คลังรายชื่อ · ว. {v.poolLic}</span>
                            : <span className="pill warn">ยังไม่รู้จัก</span>}
                      </td>
                      <td className="n tnum">{v.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {edit && (
        <EditDialog
          cell={edit} docs={docs} busy={busy}
          used={summary.docs.map(([label]) => label)}
          branchTh={branchName(edit.branch)}
          onClose={() => setEdit(null)}
          onSave={saveCell}
        />
      )}
    </>
  );
}

/* ------------------------- กล่องแก้เวรรายวัน ------------------------- */
function EditDialog(
  { cell, docs, busy, used, branchTh, onClose, onSave }:
  {
    cell: EditCell; docs: DocOpt[] | null; busy: boolean; used: string[];
    branchTh: string; onClose: () => void; onSave: (label: string, lic?: string) => void;
  },
) {
  const [text, setText] = useState(cell.row?.docLabel || '');
  const [q, setQ] = useState('');

  const found = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!docs) return [];
    const list = k
      ? docs.filter((d) => `${d.nick_name} ${d.full_name} ${d.lic_no}`.toLowerCase().includes(k))
      : docs;
    return list.slice(0, 8);
  }, [docs, q]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(35,38,31,.45)', zIndex: 60,
      display: 'grid', placeItems: 'center', padding: 16,
    }}
    >
      <div className="card" style={{ maxWidth: 460, width: '100%', margin: 0 }}>
        <h3 style={{ marginBottom: 2 }}>{thaiDay(cell.date)}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          สาขา {cell.branch} · {branchTh}
          {cell.row && <> — เวรเดิม: <b>{cell.row.docLabel}</b></>}
        </p>

        {used.length > 0 && (
          <div className="field">
            <label>แพทย์ที่ขึ้นเวรเดือนนี้</label>
            <div className="picks">
              {used.slice(0, 14).map((u) => (
                <button key={u} type="button" onClick={() => setText(u)}>
                  <span className="chip" style={docColor(u)}><span className="t">{u}</span></span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>ค้นจากทะเบียนแพทย์</label>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="พิมพ์ชื่อเล่น ชื่อจริง หรือเลข ว." />
          {q.trim() !== '' && (
            <div className="picks" style={{ marginTop: 6 }}>
              {docs === null && <span className="muted">กำลังโหลดทะเบียน…</span>}
              {docs !== null && found.length === 0 && <span className="muted">ไม่พบชื่อนี้ในทะเบียน</span>}
              {found.map((d) => (
                <button key={d.lic_no} type="button"
                  onClick={() => { onSave(d.nick_name ? `หมอ${d.nick_name}` : d.full_name, d.lic_no); }}
                >
                  <span className="chip" style={docColor(d.nick_name ? `หมอ${d.nick_name}` : d.full_name)}>
                    <span className="t">{d.nick_name ? `หมอ${d.nick_name}` : d.full_name}</span>
                    <span className="mk">ว. {d.lic_no}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="field">
          <label>ชื่อที่จะให้แสดงในตาราง</label>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="เช่น หมอเต้ย" />
          <span className="muted">
            ระบบจะจับคู่ชื่อนี้กับทะเบียนแพทย์ให้เอง — พิมพ์ชื่อที่ยังไม่มีในระบบก็บันทึกได้
          </span>
        </div>

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <button className="danger" disabled={busy || !cell.row} onClick={() => onSave('')}>
            ลบเวรวันนี้
          </button>
          <div className="row">
            <button onClick={onClose} disabled={busy}>ยกเลิก</button>
            <button className="primary" disabled={busy || !text.trim()} onClick={() => onSave(text.trim())}>
              บันทึก
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
