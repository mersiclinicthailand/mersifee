-- ============================================================================
-- roster_lic.sql — ตารางแพทย์ รุ่นที่มี "เลข ว." มาจากไฟล์โดยตรง (อัปเดต: จับคู่ชื่อฉลาดขึ้น · ข้ามช่อง OFF)
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run
--          รันซ้ำได้ ไม่ทำข้อมูลหาย (add column if not exists / create or replace)
--          ต้องรัน roster.sql และ roster_edit.sql ไปก่อนแล้ว
--
-- สิ่งที่เปลี่ยนจากเดิม
--   1) เก็บ "สถานะ" (ยืนยัน/ยกเลิก) และ "หมายเหตุ" ของแต่ละเวรไว้ด้วย
--   2) ใช้เลข ว. ที่ไฟล์ระบุมาตรง ๆ ไม่ต้องเดาจากชื่อเล่นอีก
--      (ยังเดาจากชื่อให้อยู่ เผื่อไฟล์รุ่นเก่าที่ไม่มีคอลัมน์เลขใบประกอบ)
--   3) วันเดียวสาขาเดียวที่ไฟล์มี 2 แถว (หมอเดิมยกเลิก + หมอลงแทน)
--      เก็บเป็นแถวเดียวคือ "หมอที่มาจริง" แล้วผนวกที่มาไว้ในหมายเหตุ
--   4) แพทย์ในตารางที่ยังไม่มีในทะเบียนแพทย์ ระบบขึ้นทะเบียนให้อัตโนมัติ
--      (ดึงรายละเอียดจากคลังรายชื่อแพทย์ถ้ามี) เพื่อให้ "ลงเวลา" ใช้งานได้ทันที
--      แถวที่สร้างอัตโนมัติจะมีหมายเหตุกำกับ ให้ฝ่ายบุคคลตามกรอกเลขบัญชีทีหลัง
-- ============================================================================

/* ------------------------------------------------- 1) คอลัมน์ที่เพิ่มเข้ามา -- */

alter table fee.roster add column if not exists status text not null default 'ยืนยัน';
alter table fee.roster add column if not exists note   text not null default '';

comment on column fee.roster.status is 'ยืนยัน = ขึ้นเวรจริง · ยกเลิก = เวรถูกยกเลิกและไม่มีคนลงแทน';
comment on column fee.roster.note   is 'ที่มาของการเปลี่ยนเวร เช่น "ลงแทนหมอหลี (เดิม: หมอหลี — หมอติดธุระ)"';

/* --------------------------------------------------------- 2) อ่านตาราง -- */
-- คืนสถานะและหมายเหตุเพิ่ม และคืนชื่อของแพทย์จากคลังรายชื่อด้วย
-- เผื่อกรณีที่ยังขึ้นทะเบียนไม่สำเร็จ หน้าจอจะได้ไม่โชว์แค่ตัวเลขเปล่า ๆ

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
               'amGroup',  r.am_group,
               'status',   r.status,
               'note',     r.note)
             order by r.work_date, r.branch)
      from fee.roster r where r.ym = p_ym), '[]'::jsonb),
    'names', coalesce((
      select jsonb_object_agg(q.lic_no, q.name) from (
        select d.lic_no, d.full_name as name
        from fee.doctor d
        where d.lic_no in (select r2.lic_no from fee.roster r2
                           where r2.ym = p_ym and r2.lic_no is not null)
        union
        select dp.lic_no, dp.full_name
        from fee.doctor_pool dp
        where dp.lic_no in (select r3.pool_lic from fee.roster r3
                            where r3.ym = p_ym and r3.pool_lic is not null)
          and not exists (select 1 from fee.doctor d2 where d2.lic_no = dp.lic_no)
      ) q), '{}'::jsonb)
  )
$fn$;

/* ----------------------------------- 3) ตัวช่วย: ขึ้นทะเบียนแพทย์อัตโนมัติ -- */
-- รับเลข ว. มาชุดหนึ่ง ใครยังไม่มีในทะเบียนแพทย์ก็เพิ่มให้
-- ดึงรายละเอียดจากคลังรายชื่อแพทย์ (doctor_pool) ถ้าเจอ ไม่เจอก็สร้างแถวย่อ ๆ ไว้ก่อน
-- คืนจำนวนที่เพิ่ม — ถ้าเพิ่มไม่สำเร็จด้วยเหตุใด คืน -1 แทนการทำให้ทั้งงานล้ม

