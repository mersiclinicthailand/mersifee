import { useEffect, useState } from 'react';
import { api, type PoolRow, type PoolSearch } from '../lib/api';
import { useAuth, can } from '../lib/auth';
import { Alerts, Card, Money, Note, Skeleton, useAsync } from '../components/ui';

interface Doctor {
  lic_no: string; full_name: string; nick_name: string; bank: string; bank_acc: string;
  id_card: string; address: string; contact: string; email: string;
  payee_type: string; payee_name: string;
  status: string; note: string;
}
interface Rate {
  id?: string; lic_no: string; branch: string; hourly_rate: number;
  tax_base: string; tax_rate: number; hand_method: string;
  eff_from: string | null; eff_to: string | null; note: string;
}

const BLANK_DOC: Doctor = {
  lic_no: '', full_name: '', nick_name: '', bank: '', bank_acc: '', id_card: '',
  address: '', contact: '', email: '',
  payee_type: 'PERSON', payee_name: '', status: 'ACTIVE', note: '',
};
const BLANK_RATE: Rate = {
  lic_no: '', branch: '', hourly_rate: 0, tax_base: 'TOTAL', tax_rate: 3,
  hand_method: 'SOURCE', eff_from: null, eff_to: null, note: '',
};

const TAX_BASE_TH: Record<string, string> = {
  TOTAL: 'รวมเงินได้', SHIFT: 'เฉพาะค่าเวร', NONE: 'ไม่หักภาษี',
};

