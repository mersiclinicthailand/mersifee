// fee-send-email — ส่งอีเมลหาแพทย์ผ่าน Resend
//   sign_invite : เชิญแพทย์กดลิงก์เซ็นรับรองรายได้ (ลิงก์มีอายุ 14 วัน)      — admin · hr
//   tax_detail  : สรุปยอดหักภาษี ณ ที่จ่ายของเดือน                          — admin · hr · acct
//   wht_cert    : ส่งหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) แนบ PDF     — admin · hr · acct
//
// ส่งได้เฉพาะรอบที่อนุมัติแล้ว · ต้องตั้ง secret: RESEND_API_KEY, FEE_MAIL_FROM, FEE_APP_URL
//
// หมายเหตุสำคัญ: ตารางในสคีมา fee เปิด FORCE ROW LEVEL SECURITY
//   กุญแจ service role จึง "อ่านไม่เห็นแถว" — ทุกงานที่แตะตารางต้องผ่าน RPC
//   (fee_mail_prepare / fee_mail_token / fee_mail_record ใน supabase/mail_rpc.sql)
//   ที่เรียกด้วย token ของคนที่กดส่ง ระบบจะตรวจสิทธิ์จาก auth.uid() ของคนนั้นเอง
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

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('FEE_MAIL_FROM') || 'Mersi Clinic <onboarding@resend.dev>';
  const appUrl = (Deno.env.get('FEE_APP_URL') || '').replace(/\/+$/, '');
  if (!apiKey) {
    return json({ error: 'ยังไม่ได้ตั้งค่า RESEND_API_KEY ที่ Supabase — ตั้งก่อนจึงจะส่งเมลได้' }, 400);
  }

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'ไม่ได้ล็อกอิน' }, 401);

  // client ที่ "เป็นตัวคนกด" — RPC จะเห็น auth.uid() ของคนนั้น แล้วตรวจสิทธิ์เอง
  const asUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { auth: { persistSession: false }, global: { headers: { Authorization: auth } } },
  );

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const branch = String(body.branch || '');
  const ym = String(body.ym || '');
  const lics: string[] = Array.isArray(body.licNos) ? body.licNos.map(String) : [];
  // wht_cert: { [licNo]: { filename, content(base64) } } — แนบได้คนละ 1 ไฟล์
  const files: Record<string, { filename: string; content: string }> =
    body.attachments && typeof body.attachments === 'object' ? body.attachments : {};
  const note = String(body.note || '').slice(0, 1000);

  if (!branch || !ym) return json({ error: 'ต้องระบุสาขาและเดือน' }, 400);
  if (!lics.length) return json({ error: 'ยังไม่ได้เลือกแพทย์' }, 400);

  const { data: ctx, error: pErr } = await asUser.rpc('fee_mail_prepare', {
    p_action: action, p_branch: branch, p_ym: ym, p_lics: lics,
  });
  if (pErr) return json({ error: pErr.message }, 403);

  const pid: string = ctx.pid;
  const branchTh: string = ctx.branchTh;
  const monthTh = ymThai(ym);
  const results: { licNo: string; ok: boolean; error?: string }[] = [];
  const log: Record<string, unknown>[] = [];

  for (const d of (ctx.rows || []) as {
    licNo: string; name: string; email: string; gross: number; tax: number; net: number; inRound: boolean;
  }[]) {
    const licNo = String(d.licNo);
    const email = String(d.email || '');

    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
      results.push({ licNo, ok: false, error: 'ไม่มีอีเมลในทะเบียน' });
      continue;
    }
    if (!d.inRound) {
      results.push({ licNo, ok: false, error: 'ไม่พบยอดของแพทย์ในรอบที่อนุมัติ' });
      continue;
    }

    let subject: string;
    let html: string;
    const attachments: { filename: string; content: string }[] = [];

    if (action === 'sign_invite') {
      // token สุ่ม 32 ไบต์ — เก็บเฉพาะ hash ลงฐานข้อมูล ตัวจริงอยู่ในอีเมลเท่านั้น
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const plain = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();

      const { error: tErr } = await asUser.rpc('fee_mail_token', {
        p_pid: pid, p_lic: licNo, p_hash: hash, p_expires: expires,
      });
      if (tErr) { results.push({ licNo, ok: false, error: `สร้างลิงก์ไม่สำเร็จ: ${tErr.message}` }); continue; }

      const link = `${appUrl}/sign/${plain}`;
      subject = `ขอความอนุเคราะห์เซ็นรับรองรายได้ ${monthTh} · ${branchTh}`;
      html = shell('เซ็นรับรองรายได้ประจำเดือน', `
        <p style="margin:0 0 6px;">เรียน ${esc(d.name)}</p>
        <p style="margin:0;color:#5B6154;line-height:1.7;">
          ยอดค่าตอบแทนประจำเดือน <b>${esc(monthTh)}</b> สาขา<b>${esc(branchTh)}</b>
          ได้รับการอนุมัติเรียบร้อยแล้ว ขอความอนุเคราะห์อาจารย์ตรวจสอบยอดด้านล่าง
          แล้วกดปุ่มเพื่อเซ็นรับรองครับ
        </p>
        ${amountTable(d.gross, d.tax, d.net)}
        <div style="text-align:center;margin:22px 0 8px;">
          <a href="${esc(link)}" style="display:inline-block;background:${SAGE};color:#fff;
             text-decoration:none;padding:13px 30px;border-radius:9px;font-weight:600;">
            ตรวจสอบและเซ็นรับรอง
          </a>
        </div>
        <p style="color:#8A8F80;font-size:.8rem;text-align:center;margin:0;">
          ลิงก์นี้ใช้ได้เฉพาะอาจารย์ท่านเดียว และมีอายุ 14 วัน · กรุณาอย่าส่งต่อให้ผู้อื่น
        </p>`);
    } else if (action === 'wht_cert') {
      const f = files[licNo];
      if (!f || !f.content) {
        results.push({ licNo, ok: false, error: 'ยังไม่ได้แนบไฟล์ 50 ทวิ ของแพทย์คนนี้' });
        continue;
      }
      // Resend รับไฟล์แนบรวมไม่เกิน 40MB — จำกัดไว้ที่ 8MB ต่อไฟล์ก็เหลือเฟือสำหรับ PDF
      if (f.content.length > 8 * 1024 * 1024 * 1.37) {
        results.push({ licNo, ok: false, error: 'ไฟล์ใหญ่เกิน 8MB' });
        continue;
      }
      const fname = String(f.filename || `50ทวิ_${licNo}_${ym}.pdf`).replace(/[\\/:*?"<>|]+/g, '_');
      attachments.push({ filename: fname, content: f.content });
      subject = `หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ${monthTh} · ${branchTh}`;
      html = shell('หนังสือรับรองการหักภาษี ณ ที่จ่าย', `
        <p style="margin:0 0 6px;">เรียน ${esc(d.name)}</p>
        <p style="margin:0;color:#5B6154;line-height:1.7;">
          ฝ่ายบัญชีขอส่ง <b>หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)</b>
          สำหรับค่าตอบแทนประจำเดือน <b>${esc(monthTh)}</b> สาขา<b>${esc(branchTh)}</b>
          ตามไฟล์แนบครับ
        </p>
        ${amountTable(d.gross, d.tax, d.net)}
        ${note ? `<p style="color:#5B6154;font-size:.9rem;line-height:1.7;margin:0 0 10px;">${esc(note)}</p>` : ''}
        <p style="color:#8A8F80;font-size:.82rem;line-height:1.7;margin:0;">
          ไฟล์แนบ: ${esc(fname)} · กรุณาเก็บไว้ใช้ยื่นแบบภาษีเงินได้บุคคลธรรมดาประจำปี
          หากยอดไม่ตรงกับที่ได้รับ กรุณาติดต่อฝ่ายบัญชีครับ
        </p>`);
    } else {
      subject = `รายละเอียดการหักภาษี ณ ที่จ่าย ${monthTh} · ${branchTh}`;
      html = shell('รายละเอียดการหักภาษี ณ ที่จ่าย', `
        <p style="margin:0 0 6px;">เรียน ${esc(d.name)}</p>
        <p style="margin:0;color:#5B6154;line-height:1.7;">
          สรุปการหักภาษี ณ ที่จ่ายสำหรับค่าตอบแทนประจำเดือน <b>${esc(monthTh)}</b>
          สาขา<b>${esc(branchTh)}</b> ดังนี้ครับ
        </p>
        ${amountTable(d.gross, d.tax, d.net)}
        ${note ? `<p style="color:#5B6154;font-size:.9rem;line-height:1.7;margin:0 0 10px;">${esc(note)}</p>` : ''}
        <p style="color:#5B6154;font-size:.9rem;line-height:1.7;margin:0;">
          หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ฝ่ายบัญชีจะจัดส่งให้ตามรอบ
          หากมีข้อสงสัยกรุณาติดต่อฝ่ายบัญชีได้เลยครับ
        </p>`);
    }

    // ---- ยิงเข้า Resend ----
    let ok = false; let providerId = ''; let errMsg = '';
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: [email], subject, html,
          ...(attachments.length ? { attachments } : {}),
        }),
      });
      const jr = await r.json().catch(() => ({}));
      ok = r.ok;
      providerId = jr?.id || '';
      if (!ok) errMsg = jr?.message || jr?.error?.message || `HTTP ${r.status}`;
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }

    log.push({ licNo, toEmail: email, subject, ok, providerId, error: errMsg || '' });
    results.push({ licNo, ok, error: errMsg || undefined });
  }

  // บันทึกผลลงฐาน — ถ้าบันทึกไม่ได้ เมลก็ส่งไปแล้ว จึงไม่ตีกลับทั้งคำสั่ง แค่แจ้งเตือน
  let logError: string | undefined;
  if (log.length || results.length) {
    const { error: lErr } = await asUser.rpc('fee_mail_record', {
      p_pid: pid, p_action: action, p_rows: log,
    });
    if (lErr) logError = `ส่งเมลแล้ว แต่บันทึกประวัติไม่สำเร็จ: ${lErr.message}`;
  }

  const sent = results.filter((r) => r.ok).length;
  return json({ ok: true, sent, total: results.length, results, logError });
});