create or replace function fee.roster_autoreg(p_lics jsonb, p_src text)
returns int
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_added int := 0;
begin
  begin
    with want as (
      select distinct btrim(x) as lic
      from jsonb_array_elements_text(coalesce(p_lics, '[]'::jsonb)) as x
    ),
    todo as (
      select w.lic from want w
      where w.lic is not null and w.lic <> ''
        and not exists (select 1 from fee.doctor d where d.lic_no = w.lic)
    ),
    ins as (
      insert into fee.doctor (lic_no, full_name, nick_name, bank, bank_acc, id_card,
                              address, contact, payee_type, payee_name, status, note)
      select t.lic,
             coalesce(nullif(btrim(dp.full_name), ''), 'แพทย์ ว.' || t.lic),
             coalesce(dp.nick_name, ''),
             coalesce(dp.bank, ''), coalesce(dp.bank_acc, ''), coalesce(dp.id_card, ''),
             coalesce(dp.address, ''), coalesce(dp.contact, ''),
             coalesce(nullif(dp.payee_type, ''), 'PERSON'), coalesce(dp.payee_name, ''),
             'ACTIVE',
             case when dp.lic_no is null
                  then 'เพิ่มอัตโนมัติจาก' || p_src || ' — ยังไม่มีข้อมูลในคลังรายชื่อ ต้องกรอกชื่อ-สกุลและเลขบัญชี'
                  else 'เพิ่มอัตโนมัติจาก' || p_src || ' (ดึงจากคลังรายชื่อแพทย์) — ตรวจเลขบัญชีก่อนจ่ายเงิน'
             end
      from todo t
      left join fee.doctor_pool dp on dp.lic_no = t.lic
      on conflict (lic_no) do nothing
      returning 1
    )
    select count(*) into v_added from ins;
  exception when others then
    return -1;                      -- ทะเบียนแพทย์เพิ่มไม่ได้ แต่ตารางเวรต้องบันทึกสำเร็จ
  end;
  return v_added;
end
$fn$;


/* ------------------------------ ตัวช่วยจับคู่ชื่อในตารางเวร (รุ่นที่ 2) ------------------------------
 * ตารางเวรที่ทำมือเขียนชื่อไม่ตรงทะเบียนเป๊ะ ๆ เช่น
 *   "หมอลูกหยี"  ทะเบียน "ลูกหยี๋"      → ต่างกันแค่วรรณยุกต์
 *   "หมอปิ่น ปภาภรณ์"                   → ชื่อเล่น + ชื่อจริงในช่องเดียว
 *   "หมอนารา"    ทะเบียนชื่อเล่น "จ๋า"   → เป็นชื่อจริง
 *   "หมอเต้ย"    มี 2 คนในทะเบียน        → เลือกคนที่เคยทำงานสาขานี้ก่อน
 *   "OFF"                               → ไม่ใช่หมอ ไม่ต้องเก็บ
 * ------------------------------------------------------------------------------------------------ */

