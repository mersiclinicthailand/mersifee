-- ============================================================================
-- fee_roster — ตารางแพทย์ (แผนขึ้นเวรรายเดือนของทั้ง 14 สาขา)
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run
--          รันซ้ำได้ ไม่ทำข้อมูลหาย (create if not exists / create or replace)
--
-- ตารางแพทย์คือ "แผน" ว่าใครขึ้นสาขาไหนวันไหน ไม่ใช่ใบเวรจริง
-- ใช้ดูล่วงหน้า และเทียบกับใบเวรที่บันทึกจริงได้ว่าตรงตามแผนหรือไม่
--
-- 1 แถว = 1 สาขา 1 วัน ที่มีแพทย์ (ช่อง "ไม่มีแพทย์" ในไฟล์ไม่เก็บแถว)
-- ไฟล์ต้นทางเขียนชื่อเป็นชื่อเล่น เช่น "หมอเต้ย" ระบบจึงจับคู่กลับเป็นเลข ว. ให้เอง
-- ตามลำดับ: ชื่อเล่นในทะเบียนแพทย์ → ชื่อจริง → ทะเบียนชื่อต้นทาง → คลังรายชื่อแพทย์
-- ============================================================================

/* ---------------------------------------------------------------- ตาราง -- */

create table if not exists fee.roster (
  ym          text        not null,
  branch      text        not null,
  work_date   date        not null,
  doc_label   text        not null,          -- ชื่อที่เขียนในไฟล์ เช่น "หมอเต้ย"
  lic_no      text,                          -- จับคู่ทะเบียนแพทย์ได้ (ว่าง = ยังจับคู่ไม่ได้)
  pool_lic    text,                          -- ไม่อยู่ในทะเบียน แต่เจอในคลังรายชื่อแพทย์
  am_group    text        not null default '',
  updated_by  text        not null default '',
  updated_at  timestamptz not null default now(),
  constraint roster_pk primary key (branch, work_date),
  constraint roster_ym_matches_date check (ym = to_char(work_date, 'YYYY-MM'))
);

create index if not exists roster_ym_idx  on fee.roster (ym);
create index if not exists roster_lic_idx on fee.roster (lic_no, work_date);

comment on table fee.roster is
  'ตารางแพทย์รายเดือน (แผนขึ้นเวร) — นำเข้าจากไฟล์ ตารางเวร-YYYY-MM.xlsx ผ่าน RPC fee_roster_import';

/* ------------------------------------------------------------------ RLS -- */
-- อ่าน: ผู้ที่ได้รับสิทธิ์ใช้ระบบแล้ว (มีแถวใน fee.staff) ดูได้ทุกสาขา
--       เพราะตารางเวรฉบับกระดาษก็แจกทั้งบริษัทอยู่แล้ว และไม่มีข้อมูลการเงิน
-- เขียน: ไม่เปิด policy ใด ๆ — เขียนได้ผ่าน RPC fee_roster_import เท่านั้น

alter table fee.roster enable row level security;

drop policy if exists roster_read on fee.roster;
create policy roster_read on fee.roster
  for select to authenticated
  using (exists (select 1 from fee.staff s where s.id = auth.uid()));

grant select on fee.roster to authenticated;

/* ------------------------------------------- ตัวช่วยตัดคำนำหน้าชื่อแพทย์ -- */
-- "หมอเต้ย" → "เต้ย" · "นางสาวนารา เจริญพงศ์" → "นารา เจริญพงศ์"
-- ตัดซ้ำ 2 รอบ เพราะบางชื่อมีคำนำหน้าซ้อนกัน เช่น "นพ.หมอเต้ย"

create or replace function fee.strip_title(p text)
returns text
language sql immutable
set search_path to ''
as $fn$
  select btrim(regexp_replace(
           btrim(regexp_replace(
             coalesce(p, ''),
             '^(หมอ|นพ\.|พญ\.|น\.พ\.|พ\.ญ\.|ทพ\.|ทพญ\.|ดร\.|นายแพทย์|แพทย์หญิง|นางสาว|นาง|นาย)\s*', '')),
           '^(หมอ|นพ\.|พญ\.|น\.พ\.|พ\.ญ\.|ทพ\.|ทพญ\.|ดร\.|นายแพทย์|แพทย์หญิง|นางสาว|นาง|นาย)\s*', ''))
$fn$;

/* ----------------------------------------------------------- อ่านตาราง -- */
-- security invoker (ค่าเริ่มต้น) — สิทธิ์การอ่านบังคับด้วย RLS ข้างบนตามปกติ

create or replace function public.fee_roster_get(p_ym text)
returns jsonb
language sql stable
set search_path to ''
as $fn$
  select jsonb_build_object(
    'ym', p_ym,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branch',   r.branch,
               'workDate', to_char(r.work_date, 'YYYY-MM-DD'),
               'docLabel', r.doc_label,
               'licNo',    coalesce(r.lic_no, ''),
               'poolLic',  coalesce(r.pool_lic, ''),
               'amGroup',  r.am_group)
             order by r.work_date, r.branch)
      from fee.roster r where r.ym = p_ym), '[]'::jsonb),
    'names', coalesce((
      select jsonb_object_agg(d.lic_no, d.full_name)
      from fee.doctor d
      where d.lic_no in (select r2.lic_no from fee.roster r2
                         where r2.ym = p_ym and r2.lic_no is not null)), '{}'::jsonb)
  )
