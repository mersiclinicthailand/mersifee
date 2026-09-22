import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, can } from '../lib/auth';
import { TABS, visibleTabs } from '../lib/tabs';
import { Alerts, Card, Confirm, Note, Skeleton, useAsync } from '../components/ui';

interface Cfg { key: string; value: string; note: string; updated_by: string; updated_at: string }
interface Staff {
  id: string; role: string; branch_codes: string[]; lic_no: string | null; active: boolean;
  tabs: string[] | null;
  profile?: { username: string; display_name: string; active: boolean; last_login: string | null };
}
interface Audit { id: number; at: string; actor: string; action: string; target: string; detail: string }

const ROLE_TH: Record<string, string> = {
  admin: 'ผู้ดูแลระบบ', it: 'ไอที', hr: 'ฝ่ายบุคคล', acct: 'ฝ่ายบัญชี',
  approver: 'ผู้อนุมัติ', md: 'ผู้บริหาร', branch: 'พนักงานสาขา',
  doctor: 'แพทย์', audit: 'ผู้ตรวจสอบภายใน',
};

/** ค่าที่เลือกจากรายการแทนการพิมพ์เอง — กันพิมพ์ผิดแล้วระบบเพี้ยน */
const CHOICES: Record<string, { v: string; t: string }[]> = {
  COVER_SHIFT_SOURCE: [
    { v: 'SHEET', t: 'ผูกกับผลรวมในชีตแพทย์ (แนะนำ — กระทบยอดลงตัวเสมอ)' },
    { v: 'HOURS', t: 'ชม.รวม × อัตรา (สูตรต้นฉบับ — ยอดพิเศษจะหาย)' },
  ],
  TAX_BASE_DEFAULT: [
    { v: 'TOTAL', t: 'รวมเงินได้ (ค่าเวร + ค่ามือ)' },
    { v: 'SHIFT', t: 'เฉพาะค่าเวร' },
    { v: 'NONE', t: 'ไม่หักภาษี' },
  ],
  REQUIRE_DOCTOR_SIGN: [
    { v: 'BLOCK', t: 'ต้องเซ็นครบก่อนส่งตรวจ' },
    { v: 'WARN', t: 'เตือนอย่างเดียว (ช่วงเปลี่ยนผ่าน)' },
    { v: 'OFF', t: 'ไม่ตรวจลายเซ็น' },
  ],
  HAND_METHOD_DEFAULT: [
    { v: 'SOURCE', t: 'ตามต้นทาง (ไม่คูณจำนวนซ้ำ)' },
    { v: 'UNIT', t: 'ต่อหน่วย' },
    { v: 'ITEM', t: 'ต่อรายการ' },
  ],
  GRACE_ENABLE: [{ v: 'Y', t: 'เปิดใช้' }, { v: 'N', t: 'ปิด' }],
  DOCTOR_PIN_REQUIRED: [{ v: 'Y', t: 'บังคับทุกคน' }, { v: 'N', t: 'เฉพาะคนที่ตั้ง PIN ไว้' }],
  CLOCK_ALLOW_MANUAL: [{ v: 'Y', t: 'อนุญาต' }, { v: 'N', t: 'ไม่อนุญาต' }],
  REQUIRE_ZERO_CONFIRM: [{ v: 'Y', t: 'บังคับยืนยัน' }, { v: 'N', t: 'ไม่บังคับ' }],
  BLOCK_PROC_NO_SHIFT: [{ v: 'Y', t: 'บล็อก' }, { v: 'N', t: 'เตือนอย่างเดียว' }],
};