export default function Registry() {
  const { boot } = useAuth();
  const [tab, setTab] = useState<'doc' | 'rate'>('doc');
  const [docs, setDocs] = useState<Doctor[] | null>(null);
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [editDoc, setEditDoc] = useState<Doctor | null>(null);
  const [editRate, setEditRate] = useState<Rate | null>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  /* คลังรายชื่อแพทย์ — 674 รายชื่อที่ย้ายมาจากระบบเดิมแต่ยังไม่เคยขึ้นทะเบียน */
  const [poolOpen, setPoolOpen] = useState(false);
  const [poolQ, setPoolQ] = useState('');
  const [pool, setPool] = useState<PoolSearch | null>(null);
  const [poolPick, setPoolPick] = useState<Set<string>>(new Set());

  const role = boot?.me.role;
  const mayDoc = can.registry(role);
  const mayRate = can.rates(role);

  const load = () => {
    api.listDoctors().then((d) => setDocs(d as Doctor[])).catch((e) => setErr(e.message));
    api.listRates().then((r) => setRates(r as Rate[])).catch((e) => setErr(e.message));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ค้นคลังแบบหน่วงคำพิมพ์ — กันยิงทุกตัวอักษร */
  useEffect(() => {
    if (!poolOpen) return;
    setPool(null);
    const t = setTimeout(() => {
      api.poolSearch(poolQ, 100).then(setPool).catch((e) => setErr(e.message));
    }, poolQ ? 300 : 0);
    return () => clearTimeout(t);
  }, [poolOpen, poolQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePick = (lic: string) => setPoolPick((s) => {
    const n = new Set(s);
    if (n.has(lic)) n.delete(lic); else n.add(lic);
    return n;
  });

  const promote = () => run(async () => {
    const licNos = [...poolPick];
    if (!licNos.length) throw new Error('ยังไม่ได้เลือกแพทย์');
    const r = await api.poolPromote(licNos);
    setPoolPick(new Set());
    load();
    setPool(null);
    api.poolSearch(poolQ, 100).then(setPool).catch(() => { /* โหลดใหม่ไม่ได้ก็ไม่เป็นไร */ });
    setMsg(
      `ขึ้นทะเบียนแล้ว ${r.added} คน`
      + (r.skipped ? ` · ข้ามที่มีในทะเบียนอยู่แล้ว ${r.skipped} คน` : '')
      + ' — อย่าลืมตั้งอัตราค่าตอบแทนที่แท็บ “อัตราและสัญญา”',
    );
  });

  const saveDoc = () => editDoc && run(async () => {
    if (!editDoc.lic_no.trim() || !editDoc.full_name.trim()) {
      throw new Error('ต้องระบุรหัส ว. และชื่อ-สกุล');
    }
    await api.saveDoctor({ ...editDoc, lic_no: editDoc.lic_no.trim() });
    setEditDoc(null); load();
    setMsg('บันทึกทะเบียนแพทย์แล้ว');
  });

  const saveRate = () => editRate && run(async () => {
    if (!editRate.hourly_rate) throw new Error('ต้องระบุอัตราต่อชั่วโมง');
    if (!editRate.eff_from) throw new Error('ต้องระบุวันที่เริ่มมีผล — อัตราที่ไม่มีวันมีผลทำให้ตรวจย้อนกลับไม่ได้');
    await api.saveRate({
      ...editRate,
      lic_no: editRate.lic_no.trim() || '*',
      approved_by: boot?.me.username || '',
    });
    setEditRate(null); load();
    setMsg('บันทึกอัตราแล้ว — อัตราที่เปลี่ยนไม่กระทบรอบที่อนุมัติไปแล้ว');
  });

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ทะเบียน</h1>
        <div className="spacer" />
        <button className={tab === 'doc' ? 'primary' : ''} onClick={() => setTab('doc')}>แพทย์</button>
        <button className={tab === 'rate' ? 'primary' : ''} onClick={() => setTab('rate')}>อัตราและสัญญา</button>
      </div>

      <Alerts err={err} msg={msg} />

      {tab === 'doc' && (
        <Card
          title={`ทะเบียนแพทย์ (${docs?.length ?? '—'} คน)`}
          right={mayDoc && (
            <div className="row" style={{ gap: 6 }}>
              <button className={poolOpen ? 'primary' : ''}
                onClick={() => { setPoolOpen(!poolOpen); setPoolPick(new Set()); }}
              >
                {poolOpen ? 'ปิดคลังรายชื่อ' : 'ดึงจากคลังรายชื่อ'}
              </button>
              <button className="primary" onClick={() => setEditDoc({ ...BLANK_DOC })}>+ เพิ่มแพทย์</button>
            </div>
          )}
        >
          {!mayDoc && <Note tone="info">บทบาทของคุณดูได้อย่างเดียว — แก้ไขได้เฉพาะฝ่ายบุคคลและผู้ดูแลระบบ</Note>}
          {!docs ? <Skeleton rows={5} /> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>รหัส ว.</th><th>ชื่อ-สกุล</th><th>ชื่อเล่น</th><th>ธนาคาร</th>
                    <th>เลขบัญชี</th><th>ผู้รับเงิน</th><th>ติดต่อ</th><th>อีเมล</th>
                    <th>สถานะ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.lic_no}>
                      <td>{d.lic_no}</td>
                      <td>{d.full_name}</td>
                      <td>{d.nick_name}</td>
                      <td>{d.bank}</td>
                      <td className="tnum">{d.bank_acc}</td>
                      <td>
                        {d.payee_type === 'COMPANY'
                          ? <span className="pill warn">นิติบุคคล · {d.payee_name}</span>
                          : 'บุคคลธรรมดา'}
                      </td>
                      <td className="muted">{d.contact}</td>
                      <td>
                        {d.email
                          ? <span className="muted">{d.email}</span>
                          : <span className="pill warn">ยังไม่มีอีเมล</span>}
                      </td>
                      <td>
                        <span className={`pill ${d.status === 'ACTIVE' ? 'ok' : 'none'}`}>
                          {d.status === 'ACTIVE' ? 'ปฏิบัติงาน' : 'พ้นสภาพ'}
                        </span>
                      </td>
                      <td>
                        {mayDoc && <button className="sm" onClick={() => setEditDoc({ ...d })}>แก้ไข</button>}
                      </td>
                    </tr>
                  ))}
                  {docs.length === 0 && (
                    <tr><td colSpan={10} className="muted">ยังไม่มีแพทย์ในทะเบียน</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---------- คลังรายชื่อแพทย์ ---------- */}
      {tab === 'doc' && poolOpen && mayDoc && (
        <Card
          title={`คลังรายชื่อแพทย์ — ยังไม่ได้ขึ้นทะเบียน ${pool?.pool ?? '—'} คน`}
          right={
            <button className="primary" disabled={busy || !poolPick.size} onClick={promote}>
              ขึ้นทะเบียนที่เลือก ({poolPick.size})
            </button>
          }
        >
          <Note tone="info">
            รายชื่อชุดนี้ย้ายมาพร้อมระบบเดิมแต่ไม่เคยถูกขึ้นทะเบียน จึงไม่ปรากฏในทะเบียนแพทย์ ·
            ช่อง<b>ที่มา</b>คือสถานที่ทำงานเดิมที่ติดมากับข้อมูล ไม่ใช่สาขา Mersi ·
            ขึ้นทะเบียนแล้ว<b>ยังคำนวณไม่ได้จนกว่าจะตั้งอัตราค่าตอบแทน</b>ให้แพทย์คนนั้น
          </Note>

          <div className="field" style={{ maxWidth: 420 }}>
            <label>ค้นหา — รหัส ว. / ชื่อ-สกุล / ชื่อเล่น / ที่มา</label>
            <input value={poolQ} placeholder="เช่น สมชาย หรือ 96849 หรือ ขอนแก่น"
              onChange={(e) => setPoolQ(e.target.value)}
            />
          </div>

          {!pool ? <Skeleton rows={4} /> : (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="muted">
                  พบ {pool.found} คน
                  {pool.found > pool.rows.length && ` · แสดง ${pool.rows.length} คนแรก พิมพ์ค้นหาเพิ่มเพื่อให้แคบลง`}
                </span>
                <div className="spacer" />
                <button className="sm" disabled={busy || !pool.rows.length}
                  onClick={() => setPoolPick(new Set(pool.rows.map((r) => r.licNo)))}
                >
                  เลือกทั้งหมดที่แสดง
                </button>
                <button className="sm" disabled={busy || !poolPick.size}
                  onClick={() => setPoolPick(new Set())}
                >
                  ล้างที่เลือก
                </button>
              </div>

              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}></th>
                      <th>รหัส ว.</th><th>ชื่อ-สกุล</th><th>ชื่อเล่น</th>
                      <th>ธนาคาร</th><th>เลขบัญชี</th><th>อีเมล</th><th>ที่มา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.rows.map((r: PoolRow) => (
                      <tr key={r.licNo}>
                        <td>
                          <input type="checkbox" disabled={busy}
                            checked={poolPick.has(r.licNo)}
                            onChange={() => togglePick(r.licNo)}
                          />
                        </td>
                        <td>{r.licNo}</td>
                        <td>{r.name}</td>
                        <td>{r.nick}</td>
                        <td>{r.bank}</td>
                        <td className="tnum">{r.bankAcc}</td>
                        <td>
                          {r.email
                            ? <span className="muted">{r.email}</span>
                            : <span className="pill warn">ไม่มีอีเมล</span>}
                        </td>
                        <td className="muted">{r.source}</td>
                      </tr>
                    ))}
                    {pool.rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="muted">
                          {poolQ ? 'ไม่พบรายชื่อที่ตรงกับคำค้น' : 'ขึ้นทะเบียนครบทุกคนในคลังแล้ว'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'rate' && (
        <Card
          title={`อัตราและสัญญา (${rates?.length ?? '—'} รายการ)`}
          right={mayRate && <button className="primary" onClick={() => setEditRate({ ...BLANK_RATE })}>+ เพิ่มอัตรา</button>}
        >
          <Note tone="info">
            ลำดับการเลือกอัตรา: <b>แพทย์+สาขา → แพทย์ → สาขา → อัตรากลาง</b> ·
            ไม่พบอัตราที่มีผลในวันที่ทำงาน ระบบจะ<b>หยุดคำนวณและแจ้งปัญหา</b> ไม่ใช้ 0 แทน ·
            เว้นรหัส ว. ว่าง = อัตรากลาง · เว้นสาขาว่าง = ทุกสาขา
          </Note>
          {!rates ? <Skeleton rows={5} /> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>รหัส ว.</th><th>สาขา</th><th className="n">อัตรา/ชม.</th>
                    <th>ฐานภาษี</th><th className="n">อัตราภาษี</th>
                    <th>มีผลตั้งแต่</th><th>ถึง</th><th>หมายเหตุ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={r.id}>
                      <td>{r.lic_no === '*' ? <span className="pill none">อัตรากลาง</span> : r.lic_no}</td>
                      <td>{r.branch || <span className="muted">ทุกสาขา</span>}</td>
                      <td className="n"><Money v={r.hourly_rate} /></td>
                      <td>{TAX_BASE_TH[r.tax_base] || r.tax_base}</td>
                      <td className="n">{r.tax_base === 'NONE' ? '—' : `${r.tax_rate}%`}</td>
                      <td>{r.eff_from || <span className="pill block">ไม่ระบุ</span>}</td>
                      <td>{r.eff_to || <span className="muted">ไม่สิ้นสุด</span>}</td>
                      <td className="muted">{r.note}</td>
                      <td>
                        {mayRate && (
                          <div className="row">
                            <button className="sm" onClick={() => setEditRate({ ...r })}>แก้ไข</button>
                            <button className="sm" onClick={() => run(async () => {
                              await api.deleteRate(r.id!); load(); setMsg('ลบอัตราแล้ว');
                            })}
                            >
                              ลบ
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rates.length === 0 && (
                    <tr><td colSpan={9} className="muted">ยังไม่มีอัตรา — การคำนวณจะแจ้งปัญหา NO_RATE ทุกบรรทัด</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---------- ฟอร์มแก้ไขแพทย์ ---------- */}
      {editDoc && (
        <Card title={editDoc.lic_no ? `แก้ไข ${editDoc.lic_no}` : 'เพิ่มแพทย์ใหม่'}>
          <div className="grid g3">
            {([
              ['lic_no', 'รหัส ว.'], ['full_name', 'ชื่อ-สกุล'], ['nick_name', 'ชื่อเล่น'],
              ['bank', 'ธนาคาร'], ['bank_acc', 'เลขบัญชี'], ['id_card', 'เลขบัตรประชาชน'],
              ['contact', 'เบอร์ติดต่อ'], ['email', 'อีเมล (ใช้ส่งหนังสือรับรองรายได้)'],
      ['payee_name', 'ชื่อผู้รับเงิน (ถ้าเป็นนิติบุคคล)'],
            ] as [keyof Doctor, string][]).map(([k, label]) => (
              <div className="field" key={k}>
                <label>{label}</label>
                <input
                  value={String(editDoc[k] ?? '')}
                  disabled={k === 'lic_no' && !!docs?.some((d) => d.lic_no === editDoc.lic_no)}
                  onChange={(e) => setEditDoc({ ...editDoc, [k]: e.target.value })}
                />
              </div>
            ))}
            <div className="field">
              <label>ประเภทผู้รับเงิน</label>
              <select value={editDoc.payee_type}
                onChange={(e) => setEditDoc({ ...editDoc, payee_type: e.target.value })}
              >
                <option value="PERSON">บุคคลธรรมดา</option>
                <option value="COMPANY">นิติบุคคล</option>
              </select>
            </div>
            <div className="field">
              <label>สถานะ</label>
              <select value={editDoc.status}
                onChange={(e) => setEditDoc({ ...editDoc, status: e.target.value })}
              >
                <option value="ACTIVE">ปฏิบัติงาน</option>
                <option value="INACTIVE">พ้นสภาพ</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>ที่อยู่</label>
            <textarea rows={2} value={editDoc.address}
              onChange={(e) => setEditDoc({ ...editDoc, address: e.target.value })}
            />
          </div>
          <div className="row">
            <button className="primary" onClick={saveDoc} disabled={busy}>บันทึก</button>
            <button onClick={() => setEditDoc(null)}>ยกเลิก</button>
          </div>
        </Card>
      )}

      {/* ---------- ฟอร์มแก้ไขอัตรา ---------- */}
      {editRate && (
        <Card title={editRate.id ? 'แก้ไขอัตรา' : 'เพิ่มอัตราใหม่'}>
          <div className="grid g3">
            <div className="field">
              <label>รหัส ว. (เว้นว่าง = อัตรากลาง)</label>
              <input value={editRate.lic_no === '*' ? '' : editRate.lic_no}
                onChange={(e) => setEditRate({ ...editRate, lic_no: e.target.value })}
              />
            </div>
            <div className="field">
              <label>สาขา (เว้นว่าง = ทุกสาขา)</label>
              <select value={editRate.branch}
                onChange={(e) => setEditRate({ ...editRate, branch: e.target.value })}
              >
                <option value="">ทุกสาขา</option>
                {(boot?.branches || []).map((b) => (
                  <option key={b.code} value={b.code}>{b.code} · {b.nameTh}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>อัตราต่อชั่วโมง (บาท)</label>
              <input type="number" value={editRate.hourly_rate}
                onChange={(e) => setEditRate({ ...editRate, hourly_rate: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>ฐานคำนวณภาษี</label>
              <select value={editRate.tax_base}
                onChange={(e) => setEditRate({ ...editRate, tax_base: e.target.value })}
              >
                <option value="TOTAL">รวมเงินได้ (ค่าเวร + ค่ามือ)</option>
                <option value="SHIFT">เฉพาะค่าเวร</option>
                <option value="NONE">ไม่หักภาษี ณ ที่จ่าย</option>
              </select>
            </div>
            <div className="field">
              <label>อัตราภาษี (%)</label>
              <input type="number" step="0.01" value={editRate.tax_rate}
                onChange={(e) => setEditRate({ ...editRate, tax_rate: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>มีผลตั้งแต่</label>
              <input type="date" value={editRate.eff_from || ''}
                onChange={(e) => setEditRate({ ...editRate, eff_from: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>ถึงวันที่ (เว้นว่าง = ไม่สิ้นสุด)</label>
              <input type="date" value={editRate.eff_to || ''}
                onChange={(e) => setEditRate({ ...editRate, eff_to: e.target.value || null })}
              />
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>หมายเหตุ / เอกสารอ้างอิง</label>
              <input value={editRate.note}
                onChange={(e) => setEditRate({ ...editRate, note: e.target.value })}
              />
            </div>
          </div>
          <div className="row">
            <button className="primary" onClick={saveRate} disabled={busy}>บันทึก</button>
            <button onClick={() => setEditRate(null)}>ยกเลิก</button>
          </div>
        </Card>
      )}
    </>
  );
}
