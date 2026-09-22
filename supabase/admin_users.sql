-- ============================================================================
-- fee_admin_user_* — ตัวช่วยจัดการบัญชีผู้ใช้ ฝั่งฐานข้อมูล
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run
--
-- ทำไมต้องมีไฟล์นี้:
--   Edge Function เดิมอ่านตาราง fee.staff ด้วยกุญแจ service role แล้ว "อ่านไม่เห็นแถว"
--   (ตารางเปิด FORCE ROW LEVEL SECURITY ไว้ — service role จึงถูกกรองด้วย policy เหมือนคนทั่วไป)
--   ผลคือระบบเข้าใจว่าคนกดไม่ใช่ผู้ดูแลระบบ แล้วตีตกทุกคำสั่ง
--
--   ย้ายงานอ่าน/เขียนตารางมาไว้ในฟังก์ชัน security definer แทน ซึ่งรันด้วยสิทธิ์เจ้าของฐานข้อมูล
--   ตรวจสิทธิ์จาก auth.uid() ของ token ที่ส่งมาโดยตรง — ปลอดภัยกว่าและไม่ติด RLS
-- ============================================================================

/* บทบาทของคนที่กำลังเรียก (ใช้ตรวจสิทธิ์ก่อนทำอะไร) */
create or replace function public.fee_admin_role()
returns text
language sql stable security definer
set search_path to ''
as $fn$
  select s.role from fee.staff s where s.id = auth.uid()
$fn$;

/* ผูกบัญชี auth เข้ากับโปรไฟล์ + สิทธิ์ในระบบค่าตอบแทน (ใช้ทั้งตอนสร้างใหม่และแก้ไข) */
create or replace function public.fee_admin_user_link(
  p_id       uuid,
  p_username text,
  p_display  text,
  p_role     text,
  p_branches text[],
  p_lic      text
)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare v_role text;
begin
  select s.role into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null or v_role not in ('it', 'admin') then
    raise exception 'เฉพาะผู้ดูแลระบบ (IT) เท่านั้นที่จัดการบัญชีผู้ใช้ได้';
  end if;

  insert into public.profiles (id, username, display_name, active)
  values (p_id, lower(btrim(p_username)),
          coalesce(nullif(btrim(p_display), ''), lower(btrim(p_username))), true)
  on conflict (id) do update
    set username = excluded.username, display_name = excluded.display_name, active = true;

  -- fee.staff.role เป็นชนิด enum (fee.fee_role) ไม่ใช่ text จึงต้อง cast
  -- ตรวจชื่อบทบาทก่อน จะได้ขึ้นข้อความที่อ่านรู้เรื่องแทน error ของ Postgres
  if not exists (
    select 1 from pg_catalog.pg_enum e
      join pg_catalog.pg_type t on t.oid = e.enumtypid
     where t.typname = 'fee_role' and e.enumlabel = p_role
  ) then
    raise exception 'ไม่รู้จักบทบาท % (ค่าที่ใช้ได้: %)', p_role,
      (select string_agg(e.enumlabel, ', ' order by e.enumsortorder)
         from pg_catalog.pg_enum e join pg_catalog.pg_type t on t.oid = e.enumtypid
        where t.typname = 'fee_role');
  end if;

  insert into fee.staff (id, role, branch_codes, lic_no, active, tabs)
  values (p_id, p_role::fee.fee_role,
          coalesce(nullif(p_branches, '{}'), array['*']),
          nullif(btrim(p_lic), ''), true, null)
  on conflict (id) do update
    set role = excluded.role, branch_codes = excluded.branch_codes,
        lic_no = excluded.lic_no, active = true;

  return jsonb_build_object('ok', true, 'id', p_id);
end
$fn$;

/* ถอดบัญชีออกจากระบบ — ลบแถวสิทธิ์และโปรไฟล์ (ตัว auth user ลบที่ Edge Function) */
create or replace function public.fee_admin_user_unlink(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare v_role text; v_target text; v_admins int;
begin
  select s.role into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null or v_role not in ('it', 'admin') then
    raise exception 'เฉพาะผู้ดูแลระบบ (IT) เท่านั้นที่จัดการบัญชีผู้ใช้ได้';
  end if;
  if p_id = auth.uid() then
    raise exception 'ลบบัญชีตัวเองไม่ได้';
  end if;

  select s.role into v_target from fee.staff s where s.id = p_id;
  if v_target in ('it', 'admin') then
    select count(*) into v_admins from fee.staff s
      where s.role in ('it', 'admin') and s.active;
    if v_admins <= 1 then
      raise exception 'เหลือผู้ดูแลระบบคนสุดท้ายแล้ว ลบไม่ได้ — สร้างผู้ดูแลคนใหม่ก่อน';
    end if;
  end if;

  delete from fee.staff s where s.id = p_id;
  delete from public.profiles p where p.id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end
$fn$;

/* ชื่อผู้ใช้ซ้ำหรือไม่ (เช็คก่อนสร้าง จะได้ไม่ไปสร้างบัญชี auth ทิ้งไว้เปล่า ๆ) */
create or replace function public.fee_admin_username_taken(p_username text)
returns boolean
language sql stable security definer
set search_path to ''
as $fn$
  select exists (select 1 from public.profiles p
                 where p.username = lower(btrim(p_username)))
$fn$;


/* เก็บกวาดบัญชี auth ที่ค้าง — เกิดได้ถ้าสร้างบัญชีแล้วขั้นตอนผูกสิทธิ์ล้มกลางคัน
   ลบเฉพาะบัญชีที่ "ไม่มีโปรไฟล์" เท่านั้น คือบัญชีที่ยังไม่เคยถูกใช้งานจริง */
create or replace function public.fee_admin_fix_orphan(p_username text)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare v_role text; v_n int;
begin
  select s.role into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null or v_role not in ('it', 'admin') then
    raise exception 'เฉพาะผู้ดูแลระบบ (IT) เท่านั้นที่จัดการบัญชีผู้ใช้ได้';
  end if;

  with dead as (
    delete from auth.users u
     where u.email = lower(btrim(p_username)) || '@mersi.local'
       and not exists (select 1 from public.profiles p where p.id = u.id)
    returning 1
  )
  select count(*) into v_n from dead;

  return jsonb_build_object('ok', true, 'removed', v_n);
end
$fn$;

revoke all on function public.fee_admin_fix_orphan(text) from public, anon;
grant execute on function public.fee_admin_fix_orphan(text) to authenticated;

/* ---------------------------------------------------------------- สิทธิ์ -- */
revoke all on function public.fee_admin_role()                                   from public, anon;
revoke all on function public.fee_admin_user_link(uuid, text, text, text, text[], text) from public, anon;
revoke all on function public.fee_admin_user_unlink(uuid)                        from public, anon;
revoke all on function public.fee_admin_username_taken(text)                     from public, anon;

grant execute on function public.fee_admin_role()                                   to authenticated;
grant execute on function public.fee_admin_user_link(uuid, text, text, text, text[], text) to authenticated;
grant execute on function public.fee_admin_user_unlink(uuid)                        to authenticated;
grant execute on function public.fee_admin_username_taken(text)                     to authenticated;

-- ตรวจอย่างเร็วหลังรัน: ต้องได้ค่า admin หรือ it (บัญชีที่กำลังล็อกอินใน SQL Editor คือ postgres
-- จึงอาจได้ null — ให้ไปทดสอบจากหน้าเว็บแทน)
-- select public.fee_admin_role();
