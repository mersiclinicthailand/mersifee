// fee-admin-users — สร้าง / ลบ / ตั้งรหัสผ่านใหม่ ให้บัญชีผู้ใช้ระบบค่าตอบแทนแพทย์
//
// ต้องทำผ่าน Edge Function เพราะใช้กุญแจระดับเซิร์ฟเวอร์ (service role)
// เรียกได้เฉพาะบัญชีบทบาท it หรือ admin เท่านั้น — ตรวจซ้ำในนี้อีกชั้น ไม่เชื่อฝั่งเบราว์เซอร์
//
// บัญชีใช้ร่วมกับ Mersi CRM: 1 บัญชี = auth user + public.profiles + fee.staff
// ล็อกอินด้วยชื่อผู้ใช้ ระบบแปลงเป็นอีเมลภายใน <username>@mersi.local
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const EMAIL_DOMAIN = 'mersi.local';
const ROLES = ['admin', 'it', 'hr', 'acct', 'approver', 'md', 'audit', 'branch', 'doctor'];

Deno.serve(async (req) => {
  // preflight ต้องตอบก่อนเสมอ ไม่งั้นเบราว์เซอร์ขึ้น "Failed to send a request to the Edge Function"
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'ต้องเรียกด้วย POST' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return json({ error: 'Edge Function ยังไม่มีคีย์ของเซิร์ฟเวอร์ (SUPABASE_SERVICE_ROLE_KEY)' }, 500);
    const admin = createClient(url, key, { auth: { persistSession: false } });

    /* ---------------- ผู้เรียกต้องเป็น IT หรือผู้ดูแลระบบ ---------------- */
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'ไม่พบ token — กรุณาเข้าสู่ระบบใหม่' }, 401);

    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'token ไม่ถูกต้องหรือหมดอายุ — กรุณาเข้าสู่ระบบใหม่' }, 401);

    const { data: caller } = await admin.schema('fee').from('staff')
      .select('role').eq('id', u.user.id).maybeSingle();
    if (!caller || !['it', 'admin'].includes(caller.role)) {
      return json({ error: 'เฉพาะผู้ดูแลระบบ (IT) เท่านั้นที่จัดการบัญชีผู้ใช้ได้' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    /* ----------------------------- สร้างบัญชี ----------------------------- */
    if (action === 'create') {
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim() || username;
      const password = String(body.password || '');
      const role = String(body.role || 'branch');
      const licNo = String(body.licNo || '').trim();
      const branches: string[] = Array.isArray(body.branches) ? body.branches.map(String) : [];

      if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
        return json({ error: 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 2–32 ตัว' }, 400);
      }
      if (password.length < 8) return json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว' }, 400);
      if (!ROLES.includes(role)) return json({ error: `ไม่รู้จักบทบาท ${role}` }, 400);

      const { data: dup } = await admin.from('profiles')
        .select('id').eq('username', username).maybeSingle();
      if (dup) return json({ error: `มีชื่อผู้ใช้ ${username} อยู่แล้ว` }, 409);

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

      // profiles อาจถูกสร้างไว้แล้วโดย trigger ของ CRM — ใช้ upsert กันชนกัน
      const { error: eProf } = await admin.from('profiles')
        .upsert({ id, username, display_name: displayName, active: true }, { onConflict: 'id' });
      if (eProf) {
        await admin.auth.admin.deleteUser(id);          // ย้อนกลับ ไม่ทิ้งบัญชีค้าง
        return json({ error: `บันทึกโปรไฟล์ไม่สำเร็จ: ${eProf.message}` }, 400);
      }

      const { error: eStaff } = await admin.schema('fee').from('staff').upsert({
        id, role, branch_codes: branches.length ? branches : ['*'],
        lic_no: licNo || null, active: true, tabs: null,
      }, { onConflict: 'id' });
      if (eStaff) {
        await admin.from('profiles').delete().eq('id', id);
        await admin.auth.admin.deleteUser(id);
        return json({ error: `บันทึกสิทธิ์ไม่สำเร็จ: ${eStaff.message}` }, 400);
      }

      return json({ ok: true, id, username });
    }

    /* ------------------------------ ลบบัญชี ------------------------------ */
    if (action === 'delete') {
      const id = String(body.id || '');
      if (!id) return json({ error: 'ต้องระบุบัญชีที่จะลบ' }, 400);
      if (id === u.user.id) return json({ error: 'ลบบัญชีตัวเองไม่ได้' }, 400);

      // กันลบผู้ดูแลระบบคนสุดท้าย จนไม่มีใครเข้าไปแก้อะไรได้อีก
      const { data: target } = await admin.schema('fee').from('staff')
        .select('role').eq('id', id).maybeSingle();
      if (target && ['it', 'admin'].includes(target.role)) {
        const { count } = await admin.schema('fee').from('staff')
          .select('id', { count: 'exact', head: true })
          .in('role', ['it', 'admin']).eq('active', true);
        if ((count || 0) <= 1) {
          return json({ error: 'เหลือผู้ดูแลระบบคนสุดท้ายแล้ว ลบไม่ได้ — สร้างผู้ดูแลคนใหม่ก่อน' }, 400);
        }
      }

      await admin.schema('fee').from('staff').delete().eq('id', id);
      await admin.from('profiles').delete().eq('id', id);
      const { error: eDel } = await admin.auth.admin.deleteUser(id);
      if (eDel) return json({ error: `ลบบัญชีไม่สำเร็จ: ${eDel.message}` }, 400);
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
