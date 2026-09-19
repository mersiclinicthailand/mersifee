import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Scope } from '../App';
import { api, type Dash } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  BranchMonthPicker, Card, Money, Skeleton, Stat, StatusPill, STATUS_TH, Alerts, useAsync, YmLabel,
} from '../components/ui';

export default function Dashboard({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [dash, setDash] = useState<Dash | null>(null);
  const { err, setErr } = useAsync();

  useEffect(() => {
    let live = true;
    setDash(null);
    api.dashboard(scope.ym)
      .then((d) => { if (live) setDash(d); })
      .catch((e) => setErr(e.message));
    return () => { live = false; };
  }, [scope.ym, setErr]);

  const counts: Record<string, number> = {};
  dash?.rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const notSent = counts.NONE || 0;

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ภาพรวมทุกสาขา · <YmLabel ym={scope.ym} /></h1>
        <div className="spacer" />
        <BranchMonthPicker
          hideBranch branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} />

      {!dash ? <div className="card"><Skeleton rows={5} /></div> : (
        <>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat k="สาขาที่เห็นได้" v={dash.totalBranches} s={`ส่งข้อมูลแล้ว ${dash.totalBranches - notSent} สาขา`} />
            <Stat k="ค่ามือรวมทุกสาขา" v={<Money v={dash.totalProcSum} />} s="บาท" />
            <Stat k="แพทย์ทั้งหมด" v={dash.totalDoctors} s="คน (นับซ้ำข้ามสาขา)" />
            <Stat
              k="ยังไม่ส่งข้อมูล" v={notSent} tone={notSent ? 'bad' : 'ok'}
              s={notSent ? 'ต้องตามให้ส่ง' : 'ครบทุกสาขาแล้ว'}
            />
          </div>

          <Card title="สถานะรายสาขา" right={
            <span className="muted">
              {Object.keys(STATUS_TH).filter((k) => counts[k]).map((k) => (
                <span key={k} style={{ marginLeft: 8 }}>
                  <StatusPill s={k} /> {counts[k]}
                </span>
              ))}
            </span>
          }
          >
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>สาขา</th><th>สถานะ</th>
                    <th className="n">รายการหัตถการ</th><th className="n">ค่ามือ (บาท)</th>
                    <th className="n">แพทย์</th><th className="n">ใบเวร</th>
                    <th className="n">เซ็นแล้ว</th><th className="n">ยังจับคู่ไม่ได้</th>
                    <th>เลขอ้างอิงจ่าย</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {dash.rows.map((r) => (
                    <tr key={r.code}>
                      <td><b>{r.code}</b> · {r.nameTh}</td>
                      <td><StatusPill s={r.status} /></td>
                      <td className="n">{r.status === 'NONE' ? '—' : r.procRows.toLocaleString()}</td>
                      <td className="n">{r.status === 'NONE' ? '—' : <Money v={r.procSum} />}</td>
                      <td className="n">{r.status === 'NONE' ? '—' : r.doctors}</td>
                      <td className="n">{r.status === 'NONE' ? '—' : r.shiftRows}</td>
                      <td className="n">
                        {r.status === 'NONE' ? '—'
                          : <span className={r.signedDocs >= r.doctors && r.doctors > 0 ? 'pill ok' : 'pill none'}>
                            {r.signedDocs}/{r.doctors}
                          </span>}
                      </td>
                      <td className="n">
                        {r.unmatched
                          ? <span className="pill block">{r.unmatched}</span>
                          : (r.status === 'NONE' ? '—' : '0')}
                      </td>
                      <td>{r.paidRef || '—'}</td>
                      <td>
                        <Link
                          className="btn sm" to="/calc"
                          onClick={() => scope.setBranch(r.code)}
                        >
                          เปิด
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
              “ยังไม่ส่งข้อมูล” ไม่ใช่ “ยอดเป็นศูนย์” — สาขาที่ยอดเป็นศูนย์จริงต้องยืนยันก่อนส่งตรวจ
            </p>
          </Card>
        </>
      )}
    </>
  );
}
