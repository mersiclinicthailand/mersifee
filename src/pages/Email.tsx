import { useEffect, useState } from 'react';
import type { Scope } from '../App';
import { api, type MailTargets } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Alerts, BranchMonthPicker, Card, Money, Note, Skeleton, StatusPill, useAsync, YmLabel,
} from '../components/ui';

const thTime = (s: string | null) =>
  (s ? s.replace('T', ' ').substring(0, 16) : '—');

export default function EmailPage({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [data, setData] = useState<MailTargets | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<{ licNo: string; ok: boolean; error?: string }[] | null>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const load = () => {
    setData(null); setPicked(new Set()); setSent(null);
    api.emailTargets(scope.branch, scope.ym).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(load, [scope.branch, scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const approved = ['APPROVED', 'PAID'].includes(data?.status || '');
  const mailable = rows.filter((r) => r.email);

  const toggle = (lic: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(lic)) n.delete(lic); else n.add(lic);
    return n;
  });

  const send = (action: 'sign_invite' | 'tax_detail') => run(async () => {
    const licNos = [...picked];
    if (!licNos.length) { setErr('ยังไม่ได้เลือกแพทย์'); return; }
    const r = await api.sendMail(action, scope.branch, scope.ym, licNos);
    setSent(r.results);
    setMsg(`ส่งสำเร็จ ${r.sent} จาก ${r.total} ฉบับ`);
    load();
  });

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ส่งอีเมลหาแพทย์</h1>
        {data && <StatusPill s={data.status} />}
        <div className="spacer" />
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} msg={msg} />

      {!data ? <div className="card"><Skeleton rows={5} /></div> : (
        <>
          {!approved && (
            <Note tone="warn">
              ส่งเมลได้เฉพาะรอบที่ <b>อนุมัติแล้ว</b> เท่านั้น — รอบนี้ยังอยู่สถานะ “{data.status}”
              ยอดที่ส่งไปหาแพทย์จะดึงจาก snapshot ที่ล็อกไว้ตอนอนุมัติ จึงตรงกับเอกสารเสมอ
            </Note>
          )}

          <Card
            title={<>แพทย์ในรอบ · <YmLabel ym={scope.ym} /></>}
            right={
              <div className="row" style={{ gap: 6 }}>
                <button className="sm" disabled={busy}
                  onClick={() => setPicked(new Set(mailable.map((r) => r.licNo)))}
                >
                  เลือกทุกคนที่มีอีเมล
                </button>
                <button className="sm" disabled={busy} onClick={() => setPicked(new Set())}>
                  ล้างที่เลือก
                </button>
              </div>
            }
          >
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}></th>
                    <th>แพทย์</th><th>อีเมล</th>
                    <th className="n">รวมเงินได้</th><th className="n">ภาษี</th><th className="n">จ่ายสุทธิ</th>
                    <th>เซ็นรับรอง</th><th>เมลเชิญเซ็นล่าสุด</th><th>เมลภาษีล่าสุด</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const res = sent?.find((x) => x.licNo === r.licNo);
                    return (
                      <tr key={r.licNo}>
                        <td>
                          <input type="checkbox" disabled={!r.email || busy}
                            checked={picked.has(r.licNo)}
                            onChange={() => toggle(r.licNo)}
                          />
                        </td>
                        <td>{r.licNo} · {r.nick || r.name}</td>
                        <td>
                          {r.email
                            ? <span className="muted">{r.email}</span>
                            : <span className="pill bad">ไม่มีอีเมลในทะเบียน</span>}
                          {res && !res.ok && (
                            <><br /><span className="pill bad">ส่งไม่สำเร็จ: {res.error}</span></>
                          )}
                          {res && res.ok && <><br /><span className="pill ok">ส่งแล้ว</span></>}
                        </td>
                        <td className="n"><Money v={r.gross} /></td>
                        <td className="n"><Money v={r.tax} /></td>
                        <td className="n"><Money v={r.net} /></td>
                        <td>
                          {r.signed
                            ? <span className="pill ok">เซ็นแล้ว</span>
                            : <span className="pill none">ยังไม่เซ็น</span>}
                        </td>
                        <td className="muted">{thTime(r.lastMail)}</td>
                        <td className="muted">{thTime(r.lastTaxMail)}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="muted">
                        ยังไม่มียอดที่อนุมัติในรอบนี้ — ต้องอนุมัติที่แท็บ “อนุมัติ” ก่อน
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" disabled={busy || !approved || !picked.size}
                onClick={() => send('sign_invite')}
              >
                ส่งเมลเชิญเซ็นรับรองรายได้ ({picked.size})
              </button>
              <button disabled={busy || !approved || !picked.size}
                onClick={() => send('tax_detail')}
              >
                ส่งเมลรายละเอียดหักภาษี ({picked.size})
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              เมลเชิญเซ็นจะแนบลิงก์เฉพาะตัวของแพทย์แต่ละคน อายุ 14 วัน กดเซ็นได้เลยไม่ต้องล็อกอิน ·
              เมลรายละเอียดภาษีส่งเมื่อไรก็ได้หลังอนุมัติ · ทุกฉบับถูกบันทึกไว้ตรวจย้อนกลับได้
            </p>
          </Card>
        </>
      )}
    </>
  );
}
