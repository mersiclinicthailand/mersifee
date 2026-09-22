import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, can } from '../lib/auth';
import { Alerts, Card, Note, Skeleton, useAsync } from '../components/ui';

interface Cfg { key: string; value: string; note: string; updated_by: string; updated_at: string }
interface Staff {
  id: string; role: string; branch_codes: string[]; lic_no: string | null; active: boolean;
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
        <Card title="สิทธิ์ผู้ใช้งานระบบค่าตอบแทน">
          <Note tone="info">
            บัญชีและรหัสผ่านใช้ร่วมกับ Mersi CRM — เพิ่ม/ลบบัญชีทำที่ระบบ CRM
            ที่นี่กำหนดเฉพาะ<b>บทบาทและขอบเขตสาขาในระบบค่าตอบแทน</b> ·
            ต้องมีอย่างน้อย 3 บัญชีจริง (ผู้จัดทำ / ผู้ตรวจ / ผู้อนุมัติ) จึงจะเดินรอบอนุมัติได้ครบ
          </Note>
          {!staff ? <Skeleton rows={6} /> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อผู้ใช้</th><th>ชื่อ</th><th>บทบาทในระบบค่าตอบแทน</th>
                    <th>ขอบเขตสาขา</th><th>รหัส ว. (ถ้าเป็นแพทย์)</th><th>ใช้งาน</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s) => (
                    <tr key={s.id}>
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
                    </tr>
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
    </>
  );
}
