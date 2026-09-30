/* ============================================================================
 * IncomeDetail.tsx — รายละเอียดรายได้ให้แพทย์ตรวจก่อนเซ็น (หน้าเซ็นจากลิงก์ในอีเมล)
 * ข้อมูลมาจาก snapshot ที่ล็อกไว้ตอนอนุมัติ — ตรงกับตัวเลขในอีเมลทุกบาท
 * ==========================================================================*/
import { Fragment, useMemo, useState } from 'react';
import { detailCsv, maskAcc, type Detail } from '../lib/mailtpl';
import { Money } from './ui';

const TH_DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const dTh = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${TH_DOW[new Date(y, m - 1, d).getDay()]} ${d} ${TH_MON[m - 1]}`;
};
const hm = (h: number, m: number) => `${h} ชม.${m ? ` ${m} น.` : ''}`;
const KIND: Record<string, string> = { NIGHT: 'เวรดึก', MEETING: 'ประชุม', KOL: 'KOL', TRAIN: 'อบรม', COVER: 'เวรแทน' };
const BASE: Record<string, string> = { TOTAL: 'รวมเงินได้ทั้งหมด', SHIFT: 'เฉพาะค่าเวร', NONE: 'ไม่หักภาษี' };

export default function IncomeDetail(
  { d, meta }: { d: Detail; meta: { name: string; licNo: string; branchTh: string; ym: string } },
) {
  const [tab, setTab] = useState<'sum' | 'day' | 'proc'>('sum');
  const [q, setQ] = useState('');
  const [openDay, setOpenDay] = useState<string | null>(null);

  const procsOf = useMemo(() => {
    const m = new Map<string, Detail['procs']>();
    d.procs.forEach((p) => { m.set(p.d, [...(m.get(p.d) || []), p]); });
    return m;
  }, [d]);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? d.procs.filter((p) => `${p.c} ${p.doc} ${p.d}`.toLowerCase().includes(k)) : d.procs;
  }, [d, q]);

  const download = () => {
    const blob = new Blob([detailCsv(d, meta)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `รายละเอียดค่าตอบแทน_ว.${meta.licNo}_${meta.ym}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const row = (k: React.ReactNode, v: React.ReactNode, strong = false, tone?: string) => (
    <tr style={strong ? { fontWeight: 700 } : undefined}>
      <td className="muted" style={{ padding: '6px 0' }}>{k}</td>
      <td className="n" style={{ padding: '6px 0', color: tone ? `var(--${tone})` : undefined }}>{v}</td>
    </tr>
  );

  return (
    <div style={{ margin: '4px 0 14px' }}>
      <div className="seg" style={{ display: 'flex', marginBottom: 10 }}>
        <button className={tab === 'sum' ? 'on' : ''} onClick={() => setTab('sum')} style={{ flex: 1 }}>ที่มาของยอด</button>
        <button className={tab === 'day' ? 'on' : ''} onClick={() => setTab('day')} style={{ flex: 1 }}>รายวัน ({d.days.length})</button>
        <button className={tab === 'proc' ? 'on' : ''} onClick={() => setTab('proc')} style={{ flex: 1 }}>ค่ามือ ({d.procs.length})</button>
      </div>

      {tab === 'sum' && (
        <table style={{ width: '100%' }}>
          <tbody>
            {row(<>ค่าเวร · {hm(d.sumHrs, d.sumMins)} × <Money v={d.rate} /></>, <Money v={d.coverShift} />)}
            {row(<>ค่ามือ · {d.procCount} รายการ</>, <Money v={d.handTotal} />)}
            {d.adjList.map((a, i) => (
              <tr key={i}>
                <td className="muted" style={{ padding: '6px 0' }}>{a.amount >= 0 ? 'ปรับเพิ่ม' : 'ปรับลด'} · {a.reason || a.kind}</td>
                <td className="n" style={{ padding: '6px 0' }}>{a.amount < 0 && '−'}<Money v={Math.abs(a.amount)} /></td>
              </tr>
            ))}
            {row('รวมเงินได้', <Money v={d.gross} />, true)}
            {row(<>ฐานคิดภาษี · {BASE[d.taxBase] || d.taxBase}</>, <Money v={d.taxBaseAmt} />)}
            {row(<>หักภาษี ณ ที่จ่าย {d.taxRate}%</>, <>−<Money v={d.tax} /></>, false, 'bad')}
            {d.deduct > 0 && row('หักอื่น ๆ', <>−<Money v={d.deduct} /></>, false, 'bad')}
            {row('จ่ายสุทธิ', <Money v={d.net} />, true, 'ok')}
            {d.bankAcc && row('โอนเข้า', `${d.bank || ''} ${maskAcc(d.bankAcc)}`)}
          </tbody>
        </table>
      )}

      {tab === 'day' && (
        <div className="tablewrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr><th>วันที่</th><th>เวลา</th><th className="n">ชม.</th><th className="n">ค่าเวร</th><th className="n">ค่ามือ</th></tr>
            </thead>
            <tbody>
              {d.days.map((r) => {
                const notes = [KIND[r.kind] || '', r.grace, r.special !== null && r.special !== undefined ? `ยอดพิเศษ ${r.special}` : '',
                  r.deduct ? `หัก ${r.deduct}` : '', r.note].filter(Boolean).join(' · ');
                const list = procsOf.get(r.d) || [];
                return (
                  <Fragment key={r.d}>
                    <tr onClick={() => setOpenDay(openDay === r.d ? null : r.d)}
                      style={{ cursor: list.length ? 'pointer' : undefined }}>
                      <td style={{ whiteSpace: 'nowrap' }}><b>{dTh(r.d)}</b></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.in && r.out ? `${r.in}–${r.out}` : '—'}
                        {r.brk ? <div className="muted" style={{ fontSize: '.75rem' }}>พัก {r.brk} น.</div> : null}</td>
                      <td className="n" style={{ whiteSpace: 'nowrap' }}>{hm(r.hrs, r.mins)}</td>
                      <td className="n"><Money v={r.shift} /></td>
                      <td className="n"><Money v={r.hand} />
                        {list.length > 0 && <div className="muted" style={{ fontSize: '.75rem' }}>{list.length} รายการ {openDay === r.d ? '▴' : '▾'}</div>}</td>
                    </tr>
                    {notes && <tr key={r.d + 'n'}><td colSpan={5} className="muted" style={{ fontSize: '.8rem', paddingTop: 0 }}>↳ {notes}</td></tr>}
                    {openDay === r.d && list.map((p, i) => (
                      <tr key={r.d + i} style={{ background: 'var(--bg)' }}>
                        <td colSpan={3} style={{ fontSize: '.8rem', paddingLeft: 18 }}>{p.c}<span className="muted"> · {p.doc}</span></td>
                        <td className="n muted" style={{ fontSize: '.8rem' }}>×{p.q}</td>
                        <td className="n" style={{ fontSize: '.8rem' }}><Money v={p.f} /></td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              <tr style={{ fontWeight: 700 }}>
                <td>รวม</td><td></td><td className="n">{hm(d.sumHrs, d.sumMins)}</td>
                <td className="n"><Money v={d.shiftTotal} /></td><td className="n"><Money v={d.handTotal} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {tab === 'proc' && (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาคอร์ส / เลขที่เอกสาร / วันที่"
            style={{ width: '100%', marginBottom: 8 }} />
          <div className="tablewrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>วันที่</th><th>เลขที่เอกสาร</th><th>คอร์ส</th><th className="n">จำนวน</th><th className="n">ค่ามือ</th></tr></thead>
              <tbody>
                {shown.map((p, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dTh(p.d)}</td><td className="muted">{p.doc}</td>
                    <td>{p.c}</td><td className="n">{p.q}</td><td className="n"><Money v={p.f} /></td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={4}>รวม {shown.length} รายการ{q && ' (ที่ค้นเจอ)'}</td>
                  <td className="n"><Money v={shown.reduce((a, p) => a + p.f, 0)} /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <button className="sm" style={{ marginTop: 10 }} onClick={download}>⬇ ดาวน์โหลดรายละเอียดทั้งหมด (Excel)</button>
    </div>
  );
}
