-- ============================================================================
-- clock_sign.sql — ลายเซ็นแพทย์ตอนเข้าเวร / ออกเวร
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run (รันซ้ำได้)
--
-- 1 แถว = ลายเซ็น 1 ครั้ง (เข้า หรือ ออก) ของแพทย์ 1 คน ในวันนั้น
-- ผูกกับ สาขา + เลข ว. + วันที่ + เวลา (ไม่ผูกกับ id ของใบเวร เพราะใบเวรถูกบันทึกใหม่ทั้งรอบได้)
-- ลายเซ็นแก้/ลบไม่ได้ — เซ็นใหม่ = เพิ่มแถวใหม่ (เก็บประวัติครบไว้ตรวจย้อน)
-- ============================================================================

create table if not exists fee.clock_sign (
  id          bigint generated always as identity primary key,
  branch      text        not null,
  lic_no      text        not null,
  work_date   date        not null,
  mode        text        not null check (mode in ('IN', 'OUT')),
  at_time     text        not null,                 -- เวลาที่ลง เช่น 12:00
  png         text        not null,                 -- data:image/png;base64,...
  supervisor  text        not null default '',      -- ผู้ดูแลการลงเวลา
  signed_at   timestamptz not null default now(),   -- เวลาที่เซ็นจริงตามนาฬิกาเซิร์ฟเวอร์
  created_by  text        not null default ''       -- บัญชีที่เปิดหน้าจอ
);
create index if not exists clock_sign_bd on fee.clock_sign (branch, work_date);
create index if not exists clock_sign_ld on fee.clock_sign (lic_no, work_date);

alter table fee.clock_sign enable row level security;   -- ไม่มี policy = เข้าได้ผ่าน RPC ด้านล่างเท่านั้น
revoke all on fee.clock_sign from anon, authenticated;

/* สิทธิ์: ผู้ใช้ที่มีสิทธิ์สาขานั้น (หรือทุกสาขา) · บัญชีแพทย์เซ็นได้เฉพาะของตัวเอง */
create or replace function fee.clock_sign_can(p_branch text, p_lic text)
returns boolean language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from fee.staff s
    where s.id = auth.uid() and coalesce(s.active, true)
      and (
        s.role::text in ('admin', 'it')
        or '*' = any(coalesce(s.branch_codes, '{}'))
        or p_branch = any(coalesce(s.branch_codes, '{}'))
        or (s.role::text = 'doctor' and s.lic_no = p_lic)
      ))
$fn$;

/* บันทึกลายเซ็น */
create or replace function public.fee_clock_sign_add(
  p_branch text, p_lic text, p_date date, p_mode text, p_time text, p_png text, p_supervisor text
)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_user text; v_id bigint;
begin
  if not fee.clock_sign_can(p_branch, p_lic) then
    raise exception 'ไม่มีสิทธิ์บันทึกลายเซ็นของสาขา %', p_branch;
  end if;
  if p_mode not in ('IN', 'OUT') then raise exception 'ชนิดลายเซ็นไม่ถูกต้อง'; end if;
  if coalesce(p_png, '') !~ '^data:image/(png|jpeg);base64,' then raise exception 'ไม่พบลายเซ็น'; end if;
  if length(p_png) > 400000 then raise exception 'ไฟล์ลายเซ็นใหญ่เกินไป'; end if;
  if p_time !~ '^\d{1,2}:\d{2}$' then raise exception 'เวลาไม่ถูกต้อง'; end if;

  select coalesce(p.username, auth.uid()::text) into v_user from public.profiles p where p.id = auth.uid();

  insert into fee.clock_sign (branch, lic_no, work_date, mode, at_time, png, supervisor, created_by)
  values (p_branch, btrim(p_lic), p_date, p_mode, p_time, p_png, coalesce(btrim(p_supervisor), ''),
          coalesce(v_user, auth.uid()::text))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $fn$;

/* รายการลายเซ็นของสาขาในเดือนนั้น (ไม่รวมรูป — โหลดรูปทีละอันตอนกดดู) */
create or replace function public.fee_clock_sign_list(p_branch text, p_ym text)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
begin
  if not fee.clock_sign_can(p_branch, '') then
    raise exception 'ไม่มีสิทธิ์ดูข้อมูลสาขา %', p_branch;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'licNo', c.lic_no, 'workDate', to_char(c.work_date, 'YYYY-MM-DD'),
             'mode', c.mode, 'time', c.at_time, 'supervisor', c.supervisor,
             'signedAt', to_char(c.signed_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI'),
             'by', c.created_by)
           order by c.work_date, c.lic_no, c.signed_at)
    from fee.clock_sign c
    where c.branch = p_branch and to_char(c.work_date, 'YYYY-MM') = p_ym), '[]'::jsonb);
end $fn$;

/* รูปลายเซ็น 1 รายการ */
create or replace function public.fee_clock_sign_png(p_id bigint)
returns text language plpgsql stable security definer set search_path to '' as $fn$
declare v_branch text; v_lic text; v_png text;
begin
  select c.branch, c.lic_no, c.png into v_branch, v_lic, v_png from fee.clock_sign c where c.id = p_id;
  if v_png is null then raise exception 'ไม่พบลายเซ็น'; end if;
  if not fee.clock_sign_can(v_branch, v_lic) then raise exception 'ไม่มีสิทธิ์ดูลายเซ็นนี้'; end if;
  return v_png;
end $fn$;

revoke all on function fee.clock_sign_can(text, text) from public, anon, authenticated;
revoke all on function public.fee_clock_sign_add(text, text, date, text, text, text, text) from public, anon;
revoke all on function public.fee_clock_sign_list(text, text) from public, anon;
revoke all on function public.fee_clock_sign_png(bigint) from public, anon;
grant execute on function public.fee_clock_sign_add(text, text, date, text, text, text, text) to authenticated;
grant execute on function public.fee_clock_sign_list(text, text) to authenticated;
grant execute on function public.fee_clock_sign_png(bigint) to authenticated;
