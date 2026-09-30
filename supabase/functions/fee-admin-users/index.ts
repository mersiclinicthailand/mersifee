// fee-admin-users — สร้าง / ลบ / ตั้งรหัสผ่านใหม่ ให้บัญชีผู้ใช้ระบบค่าตอบแทนแพทย์
//
// แบ่งงานกัน 2 ฝั่ง:
//   ฝั่งนี้ (service role) — ทำเฉพาะงานที่ต้องใช้สิทธิ์ระดับเซิร์ฟเวอร์จริง ๆ
//                            คือสร้าง/ลบบัญชี auth และตั้งรหัสผ่าน
//   ฝั่งฐานข้อมูล (RPC)    — งานแตะตาราง profiles / fee.staff ทั้งหมด
//                            ผ่านฟังก์ชัน security definer ใน admin_users.sql
//
// ทำไมไม่อ่าน fee.staff ตรง ๆ ด้วย service role: ตารางเปิด FORCE ROW LEVEL SECURITY ไว้
// service role จึงถูก policy กรองจนอ่านไม่เห็นแถว แล้วระบบเข้าใจผิดว่าคนกดไม่ใช่ผู้ดูแลระบบ
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-application-name',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const EMAIL_DOMAIN = 'mersi.local';
const ROLES = ['admin', 'it', 'hr', 'acct', 'approver', 'md', 'audit', 'branch', 'doctor'];

Deno.serve(async (req) => {
  // pre-flight ต้องตอบก่อนเสมอ ไม่งั้นเบราว์เซอร์ขึ้น "Failed to send a request to the Edge Function"
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'ต้องเรียกด้วย POST' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const svcKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !svcKey) return json({ error: 'Edge Function ยังไม่มีคีย์ของเซิร์ฟเวอร์ (SUPABASE_SERVICE_ROLE_KEY)' }, 500);

    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'ไม่พบ token — กรุณาเข้าสู่ระบบใหม่' }, 401);

    const admin = createClient(url, svcKey, { auth: { persistSession: false } });
    // ทำงานกับตารางในนามของ "คนที่กดปุ่ม" — ฟังก์ชันในฐานข้อมูลจะตรวจสิทธิ์จาก auth.uid() เอง
    const asUser = createClient(url, anonKey || svcKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'token ไม่ถูกต้องหรือหมดอายุ — กรุณาเข้าสู่ระบบใหม่' }, 401);

    const { data: role, error: eRole } = await asUser.rpc('fee_admin_role');
    if (eRole) return json({ error: `ตรวจสิทธิ์ไม่สำเร็จ: ${eRole.message}` }, 500);
    if (!role || !['it', 'admin'].includes(String(role))) {
      return json({ error: `เฉพาะผู้ดูแลระบบ (IT) เท่านั้นที่จัดการบัญชีผู้ใช้ได้ (บัญชีนี้บทบาท: ${role || 'ไม่พบสิทธิ์'})` }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    /* ----------------------------- สร้างบัญชี ----------------------------- */
    if (action === 'create') {
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim() || username;
      const password = String(body.password || '');
      const userRole = String(body.role || 'branch');
      const licNo = String(body.licNo || '').trim();
      const branches: string[] = Array.isArray(body.branches) ? body.branches.map(String) : [];

      if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
        return json({ error: 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 2–32 ตัว' }, 400);
      }
      if (password.length < 8) return json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว' }, 400);
      if (!ROLES.includes(userRole)) return json({ error: `ไม่รู้จักบทบาท ${userRole}` }, 400);

      const { data: taken } = await asUser.rpc('fee_admin_username_taken', { p_username: username });
      if (taken) return json({ error: `มีชื่อผู้ใช้ ${username} อยู่แล้ว` }, 409);

      const email = `${username}@${EMAIL_DOMAIN}`;
      const { data: created, error: eAuth } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username, display_name: displayName },
      });
      if (eAuth || !created?.user) {
        const m = eAuth?.message || 'สร้างบัญชีไม่สำเร็จ';
        return json({ error: /already/i.test(m) ? `มีชื่อผู้ใช้ ${username} อยู่แล้ว` : m }, 400);
      }
      const id = created.user.id;

      const { error: eLink } = await asUser.rpc('fee_admin_user_link', {
        p_id: id, p_username: username, p_display: displayName,
        p_role: userRole, p_branches: branches, p_lic: licNo,
      });
      if (eLink) {
        await admin.auth.admin.deleteUser(id);          // ย้อนกลับ ไม่ทิ้งบัญชีค้าง
        return json({ error: `บันทึกสิทธิ์ไม่สำเร็จ: ${eLink.message}` }, 400);
      }
      return json({ ok: true, id, username });
    }

    /* ------------------------------ ลบบัญชี ------------------------------ */
    if (action === 'delete') {
      const id = String(body.id || '');
      if (!id) return json({ error: 'ต้องระบุบัญชีที่จะลบ' }, 400);

      const { error: eUnlink } = await asUser.rpc('fee_admin_user_unlink', { p_id: id });
      if (eUnlink) return json({ error: eUnlink.message }, 400);

      const { error: eDel } = await admin.auth.admin.deleteUser(id);
      if (eDel) return json({ error: `ถอดสิทธิ์แล้ว แต่ลบบัญชี auth ไม่สำเร็จ: ${eDel.message}` }, 400);
      return json({ ok: true, id });
    }

    /* -------------------------- ตั้งรหัสผ่านใหม่ -------------------------- */
    if (action === 'reset_password') {
      const id = String(body.id || '');
      const password = String(body.password || '');
      if (!id) return json({ error: 'ต้องระบุบัญชี' }, 400);
      if (password.length < 8) return json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว' }, 400);

      const { error: eUp } = await admin.auth.admin.updateUserById(id, { password });
      if (eUp) return json({ error: `ตั้งรหัสผ่านใหม่ไม่สำเร็จ: ${eUp.message}` }, 400);
      return json({ ok: true, id });
    }

    return json({ error: `คำสั่งไม่รู้จัก: ${action}` }, 400);
  } catch (e) {
    return json({ error: `เกิดข้อผิดพลาดในเซิร์ฟเวอร์: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});
