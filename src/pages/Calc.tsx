import React, { useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace } from '../lib/api';
import { useAuth } from '../lib/auth';
import { calcCore, type CalcResult } from '../lib/calc';
import { fmtMoney, toThaiDate } from '../lib/core';
import { buildFileName, buildWorkbook, buildMultiBranchWorkbook, download, toCsv } from '../lib/export';
import {
  Alerts, BranchMonthPicker, Card, Money, Note, Skeleton, Stat, StatusPill, useAsync,
} from '../components/ui';

const SIGN_TH: Record<string, { t: string; c: string }> = {
  OK:    { t: 'เซ็นแล้ว', c: 'ok' },
  STALE: { t: 'ต้องเซ็นใหม่', c: 'warn' },
  NONE:  { t: 'ยังไม่เซ็น', c: 'none' },
  SKIP:  { t: '—', c: 'none' },
};

export default function Calc({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState('');
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  useEffect(() => {
    setWs(null);
    api.workspace(scope.branch, scope.ym).then(setWs).catch((e) => setErr(e.message));
  }, [scope.branch, scope.ym, setErr]);

  const res: CalcResult | null = useMemo(
    () => (ws && boot ? calcCore(api.toCalcCtx(ws, boot.config)) : null),
    [ws, boot],
  );

  const branchInfo = boot?.branches.find((b) => b.code === scope.branch);
  const status = ws?.period?.status || 'NONE';

  async function exportOne() {
    if (!res || !branchInfo) return;
    setExporting('one');
    await run(async () => {
      const blob = await buildWorkbook(res, branchInfo, scope.ym);
      download(blob, buildFileName(branchInfo.fileCode, scope.ym));
      setMsg('ส่งออกไฟล์เรียบร้อย — ไฟล์มีสูตร Excel จริงทุกคอลัมน์ แก้เวลาในไฟล์แล้วยอดคำนวณต่อได้');
    });
    setExporting('');
  }

  /** ส่งออกทุกสาขาที่ส่งข้อมูลแล้วในเดือนนี้เป็นไฟล์เดียว
   *  ระบบเดิมทำได้ครั้งละไม่เกิน 6 สาขาเพราะเพดาน 6 นาทีของ Apps Script */
  async function exportAll() {
    if (!boot) return;
    setExporting('all');
    await run(async () => {
      const items: { res: CalcResult; br: typeof branchInfo }[] = [];
      for (const b of boot.branches) {
        const w = await api.workspace(b.code, scope.ym);
        if (!w.period) continue;
        items.push({ res: calcCore(api.toCalcCtx(w, boot.config)), br: b });
      }
      if (!items.length) throw new Error('เดือนนี้ยังไม่มีสาขาใดส่งข้อมูล');
      const blob = await buildMultiBranchWorkbook(
        items as { res: CalcResult; br: { code: string; nameEn: string; fileCode: string } }[],
        scope.ym,
      );
      download(blob, `ค่าตอบแทนแพทย์-ทุกสาขา-${scope.ym}.xlsx`);
      setMsg(`ส่งออก ${items.length} สาขาในไฟล์เดียวเรียบร้อย`);
    });
    setExporting('');
  }

  async function exportCsv() {
    if (!ws?.period) return;
    setExporting('csv');
    await run(async () => {
      const rows = await api.listProc(ws.pid) as Record<string, unknown>[];
      const blob = toCsv(
        ['วันที่ออกบิล', 'HN', 'พนักงานต้นทาง', 'รหัส ว.', 'ชื่อคอร์ส', 'จำนวน', 'เลขที่เอกสาร', 'ค่ามือ'],
        rows.map((r) => [r.bill_date, r.hn, r.emp_raw, r.lic_no, r.course, r.qty, r.doc_no, r.fee]),
      );
      download(blob, `รายการหัตถการ-${ws.pid}.csv`);
      setMsg(`ส่งออก CSV ${rows.length.toLocaleString()} แถวเรียบร้อย`);
    });
    setExporting('');
  }

  const T = res?.totals;

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>คำนวณค่าตอบแทน</h1>
        {ws && <StatusPill s={status} />}
        <div className="spacer" />
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} msg={msg} />

      {!res || !T ? <div className="card"><Skeleton rows={6} /></div> : (
        <>
          {res.blockers > 0 && (
            <Note tone="bad">
              รอบนี้มีปัญหาระดับ<b>บล็อก {res.blockers} รายการ</b> — ส่งตรวจและอนุมัติไม่ได้จนกว่าจะแก้
              (ดูรายละเอียดที่แท็บ “กระทบยอด”)
            </Note>
          )}

          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat k="รวมค่าเวร 40(2)" v={<Money v={T.shiftTotal} />} s={`${T.hrs} ชม. ${T.mins} นาที`} />
            <Stat k="รวมค่ามือ 40(6)" v={<Money v={T.handTotal} />} s={`${T.procRows.toLocaleString()} รายการ`} />
            <Stat k="รวมเงินได้" v={<Money v={T.gross} />} s={`แพทย์ ${T.doctors} คน`} />
            <Stat k="จ่ายสุทธิ" v={<Money v={T.net} />} s={`หักภาษี ${fmtMoney(T.tax)} · หักอื่น ${fmtMoney(T.deduct)}`} />
          </div>

          <Card
            title="สรุปรายแพทย์"
            right={
              <div className="row">
                <button onClick={exportOne} disabled={busy}>
                  {exporting === 'one' ? 'กำลังสร้างไฟล์…' : '⬇ ส่งออก Excel สาขานี้'}
                </button>
                {boot?.me.allBranch && (
                  <button onClick={exportAll} disabled={busy}>
                    {exporting === 'all' ? 'กำลังสร้างไฟล์…' : '⬇ ส่งออกทุกสาขา'}
                  </button>
                )}
                <button onClick={exportCsv} disabled={busy || !ws?.period}>
                  {exporting === 'csv' ? 'กำลังสร้าง…' : '⬇ CSV รายการหัตถการ'}
                </button>
              </div>
            }
          >
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>รหัส ว.</th><th>ชื่อ-สกุล</th><th>ชื่อเล่น</th>
                    <th className="n">อัตรา/ชม.</th><th className="n">ชม.</th><th className="n">นาที</th>
                    <th className="n">ค่าเวร</th><th className="n">ค่ามือ</th><th className="n">รวมเงินได้</th>
                    <th className="n">ภาษี</th><th className="n">หักอื่น</th><th className="n">จ่ายสุทธิ</th>
                    <th>ลายเซ็น</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {res.lines.map((L) => (
                    <React.Fragment key={L.licNo}>
                      <tr>
                        <td>{L.licNo}</td>
                        <td>{L.payeeType === 'COMPANY' && L.payeeName ? L.payeeName : L.fullName || <span className="pill block">ไม่มีในทะเบียน</span>}</td>
                        <td>{L.nickName}</td>
                        <td className="n"><Money v={L.rate} /></td>
                        <td className="n">{L.sumHrs}</td>
                        <td className="n">{L.sumMins}</td>
                        <td className="n"><Money v={L.coverShift} /></td>
                        <td className="n"><Money v={L.handTotal} /></td>
                        <td className="n"><Money v={L.gross} /></td>
                        <td className="n">
                          <Money v={L.taxAmt} />
                          <div className="muted" style={{ fontSize: '.7rem' }}>
                            {L.taxBase === 'NONE' ? 'ไม่หัก' : L.taxBase === 'SHIFT' ? 'ฐานค่าเวร' : 'ฐานรวมเงินได้'}
                          </div>
                        </td>
                        <td className="n"><Money v={L.deductTotal} dash /></td>
                        <td className="n"><b><Money v={L.net} /></b></td>
                        <td>
                          <span className={`pill ${SIGN_TH[L.sign.status]?.c || 'none'}`}>
                            {SIGN_TH[L.sign.status]?.t || L.sign.status}
                          </span>
                        </td>
                        <td>
                          <button className="sm"
                            onClick={() => setOpen(open === L.licNo ? null : L.licNo)}
                          >
                            {open === L.licNo ? 'ซ่อน' : 'รายวัน'}
                          </button>
                        </td>
                      </tr>
                      {open === L.licNo && (
                        <tr className="sub">
                          <td colSpan={14}>
                            <table style={{ margin: '4px 0' }}>
                              <thead>
                                <tr>
                                  <th>วันที่</th><th>เข้า</th><th>ออก</th>
                                  <th className="n">ชม.</th><th className="n">นาที</th>
                                  <th className="n">ค่าเวร</th><th className="n">ค่ามือ/วัน</th>
                                  <th className="n">รายการ</th><th className="n">หักอื่น</th>
                                  <th className="n">รวมบรรทัด</th><th>หมายเหตุ</th>
                                </tr>
                              </thead>
                              <tbody>
                                {L.rows.map((r, i) => (
                                  <tr key={i}>
                                    <td>{r.dateTh || toThaiDate(r.date)}</td>
                                    <td>{r.timeIn}</td><td>{r.timeOut}</td>
                                    <td className="n">{r.hrs}</td><td className="n">{r.mins}</td>
                                    <td className="n"><Money v={r.shiftPay} /></td>
                                    <td className="n"><Money v={r.handFee} /></td>
                                    <td className="n">{r.handRows || '—'}</td>
                                    <td className="n"><Money v={r.deduct} dash /></td>
                                    <td className="n"><Money v={r.net} /></td>
                                    <td className="muted">
                                      {r.error && <span className="pill block">{r.error}</span>}
                                      {[r.kind !== 'SHIFT' ? r.kind : '', r.graceNote, r.note]
                                        .filter(Boolean).join(' · ')}
                                    </td>
                                  </tr>
                                ))}
                                {L.orphan.map((o, i) => (
                                  <tr key={'o' + i} style={{ background: 'var(--warn-bg)' }}>
                                    <td>{o.dateTh}</td><td colSpan={5} />
                                    <td className="n"><Money v={o.amount} /></td>
                                    <td className="n">{o.rows}</td>
                                    <td colSpan={2} />
                                    <td><b>⚠️ มีค่ามือแต่ยังไม่มีใบเวร</b></td>
                                  </tr>
                                ))}
                                <tr className="total">
                                  <td colSpan={3}>รวม</td>
                                  <td className="n">{L.sumHrs}</td><td className="n">{L.sumMins}</td>
                                  <td className="n"><Money v={L.shiftTotal} /></td>
                                  <td className="n"><Money v={L.handTotal} /></td>
                                  <td colSpan={2} />
                                  <td className="n"><Money v={L.gross} /></td>
                                  <td />
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  <tr className="total">
                    <td colSpan={4}>รวมหมอทั้งหมด {T.doctors} คน</td>
                    <td className="n">{T.hrs}</td><td className="n">{T.mins}</td>
                    <td className="n"><Money v={T.shiftTotal} /></td>
                    <td className="n"><Money v={T.handTotal} /></td>
                    <td className="n"><Money v={T.gross} /></td>
                    <td className="n"><Money v={T.tax} /></td>
                    <td className="n"><Money v={T.deduct} /></td>
                    <td className="n"><Money v={T.net} /></td>
                    <td colSpan={2}>{T.signedDocs}/{T.doctors} เซ็นแล้ว</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="muted" style={{ marginBottom: 0 }}>
              วิธีคิดค่าเวรบนใบปะหน้า:{' '}
              <b>{res.coverMode === 'HOURS' ? 'ชม.รวม × อัตรา (สูตรต้นฉบับ)' : 'ผูกกับผลรวมในชีตแพทย์'}</b>
              {' '}· เปลี่ยนได้ที่แท็บตั้งค่า · ไฟล์ที่ส่งออกเป็นสูตร Excel จริงทุกคอลัมน์
            </p>
          </Card>
        </>
      )}
    </>
  );
}
