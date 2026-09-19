/* ============================================================================
 * Sign.tsx — หน้าเซ็นรับรองรายได้ของแพทย์ เปิดจากลิงก์ในอีเมล ไม่ต้องล็อกอิน
 *
 * สิ่งที่หน้านี้เห็นได้มีแค่ยอดของแพทย์เจ้าของลิงก์คนเดียว
 * เพราะฝั่งฐานข้อมูลตรวจ token แล้วคืนเฉพาะบรรทัดของคนนั้น
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type SignView } from '../lib/api';
import { toThaiDate, ymThai } from '../lib/core';
import { Alerts, Money, Note, SignaturePad, Skeleton, useAsync } from '../components/ui';

export default function Sign() {
  const { token = '' } = useParams();
  const [view, setView] = useState<SignView | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { busy, err, setErr, run } = useAsync();

  useEffect(() => {
    api.signOpen(token)
      .then((v) => { setView(v); setDone(v.signedAt); })
      .catch((e) => setErr(e.message));
  }, [token, setErr]);

  const submit = () => run(async () => {
    if (!png) { setErr('กรุณาเซ็นในกรอบก่อนครับ'); return; }
    const r = await api.signSubmit(token, png);
    setDone(r.signedAt);
  });

  return (
    <div className="login-wrap">
      <div className="login" style={{ maxWidth: 460 }}>
        <div className="card">
          <img className="mark-lg" src="/logo.png" alt="Mersi Clinic" />
          <h1 style={{ textAlign: 'center', marginBottom: 2 }}>Mersi Clinic</h1>
          <p className="muted" style={{ textAlign: 'center', marginTop: 0, marginBottom: 18 }}>
            เซ็นรับรองรายได้ประจำเดือน
          </p>

          <Alerts err={err} msg={null} />

          {!view && !err && <Skeleton rows={5} />}

          {view && (
            <>
              <div className="stat" style={{ marginBottom: 12 }}>
                <div className="k">{view.licNo} · สาขา{view.branchTh}</div>
                <div style={{ fontWeight: 600 }}>{view.name}</div>
                <div className="s">รอบเดือน {ymThai(view.ym)}</div>
              </div>

              <table style={{ width: '100%', marginBottom: 14 }}>
                <tbody>
                  <tr>
                    <td className="muted">รวมเงินได้</td>
                    <td className="n"><Money v={view.gross} /></td>
                  </tr>
                  <tr>
                    <td className="muted">หักภาษี ณ ที่จ่าย</td>
                    <td className="n">−<Money v={view.tax} /></td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td>จ่ายสุทธิ</td>
                    <td className="n"><Money v={view.net} /></td>
                  </tr>
                  {view.bankAcc && (
                    <tr>
                      <td className="muted">โอนเข้าบัญชี</td>
                      <td className="n muted">{view.bank} {view.bankAcc}</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {done ? (
                <Note tone="ok">
                  เซ็นรับรองเรียบร้อยแล้ว เมื่อ {toThaiDate(done.substring(0, 10))}
                  {' '}เวลา {done.substring(11, 16)} น. · ขอบคุณครับ
                  <br />
                  <span className="muted">
                    หากต้องการแก้ไข เซ็นใหม่ในกรอบด้านล่างแล้วกดยืนยันอีกครั้งได้เลย
                  </span>
                </Note>
              ) : (
                <p className="muted" style={{ marginTop: 0 }}>
                  กรุณาตรวจสอบยอดด้านบน หากถูกต้องแล้วเซ็นชื่อในกรอบแล้วกดยืนยันครับ
                </p>
              )}

              <SignaturePad onChange={setPng} />

              <button className="primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                disabled={busy || !png} onClick={submit}
              >
                {busy ? 'กำลังบันทึก…' : done ? 'เซ็นใหม่แทนของเดิม' : 'ยืนยันการรับรองรายได้'}
              </button>

              <p className="muted" style={{ fontSize: '.78rem', marginBottom: 0 }}>
                ลายเซ็นจะถูกผูกกับยอดที่แสดงด้านบน ณ เวลาที่เซ็น
                หากยอดมีการแก้ไขภายหลัง ระบบจะแจ้งว่าต้องเซ็นใหม่
              </p>
            </>
          )}
        </div>
        <p className="muted" style={{ textAlign: 'center' }}>
          หากมีข้อสงสัยกรุณาติดต่อฝ่ายบุคคล Mersi Clinic
        </p>
      </div>
    </div>
  );
}