export default function Settings() {
  const { boot, refresh } = useAuth();
  const [tab, setTab] = useState<'cfg' | 'users' | 'log'>('cfg');
  const [cfg, setCfg] = useState<Cfg[] | null>(null);
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [log, setLog] = useState<Audit[] | null>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const role = boot?.me.role;

  useEffect(() => {
    if (tab === 'cfg' && !cfg) api.listConfig().then((c) => setCfg(c as Cfg[])).catch((e) => setErr(e.message));
    if (tab === 'users' && !staff) api.listStaff().then((s) => setStaff(s as Staff[])).catch((e) => setErr(e.message));
    if (tab === 'log' && !log) api.listAudit().then((l) => setLog(l as Audit[])).catch((e) => setErr(e.message));
  }, [tab, cfg, staff, log, setErr]);

  const saveCfg = (key: string, value: string) => run(async () => {
    await api.saveConfig(key, value);
    setCfg((c) => c && c.map((x) => (x.key === key ? { ...x, value } : x)));
    await refresh();
    setMsg(`บันทึกค่า ${key} แล้ว`);
  });

  const saveStaff = (s: Staff, patch: Partial<Staff>) => run(async () => {
    await api.saveStaff({ ...s, ...patch, profile: undefined });
    setStaff((xs) => xs && xs.map((x) => (x.id === s.id ? { ...x, ...patch } : x)));
    setMsg('บันทึกสิทธิ์ผู้ใช้แล้ว');
  });

  /* ------------------------- จัดการบัญชีผู้ใช้ (IT) ------------------------- */
  const [editTabs, setEditTabs] = useState<string | null>(null);   // id ของแถวที่กำลังแก้สิทธิ์แท็บ
  const [askDel, setAskDel] = useState<Staff | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [nu, setNu] = useState({
    username: '', displayName: '', password: '', role: 'branch', branches: '', licNo: '',
  });

  const reloadStaff = async () => {
    setStaff(await api.listStaff() as Staff[]);
  };

  const createUser = () => run(async () => {
    await api.adminUser('create', {
      username: nu.username, displayName: nu.displayName, password: nu.password,
      role: nu.role, licNo: nu.licNo,
      branches: nu.branches.split(',').map((x) => x.trim()).filter(Boolean),
    });
    setShowNew(false);
    setNu({ username: '', displayName: '', password: '', role: 'branch', branches: '', licNo: '' });
    await reloadStaff();
    setMsg(`สร้างบัญชี ${nu.username} แล้ว — แจ้งรหัสผ่านให้เจ้าตัวและให้เปลี่ยนทันที`);
  });

  const deleteUser = (s: Staff) => run(async () => {
    setAskDel(null);
    await api.adminUser('delete', { id: s.id });
    await reloadStaff();
    setMsg(`ลบบัญชี ${s.profile?.username} ออกจากระบบทั้งหมดแล้ว`);
  });

  const resetPw = (s: Staff) => run(async () => {
    const pw = prompt(`ตั้งรหัสผ่านใหม่ให้ ${s.profile?.username} (อย่างน้อย 8 ตัว)`);
    if (!pw) return;
    await api.adminUser('reset_password', { id: s.id, password: pw });
    setMsg(`ตั้งรหัสผ่านใหม่ให้ ${s.profile?.username} แล้ว`);
  });

  /** ติ๊ก/เอาติ๊กออกทีละแท็บ — null แปลว่ายังใช้ค่าเริ่มต้นตามบทบาท
   *  พอ IT เริ่มติ๊กครั้งแรก ระบบจะยึดค่าเริ่มต้นของบทบาทนั้นมาเป็นจุดตั้งต้นก่อน */
  const toggleTab = (s: Staff, to: string, on: boolean) => {
    const base = s.tabs ?? visibleTabs(s.role, null).map((t) => t.to);
    const next = on ? [...new Set([...base, to])] : base.filter((x) => x !== to);
    saveStaff(s, { tabs: next });
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ตั้งค่า</h1>
        <div className="spacer" />
        <button className={tab === 'cfg' ? 'primary' : ''} onClick={() => setTab('cfg')}>ค่าระบบ</button>
        {can.users(role) && (
          <button className={tab === 'users' ? 'primary' : ''} onClick={() => setTab('users')}>ผู้ใช้งาน</button>
        )}
        {can.seeAudit(role) && (
          <button className={tab === 'log' ? 'primary' : ''} onClick={() => setTab('log')}>ประวัติการใช้งาน</button>
        )}
      </div>

      <Alerts err={err} msg={msg} />

      {tab === 'cfg' && (
        <Card title="ค่าตั้งต้นของระบบ">
          {!can.config(role) && <Note tone="info">บทบาทของคุณดูได้อย่างเดียว</Note>}
          <Note tone="warn">
            การเปลี่ยน “วิธีคิดค่าเวรบนใบปะหน้า” และ “ฐานภาษีตั้งต้น” กระทบยอดที่คำนวณทันที —
            ควรให้ฝ่ายบัญชียืนยันก่อน · รอบที่อนุมัติไปแล้วไม่ถูกกระทบ เพราะยอดถูกล็อกเป็น snapshot
          </Note>
          {!cfg ? <Skeleton rows={6} /> : (
            <div className="grid g2">
              {cfg.map((c) => (
                <div key={c.key} className="field">
                  <label>{c.key}</label>
                  {CHOICES[c.key] ? (
                    <select
                      value={c.value} disabled={busy || !can.config(role)}
                      onChange={(e) => saveCfg(c.key, e.target.value)}
                    >
                      {CHOICES[c.key].map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
                    </select>
                  ) : (
                    <input
                      defaultValue={c.value} disabled={busy || !can.config(role)}
                      onBlur={(e) => e.target.value !== c.value && saveCfg(c.key, e.target.value)}
                    />
                  )}
                  <p className="muted" style={{ margin: '3px 0 0' }}>{c.note}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'users' && can.users(role) && (
        <Card
          title="สิทธิ์ผู้ใช้งานระบบค่าตอบแทน"
          right={
            <button className="primary sm" disabled={busy}
              onClick={() => setShowNew((v) => !v)}
            >
              {showNew ? 'ปิดฟอร์ม' : '+ สร้างผู้ใช้'}
            </button>
          }
        >
          <Note tone="info">
            บัญชีใช้ร่วมกับ Mersi CRM — สร้างที่นี่ก็ใช้ล็อกอิน CRM ได้เหมือนกัน ·
            ช่อง <b>แท็บที่เห็น</b> ใช้กำหนดสิทธิ์รายคน ถ้าไม่กำหนดจะใช้ค่าเริ่มต้นตามบทบาท ·
            ต้องมีอย่างน้อย 2 บัญชีจริง (สาขาจัดทำ / HR อนุมัติ) จึงจะเดินรอบอนุมัติได้ครบ
          </Note>

          {showNew && (
            <div className="card" style={{ background: 'var(--bg)', marginBottom: 12 }}>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
                <div className="field">
                  <label>ชื่อผู้ใช้ (a-z 0-9)</label>
                  <input value={nu.username} autoCapitalize="none"
                    onChange={(e) => setNu({ ...nu, username: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>ชื่อที่แสดง</label>
                  <input value={nu.displayName}
                    onChange={(e) => setNu({ ...nu, displayName: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>รหัสผ่านเริ่มต้น (≥8 ตัว)</label>
                  <input value={nu.password} type="text"
                    onChange={(e) => setNu({ ...nu, password: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>บทบาท</label>
                  <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                    {Object.entries(ROLE_TH).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>ขอบเขตสาขา (คั่นด้วย , · * = ทุกสาขา)</label>
                  <input value={nu.branches} placeholder="BN, RM"
                    onChange={(e) => setNu({ ...nu, branches: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>รหัส ว. (ถ้าเป็นแพทย์)</label>
                  <input value={nu.licNo}
                    onChange={(e) => setNu({ ...nu, licNo: e.target.value })}
                  />
                </div>
              </div>
              <button className="primary" disabled={busy || !nu.username || nu.password.length < 8}
                onClick={createUser}
              >
                สร้างบัญชี
              </button>
              <p className="muted" style={{ marginBottom: 0 }}>
                ระบบจะบังคับให้ผู้ใช้เปลี่ยนรหัสผ่านเองในการเข้าครั้งแรก
              </p>
            </div>
          )}
          {!staff ? <Skeleton rows={6} /> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อผู้ใช้</th><th>ชื่อ</th><th>บทบาทในระบบค่าตอบแทน</th>
                    <th>ขอบเขตสาขา</th><th>รหัส ว.</th><th>ใช้งาน</th>
                    <th>แท็บที่เห็น</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s) => (
                    <Fragment key={s.id}>
                    <tr>
                      <td>{s.profile?.username}</td>
                      <td>{s.profile?.display_name}</td>
                      <td>
                        <select value={s.role} disabled={busy}
                          onChange={(e) => saveStaff(s, { role: e.target.value })}
                        >
                          {Object.entries(ROLE_TH).map(([v, t]) => (
                            <option key={v} value={v}>{t}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          defaultValue={(s.branch_codes || []).join(', ')}
                          placeholder="* = ทุกสาขา" style={{ minWidth: 140 }}
                          onBlur={(e) => {
                            const arr = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                            if (arr.join(',') !== (s.branch_codes || []).join(',')) {
                              saveStaff(s, { branch_codes: arr });
                            }
                          }}
                        />
                      </td>
                      <td>
                        <input
                          defaultValue={s.lic_no || ''} style={{ minWidth: 90 }}
                          onBlur={(e) => e.target.value !== (s.lic_no || '') && saveStaff(s, { lic_no: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox" checked={s.active} disabled={busy}
                          onChange={(e) => saveStaff(s, { active: e.target.checked })}
                        />
                      </td>
                      <td>
                        <button className="sm"
                          onClick={() => setEditTabs(editTabs === s.id ? null : s.id)}
                        >
                          {s.tabs
                            ? `กำหนดเอง ${s.tabs.length} แท็บ`
                            : `ตามบทบาท (${visibleTabs(s.role, null).length})`}
                        </button>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                          <button className="sm" disabled={busy} onClick={() => resetPw(s)}>
                            รหัสผ่านใหม่
                          </button>
                          <button className="danger sm" disabled={busy}
                            onClick={() => setAskDel(s)}
                          >
                            ลบ
                          </button>
                        </div>
                      </td>
                    </tr>

                    {editTabs === s.id && (
                      <tr>
                        <td colSpan={8} style={{ background: 'var(--bg)' }}>
                          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
                            {TABS.map((t) => {
                              const on = visibleTabs(s.role, s.tabs).some((x) => x.to === t.to);
                              return (
                                <label key={t.to}
                                  style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                                >
                                  <input type="checkbox" checked={on}
                                    disabled={busy || t.always}
                                    onChange={(e) => toggleTab(s, t.to, e.target.checked)}
                                  />
                                  {t.label}{t.always && <span className="muted"> (ปิดไม่ได้)</span>}
                                </label>
                              );
                            })}
                            {s.tabs && (
                              <button className="sm" disabled={busy}
                                onClick={() => saveStaff(s, { tabs: null })}
                              >
                                กลับไปใช้ค่าเริ่มต้นตามบทบาท
                              </button>
                            )}
                          </div>
                          <p className="muted" style={{ margin: '8px 0 0' }}>
                            ซ่อนแท็บเป็นเรื่องหน้าจอเท่านั้น — สิทธิ์จริงยังบังคับที่ฐานข้อมูล
                            เช่น ต่อให้เปิดแท็บ “อนุมัติ” ให้ คนที่ไม่ใช่ HR ก็ยังกดอนุมัติไม่ได้อยู่ดี
                          </p>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'log' && can.seeAudit(role) && (
        <Card title="ประวัติการใช้งาน (ผู้ใช้ลบเองไม่ได้)">
          {!log ? <Skeleton rows={6} /> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>เมื่อ</th><th>ผู้ทำรายการ</th><th>การกระทำ</th><th>เป้าหมาย</th><th>รายละเอียด</th></tr>
                </thead>
                <tbody>
                  {log.map((l) => (
                    <tr key={l.id}>
                      <td className="muted">{(l.at || '').replace('T', ' ').substring(0, 19)}</td>
                      <td>{l.actor}</td>
                      <td>{l.action}</td>
                      <td>{l.target}</td>
                      <td className="muted">{l.detail}</td>
                    </tr>
                  ))}
                  {log.length === 0 && <tr><td colSpan={5} className="muted">ยังไม่มีประวัติ</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Confirm
        open={!!askDel}
        title={`ลบบัญชี ${askDel?.profile?.username || ''}`}
        confirmText="ลบถาวร"
        body={
          <>
            บัญชีนี้จะถูกลบออกจาก<b>ทั้ง Mersi CRM และระบบค่าตอบแทน</b> พร้อมกัน
            และเข้าสู่ระบบไม่ได้อีก — ประวัติการทำรายการที่ผ่านมายังอยู่ครบในแท็บ
            “ประวัติการใช้งาน” · ถ้าแค่อยากระงับชั่วคราว ให้เอาติ๊ก “ใช้งาน” ออกแทน
          </>
        }
        onOk={() => askDel && deleteUser(askDel)}
        onCancel={() => setAskDel(null)}
      />
    </>
  );
}