create or replace function fee.roster_is_off(p text)
returns boolean language sql immutable set search_path to '' as $fn$
  select upper(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')))
         in ('', 'OFF', 'OFF.', 'DAY OFF', '-', '–', 'หยุด', 'ปิด', 'ปิดสาขา', 'ไม่มีแพทย์', 'ไม่มีหมอ', 'ว่าง')
$fn$;

/* ตัดวรรณยุกต์ ไม้ไต่คู้ การันต์ และช่องว่าง — ใช้เปรียบเทียบเท่านั้น */
create or replace function fee.name_fold(p text)
returns text language sql immutable set search_path to '' as $fn$
  select regexp_replace(coalesce(p, ''), '[็-์\s.]', '', 'g')
$fn$;

create or replace function fee.roster_find_lic(p_key text, p_branch text default null)
returns text language plpgsql stable set search_path to '' as $fn$
declare
  k   text := btrim(coalesce(p_key, ''));
  k1  text := split_part(k, ' ', 1);          -- "ปิ่น ปภาภรณ์" → "ปิ่น"
  k2  text := split_part(k, ' ', 2);          -- → "ปภาภรณ์"
  v   text;
  n   int;
begin
  if k = '' then return null; end if;

  -- 1) ชื่อเล่นตรงตัว — ถ้ามีหลายคน เลือกคนที่เคยจับคู่ไว้ที่สาขานี้ก่อน
  select d.lic_no into v from fee.doctor d
   where d.nick_name = k
   order by exists (select 1 from fee.alias a where a.lic_no = d.lic_no and a.branch = p_branch) desc,
            exists (select 1 from fee.roster r where r.lic_no = d.lic_no and r.branch = p_branch) desc,
            d.lic_no
   limit 1;
  if v is not null then return v; end if;

  -- 2) ชื่อจริงตรงตัว
  select d.lic_no into v from fee.doctor d
   where split_part(fee.strip_title(d.full_name), ' ', 1) = k
   order by d.lic_no limit 1;
  if v is not null then return v; end if;

  -- 3) ตารางจับคู่ชื่อ (alias)
  select a.lic_no into v from fee.alias a
   where fee.strip_title(a.alias) = k order by (a.branch = p_branch) desc, a.lic_no limit 1;
  if v is not null then return v; end if;

  -- 4) "ชื่อเล่น ชื่อจริง" ในช่องเดียว — ต้องตรงทั้งคู่ถ้ามีคำที่สอง
  if k2 <> '' then
    select d.lic_no into v from fee.doctor d
     where (d.nick_name = k1 or split_part(fee.strip_title(d.full_name), ' ', 1) = k1)
       and (split_part(fee.strip_title(d.full_name), ' ', 1) = k2
            or split_part(fee.strip_title(d.full_name), ' ', 2) = k2)
     order by d.lic_no limit 1;
    if v is not null then return v; end if;
    select d.lic_no into v from fee.doctor d where d.nick_name = k1 order by d.lic_no limit 1;
    if v is not null then return v; end if;
  end if;

  -- 5) ต่างกันแค่วรรณยุกต์ — ต้องเจอคนเดียวเท่านั้น (เจอหลายคนไม่เดา)
  select count(distinct d.lic_no), min(d.lic_no) into n, v from fee.doctor d
   where d.nick_name <> '' and fee.name_fold(d.nick_name) = fee.name_fold(k1);
  if n = 1 then return v; end if;

  return null;
end
$fn$;

/* คลังรายชื่อแพทย์ — ใช้เฉพาะเมื่อไม่เจอในทะเบียน และต้องเจอคนเดียว (กันเดาผิดคน) */
create or replace function fee.roster_find_pool(p_key text)
returns text language plpgsql stable set search_path to '' as $fn$
declare
  k  text := split_part(btrim(coalesce(p_key, '')), ' ', 1);
  v  text; n int;
begin
  if k = '' then return null; end if;
  select count(*), min(dp.lic_no) into n, v from fee.doctor_pool dp
   where dp.nick_name = k or split_part(fee.strip_title(dp.full_name), ' ', 1) = k;
  if n = 1 then return v; end if;
  select count(*), min(dp.lic_no) into n, v from fee.doctor_pool dp
   where dp.nick_name <> '' and fee.name_fold(dp.nick_name) = fee.name_fold(k);
  if n = 1 then return v; end if;
  return null;
end
$fn$;

