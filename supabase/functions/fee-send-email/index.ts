// fee-send-email — ส่งอีเมลหาแพทย์ผ่าน Resend
//   sign_invite : เชิญแพทย์กดลิงก์เซ็นรับรองรายได้ (ลิงก์มีอายุ 14 วัน)
//   tax_detail  : แจ้งรายละเอียดการหักภาษี ณ ที่จ่าย (HR กดส่งเองเมื่อพร้อม)
//
// เรียกได้เฉพาะบัญชี hr หรือ admin และเฉพาะรอบที่อนุมัติแล้วเท่านั้น
// ต้องตั้ง secret ที่ Supabase ก่อนใช้งาน: RESEND_API_KEY, FEE_MAIL_FROM, FEE_APP_URL
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const ymThai = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${TH_MONTH[m - 1]} ${String(y + 543).slice(-2)}`;
};
const money = (n: number) =>
  Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** กัน HTML injection จากชื่อ/ข้อความที่มาจากฐานข้อมูล */
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const SAGE = '#8B9677';

function shell(title: string, body: string) {
  return `<!doctype html><html lang="th"><body style="margin:0;background:#F5F5F1;
    font-family:'IBM Plex Sans Thai','Sarabun',sans-serif;color:#23261F;">
    <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
      <div style="background:#fff;border:1px solid #E3E3DC;border-radius:14px;padding:26px 24px;">
        <div style="text-align:center;margin-bottom:18px;">
          <div style="font-size:1.35rem;font-weight:700;">Mersi Clinic</div>
          <div style="color:#5B6154;font-size:.9rem;">${esc(title)}</div>
        </div>
        ${body}
      </div>
      <p style="color:#8A8F80;font-size:.75rem;text-align:center;margin-top:14px;">
        อีเมลฉบับนี้ส่งจากระบบค่าตอบแทนแพทย์ของ Mersi Clinic โดยอัตโนมัติ
        หากได้รับโดยไม่ทราบที่มา กรุณาติดต่อฝ่ายบุคคล
      </p>
    </div></body></html>`;
}

const amountTable = (gross: number, tax: number, net: number) => `
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:.95rem;">
    <tr><td style="padding:7px 0;color:#5B6154;">รวมเงินได้</td>
        <td style="padding:7px 0;text-align:right;font-variant-numeric:tabular-nums;">${money(gross)}</td></tr>
    <tr><td style="padding:7px 0;color:#5B6154;">หักภาษี ณ ที่จ่าย</td>
        <td style="padding:7px 0;text-align:right;font-variant-numeric:tabular-nums;">−${money(tax)}</td></tr>
    <tr style="border-top:1px solid #E3E3DC;">
        <td style="padding:9px 0;font-weight:700;">จ่ายสุทธิ</td>
        <td style="padding:9px 0;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;">${money(net)}</td></tr>
  </table>`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'ต้องเรียกด้วย POST' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('FEE_MAIL_FROM') || 'Mersi Clinic <onboarding@resend.dev>';
  const appUrl = (Deno.env.get('FEE_APP_URL') || '').replace(/\/+$/, '');
  if (!apiKey) {
    return json({ error: 'ยังไม่ได้ตั้งค่า RESEND_API_KEY ที่ Supabase — ตั้งก่อนจึงจะส่งเมลได้' }, 400);
  }

  // ---- ผู้เรียกต้องเป็น HR หรือผู้ดูแลระบบ ----
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  const { data: u } = await admin.auth.getUser(token);
  if (!u?.user) return json({ error: 'token ไม่ถูกต้อง' }, 401);

  const { data: caller } = await admin.schema('fee').from('staff')
    .select('role, branch_codes').eq('id', u.user.id).maybeSingle();
  if (!caller || !['hr', 'admin'].includes(caller.role)) {
    return json({ error: 'เฉพาะฝ่าย HR หรือผู้ดูแลระบบเท่านั้นที่ส่งเมลได้' }, 403);
  }
  const { data: prof } = await admin.from('profiles')
    .select('username').eq('id', u.user.id).maybeSingle();
  const sentBy = prof?.username || u.user.id;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const branch = String(body.branch || '');
  const ym = String(body.ym || '');
  const lics: string[] = Array.isArray(body.licNos) ? body.licNos.map(String) : [];
  const pid = `${branch}-${ym.replace('-', '')}`;

  if (!branch || !ym) return json({ error: 'ต้องระบุสาขาและเดือน' }, 400);
  if (!lics.length) return json({ error: 'ยังไม่ได้เลือกแพทย์' }, 400);
  if (!['sign_invite', 'tax_detail'].includes(action)) {
    return json({ error: `คำสั่งไม่รู้จัก: ${action}` }, 400);
  }
  // HR ที่ถูกจำกัดสาขา ส่งข้ามสาขาไม่ได้
  const scope: string[] = caller.branch_codes || [];
  if (!scope.includes('*') && !scope.includes(branch) && caller.role !== 'admin') {
    return json({ error: `ไม่มีสิทธิ์สาขา ${branch}` }, 403);
  }

  // ---- รอบต้องอนุมัติแล้ว ----
  const { data: period } = await admin.schema('fee').from('period')
    .select('pid, status, snapshot, ym, branch').eq('pid', pid).maybeSingle();
  if (!period) return json({ error: 'ยังไม่มีข้อมูลของรอบนี้' }, 400);
  if (!['APPROVED', 'PAID'].includes(period.status)) {
    return json({ error: `ส่งเมลได้เฉพาะรอบที่อนุมัติแล้ว (ตอนนี้ ${period.status})` }, 400);
  }

  const lines: Record<string, { gross: number; tax: number; net: number }> = {};
  for (const l of (period.snapshot?.lines || [])) {
    lines[String(l.licNo)] = { gross: +l.gross || 0, tax: +l.tax || 0, net: +l.net || 0 };
  }

  const { data: docs } = await admin.schema('fee').from('doctor')
    .select('lic_no, full_name, nick_name, contact, email').in('lic_no', lics);

  const { data: branchRow } = await admin.from('branches')
    .select('name_th').eq('code', branch).maybeSingle();
  const branchTh = branchRow?.name_th || branch;
  const monthTh = ymThai(ym);

  const results: { licNo: string; ok: boolean; error?: string }[] = [];

  for (const d of (docs || [])) {
    // ทะเบียนมีช่อง email แยกแล้ว แต่ข้อมูลเก่าบางแถวยังเก็บอีเมลไว้ในช่องติดต่อ
    const email = String(d.email || d.contact || '').trim().toLowerCase();
    const licNo = String(d.lic_no);
    const amt = lines[licNo];

    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
      results.push({ licNo, ok: false, error: 'ไม่มีอีเมลในทะเบียน' });
      continue;
    }
    if (!amt) {
      results.push({ licNo, ok: false, error: 'ไม่พบยอดของแพทย์ในรอบที่อนุมัติ' });
      continue;
    }

    let subject: string;
    let html: string;

    if (action === 'sign_invite') {
      // token สุ่ม 32 ไบต์ — เก็บเฉพาะ hash ลงฐานข้อมูล ตัวจริงอยู่ในอีเมลเท่านั้น
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const plain = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');

      const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const { error: tErr } = await admin.schema('fee').from('doctor_token').insert({
        token_hash: hash, pid, lic_no: licNo, purpose: 'SIGN',
        expires_at: expires, created_by: sentBy,
      });
      if (tErr) { results.push({ licNo, ok: false, error: `สร้างลิงก์ไม่สำเร็จ: ${tErr.message}` }); continue; }

      const link = `${appUrl}/sign/${plain}`;
      subject = `ขอความอนุเคราะห์เซ็นรับรองรายได้ ${monthTh} · ${branchTh}`;
      html = shell('เซ็นรับรองรายได้ประจำเดือน', `
        <p style="margin:0 0 6px;">เรียน ${esc(d.full_name)}</p>
        <p style="margin:0;color:#5B6154;line-height:1.7;">
          ยอดค่าตอบแทนประจำเดือน <b>${esc(monthTh)}</b> สาขา<b>${esc(branchTh)}</b>
          ได้รับการอนุมัติเรียบร้อยแล้ว ขอความอนุเคราะห์อาจารย์ตรวจสอบยอดด้านล่าง
          แล้วกดปุ่มเพื่อเซ็นรับรองครับ
        </p>
        ${amountTable(amt.gross, amt.tax, amt.net)}
        <div style="text-align:center;margin:22px 0 8px;">
          <a href="${esc(link)}" style="display:inline-block;background:${SAGE};color:#fff;
             text-decoration:none;padding:13px 30px;border-radius:9px;font-weight:600;">
            ตรวจสอบและเซ็นรับรอง
          </a>
        </div>
        <p style="color:#8A8F80;font-size:.8rem;text-align:center;margin:0;">
          ลิงก์นี้ใช้ได้เฉพาะอาจารย์ท่านเดียว และมีอายุ 14 วัน · กรุณาอย่าส่งต่อให้ผู้อื่น
        </p>`);
    } else {
      subject = `รายละเอียดการหักภาษี ณ ที่จ่าย ${monthTh} · ${branchTh}`;
      html = shell('รายละเอียดการหักภาษี ณ ที่จ่าย', `
        <p style="margin:0 0 6px;">เรียน ${esc(d.full_name)}</p>
        <p style="margin:0;color:#5B6154;line-height:1.7;">
          สรุปการหักภาษี ณ ที่จ่ายสำหรับค่าตอบแทนประจำเดือน <b>${esc(monthTh)}</b>
          สาขา<b>${esc(branchTh)}</b> ดังนี้ครับ
        </p>
        ${amountTable(amt.gross, amt.tax, amt.net)}
        <p style="color:#5B6154;font-size:.9rem;line-height:1.7;margin:0;">
          ภาษีหัก ณ ที่จ่ายคำนวณในอัตรา 3% ของเงินได้ · หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)
          ฝ่ายบัญชีจะจัดส่งให้ตามรอบ หากมีข้อสงสัยกรุณาติดต่อฝ่ายบุคคลได้เลยครับ
        </p>`);
    }

    // ---- ยิงเข้า Resend ----
    let ok = false; let providerId = ''; let errMsg = '';
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [email], subject, html }),
      });
      const jr = await r.json().catch(() => ({}));
      ok = r.ok;
      providerId = jr?.id || '';
      if (!ok) errMsg = jr?.message || jr?.error?.message || `HTTP ${r.status}`;
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }

    await admin.schema('fee').from('email_log').insert({
      pid, lic_no: licNo,
      kind: action === 'sign_invite' ? 'SIGN_INVITE' : 'TAX_DETAIL',
      to_email: email, subject, status: ok ? 'SENT' : 'FAILED',
      provider_id: providerId, error: errMsg || null, sent_by: sentBy,
    });

    results.push({ licNo, ok, error: errMsg || undefined });
  }

  const sent = results.filter((r) => r.ok).length;
  await admin.schema('fee').from('audit').insert({
    actor: sentBy, action: action === 'sign_invite' ? 'MAIL_SIGN_INVITE' : 'MAIL_TAX_DETAIL',
    target: pid, detail: `ส่งสำเร็จ ${sent}/${results.length} ฉบับ`,
  });

  return json({ ok: true, sent, total: results.length, results });
});
