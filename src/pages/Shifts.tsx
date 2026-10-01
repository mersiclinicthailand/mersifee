import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace } from '../lib/api';
import { useAuth } from '../lib/auth';
import { validateShifts, type ShiftRow } from '../lib/calc';
import { toIsoDate, toThaiDate, cellStr } from '../lib/core';
import {
  Alerts, BranchMonthPicker, Card, Note, Skeleton, StatusPill, useAsync,
} from '../components/ui';
import { docNick } from '../lib/names';

const KINDS: { v: string; t: string }[] = [
  { v: 'SHIFT', t: 'เวรปกติ' },
  { v: 'NIGHT', t: 'เวรข้ามคืน' },
  { v: 'SPECIAL', t: 'ยอดพิเศษ/เหมา' },
  { v: 'MEETING', t: 'ประชุมประจำเดือน' },
  { v: 'KOL', t: 'ค่าตอบแทน KOL' },
];

const SOURCE_TH: Record<string, string> = {
  MANUAL: 'กรอกมือ', CLOCK: 'ลงเวลาหน้าจอ', IMPORT: 'ไฟล์เดิม',
};

type Row = ShiftRow & { _new?: boolean };
type Doc = { licNo?: string; nickName?: string; fullName?: string };

/** เรียงใบเวรเป็นกลุ่มรายแพทย์ (ชื่อเล่นตามตัวอักษรไทย) → วันที่ → เวลาเข้า
 *  บรรทัดที่ยังไม่เลือกแพทย์อยู่ท้ายสุด */
function sortRows(rows: Row[], docs: Doc[]): Row[] {
  const nick: Record<string, string> = {};
  docs.forEach((d) => { nick[cellStr(d.licNo)] = docNick(cellStr(d.nickName)) || cellStr(d.fullName); });
  const key = (r: Row) => nick[cellStr(r.licNo)] || cellStr(r.licNo);
  return rows.slice().sort((a, b) => {
    const la = cellStr(a.licNo), lb = cellStr(b.licNo);
    if (!la !== !lb) return la ? -1 : 1;
    const n = key(a).localeCompare(key(b), 'th');
    if (n) return n;
    if (la !== lb) return la < lb ? -1 : 1;               // ชื่อเล่นซ้ำกัน (เช่น เต้ย 2 คน) แยกด้วยเลข ว.
    const d = toIsoDate(a.workDate).localeCompare(toIsoDate(b.workDate));
    if (d) return d;
    return cellStr(a.timeIn).localeCompare(cellStr(b.timeIn));
  });
}