/* แก้ข้อมูลเดิมที่นำเข้าไปแล้ว: ลบช่อง OFF ทิ้ง และจับคู่ชื่อที่ยังไม่มีเลข ว. ใหม่ */
create or replace function public.fee_roster_rematch(p_ym text)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_role text; v_off int; v_fix int; v_left int;
begin
  select s.role::text into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null or v_role not in ('admin', 'hr', 'acct', 'it') then
    raise exception 'บทบาทนี้ไม่มีสิทธิ์แก้ตารางแพทย์';
  end if;
  delete from fee.roster r where r.ym = p_ym and fee.roster_is_off(r.doc_label);
  get diagnostics v_off = row_count;
  update fee.roster r
     set lic_no = x.lic, pool_lic = null, updated_at = now()
    from (select r2.branch, r2.work_date, fee.roster_find_lic(fee.strip_title(r2.doc_label), r2.branch) as lic
            from fee.roster r2 where r2.ym = p_ym and r2.lic_no is null) x
   where r.branch = x.branch and r.work_date = x.work_date and x.lic is not null;
  get diagnostics v_fix = row_count;
  update fee.roster r set pool_lic = fee.roster_find_pool(fee.strip_title(r.doc_label))
   where r.ym = p_ym and r.lic_no is null;
  select count(*) into v_left from fee.roster r where r.ym = p_ym and r.lic_no is null;
  return jsonb_build_object('removedOff', v_off, 'matched', v_fix, 'stillUnknown', v_left);
end
$fn$;

revoke all on function public.fee_roster_rematch(text) from public, anon;
grant execute on function public.fee_roster_rematch(text) to authenticated;

