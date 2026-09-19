import { useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace } from '../lib/api';
import { useAuth } from '../lib/auth';
import { calcCore, type CalcResult } from '../lib/calc';
import {
  Alerts, BranchMonthPicker, Card, Money, Note, Skeleton, Stat, StatusPill, useAsync,
} from '../components/ui';

export default function Reconcile({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const { err, setErr } = useAsync();

  useEffect(() => {
    setWs(null);
    api.workspace(scope.branch, scope.ym).then(setWs).catch((e) => setErr(e.message));
  }, [scope.branch, scope.ym, setErr]);

  const res: CalcResult | null = useMemo(
    () => (ws && boot ? calcCore(api.toCalcCtx(ws, boot.config)) : null),
    [ws, boot],
  );

  /** ห่วงโซ่กระทบยอด 8 ขั้น — ต้นทาง → จับคู่ได้ → เข้าใบเวร → … → จ่ายสุทธิ */
  const chain = useMemo(() => {
    if (!res || !ws) return [];
    const unmatchedSum = res.unmatched.reduce((a, u) => a + u.sum, 0);
    const matched = res.procTotalAll - unmatchedSum;
    const orphanSum = res.lines.reduce((a, L) => a + L.orphan.reduce((b, o) => b + o.amount, 0), 0);
    const T = res.totals;
    return [
      { step: '1. รายงานค่าหัตถการ (แถวแพทย์)', amount: res.procTotalAll, detail: `${res.procRowsAll.toLocaleString()} แถว` },
      { step: '2. จับคู่แพทย์ในทะเบียนได้', amount: matched, detail: unmatchedSum ? `จับคู่ไม่ได้ ${res.unmatched.length} ชื่อ` : 'ครบทุกรายการ' },
      { step: '3. เข้าใบเวร (ค่ามือรวม)', amount: T.handTotal, detail: orphanSum ? `ตกค้างไม่มีใบเวร ${orphanSum.toLocaleString()}` : 'ครบทุกวัน' },
      { step: '4. ใบปะหน้า — ค่าเวร', amount: T.shiftTotal, detail: `${T.hrs} ชม. ${T.mins} นาที` },
      { step: '5. ใบปะหน้า — รวมเงินได้', amount: T.gross, detail: '' },
      { step: '6. หักภาษี', amount: -T.tax, detail: '' },
      { step: '7. หักอื่น ๆ', amount: -T.deduct, detail: '' },
      { step: '8. จ่ายสุทธิ', amount: T.net, detail: `แพทย์ ${T.doctors} คน` },
    ];
  }, [res, ws]);

  const balanced = res ? res.blockers === 0 : false;
  const byCode: Record<string, number> = {};
  res?.issues.forEach((i) => { byCode[i.code] = (byCode[i.code] || 0) + 1; });

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>กระทบยอด</h1>
        {ws && <StatusPill s={ws.period?.status || 'NONE'} />}
        <div className="spacer" />
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} />

      {!res ? <div className="card"><Skeleton rows={6} /></div> : (
        <>
          {balanced ? (
            <Note tone="ok">
              ✅ กระทบยอดลงตัว ไม่มีปัญหาระดับบล็อก — รอบนี้ส่งตรวจได้
              {res.issues.length > 0 && ` (มีข้อสังเกต ${res.issues.length} รายการให้ตรวจ)`}
            </Note>
          ) : (
            <Note tone="bad">
              ❌ มีปัญหาระดับบล็อก {res.blockers} รายการ — ต้องแก้ก่อนจึงจะส่งตรวจได้
            </Note>
          )}

          <div className="grid g3" style={{ marginBottom: 14 }}>
            <Stat k="ยอดต้นทางทั้งหมด" v={<Money v={res.procTotalAll} />} s={`${res.procRowsAll.toLocaleString()} แถว`} />
            <Stat
              k="ชื่อที่จับคู่ไม่ได้" v={res.unmatched.length}
              tone={res.unmatched.length ? 'bad' : 'ok'}
              s={res.unmatched.length ? `รวม ${res.unmatched.reduce((a, u) => a + u.sum, 0).toLocaleString()} บาท` : 'ครบทุกชื่อ'}
            />
            <Stat
              k="แถวซ้ำในไฟล์" v={res.dupGroups} tone={res.dupGroups ? 'warn' : undefined}
              s={res.dupGroups ? 'ต้องตรวจเอกสารยืนยัน' : 'ไม่พบ'}
            />
          </div>

          <Card title="ห่วงโซ่กระทบยอด 8 ขั้น">
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>ขั้น</th><th className="n">จำนวนเงิน (บาท)</th><th>รายละเอียด</th></tr>
                </thead>
                <tbody>
                  {chain.map((c, i) => (
                    <tr key={i} className={i === chain.length - 1 ? 'total' : undefined}>
                      <td>{c.step}</td>
                      <td className="n" style={c.amount < 0 ? { color: 'var(--bad)' } : undefined}>
                        <Money v={c.amount} />
                      </td>
                      <td className="muted">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title={`ปัญหาและข้อสังเกต (${res.issues.length} รายการ)`}>
            {res.issues.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>ไม่พบปัญหาในรอบนี้</p>
            ) : (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  {Object.entries(byCode).map(([code, n]) => (
                    <span key={code} className="pill none">{code} · {n}</span>
                  ))}
                </div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr><th>ระดับ</th><th>รหัส</th><th>แพทย์</th><th>รายละเอียด</th></tr>
                    </thead>
                    <tbody>
                      {res.issues.map((is) => (
                        <tr key={is.id}>
                          <td>
                            <span className={`pill ${is.severity === 'block' ? 'block' : 'warn'}`}>
                              {is.severity === 'block' ? 'บล็อก' : 'สังเกต'}
                            </span>
                          </td>
                          <td className="muted">{is.code}</td>
                          <td>
                            {is.licNo
                              ? (res.lines.find((L) => L.licNo === is.licNo)?.nickName || is.licNo)
                              : '—'}
                          </td>
                          <td>{is.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>

          <Card title="กระทบยอดรายวันรายแพทย์">
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>แพทย์</th><th>วันที่</th><th className="n">ชม.</th><th className="n">นาที</th>
                    <th className="n">ค่าเวร</th><th className="n">ค่ามือจากต้นทาง</th>
                    <th className="n">ค่ามือที่ใช้จริง</th><th className="n">ส่วนต่าง</th><th>หมายเหตุ</th>
                  </tr>
                </thead>
                <tbody>
                  {res.lines.flatMap((L) => L.rows.filter((r) => !r.error).map((r, i) => {
                    const diff = (r.handFee || 0) - (r.handAuto || 0);
                    return (
                      <tr key={L.licNo + i} style={diff ? { background: 'var(--warn-bg)' } : undefined}>
                        <td>{L.nickName || L.licNo}</td>
                        <td>{r.dateTh}</td>
                        <td className="n">{r.hrs}</td><td className="n">{r.mins}</td>
                        <td className="n"><Money v={r.shiftPay} /></td>
                        <td className="n"><Money v={r.handAuto} /></td>
                        <td className="n"><Money v={r.handFee} /></td>
                        <td className="n">{diff ? <Money v={diff} /> : '—'}</td>
                        <td className="muted">{[r.graceNote, r.note].filter(Boolean).join(' · ')}</td>
                      </tr>
                    );
                  }))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
