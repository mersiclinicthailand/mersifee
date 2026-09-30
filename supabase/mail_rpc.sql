-- ============================================================================
-- mail_rpc.sql — ฟังก์ชันฐานข้อมูลสำหรับ Edge Function "fee-send-email"
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run
--          รันซ้ำได้ ไม่ทำข้อมูลหาย (create or replace ทั้งหมด ไม่สร้างตาราง)
--
-- ทำไมต้องมีไฟล์นี้ (ปัญหาเดียวกับตอนสร้างผู้ใช้ไม่ได้):
--   Edge Function ส่งเมลเดิมอ่านตาราง fee.staff / fee.period / fee.doctor ด้วยกุญแจ service role
--   แต่ตารางในสคีมา fee เปิด FORCE ROW LEVEL SECURITY ไว้ → อ่านไม่เห็นแถว
--   ผลคือกดส่งเมลแล้วโดนตีกลับว่า "เฉพาะฝ่าย HR หรือผู้ดูแลระบบ" แม้จะเป็น HR จริง
--
--   ย้ายงานอ่าน/เขียนตารางทั้งหมดมาไว้ในฟังก์ชัน security definer ด้านล่าง
--   ตรวจสิทธิ์จาก auth.uid() ของคนที่กดส่งโดยตรง
--
-- สิทธิ์ส่งเมลแต่ละแบบ
--   sign_invite (เชิญเซ็นรับรองรายได้)      : admin · hr
--   tax_detail  (สรุปยอดหักภาษี)            : admin · hr · acct
--   wht_cert    (หนังสือรับรองหัก ณ ที่จ่าย) : admin · hr · acct
-- ============================================================================

/* --------------------------------------------- 1) เตรียมข้อมูลก่อนส่ง -- */
-- ตรวจสิทธิ์ + ตรวจว่ารอบอนุมัติแล้ว + คืนรายชื่อ/อีเมล/ยอดของแพทย์ที่เลือก

create or replace function public.fee_mail_prepare(
  p_action text,
  p_branch text,
  p_ym     text,
  p_lics   text[]
)
returns jsonb
language plpgsql stable security definer
set search_path to ''
as $fn$
declare
  v_role   text;
  v_scope  text[];
  v_user   text;
  v_pid    text;
  v_status text;
  v_snap   jsonb;
  v_brTh   text;
  v_rows   jsonb;
begin
  select s.role::text, s.branch_codes into v_role, v_scope
  from fee.staff s where s.id = auth.uid();

  if v_role is null then
    raise exception 'บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งานระบบค่าตอบแทนแพทย์';
  end if;
  if p_action = 'sign_invite' and v_role not in ('admin', 'hr') then
    raise exception 'เมลเชิญเซ็นรับรองรายได้ ส่งได้เฉพาะฝ่ายบุคคลหรือผู้ดูแลระบบ';
  end if;
  if p_action in ('tax_detail', 'wht_cert') and v_role not in ('admin', 'hr', 'acct') then
    raise exception 'เมลเรื่องภาษีหัก ณ ที่จ่าย ส่งได้เฉพาะฝ่ายบัญชี ฝ่ายบุคคล หรือผู้ดูแลระบบ';
  end if;
  if p_action not in ('sign_invite', 'tax_detail', 'wht_cert') then
    raise exception 'คำสั่งไม่รู้จัก: %', p_action;
  end if;
  if v_role <> 'admin' and not ('*' = any(coalesce(v_scope, '{}'))
                                or p_branch = any(coalesce(v_scope, '{}'))) then
    raise exception 'ไม่มีสิทธิ์สาขา %', p_branch;
  end if;
  if coalesce(array_length(p_lics, 1), 0) = 0 then
    raise exception 'ยังไม่ได้เลือกแพทย์';
  end if;

  v_pid := p_branch || '-' || replace(p_ym, '-', '');
  select p.status::text, p.snapshot into v_status, v_snap
  from fee.period p where p.pid = v_pid;

  if v_status is null then
    raise exception 'ยังไม่มีข้อมูลของรอบ %', v_pid;
  end if;
  if v_status not in ('APPROVED', 'PAID') then
    raise exception 'ส่งเมลได้เฉพาะรอบที่อนุมัติแล้ว (ตอนนี้ %)', v_status;
  end if;

  select coalesce(p.username, '') into v_user
  from public.profiles p where p.id = auth.uid();

  select b.name_th into v_brTh from public.branches b where b.code = p_branch;

  -- ยอดดึงจาก snapshot ที่ล็อกไว้ตอนอนุมัติ จึงตรงกับเอกสารที่อนุมัติเสมอ
  select coalesce(jsonb_agg(jsonb_build_object(
           'licNo', d.lic_no,
           'name',  d.full_name,
           'nick',  coalesce(d.nick_name, ''),
           -- ทะเบียนมีช่อง email แยกแล้ว แต่ข้อมูลเก่าบางแถวยังเก็บอีเมลไว้ในช่องติดต่อ
           'email', lower(btrim(coalesce(nullif(btrim(d.email), ''),
                                         case when d.contact like '%@%' then d.contact end, ''))),
           'gross', coalesce((l.v->>'gross')::numeric, 0),
           'tax',   coalesce((l.v->>'tax')::numeric, 0),
           'net',   coalesce((l.v->>'net')::numeric, 0),
           'inRound', l.v is not null,
           -- รายละเอียดทั้งหมดที่ล็อกไว้ตอนอนุมัติ (ใบเวรรายวัน + รายการค่ามือ) — รอบที่อนุมัติก่อนอัปเดตจะไม่มี
           'detail', case when (l.v ? 'days') then l.v else null end)
         order by d.lic_no), '[]'::jsonb)
    into v_rows
  from fee.doctor d
  left join lateral (
    select x as v
    from jsonb_array_elements(coalesce(v_snap->'lines', '[]'::jsonb)) x
    where x->>'licNo' = d.lic_no
    limit 1
  ) l on true
  where d.lic_no = any(p_lics);

  return jsonb_build_object(
    'pid', v_pid, 'status', v_status, 'sentBy', coalesce(nullif(v_user, ''), auth.uid()::text),
    'branchTh', coalesce(v_brTh, p_branch), 'rows', v_rows);