/* ------------------------------------------------------- 4) นำเข้าตาราง -- */
-- p_rows = [{ workDate, branch, docLabel, licNo, amGroup, status, note }, ...]
--   licNo  — เลขใบประกอบจากไฟล์ (ถ้าว่าง ระบบจับคู่จากชื่อให้เหมือนเดิม)
--   status — "ยืนยัน" หรือ "ยกเลิก" (ถ้าว่าง ถือเป็น "ยืนยัน")
-- แทนที่ทั้งเดือน: ลบของเดิมเดือนนั้นแล้วใส่ชุดใหม่ ในทรานแซกชันเดียว

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
  v_cancel  int := 0;
  v_merged  int := 0;
  v_added   int := 0;
  v_fromlic int := 0;
  v_unknown jsonb;
  v_bad     jsonb;
  v_mismatch jsonb;
  v_lics    jsonb;
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

  /* -------- 4.1 แปลง json เป็นตาราง แล้วหาเลข ว. ของแต่ละแถว -------- */
  create temp table _ros on commit drop as
  with src as (
    select
      row_number() over ()                        as seq,
      nullif(btrim(x->>'branch'), '')             as branch,
      (nullif(btrim(x->>'workDate'), ''))::date   as work_date,
      nullif(btrim(x->>'docLabel'), '')           as doc_label,
      nullif(regexp_replace(coalesce(x->>'licNo', ''), '\D', '', 'g'), '') as lic_file,
      coalesce(btrim(x->>'amGroup'), '')          as am_group,
      case when btrim(coalesce(x->>'status', '')) = 'ยกเลิก' then 'ยกเลิก' else 'ยืนยัน' end as status,
      coalesce(btrim(x->>'note'), '')             as note
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as x
  ),
  clean as (
    select *, fee.strip_title(doc_label) as key
    from src
    where branch is not null and work_date is not null and doc_label is not null
      and to_char(work_date, 'YYYY-MM') = p_ym
      and not fee.roster_is_off(doc_label)
  )
  select
    c.seq, c.branch, c.work_date, c.doc_label, c.am_group, c.status, c.note,
    c.lic_file, c.key,
    c.branch in (select b.code from fee.branch b)               as branch_ok,
    -- เลข ว. จากไฟล์มาก่อนเสมอ (ฝ่ายบุคคลเป็นคนดูแลเลขนี้)
    coalesce(
      c.lic_file,
      fee.roster_find_lic(c.key, c.branch)
    )                                                            as lic_no
  from clean c;

  if not exists (select 1 from _ros where branch_ok) then
    raise exception 'ไม่มีแถวที่ใช้ได้ — ตรวจรหัสสาขาและเดือนในไฟล์อีกครั้ง';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('code', branch, 'count', n)), '[]'::jsonb)
    into v_bad
  from (select branch, count(*) n from _ros where not branch_ok group by branch) q;

  /* -------- 4.2 ขึ้นทะเบียนแพทย์ที่ยังไม่มี ก่อนบันทึกตาราง -------- */
  select coalesce(jsonb_agg(distinct to_jsonb(lic_no)), '[]'::jsonb) into v_lics
  from _ros where branch_ok and lic_no is not null;

  v_added := fee.roster_autoreg(v_lics, 'ตารางแพทย์ ' || p_ym);

  /* -------- 4.3 รวมแถวซ้ำ: 1 สาขา 1 วัน เหลือแถวเดียว --------
     เรียงลำดับความสำคัญ: ยืนยันมาก่อนยกเลิก → มีเลข ว. มาก่อน → ตามลำดับในไฟล์
     แถวที่แพ้จะถูกผนวกเข้าหมายเหตุของแถวที่ชนะ เพื่อไม่ให้ที่มาหายไป          */
  create temp table _pick on commit drop as
  with ranked as (
    select *, row_number() over (
      partition by branch, work_date
      order by (status = 'ยกเลิก'), (lic_no is null), seq
    ) as rk,
    count(*) over (partition by branch, work_date) as cnt
    from _ros where branch_ok
  ),
  lost as (
    select branch, work_date,
           string_agg(doc_label || case when note <> '' then ' — ' || note else '' end,
                      ' · ' order by seq) as why
    from ranked where rk > 1 group by branch, work_date
  )
  select r.branch, r.work_date, r.doc_label, r.lic_no, r.am_group, r.status, r.key,
         btrim(r.note || case when l.why is not null
                              then case when r.note <> '' then ' ' else '' end || '(เดิม: ' || l.why || ')'
                              else '' end) as note,
         (r.cnt > 1) as merged
  from ranked r
  left join lost l on l.branch = r.branch and l.work_date = r.work_date
  where r.rk = 1;

  /* -------- 4.4 เขียนทับทั้งเดือน -------- */
  delete from fee.roster r where r.ym = p_ym;
  get diagnostics v_removed = row_count;

  insert into fee.roster (ym, branch, work_date, doc_label, lic_no, pool_lic,
                          am_group, status, note, updated_by, updated_at)
  select p_ym, p.branch, p.work_date, p.doc_label,
         case when exists (select 1 from fee.doctor d where d.lic_no = p.lic_no)
              then p.lic_no else null end,
         case when p.lic_no is not null
                   and not exists (select 1 from fee.doctor d where d.lic_no = p.lic_no)
                   and exists (select 1 from fee.doctor_pool dp where dp.lic_no = p.lic_no)
              then p.lic_no
              when p.lic_no is null then fee.roster_find_pool(p.key)
              else null end,
         p.am_group, p.status, p.note, v_user, now()
  from _pick p;
  get diagnostics v_saved = row_count;

  /* -------- 4.5 สรุปผลให้หน้าจอรายงาน -------- */
  select count(*) filter (where r.lic_no is not null),
         count(*) filter (where r.lic_no is null and r.pool_lic is not null),
         count(*) filter (where r.status = 'ยกเลิก')
    into v_matched, v_pooled, v_cancel
  from fee.roster r where r.ym = p_ym;

  select count(*) into v_merged from _pick where merged;
  select count(*) into v_fromlic from _ros where branch_ok and lic_file is not null;

  select coalesce(jsonb_agg(jsonb_build_object('name', doc_label, 'count', n)
                            order by n desc), '[]'::jsonb)
    into v_unknown
  from (select p.doc_label, count(*) n from _pick p
        where p.lic_no is null
           or not exists (select 1 from fee.doctor d where d.lic_no = p.lic_no)
        group by p.doc_label) q;

  -- ชื่อในไฟล์กับชื่อในทะเบียนไม่ตรงกัน: ไม่ใช่ข้อผิดพลาด แต่ควรให้คนตรวจ
  select coalesce(jsonb_agg(q.j), '[]'::jsonb) into v_mismatch
  from (
    select distinct jsonb_build_object(
             'licNo', p.lic_no, 'file', p.key,
             'registry', coalesce(nullif(d.nick_name, ''), d.full_name)) as j
    from _pick p
    join fee.doctor d on d.lic_no = p.lic_no
    where p.key <> '' and coalesce(d.nick_name, '') <> p.key
      and split_part(fee.strip_title(coalesce(d.full_name, '')), ' ', 1) <> p.key
    limit 20                       -- แสดงพอให้เห็นแนว ไม่ถล่มหน้าจอ
  ) q;

  return jsonb_build_object(
    'ym', p_ym, 'saved', v_saved, 'removed', v_removed,
    'matched', v_matched, 'pooled', v_pooled,
    'cancelled', v_cancel, 'merged', v_merged,
    'fromFileLic', v_fromlic, 'registered', v_added,
    'unmatched', v_unknown, 'badBranch', v_bad, 'mismatch', v_mismatch);