$fn$;

/* ---------------------------------------------------------- นำเข้าตาราง -- */
-- แทนที่ทั้งเดือน: ลบของเดิมเดือนนั้นแล้วใส่ชุดใหม่ ทำในทรานแซกชันเดียว
-- p_rows = [{ workDate, branch, docLabel, amGroup }, ...]

create or replace function public.fee_roster_import(p_ym text, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_role    text;
  v_user    text;
  v_removed int := 0;
  v_saved   int := 0;
  v_matched int := 0;
  v_pooled  int := 0;
  v_unknown jsonb;
  v_bad     jsonb;
begin
  if p_ym !~ '^\d{4}-\d{2}$' then
    raise exception 'รูปแบบเดือนไม่ถูกต้อง (ต้องเป็น YYYY-MM)';
  end if;

  -- ด่านสิทธิ์: ต้องเป็นผู้ใช้ที่ขึ้นทะเบียนในระบบ และอยู่ในบทบาทที่ดูแลข้อมูลกลาง
  select s.role into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null then
    raise exception 'บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งานระบบค่าตอบแทนแพทย์';
  end if;
  if v_role not in ('admin', 'hr', 'acct', 'it') then
    raise exception 'บทบาทนี้ไม่มีสิทธิ์นำเข้าตารางแพทย์ (ต้องเป็นผู้ดูแลระบบ ฝ่ายบุคคล หรือฝ่ายบัญชี)';
  end if;

  select coalesce(p.username, '') into v_user
  from public.profiles p where p.id = auth.uid();

  -- แปลง json เป็นตารางชั่วคราว พร้อมจับคู่ชื่อเป็นเลข ว.
  create temp table _ros on commit drop as
  with src as (
    select
      nullif(btrim(x->>'branch'), '')            as branch,
      (nullif(btrim(x->>'workDate'), ''))::date  as work_date,
      nullif(btrim(x->>'docLabel'), '')          as doc_label,
      coalesce(btrim(x->>'amGroup'), '')         as am_group
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as x
  ),
  clean as (
    select *, fee.strip_title(doc_label) as key
    from src
    where branch is not null and work_date is not null and doc_label is not null
      and to_char(work_date, 'YYYY-MM') = p_ym
  )
  select
    c.branch, c.work_date, c.doc_label, c.am_group,
    c.branch in (select b.code from fee.branch b)               as branch_ok,
    coalesce(
      (select d.lic_no from fee.doctor d
        where d.nick_name = c.key order by d.lic_no limit 1),
      (select d.lic_no from fee.doctor d
        where split_part(fee.strip_title(d.full_name), ' ', 1) = c.key
        order by d.lic_no limit 1),
      (select a.lic_no from fee.alias a
        where fee.strip_title(a.alias) = c.key order by a.lic_no limit 1)
    )                                                            as lic_no,
    coalesce(
      (select dp.lic_no from fee.doctor_pool dp
        where dp.nick_name = c.key order by dp.lic_no limit 1),
      (select dp.lic_no from fee.doctor_pool dp
        where split_part(fee.strip_title(dp.full_name), ' ', 1) = c.key
        order by dp.lic_no limit 1)
    )                                                            as pool_lic
  from clean c;

  if not exists (select 1 from _ros where branch_ok) then
    raise exception 'ไม่มีแถวที่ใช้ได้ — ตรวจรหัสสาขาและเดือนในไฟล์อีกครั้ง';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('code', branch, 'count', n)), '[]'::jsonb)
    into v_bad
  from (select branch, count(*) n from _ros where not branch_ok group by branch) q;

  delete from fee.roster r where r.ym = p_ym;
  get diagnostics v_removed = row_count;

  insert into fee.roster (ym, branch, work_date, doc_label, lic_no, pool_lic,
                          am_group, updated_by, updated_at)
  select p_ym, branch, work_date, doc_label,
         lic_no, case when lic_no is null then pool_lic else null end,
         am_group, v_user, now()
  from _ros where branch_ok;
  get diagnostics v_saved = row_count;

  select count(*) filter (where lic_no is not null),
         count(*) filter (where lic_no is null and pool_lic is not null)
    into v_matched, v_pooled
  from _ros where branch_ok;

  select coalesce(jsonb_agg(jsonb_build_object('name', doc_label, 'count', n)
                            order by n desc), '[]'::jsonb)
    into v_unknown
  from (select doc_label, count(*) n from _ros
        where branch_ok and lic_no is null and pool_lic is null
        group by doc_label) q;

  return jsonb_build_object('ym', p_ym, 'saved', v_saved, 'removed', v_removed,
                            'matched', v_matched, 'pooled', v_pooled,
                            'unmatched', v_unknown, 'badBranch', v_bad);
end
$fn$;

/* ---------------------------------------------------------------- สิทธิ์ -- */

revoke all on function public.fee_roster_get(text)            from public, anon;
revoke all on function public.fee_roster_import(text, jsonb)  from public, anon;
grant execute on function public.fee_roster_get(text)           to authenticated;
grant execute on function public.fee_roster_import(text, jsonb) to authenticated;

-- ตรวจผลอย่างเร็วหลังรัน (ควรได้ rows ว่าง เพราะยังไม่ได้นำเข้าอะไร)
-- select public.fee_roster_get('2026-10');