end
$fn$;

/* ------------------------------------ 2) ลิงก์เซ็นรับรอง (เก็บเฉพาะ hash) -- */

create or replace function public.fee_mail_token(
  p_pid text, p_lic text, p_hash text, p_expires timestamptz
)
returns void
language plpgsql security definer
set search_path to ''
as $fn$
declare v_role text; v_user text;
begin
  select s.role::text into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null or v_role not in ('admin', 'hr') then
    raise exception 'ไม่มีสิทธิ์สร้างลิงก์เซ็นรับรอง';
  end if;
  select coalesce(p.username, auth.uid()::text) into v_user
  from public.profiles p where p.id = auth.uid();

  insert into fee.doctor_token (token_hash, pid, lic_no, purpose, expires_at, created_by)
  values (p_hash, p_pid, p_lic, 'SIGN', p_expires, coalesce(v_user, auth.uid()::text));
end
$fn$;

/* --------------------------------------------- 3) บันทึกผลการส่งเมล -- */
-- p_rows = [{ licNo, toEmail, subject, ok, providerId, error }, ...]
-- wht_cert บันทึกเป็นชนิด TAX_DETAIL (เรื่องภาษีเหมือนกัน) — หัวเรื่องบอกว่าเป็น 50 ทวิ

create or replace function public.fee_mail_record(
  p_pid text, p_action text, p_rows jsonb
)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_role text; v_user text; v_kind text; v_ok int; v_all int;
begin
  select s.role::text into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null or v_role not in ('admin', 'hr', 'acct') then
    raise exception 'ไม่มีสิทธิ์บันทึกผลการส่งเมล';
  end if;
  select coalesce(p.username, auth.uid()::text) into v_user
  from public.profiles p where p.id = auth.uid();
  v_user := coalesce(v_user, auth.uid()::text);
  v_kind := case p_action when 'sign_invite' then 'SIGN_INVITE' else 'TAX_DETAIL' end;

  insert into fee.email_log (pid, lic_no, kind, to_email, subject, status,
                             provider_id, error, sent_by)
  select p_pid, x->>'licNo', v_kind, coalesce(x->>'toEmail', ''), coalesce(x->>'subject', ''),
         case when (x->>'ok')::boolean then 'SENT' else 'FAILED' end,
         coalesce(x->>'providerId', ''), nullif(x->>'error', ''), v_user
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
  where coalesce(x->>'toEmail', '') <> '';

  select count(*) filter (where (x->>'ok')::boolean), count(*)
    into v_ok, v_all
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x;

  insert into fee.audit (actor, action, target, detail)
  values (v_user,
          case p_action when 'sign_invite' then 'MAIL_SIGN_INVITE'
                        when 'wht_cert'    then 'MAIL_WHT_CERT'
                        else 'MAIL_TAX_DETAIL' end,
          p_pid, format('ส่งสำเร็จ %s/%s ฉบับ', v_ok, v_all));

  return jsonb_build_object('sent', v_ok, 'total', v_all);
end
$fn$;

/* ---------------------------------------------------------------- สิทธิ์ -- */

revoke all on function public.fee_mail_prepare(text, text, text, text[])      from public, anon;
revoke all on function public.fee_mail_token(text, text, text, timestamptz)   from public, anon;
revoke all on function public.fee_mail_record(text, text, jsonb)              from public, anon;
grant execute on function public.fee_mail_prepare(text, text, text, text[])    to authenticated;
grant execute on function public.fee_mail_token(text, text, text, timestamptz) to authenticated;
grant execute on function public.fee_mail_record(text, text, jsonb)            to authenticated;

/* ------------------------- 4) รายละเอียดสำหรับหน้าเซ็นของแพทย์ -------------------------
 * เปิดจากลิงก์ในอีเมล (ไม่ต้องล็อกอิน) — ตรวจ token แบบเดียวกับ fee_sign_open
 * คืนเฉพาะบรรทัดของแพทย์เจ้าของลิงก์ จาก snapshot ที่ล็อกไว้ตอนอนุมัติ
 * ------------------------------------------------------------------------------------ */
create or replace function public.fee_sign_detail(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path to ''
as $fn$
declare
  v_hash text := encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  v_pid  text; v_lic text; v_line jsonb;
begin
  select t.pid, t.lic_no into v_pid, v_lic
  from fee.doctor_token t
  where t.token_hash = v_hash and t.expires_at > now()
  order by t.expires_at desc limit 1;
  if v_pid is null then
    raise exception 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว';
  end if;

  select x into v_line
  from fee.period p, jsonb_array_elements(coalesce(p.snapshot->'lines', '[]'::jsonb)) x
  where p.pid = v_pid and x->>'licNo' = v_lic
  limit 1;

  if v_line is null or not (v_line ? 'days') then
    return null;                                   -- รอบที่อนุมัติก่อนมีรายละเอียด
  end if;
  return v_line - 'bankAcc' || jsonb_build_object(
    'bankAcc', regexp_replace(coalesce(v_line->>'bankAcc', ''), '.(?=.{4})', 'x', 'g'));
end
$fn$;

revoke all on function public.fee_sign_detail(text) from public;
grant execute on function public.fee_sign_detail(text) to anon, authenticated;
