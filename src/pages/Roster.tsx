/* ============================================================================
 * Roster.tsx — ตารางแพทย์ (แผนขึ้นเวรรายเดือนของทุกสาขา)
 *
 * เป็น "แผน" ไม่ใช่ใบเวรจริง — ใช้ดูล่วงหน้าว่าใครขึ้นสาขาไหนวันไหน
 * และใช้เทียบกับใบเวรที่บันทึกจริงได้ว่าตรงตามแผนหรือไม่
 *
 * ฝ่ายบุคคล/บัญชี/ผู้ดูแลระบบ นำเข้าไฟล์ "ตารางเวร-YYYY-MM.xlsx" เดือนละครั้ง
 * ไฟล์อ่านในเบราว์เซอร์ ส่งขึ้นเซิร์ฟเวอร์เฉพาะรายการเวรที่แปลงแล้ว
 * ==========================================================================*/
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Scope } from '../App';
import { api, type RosterMonth, type RosterImportResult } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseRosterFile, type RosterParsed } from '../lib/parse';
import { Alerts, BranchMonthPicker, Card, Note, Skeleton, Stat, useAsync, YmLabel } from '../components/ui';
import { pad2, toThaiDate } from '../lib/core';

const WEEKDAY = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

const daysInMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export default function Roster({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [data, setData] = useState<RosterMonth | null>(null);
  const [parsed, setParsed] = useState<RosterParsed | null>(null);
  const [done, setDone] = useState<RosterImportResult | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const role = boot?.me.role;
  const mayImport = ['admin', 'hr', 'acct', 'it'].includes(role || '');

  const load = () => {
    setData(null);
    api.roster(scope.ym).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(load, [scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  /* คอลัมน์: เรียงตามกลุ่ม Area Manager แล้วตามลำดับที่พบในไฟล์ — ให้หน้าตาเหมือนไฟล์ต้นฉบับ */
  const cols = useMemo(() => {
    const seen = new Map<string, string>();
    (data?.rows || []).forEach((r) => { if (!seen.has(r.branch)) seen.set(r.branch, r.amGroup || ''); });
    const list = [...seen].map(([code, am]) => ({ code, am }));
    list.sort((a, b) => (a.am === b.am ? 0 : a.am < b.am ? -1 : 1));
    if (!list.length) return (boot?.branches || []).map((b) => ({ code: b.code, am: '' }));
    return onlyMine ? list.filter((c) => c.code === scope.branch) : list;
  }, [data, boot, onlyMine, scope.branch]);

  const at = useMemo(() => {
    const m = new Map<string, RosterMonth['rows'][number]>();
    (data?.rows || []).forEach((r) => m.set(`${r.workDate}|${r.branch}`, r));
    return m;
  }, [data]);

  const branchName = (code: string) =>
    boot?.branches.find((b) => b.code === code)?.nameTh || code;

  /* สรุปจำนวนเวรต่อแพทย์ + สถานะการจับคู่ชื่อ */
  const summary = useMemo(() => {
    const per = new Map<string, { n: number; licNo: string; poolLic: string }>();
    let matched = 0, pooled = 0, unknown = 0;
    (data?.rows || []).forEach((r) => {
      const cur = per.get(r.docLabel) || { n: 0, licNo: r.licNo, poolLic: r.poolLic };
      cur.n += 1;
      per.set(r.docLabel, cur);
      if (r.licNo) matched += 1;
      else if (r.poolLic) pooled += 1;
      else unknown += 1;
    });
    return {
      matched, pooled, unknown,
      docs: [...per.entries()].sort((a, b) => b[1].n - a[1].n),
    };
  }, [data]);

  async function pick(file?: File | null) {
    if (!file) return;
    setParsed(null); setDone(null); setMsg(null);
    await run(async () => {
      const p = await parseRosterFile(file);
      const known = new Set((boot?.branches || []).map((b) => b.code));
      const bad = p.cols.filter((c) => !known.has(c.code));
      if (bad.length) {
        throw new Error(
          `ไฟล์มีรหัสสาขาที่ระบบไม่รู้จัก: ${bad.map((b) => b.label).join(', ')} — ` +
          'แก้รหัสในไฟล์ให้ตรงกับทะเบียนสาขาก่อนนำเข้า',
        );
      }
      setParsed(p);
    });
  }

  const save = () => {
    if (!parsed) return;
    run(async () => {
      const r = await api.rosterImport(parsed.ym, parsed.rows);
      setDone(r);
      setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      if (r.ym === scope.ym) load(); else scope.setYm(r.ym);
    }, 'บันทึกตารางแพทย์เรียบร้อย');
  };

  const nDays = daysInMonth(scope.ym);
  const today = todayIso();

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
        <div className="spacer" />
        <button className="sm" onClick={() => setOnlyMine((v) => !v)}>
          {onlyMine ? 'ดูทุกสาขา' : `ดูเฉพาะ ${scope.branch}`}
        </button>
      </div>

      <Alerts err={err} msg={msg} />

      <Note tone="info">
        ตารางแพทย์คือ<b>แผน</b>ว่าใครขึ้นสาขาไหนวันไหน ไม่ใช่ใบเวรจริง
        ใช้เทียบกับใบเวรที่บันทึกได้ว่าตรงตามแผนหรือไม่
        {mayImport && <> · นำเข้าไฟล์เดือนเดิมซ้ำได้ ระบบจะแทนที่ทั้งเดือนให้</>}
      </Note>

      {mayImport && (
        <Card title="นำเข้าตารางเวรรายเดือน"
          right={<span className="muted">อ่านเดือนจากหัวตารางในไฟล์เอง</span>}>
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
              <Note tone="warn">
                จะ<b>แทนที่</b>ตารางแพทย์ของ <YmLabel ym={parsed.ym} /> ทั้งเดือน
              </Note>
              <button className="primary" onClick={save} disabled={busy}>
                บันทึกตารางแพทย์ {parsed.rows.length} เวร
              </button>
            </>
          )}

          {done && (
            <Note tone="ok">
              บันทึก <b><YmLabel ym={done.ym} /></b> แล้ว {done.saved} เวร
              {done.removed > 0 && <> (แทนที่ของเดิม {done.removed} เวร)</>}
              <br />จับคู่ทะเบียนแพทย์ได้ {done.matched} เวร · เจอในคลังรายชื่อ {done.pooled} เวร
              {done.unmatched.length > 0 ? (
                <>
                  <br />ชื่อที่ยังไม่รู้จัก {done.unmatched.length} ชื่อ:{' '}
                  {done.unmatched.map((u) => `${u.name} (${u.count})`).join(', ')}
                  <br /><span className="muted">
                    เพิ่มชื่อเหล่านี้ในทะเบียนแพทย์ หรือผูกไว้ที่ ทะเบียน → ชื่อต้นทาง แล้วนำเข้าไฟล์ซ้ำได้
                  </span>
                </>
              ) : <><br />จับคู่ชื่อได้ครบทุกชื่อ</>}
            </Note>
          )}
        </Card>
      )}

      <Card title={<>ตารางเวร <YmLabel ym={scope.ym} /></>}>
        {!data ? <Skeleton rows={6} /> : data.rows.length === 0 ? (
          <p className="muted">
            ยังไม่มีตารางแพทย์ของเดือนนี้
            {mayImport && ' — นำเข้าไฟล์ตารางเวรด้านบนเพื่อเริ่ม'}
          </p>
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
                  const wd = new Date(`${iso}T00:00:00`).getDay();
                  return (
                    <tr key={iso} className={iso === today ? 'today' : undefined}>
                      <td className="tnum" style={wd === 0 || wd === 6 ? { color: 'var(--bad)' } : undefined}>
                        <b>{d}</b> {WEEKDAY[wd]}
                      </td>
                      {cols.map((c) => {
                        const r = at.get(`${iso}|${c.code}`);
                        if (!r) return <td key={c.code} className="muted">—</td>;
                        const tip = r.licNo
                          ? `${data.names[r.licNo] || ''} (ว. ${r.licNo})`
                          : r.poolLic
                            ? `อยู่ในคลังรายชื่อแพทย์ (ว. ${r.poolLic})`
                            : 'ยังไม่รู้จักชื่อนี้ในระบบ';
                        return (
                          <td key={c.code} title={tip}>
                            {r.docLabel}
                            {!r.licNo && (r.poolLic
                              ? <span className="muted"> ○</span>
                              : <span className="pill warn" style={{ marginLeft: 4 }}>?</span>)}
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
                <thead>
                  <tr><th>ชื่อในตาราง</th><th>สถานะ</th><th className="n">จำนวนเวร</th></tr>
                </thead>
                <tbody>
                  {summary.docs.map(([label, v]) => (
                    <tr key={label}>
                      <td><b>{label}</b>{data.names[v.licNo] && <> <span className="muted">{data.names[v.licNo]}</span></>}</td>
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
            <p className="muted" style={{ marginBottom: 0 }}>
              อัปเดตล่าสุดของเดือนนี้นำเข้าโดยผู้ดูแลระบบผ่านหน้านี้ · ข้อมูลวันที่แสดงเป็น{' '}
              {toThaiDate(`${scope.ym}-01`).replace(/^\d+\s/, '')}
            </p>
          </Card>
        </>
      )}
    </>
  );
}