end
$fn$;

/* ------------------------------------------------- 5) แก้เวรทีละช่อง -- */
-- คงรูปแบบการเรียกเดิมไว้ (4 พารามิเตอร์) แต่ขึ้นทะเบียนแพทย์ให้อัตโนมัติด้วย
-- และการแก้ด้วยมือถือว่าเป็นเวรที่ "ยืนยัน" เสมอ (ทับหมายเหตุเดิมของช่องนั้น)

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
  v_add  int := 0;
begin
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

  if coalesce(btrim(p_label), '') = '' or fee.roster_is_off(p_label) then
    delete from fee.roster r where r.branch = p_branch and r.work_date = p_date;
    return jsonb_build_object('cleared', true, 'ym', v_ym);
  end if;

  v_key := fee.strip_title(p_label);

  v_lic := nullif(regexp_replace(coalesce(p_lic, ''), '\D', '', 'g'), '');
  if v_lic is null then
    v_lic := fee.roster_find_lic(v_key, p_branch);
  end if;

  -- เลือกจากทะเบียนหรือพิมพ์เลขมาเอง แต่ยังไม่มีในทะเบียน → ขึ้นทะเบียนให้เลย
  if v_lic is not null
     and not exists (select 1 from fee.doctor d where d.lic_no = v_lic) then
    v_add := fee.roster_autoreg(jsonb_build_array(v_lic), 'การแก้ตารางแพทย์');
  end if;

  if v_lic is not null
     and not exists (select 1 from fee.doctor d where d.lic_no = v_lic) then
    -- ขึ้นทะเบียนไม่สำเร็จ → เก็บไว้เป็นเลขจากคลังรายชื่อแทน จะได้ไม่หาย
    v_pool := v_lic;
    v_lic  := null;
  elsif v_lic is null then
    v_pool := fee.roster_find_pool(v_key);
  end if;

  select r.am_group into v_am
  from fee.roster r where r.branch = p_branch and r.ym = v_ym limit 1;

  insert into fee.roster (ym, branch, work_date, doc_label, lic_no, pool_lic,
                          am_group, status, note, updated_by, updated_at)
  values (v_ym, p_branch, p_date, btrim(p_label), v_lic, v_pool,
          coalesce(v_am, ''), 'ยืนยัน', '', v_user, now())
  on conflict (branch, work_date) do update
    set ym = excluded.ym, doc_label = excluded.doc_label,
        lic_no = excluded.lic_no, pool_lic = excluded.pool_lic,
        status = 'ยืนยัน', note = '',
        updated_by = excluded.updated_by, updated_at = now();

  return jsonb_build_object('cleared', false, 'ym', v_ym,
                            'licNo', coalesce(v_lic, ''), 'poolLic', coalesce(v_pool, ''),
                            'registered', greatest(v_add, 0));
end
$fn$;

/* ---------------------------------------------------------------- สิทธิ์ -- */

revoke all on function fee.roster_autoreg(jsonb, text)        from public, anon, authenticated;
revoke all on function public.fee_roster_get(text)            from public, anon;
revoke all on function public.fee_roster_import(text, jsonb)  from public, anon;
revoke all on function public.fee_roster_set(text, date, text, text) from public, anon;
grant execute on function public.fee_roster_get(text)                to authenticated;
grant execute on function public.fee_roster_import(text, jsonb)      to authenticated;
grant execute on function public.fee_roster_set(text, date, text, text) to authenticated;

-- ตรวจผลอย่างเร็วหลังรัน
-- select public.fee_roster_get('2026-10');
