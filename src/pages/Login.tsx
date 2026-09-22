import React, { useState } from 'react';
import { supabase, toEmail, APP_VERSION } from '../lib/supabase';
import { Note } from '../components/ui';

export default function Login({ error }: { error?: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) { setErr('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน'); return; }
    setBusy(true); setErr(null);
    const { error: e2 } = await supabase.auth.signInWithPassword({
      email: toEmail(username), password,
    });
    setBusy(false);
    if (e2) {
      setErr(/invalid/i.test(e2.message)
        ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'
        : e2.message);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login">
        <div className="card">
          <img className="mark-lg" src="/logo.png" alt="Mersi Clinic" />
          <h1 style={{ textAlign: 'center', marginBottom: 2 }}>Mersi Clinic</h1>
          <p className="muted" style={{ textAlign: 'center', marginTop: 0, marginBottom: 18 }}>
            ระบบค่าหัตถการและค่าตอบแทนแพทย์
          </p>

          {(err || error) && <Note tone="bad">{err || error}</Note>}

          <form onSubmit={submit}>
            <div className="field">
              <label>ชื่อผู้ใช้</label>
              <input
                value={username} autoFocus autoCapitalize="none" autoCorrect="off"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label>รหัสผ่าน</label>
              <input
                type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button className="primary" style={{ width: '100%', justifyContent: 'center' }}
              disabled={busy} type="submit"
            >
              {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </button>
          </form>
        </div>
        <p className="muted" style={{ textAlign: 'center' }}>
          ใช้ชื่อผู้ใช้เดียวกับ Mersi CRM · {APP_VERSION}
        </p>
      </div>
    </div>
  );
}