export default function Shifts({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const load = () => {
    setWs(null);
    api.workspace(scope.branch, scope.ym)
      .then((w) => {
        setWs(w);
        setRows(sortRows(w.shifts.map((s) => ({ ...s })), w.doctors));
        setDirty(false);
      })
      .catch((e) => setErr(e.message));
  };
  useEffect(load, [scope.branch, scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = ws?.period?.status || 'NONE';
  const locked = ['APPROVED', 'PAID'].includes(status);
  const docs = ws?.doctors || [];

  const errors = useMemo(() => validateShifts(rows), [rows]);

  /** วันที่มีค่าหัตถการแต่ยังไม่มีใบเวร — เติมให้อัตโนมัติ ผู้ใช้กรอกเวลาเอง */
  const suggestions = useMemo(() => {
    if (!ws) return [];
    const have = new Set(rows.map((r) => `${r.licNo}|${toIsoDate(r.workDate)}`));
    return ws.procDays
      .map((d) => ({ licNo: cellStr(d.licNo), date: toIsoDate(d.workDate), amount: Number(d.amount) }))
      .filter((d) => !have.has(`${d.licNo}|${d.date}`))
      .sort((a, b) => (a.licNo + a.date).localeCompare(b.licNo + b.date));
  }, [ws, rows]);

  const set = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  /** เพิ่มบรรทัด — ถ้าระบุแพทย์ จะแทรกเข้ากลุ่มของแพทย์คนนั้นตามลำดับวันที่ */
  const addRow = (licNo = '', workDate = '') => {
    const nr: Row = {
      id: '', licNo, workDate, timeIn: '12:00', timeOut: '20:00', breakMin: 0,
      specialAmt: '', handOverride: '', deductOther: 0, kind: 'SHIFT', note: '',
      source: 'MANUAL', _new: true,
    };
    setRows((rs) => (licNo ? sortRows([...rs, nr], docs) : [...rs, nr]));
    setDirty(true);
  };
  const nickOf = (lic: unknown) => {
    const d = docs.find((x) => cellStr(x.licNo) === cellStr(lic));
    return d ? (docNick(cellStr(d.nickName)) || '') : '';
  };
  const nameOf = (lic: unknown) => cellStr(docs.find((x) => cellStr(x.licNo) === cellStr(lic))?.fullName);

  const save = () => run(async () => {
    const payload = rows
      .filter((r) => cellStr(r.licNo) && toIsoDate(r.workDate))
      .map((r) => ({
        id: r._new ? '' : r.id, licNo: r.licNo, workDate: toIsoDate(r.workDate),
        timeIn: r.timeIn || '', timeOut: r.timeOut || '', breakMin: Number(r.breakMin) || 0,
        specialAmt: cellStr(r.specialAmt), handOverride: cellStr(r.handOverride),
        deductOther: Number(r.deductOther) || 0, kind: r.kind || 'SHIFT', note: r.note || '',
        source: r.source || 'MANUAL',
        // ลายเซ็นตอนออกเวรคงไว้เฉพาะเมื่อข้อมูลบรรทัดนั้นไม่เปลี่ยน — ฝั่งเซิร์ฟเวอร์รับค่านี้ไป
        signId: r.signId || '', signedAt: r.signedAt || '',
      }));
    const r = await api.saveShifts(scope.branch, scope.ym, payload);
    load();
    setMsg(`บันทึกใบเวร ${r.saved} รายการแล้ว`);
  });

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ใบเวรแพทย์</h1>
        {ws && <StatusPill s={status} />}
        <div className="spacer" />
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} msg={msg} />

      {locked && (
        <Note tone="warn">
          รอบนี้ถูกล็อกแล้ว แก้ใบเวรไม่ได้ — ต้องให้ผู้อนุมัติตีกลับก่อน
        </Note>
      )}

      {errors.length > 0 && (
        <Note tone="bad">
          <b>ต้องแก้ก่อนบันทึก ({errors.length} รายการ)</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </Note>
      )}

      {suggestions.length > 0 && !locked && (
        <Card title={<>วันที่มีค่าหัตถการแต่ยังไม่มีใบเวร ({suggestions.length} วัน)</>}>
          <Note tone="warn">
            ยอดค่ามือของวันเหล่านี้ยังไม่เข้าการคำนวณ และรอบนี้ส่งตรวจไม่ได้จนกว่าจะมีใบเวร
          </Note>
          <div className="row">
            {suggestions.slice(0, 40).map((s) => {
              const d = docs.find((x) => x.licNo === s.licNo);
              return (
                <button key={s.licNo + s.date} className="sm"
                  onClick={() => addRow(s.licNo, s.date)}
                >
                  + {docNick(d?.nickName) || s.licNo} · {toThaiDate(s.date)}
                </button>
              );
            })}
            <button
              className="sm primary"
              onClick={() => suggestions.forEach((s) => addRow(s.licNo, s.date))}
            >
              + เพิ่มทั้งหมด {suggestions.length} วัน
            </button>
          </div>
        </Card>
      )}

      <Card
        title={`ใบเวร ${rows.length} รายการ`}
        right={
          <div className="row">
            <button onClick={() => setRows((rs) => sortRows(rs, docs))} disabled={!rows.length}
              title="จัดเรียงใหม่หลังแก้แพทย์/วันที่">
              ↕ เรียงตามแพทย์
            </button>
            <button onClick={() => addRow()} disabled={locked}>+ เพิ่มบรรทัด</button>
            <button className="primary" onClick={save}
              disabled={busy || locked || !dirty || errors.length > 0}
            >
              บันทึกทั้งหมด
            </button>
          </div>
        }
      >
        {!ws ? <Skeleton rows={6} /> : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>แพทย์</th><th>ชื่อเล่น</th><th>วันที่</th><th>เข้า</th><th>ออก</th>
                  <th className="n">พัก (นาที)</th><th>ประเภท</th>
                  <th className="n">ยอดพิเศษ</th><th className="n">แก้ค่ามือ</th>
                  <th className="n">หักอื่น ๆ</th><th>หมายเหตุ</th><th>ที่มา</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const lic = cellStr(r.licNo);
                  const first = i === 0 || cellStr(rows[i - 1].licNo) !== lic;
                  const count = rows.filter((x) => cellStr(x.licNo) === lic).length;
                  return (
                  <Fragment key={i}>
                  {first && (
                    <tr className="group-row">
                      <td colSpan={13} style={{ background: 'var(--sage-lt)', paddingTop: 7, paddingBottom: 7 }}>
                        <div className="row" style={{ gap: 10 }}>
                          <b>{lic ? (nickOf(lic) ? `หมอ${nickOf(lic)}` : `ว.${lic}`) : 'ยังไม่เลือกแพทย์'}</b>
                          {lic && <span className="muted">ว.{lic} · {nameOf(lic)}</span>}
                          <span className="pill none">{count} เวร</span>
                          <div className="spacer" />
                          {lic && (
                            <button className="sm" disabled={locked} onClick={() => addRow(lic, '')}>
                              + เพิ่มเวรหมอคนนี้
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td>
                      <select value={cellStr(r.licNo)} disabled={locked}
                        onChange={(e) => set(i, { licNo: e.target.value })}
                      >
                        <option value="">— เลือก —</option>
                        {docs.map((d) => (
                          <option key={d.licNo} value={d.licNo}>
                            {d.licNo} · {docNick(d.nickName) || d.fullName}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}><b>{nickOf(r.licNo) || '—'}</b></td>
                    <td>
                      <input type="date" value={toIsoDate(r.workDate)} disabled={locked}
                        onChange={(e) => set(i, { workDate: e.target.value })}
                      />
                    </td>
                    <td>
                      <input type="time" value={cellStr(r.timeIn)} disabled={locked}
                        onChange={(e) => set(i, { timeIn: e.target.value })}
                      />
                    </td>
                    <td>
                      <input type="time" value={cellStr(r.timeOut)} disabled={locked}
                        onChange={(e) => set(i, { timeOut: e.target.value })}
                      />
                    </td>
                    <td className="n">
                      <input type="number" min={0} value={Number(r.breakMin) || 0} disabled={locked}
                        onChange={(e) => set(i, { breakMin: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <select value={cellStr(r.kind) || 'SHIFT'} disabled={locked}
                        onChange={(e) => set(i, { kind: e.target.value })}
                      >
                        {KINDS.map((k) => <option key={k.v} value={k.v}>{k.t}</option>)}
                      </select>
                    </td>
                    <td className="n">
                      <input value={cellStr(r.specialAmt)} disabled={locked} placeholder="—"
                        onChange={(e) => set(i, { specialAmt: e.target.value })}
                      />
                    </td>
                    <td className="n">
                      <input value={cellStr(r.handOverride)} disabled={locked} placeholder="อัตโนมัติ"
                        onChange={(e) => set(i, { handOverride: e.target.value })}
                      />
                    </td>
                    <td className="n">
                      <input type="number" value={Number(r.deductOther) || 0} disabled={locked}
                        onChange={(e) => set(i, { deductOther: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input value={cellStr(r.note)} disabled={locked} style={{ minWidth: 170 }}
                        placeholder={cellStr(r.specialAmt) ? 'ต้องระบุเหตุผล' : ''}
                        onChange={(e) => set(i, { note: e.target.value })}
                      />
                    </td>
                    <td className="muted">
                      {SOURCE_TH[cellStr(r.source) || 'MANUAL']}
                      {r.signId ? ' 🖊' : ''}
                    </td>
                    <td>
                      <button className="sm" disabled={locked}
                        onClick={() => { setRows((rs) => rs.filter((_, j) => j !== i)); setDirty(true); }}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                  </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={13} className="muted">ยังไม่มีใบเวรในรอบนี้</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          🖊 = แพทย์เซ็นบรรทัดนั้นแล้ว · แก้บรรทัดที่เซ็นแล้วจะทำให้ต้องเซ็นใหม่ ·
          ค่ามือรายวันดึงจากรายงานค่าหัตถการอัตโนมัติ ช่อง “แก้ค่ามือ” ใช้เมื่อต้องทับค่าจากต้นทางเท่านั้น
        </p>
      </Card>
    </>
  );
}
