/* ============================================================================
 * MailTest.tsx — ส่งเมลทดสอบถึงตัวเอง
 * เนื้อหาเหมือนเมลจริงทุกอย่าง แต่ชื่อ/ยอดเป็นข้อมูลตัวอย่าง และมีแถบ "อีเมลทดสอบ" ด้านบน
 * ลิงก์เซ็นในเมลทดสอบพาไปหน้าเซ็นโหมดสาธิต (กดเซ็นได้ แต่ไม่บันทึกอะไร)
 * ==========================================================================*/
import { useState } from 'react';
import { api } from '../lib/api';
import { Card, Note } from './ui';

type Kind = 'sign_invite' | 'tax_detail' | 'wht_cert';
const LABEL: Record<Kind, string> = {
  sign_invite: 'เมลเชิญเซ็นรับรองรายได้',
  tax_detail: 'เมลสรุปยอดหักภาษี',
  wht_cert: 'เมล 50 ทวิ (แนบ PDF)',
};
const KEY = 'fee.testMail';

export default function MailTest(
  { branch, ym, kinds, defaultKind }: { branch: string; ym: string; kinds: Kind[]; defaultKind: Kind },
) {
  const [to, setTo] = useState(() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } });
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async () => {
    setRes(null);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to.trim())) {
      setRes({ ok: false, text: 'กรอกอีเมลให้ถูกต้องก่อน' }); return;
    }
    setBusy(true);
    try {
      try { localStorage.setItem(KEY, to.trim()); } catch { /* ไม่เป็นไร */ }
      await api.sendTest(kind, to.trim(), branch, ym);
      setRes({ ok: true, text: `ส่ง "${LABEL[kind]}" ไปที่ ${to.trim()} แล้ว — เปิดกล่องจดหมายดูได้เลย (ถ้าไม่เห็นให้ดูในถังขยะ/สแปม)` });
    } catch (e) {
      setRes({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  return (
    <Card title="🧪 ส่งเมลทดสอบถึงตัวฉัน"
      right={<span className="muted">ข้อมูลตัวอย่าง · ไม่ส่งถึงแพทย์ · ไม่ต้องรออนุมัติรอบ</span>}
    >
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input type="email" value={to} placeholder="อีเมลของคุณ เช่น hr@mersiclinic.com"
          onChange={(e) => setTo(e.target.value)} style={{ minWidth: 260, flex: 1 }}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {kinds.map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
        </select>
        <button onClick={send} disabled={busy}>{busy ? 'กำลังส่ง…' : 'ส่งเมลทดสอบ'}</button>
      </div>
      {res && <div style={{ marginTop: 10 }}><Note tone={res.ok ? 'ok' : 'bad'}>{res.text}</Note></div>}
      <p className="muted" style={{ marginBottom: 0, fontSize: '.82rem' }}>
        หน้าตาเหมือนเมลจริงทุกอย่าง ต่างแค่มีแถบสีเหลือง “อีเมลทดสอบ” ·
        ปุ่มเซ็นในเมลทดสอบพาไปหน้าเซ็นโหมดสาธิต ลองเซ็นได้แต่ไม่บันทึก
      </p>
    </Card>
  );
}
