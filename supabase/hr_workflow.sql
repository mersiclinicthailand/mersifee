-- ============================================================================
-- hr_workflow.sql — ให้ฝ่าย HR ทำขั้นตอนอนุมัติได้ครบทุกขั้นจนจบรอบ
--                   (ส่งตรวจ → อนุมัติ → บันทึกจ่าย) ด้วยบัญชีเดียว
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run (รันซ้ำได้)
--
-- ทำงานอย่างไร
--   ฟังก์ชัน public.fee_workflow ตัวที่ใช้อยู่ ถูกเขียนไว้ตอนตั้งระบบ (ไม่มีต้นฉบับในโปรเจกต์)
--   ไฟล์นี้จึง "อ่านโค้ดตัวจริงจากฐานข้อมูล แล้วแก้เฉพาะจุดตรวจสิทธิ์" ไม่เขียนทับทั้งตัว
--     1) เก็บสำเนาตัวเดิมไว้ชื่อ public.fee_workflow_before_hr (ย้อนกลับได้)
--     2) ทุกจุดที่ตรวจบทบาทด้วย fee.has_role(array[...]) → เติม 'hr' เข้าไป
--     3) จุดที่ห้าม "ผู้อนุมัติเป็นคนเดียวกับผู้ส่งตรวจ" → ยกเว้นให้ hr / admin
--   แล้วแสดงผลว่าแก้ไปกี่จุด — ถ้าขึ้น 0 ทุกช่อง ให้ส่งภาพผลลัพธ์มา (โค้ดเดิมเขียนต่างจากที่คาด)
--
-- ย้อนกลับ (ถ้าต้องการ):
--   select pg_get_functiondef('public.fee_workflow_before_hr'::regproc);  แล้วเปลี่ยนชื่อกลับ
-- ============================================================================

create or replace function pg_temp.patch_workflow()
returns table (รายการ text, ผล text)
language plpgsql as $fn$
declare
  v_oid  oid;
  src    text;
  dst    text;
  bak    text;
  n_role int := 0;
  n_self int := 0;
begin
  select p.oid into v_oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'fee_workflow'
  order by p.oid desc limit 1;
  if v_oid is null then
    return query select 'fee_workflow'::text, 'ไม่พบฟังก์ชันในฐานข้อมูล'::text; return;
  end if;
  src := pg_get_functiondef(v_oid);
  dst := src;

  -- 1) สำเนาตัวเดิม (ครั้งแรกเท่านั้น)
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'fee_workflow_before_hr') then
    bak := regexp_replace(src, 'FUNCTION public\.fee_workflow\(', 'FUNCTION public.fee_workflow_before_hr(', 'i');
    execute bak;
    execute 'revoke all on function public.fee_workflow_before_hr from public, anon, authenticated';
  end if;

  -- 2) has_role(array[...]) ที่ยังไม่มี hr → เติม 'hr'
  select count(*) into n_role
  from regexp_matches(dst, 'has_role\s*\(\s*(?:ARRAY)?\s*\[(?![^\]]*''hr'')[^\]]*\]', 'gi');
  dst := regexp_replace(dst, '(has_role\s*\(\s*(?:ARRAY)?\s*\[)(?![^\]]*''hr'')', '\1''hr'', ', 'gi');

  -- บางเวอร์ชันตรวจบทบาทแบบ  v_role in ('admin', ...)  → เติม 'hr' ด้วย
  select n_role + count(*) into n_role
  from regexp_matches(dst, '(role\w*\s+in\s*\()(?![^)]*''hr'')(?=[^)]*''admin'')', 'gi');
  dst := regexp_replace(dst, '(role\w*\s+in\s*\()(?![^)]*''hr'')(?=[^)]*''admin'')', '\1''hr'', ', 'gi');

  -- 3) ห้ามอนุมัติรอบที่ตัวเองส่ง → ยกเว้น hr/admin
  --    แก้เฉพาะ "การเปรียบเทียบ" หลัง if / when / and / or / ( — ไม่แตะคำสั่ง set submitted_by = ...
  if position('and not fee.has_role(array[''hr'',''admin''])' in dst) = 0 then
  select count(*) into n_self
  from regexp_matches(dst,
    '(\m(?:if|when|and|or)\s+|\(\s*)((?:\w+\.)?submitted_by\s*=\s*(?:fee\.username\(\)|v_\w+)|(?:fee\.username\(\)|v_\w+)\s*=\s*(?:\w+\.)?submitted_by)',
    'gi');
  dst := regexp_replace(dst,
    '(\m(?:if|when|and|or)\s+|\(\s*)((?:\w+\.)?submitted_by\s*=\s*(?:fee\.username\(\)|v_\w+)|(?:fee\.username\(\)|v_\w+)\s*=\s*(?:\w+\.)?submitted_by)',
    '\1(\2 and not fee.has_role(array[''hr'',''admin'']))', 'gi');
  end if;

  if dst <> src then
    execute dst;
  end if;

  return query values
    ('จุดตรวจบทบาทที่เติม hr', n_role::text),
    ('จุดห้ามอนุมัติรอบของตัวเองที่ยกเว้นให้ hr', n_self::text),
    ('สำเนาตัวเดิม', 'public.fee_workflow_before_hr'),
    ('สถานะ', case when dst <> src then '✅ แก้แล้ว'
                  when position('''hr''' in src) > 0 then '✅ แก้ไว้แล้วจากการรันครั้งก่อน'
                  else '⚠️ ไม่พบจุดที่ต้องแก้ — ส่งภาพนี้มาให้ตรวจ' end);

  -- ถ้าไม่พบอะไรเลย แสดงบรรทัดที่ตรวจสิทธิ์ให้ดู
  if dst = src and position('''hr''' in src) = 0 then
    return query
      select 'บรรทัดในโค้ดเดิม'::text, l
      from regexp_split_to_table(src, E'\n') l
      where l ~* '(raise exception|has_role|role|submitted_by)';
  end if;
end $fn$;

select * from pg_temp.patch_workflow();
