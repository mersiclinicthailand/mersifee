-- ============================================================================
-- fee_roster_set — เพิ่ม / แก้ / ลบ เวรทีละช่อง จากหน้าปฏิทินตารางแพทย์
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run
--          (ต้องรัน roster.sql ไปก่อนแล้ว — ไฟล์นี้เพิ่มเฉพาะฟังก์ชันแก้ไข)
--
-- p_label ว่าง = ลบเวรของวันนั้น (เท่ากับ "ไม่มีแพทย์")
-- ถ้าไม่ส่ง p_lic มา ระบบจับคู่ชื่อเป็นเลข ว. ให้เองแบบเดียวกับตอนนำเข้าไฟล์
-- ============================================================================

create or replace function public.fee_roster_set(
  p_branch text,
  p_date   date,
  p_label  text default null,
  p_lic    text default null
)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_role text;
  v_user text;
  v_ym   text;
  v_lic  text;
  v_pool text;
  v_key  text;
  v_am   text;
begin
  -- ด่านสิทธิ์เดียวกับการนำเข้าไฟล์
  select s.role into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null then
    raise exception 'บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งานระบบค่าตอบแทนแพทย์';
  end if;
  if v_role not in ('admin', 'hr', 'acct', 'it') then
    raise exception 'บทบาทนี้ไม่มีสิทธิ์แก้ตารางแพทย์ (ต้องเป็นผู้ดูแลระบบ ฝ่ายบุคคล หรือฝ่ายบัญชี)';
  end if;

  if p_branch is null or p_date is null then
    raise exception 'ต้องระบุสาขาและวันที่';
  end if;
  if not exists (select 1 from fee.branch b where b.code = p_branch) then
    raise exception 'ไม่รู้จักรหัสสาขา %', p_branch;
  end if;

  select coalesce(p.username, '') into v_user
  from public.profiles p where p.id = auth.uid();
  v_ym := to_char(p_date, 'YYYY-MM');

  -- ว่าง = ไม่มีแพทย์วันนั้น → ลบแถวทิ้ง
  if coalesce(btrim(p_label), '') = '' then
    delete from fee.roster r where r.branch = p_branch and r.work_date = p_date;
    return jsonb_build_object('cleared', true, 'ym', v_ym);
  end if;

  v_key := fee.strip_title(p_label);

  if coalesce(btrim(p_lic), '') <> '' then
    v_lic := btrim(p_lic);                       -- เลือกจากทะเบียนแพทย์มาแล้ว
  else
    select coalesce(
      (select d.lic_no from fee.doctor d
        where d.nick_name = v_key order by d.lic_no limit 1),
      (select d.lic_no from fee.doctor d
        where split_part(fee.strip_title(d.full_name), ' ', 1) = v_key
        order by d.lic_no limit 1),
      (select a.lic_no from fee.alias a
        where fee.strip_title(a.alias) = v_key order by a.lic_no limit 1)
    ) into v_lic;
  end if;

  if v_lic is null then
    select coalesce(
      (select dp.lic_no from fee.doctor_pool dp
        where dp.nick_name = v_key order by dp.lic_no limit 1),
      (select dp.lic_no from fee.doctor_pool dp
        where split_part(fee.strip_title(dp.full_name), ' ', 1) = v_key
        order by dp.lic_no limit 1)
    ) into v_pool;
  end if;

  -- กลุ่ม Area Manager ใช้ของสาขาเดิมในเดือนนั้น ถ้ามี
  select r.am_group into v_am
  from fee.roster r where r.branch = p_branch and r.ym = v_ym limit 1;

  insert into fee.roster (ym, branch, work_date, doc_label, lic_no, pool_lic,
                          am_group, updated_by, updated_at)
  values (v_ym, p_branch, p_date, btrim(p_label), v_lic, v_pool,
          coalesce(v_am, ''), v_user, now())
  on conflict (branch, work_date) do update
    set ym = excluded.ym, doc_label = excluded.doc_label,
        lic_no = excluded.lic_no, pool_lic = excluded.pool_lic,
        updated_by = excluded.updated_by, updated_at = now();

  return jsonb_build_object('cleared', false, 'ym', v_ym,
                            'licNo', coalesce(v_lic, ''), 'poolLic', coalesce(v_pool, ''));
end
$fn$;

revoke all on function public.fee_roster_set(text, date, text, text) from public, anon;
grant execute on function public.fee_roster_set(text, date, text, text) to authenticated;
