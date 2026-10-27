-- ============================================================================
-- ตารางพยาบาล — แผนขึ้นเวรพยาบาลรายเดือน + ทะเบียนพยาบาล (ไว้ส่งออกเข้า HumanSoft)
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run
--          รันซ้ำได้ ไม่ทำข้อมูลหาย (create if not exists / create or replace)
--
-- ⚠️ ตารางพยาบาล "ไม่เกี่ยวกับการคำนวณค่าตอบแทน" — ไม่มีฟังก์ชันคำนวณใดอ่านตารางนี้
--
-- fee.nurse         ทะเบียนพยาบาล 1 แถว = 1 คน (เลขใบประกอบวิชาชีพเป็นกุญแจ)
--                   เก็บรหัสพนักงาน HumanSoft / สาขาต้นสังกัด / แผนก / ตำแหน่ง ไว้ใช้ตอนส่งออก
-- fee.nurse_roster  1 แถว = 1 สาขา 1 วัน ที่มีพยาบาล (ช่องว่างในไฟล์ไม่เก็บแถว)
-- ============================================================================

/* ---------------------------------------------------------------- ตาราง -- */

create table if not exists fee.nurse (
  lic_no      text        primary key,              -- เลขใบประกอบวิชาชีพการพยาบาล
  nick_name   text        not null default '',      -- "ฟิล์ม"
  full_name   text        not null default '',      -- "นางสาว... ..." (ใส่เองที่หน้าทะเบียนพยาบาล)
  hs_code     text        not null default '',      -- รหัสพนักงาน HumanSoft เช่น RM690901
  home_branch text        not null default '',      -- สาขาต้นสังกัด (คอลัมน์ "สาขา" ในไฟล์ HumanSoft)
  dept        text        not null default 'แผนกบริการ',
  position    text        not null default 'พยาบาล(Nurse)',
  phone       text        not null default '',
  active      boolean     not null default true,
  updated_by  text        not null default '',
  updated_at  timestamptz not null default now()
);

create table if not exists fee.nurse_roster (
  ym          text        not null,
  branch      text        not null,
  work_date   date        not null,
  nurse_label text        not null,                 -- ชื่อที่เขียนในไฟล์ เช่น "พว.ฟิล์ม"
  lic_no      text,                                 -- จับคู่ทะเบียนพยาบาลได้ (ว่าง = ยังไม่รู้ว่าใคร)
  am_group    text        not null default '',
  note        text        not null default '',
  updated_by  text        not null default '',
  updated_at  timestamptz not null default now(),
  constraint nurse_roster_pk primary key (branch, work_date),
  constraint nurse_roster_ym_matches_date check (ym = to_char(work_date, 'YYYY-MM'))
);

create index if not exists nurse_roster_ym_idx  on fee.nurse_roster (ym);
create index if not exists nurse_roster_lic_idx on fee.nurse_roster (lic_no, work_date);

comment on table fee.nurse is
  'ทะเบียนพยาบาล — ใช้กับตารางพยาบาลและไฟล์นำเข้า HumanSoft เท่านั้น (ไม่เกี่ยวกับค่าตอบแทน)';
comment on table fee.nurse_roster is
  'ตารางพยาบาลรายเดือน — นำเข้าจากไฟล์ mersi_ตารางเวรพยาบาล_YYYY-MM.xlsx ผ่าน RPC fee_nurse_roster_import';

/* ------------------------------------------------------------------ RLS -- */
-- อ่าน: ผู้ใช้ที่ได้รับสิทธิ์ระบบแล้ว (มีแถวใน fee.staff) ดูได้ทุกสาขา เหมือนตารางแพทย์
-- เขียน: ไม่เปิด policy — เขียนผ่าน RPC ด้านล่างเท่านั้น

alter table fee.nurse enable row level security;
alter table fee.nurse_roster enable row level security;

drop policy if exists nurse_read on fee.nurse;
create policy nurse_read on fee.nurse
  for select to authenticated
  using (exists (select 1 from fee.staff s where s.id = auth.uid()));

drop policy if exists nurse_roster_read on fee.nurse_roster;
create policy nurse_roster_read on fee.nurse_roster
  for select to authenticated
  using (exists (select 1 from fee.staff s where s.id = auth.uid()));

grant select on fee.nurse, fee.nurse_roster to authenticated;

/* ---------------------------------------------------------- ตัวช่วย -- */

-- "พว.ฟิล์ม" → "ฟิล์ม" · "นางสาวกัญญา ทองดี" → "กัญญา ทองดี"
create or replace function fee.strip_nurse_title(p text)
returns text
language sql immutable
set search_path to ''
as $fn$
  select btrim(regexp_replace(
           btrim(regexp_replace(
             coalesce(p, ''),
             '^(พว\.|พย\.|พยาบาล|คุณ|น\.ส\.|นส\.|นางสาว|นาง|นาย)\s*', '')),
           '^(พว\.|พย\.|พยาบาล|คุณ|น\.ส\.|นส\.|นางสาว|นาง|นาย)\s*', ''))
$fn$;

-- ด่านสิทธิ์เขียน — คืนชื่อผู้ใช้ไว้บันทึก updated_by
create or replace function fee.nurse_editor()
returns text
language plpgsql stable security definer
set search_path to ''
as $fn$
declare
  v_role text;
  v_user text;
begin
  select s.role into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null then
    raise exception 'บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งานระบบ';
  end if;
  if v_role not in ('admin', 'hr', 'acct', 'it') then
    raise exception 'บทบาทนี้ไม่มีสิทธิ์แก้ตารางพยาบาล (ต้องเป็นผู้ดูแลระบบ ฝ่ายบุคคล ฝ่ายบัญชี หรือ IT)';
  end if;
  select coalesce(p.username, '') into v_user from public.profiles p where p.id = auth.uid();
  return coalesce(v_user, '');
end
$fn$;

-- ชื่อ → เลขใบประกอบ จากทะเบียนพยาบาล (ชื่อเล่นก่อน แล้วชื่อจริงคำแรก)
create or replace function fee.nurse_lic_of(p_label text)
returns text
language sql stable
set search_path to ''
as $fn$
  select coalesce(
    (select n.lic_no from fee.nurse n
      where n.nick_name <> '' and n.nick_name = fee.strip_nurse_title(p_label)
      order by n.active desc, n.lic_no limit 1),
    (select n.lic_no from fee.nurse n
      where n.full_name <> ''
        and split_part(fee.strip_nurse_title(n.full_name), ' ', 1) = fee.strip_nurse_title(p_label)
      order by n.active desc, n.lic_no limit 1))
$fn$;

/* ----------------------------------------------------------- อ่านตาราง -- */

create or replace function public.fee_nurse_roster_get(p_ym text)
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
               'label',    r.nurse_label,
               'licNo',    coalesce(r.lic_no, ''),
               'amGroup',  r.am_group,
               'note',     r.note)
             order by r.work_date, r.branch)
      from fee.nurse_roster r where r.ym = p_ym), '[]'::jsonb),
    'nurses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'licNo',      n.lic_no,
               'nick',       n.nick_name,
               'fullName',   n.full_name,
               'hsCode',     n.hs_code,
               'homeBranch', n.home_branch,
               'dept',       n.dept,
               'position',   n.position,
               'phone',      n.phone,
               'active',     n.active)
             order by n.active desc, n.nick_name, n.lic_no)
      from fee.nurse n), '[]'::jsonb)
  )
$fn$;

/* ---------------------------------------------------------- นำเข้าตาราง -- */
-- แทนที่ทั้งเดือน · p_rows = [{ workDate, branch, label, licNo, amGroup, status, note, phone }, ...]
-- เลขใบประกอบที่ยังไม่มีในทะเบียน → ขึ้นทะเบียนพยาบาลให้อัตโนมัติ (ชื่อเล่นจากไฟล์)

create or replace function public.fee_nurse_roster_import(p_ym text, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_user       text;
  v_removed    int := 0;
  v_saved      int := 0;
  v_registered int := 0;
  v_matched    int := 0;
  v_unknown    jsonb;
  v_bad        jsonb;
begin
  if p_ym !~ '^\d{4}-\d{2}$' then
    raise exception 'รูปแบบเดือนไม่ถูกต้อง (ต้องเป็น YYYY-MM)';
  end if;
  v_user := fee.nurse_editor();

  create temp table _nr on commit drop as
  with src as (
    select
      nullif(upper(btrim(x->>'branch')), '')            as branch,
      (nullif(btrim(x->>'workDate'), ''))::date         as work_date,
      nullif(btrim(x->>'label'), '')                    as label,
      nullif(regexp_replace(coalesce(x->>'licNo', ''), '\D', '', 'g'), '') as lic,
      coalesce(btrim(x->>'amGroup'), '')                as am_group,
      coalesce(nullif(btrim(x->>'status'), ''), 'ยืนยัน') as status,
      coalesce(btrim(x->>'note'), '')                   as note,
      coalesce(btrim(x->>'phone'), '')                  as phone,
      ord
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(x, ord)
  )
  select * from src
  where branch is not null and work_date is not null and label is not null
    and to_char(work_date, 'YYYY-MM') = p_ym;

  select coalesce(jsonb_agg(jsonb_build_object('code', b.branch, 'count', b.n)), '[]'::jsonb)
    into v_bad
  from (select branch, count(*) n from _nr
        where branch not in (select b.code from fee.branch b) group by branch) b;
  delete from _nr where branch not in (select b.code from fee.branch b);

  -- ขึ้นทะเบียนพยาบาลที่ไฟล์ให้เลขใบประกอบมาแต่ยังไม่มีในระบบ
  insert into fee.nurse (lic_no, nick_name, phone, updated_by)
  select distinct on (lic) lic, fee.strip_nurse_title(label), phone, v_user
  from _nr where lic is not null and lic not in (select n.lic_no from fee.nurse n)
  order by lic, ord
  on conflict (lic_no) do nothing;
  get diagnostics v_registered = row_count;

  -- เติมเบอร์โทรที่ทะเบียนยังว่าง
  update fee.nurse n set phone = s.phone
  from (select distinct on (lic) lic, phone from _nr
        where lic is not null and phone <> '' order by lic, ord) s
  where n.lic_no = s.lic and n.phone = '';

  -- ไม่มีเลขใบประกอบมาในไฟล์ → จับคู่ชื่อกับทะเบียน
  update _nr set lic = fee.nurse_lic_of(label) where lic is null;

  delete from fee.nurse_roster r where r.ym = p_ym;
  get diagnostics v_removed = row_count;

  -- 1 สาขา 1 วัน เหลือแถวเดียว: เลือกแถวที่ยืนยันก่อนแถวที่ยกเลิก · แถวที่ยกเลิกทั้งหมดไม่เก็บ
  insert into fee.nurse_roster (ym, branch, work_date, nurse_label, lic_no, am_group, note, updated_by)
  select distinct on (branch, work_date)
         p_ym, branch, work_date, label, lic, am_group, note, v_user
  from _nr
  where status <> 'ยกเลิก'
  order by branch, work_date, ord;
  get diagnostics v_saved = row_count;

  select count(*) into v_matched from fee.nurse_roster r where r.ym = p_ym and r.lic_no is not null;

  select coalesce(jsonb_agg(jsonb_build_object('name', u.nurse_label, 'count', u.n) order by u.n desc), '[]'::jsonb)
    into v_unknown
  from (select nurse_label, count(*) n from fee.nurse_roster
        where ym = p_ym and lic_no is null group by nurse_label) u;

  return jsonb_build_object(
    'ym', p_ym, 'saved', v_saved, 'removed', v_removed, 'matched', v_matched,
    'registered', v_registered, 'unmatched', v_unknown, 'badBranch', v_bad);
end
$fn$;

/* ---------------------------------------------------- แก้เวรทีละช่อง -- */
-- p_lic เลือกจากทะเบียน หรือส่งแค่ p_label ให้ระบบจับคู่เอง · ทั้งคู่ว่าง = ลบเวรวันนั้น

create or replace function public.fee_nurse_roster_set(
  p_branch text, p_date date, p_lic text default null, p_label text default null, p_note text default null
)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_user  text;
  v_ym    text;
  v_lic   text := nullif(btrim(coalesce(p_lic, '')), '');
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_am    text;
begin
  v_user := fee.nurse_editor();
  if p_branch is null or p_date is null then raise exception 'ต้องระบุสาขาและวันที่'; end if;
  if not exists (select 1 from fee.branch b where b.code = p_branch) then
    raise exception 'ไม่รู้จักรหัสสาขา %', p_branch;
  end if;
  v_ym := to_char(p_date, 'YYYY-MM');

  if v_lic is null and v_label is null then
    delete from fee.nurse_roster r where r.branch = p_branch and r.work_date = p_date;
    return jsonb_build_object('cleared', true, 'ym', v_ym);
  end if;

  if v_lic is not null then
    if not exists (select 1 from fee.nurse n where n.lic_no = v_lic) then
      raise exception 'ไม่พบเลขใบประกอบ % ในทะเบียนพยาบาล', v_lic;
    end if;
    if v_label is null then
      select 'พว.' || coalesce(nullif(n.nick_name, ''), split_part(fee.strip_nurse_title(n.full_name), ' ', 1))
        into v_label from fee.nurse n where n.lic_no = v_lic;
    end if;
  else
    v_lic := fee.nurse_lic_of(v_label);
  end if;

  select r.am_group into v_am from fee.nurse_roster r
  where r.branch = p_branch and r.ym = v_ym and r.am_group <> '' limit 1;

  insert into fee.nurse_roster (ym, branch, work_date, nurse_label, lic_no, am_group, note, updated_by, updated_at)
  values (v_ym, p_branch, p_date, v_label, v_lic, coalesce(v_am, ''), coalesce(btrim(p_note), ''), v_user, now())
  on conflict (branch, work_date) do update
    set nurse_label = excluded.nurse_label, lic_no = excluded.lic_no,
        note = case when p_note is null then fee.nurse_roster.note else excluded.note end,
        updated_by = excluded.updated_by, updated_at = now();

  return jsonb_build_object('cleared', false, 'ym', v_ym, 'licNo', coalesce(v_lic, ''), 'label', v_label);
end
$fn$;

/* ------------------------------------------------------- สลับเวร 2 ช่อง -- */
-- สลับพยาบาลระหว่าง 2 ช่อง (ต่างวันหรือต่างสาขาก็ได้) ในทรานแซกชันเดียว
-- ช่องหนึ่งว่าง = ย้ายเวรไปช่องว่างนั้น · หมายเหตุบันทึกที่มาของการสลับไว้ทั้งสองช่อง

-- หมายเหตุเดิมตัดท่อน "สลับมาจาก ..." ทิ้งก่อน เพื่อไม่ให้สลับหลายรอบแล้วหมายเหตุยาวต่อกันไปเรื่อย ๆ
create or replace function fee.nurse_unswap_note(p text)
returns text
language sql immutable
set search_path to ''
as $fn$
  select btrim(regexp_replace(coalesce(p, ''), '(\s*·\s*)?สลับมาจาก \S+ \d{2}/\d{2}', '', 'g'), ' ·')
$fn$;

create or replace function public.fee_nurse_roster_swap(
  p_branch_a text, p_date_a date, p_branch_b text, p_date_b date
)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_user text;
  a fee.nurse_roster%rowtype;
  b fee.nurse_roster%rowtype;
  v_am_a text;
  v_am_b text;
begin
  v_user := fee.nurse_editor();
  if p_branch_a = p_branch_b and p_date_a = p_date_b then
    raise exception 'เลือกช่องเดียวกัน — ต้องเลือก 2 ช่องที่ต่างกัน';
  end if;

  select * into a from fee.nurse_roster r where r.branch = p_branch_a and r.work_date = p_date_a for update;
  select * into b from fee.nurse_roster r where r.branch = p_branch_b and r.work_date = p_date_b for update;
  if a.branch is null and b.branch is null then
    raise exception 'ทั้งสองช่องยังไม่มีพยาบาล — ไม่มีอะไรให้สลับ';
  end if;

  select r.am_group into v_am_a from fee.nurse_roster r
   where r.branch = p_branch_a and r.ym = to_char(p_date_a, 'YYYY-MM') and r.am_group <> '' limit 1;
  select r.am_group into v_am_b from fee.nurse_roster r
   where r.branch = p_branch_b and r.ym = to_char(p_date_b, 'YYYY-MM') and r.am_group <> '' limit 1;

  delete from fee.nurse_roster r
   where (r.branch = p_branch_a and r.work_date = p_date_a)
      or (r.branch = p_branch_b and r.work_date = p_date_b);

  -- เวรของ b ย้ายมาช่อง a
  if b.branch is not null then
    insert into fee.nurse_roster (ym, branch, work_date, nurse_label, lic_no, am_group, note, updated_by)
    values (to_char(p_date_a, 'YYYY-MM'), p_branch_a, p_date_a, b.nurse_label, b.lic_no,
            coalesce(v_am_a, ''),
            btrim(concat_ws(' · ', nullif(fee.nurse_unswap_note(b.note), ''),
              format('สลับมาจาก %s %s', p_branch_b, to_char(p_date_b, 'DD/MM')))), v_user);
  end if;
  -- เวรของ a ย้ายไปช่อง b
  if a.branch is not null then
    insert into fee.nurse_roster (ym, branch, work_date, nurse_label, lic_no, am_group, note, updated_by)
    values (to_char(p_date_b, 'YYYY-MM'), p_branch_b, p_date_b, a.nurse_label, a.lic_no,
            coalesce(v_am_b, ''),
            btrim(concat_ws(' · ', nullif(fee.nurse_unswap_note(a.note), ''),
              format('สลับมาจาก %s %s', p_branch_a, to_char(p_date_a, 'DD/MM')))), v_user);
  end if;

  return jsonb_build_object('ok', true,
    'a', coalesce(b.nurse_label, ''), 'b', coalesce(a.nurse_label, ''));
end
$fn$;

/* ------------------------------------------------------ ทะเบียนพยาบาล -- */
-- เพิ่ม/แก้ 1 คน · p = { licNo, nick, fullName, hsCode, homeBranch, dept, position, phone, active }

create or replace function public.fee_nurse_save(p jsonb)
returns jsonb
language plpgsql security definer
set search_path to ''
as $fn$
declare
  v_user text;
  v_lic  text := regexp_replace(coalesce(p->>'licNo', ''), '\D', '', 'g');
  v_br   text := upper(btrim(coalesce(p->>'homeBranch', '')));
begin
  v_user := fee.nurse_editor();
  if v_lic = '' then raise exception 'ต้องระบุเลขใบประกอบวิชาชีพ'; end if;
  if v_br <> '' and not exists (select 1 from fee.branch b where b.code = v_br) then
    raise exception 'ไม่รู้จักรหัสสาขา %', v_br;
  end if;

  insert into fee.nurse as n (lic_no, nick_name, full_name, hs_code, home_branch, dept, position,
                              phone, active, updated_by, updated_at)
  values (v_lic,
          fee.strip_nurse_title(p->>'nick'),
          btrim(coalesce(p->>'fullName', '')),
          upper(btrim(coalesce(p->>'hsCode', ''))),
          v_br,
          coalesce(nullif(btrim(p->>'dept'), ''), 'แผนกบริการ'),
          coalesce(nullif(btrim(p->>'position'), ''), 'พยาบาล(Nurse)'),
          btrim(coalesce(p->>'phone', '')),
          coalesce((p->>'active')::boolean, true),
          v_user, now())
  on conflict (lic_no) do update
    set nick_name = excluded.nick_name, full_name = excluded.full_name, hs_code = excluded.hs_code,
        home_branch = excluded.home_branch, dept = excluded.dept, position = excluded.position,
        phone = excluded.phone, active = excluded.active,
        updated_by = excluded.updated_by, updated_at = now();

  -- ช่องในตารางที่เคยจับคู่ไม่ได้ ลองจับคู่ใหม่ด้วยชื่อล่าสุด
  update fee.nurse_roster r set lic_no = fee.nurse_lic_of(r.nurse_label)
  where r.lic_no is null and fee.nurse_lic_of(r.nurse_label) is not null;

  return jsonb_build_object('ok', true, 'licNo', v_lic);
end
$fn$;

/* ---------------------------------------------- ทะเบียนพยาบาลตั้งต้น -- */
-- จากชีต EMPLOYEE ของ Mersi HR Roster (PosGroup = NURSE) จับคู่กับเลขใบประกอบในตารางเวรพยาบาล พ.ย. 69
-- เติมเฉพาะช่องที่ยังว่าง — ถ้า HR แก้ในหน้าเว็บไปแล้ว รันซ้ำจะไม่เขียนทับ
-- ฟิล์ม (6711351591) ไม่มีในชีต → เว้นรหัส/ชื่อ/สาขาไว้ให้กรอกเอง

insert into fee.nurse as n (lic_no, nick_name, full_name, hs_code, home_branch, dept, position, updated_by)
values
  ('6911367629', 'ต้าร์',  'น.ส.รัชนีกร เมืองจันทร์', 'BN690701', 'BN', 'แผนกบริการ', 'พยาบาล(Nurse)', 'seed'),
  ('6911367644', 'กี้',    'น.ส.ธนิดา หลักมั่น',      'BY690901', 'BY', 'แผนกบริการ', 'พยาบาล(Nurse)', 'seed'),
  ('6911367612', 'จุ๊',    'น.ส.จิตพร พิมพ์จันทร์',   'RP690901', 'RP', 'แผนกบริการ', 'พยาบาล(Nurse)', 'seed'),
  ('6911372131', 'อัน',    'น.ส.ชลฤดี เกิดผล',        'SM690904', 'SM', 'แผนกบริการ', 'พยาบาล(Nurse)', 'seed'),
  ('6711351591', 'ฟิล์ม',  '',                        '',         '',   'แผนกบริการ', 'พยาบาล(Nurse)', 'seed')
on conflict (lic_no) do update
  set nick_name   = case when n.nick_name   = '' then excluded.nick_name   else n.nick_name   end,
      full_name   = case when n.full_name   = '' then excluded.full_name   else n.full_name   end,
      hs_code     = case when n.hs_code     = '' then excluded.hs_code     else n.hs_code     end,
      home_branch = case when n.home_branch = '' then excluded.home_branch else n.home_branch end,
      position    = case when n.position in ('', 'พยาบาลวิชาชีพ(Registered Nurse)') then excluded.position else n.position end;

/* --------------------------------------------------------------- สิทธิ์ -- */

revoke all on function public.fee_nurse_roster_import(text, jsonb) from public, anon;
revoke all on function public.fee_nurse_roster_set(text, date, text, text, text) from public, anon;
revoke all on function public.fee_nurse_roster_swap(text, date, text, date) from public, anon;
revoke all on function public.fee_nurse_save(jsonb) from public, anon;
revoke all on function public.fee_nurse_roster_get(text) from public, anon;
revoke all on function fee.nurse_editor() from public, anon;

grant execute on function public.fee_nurse_roster_get(text) to authenticated;
grant execute on function public.fee_nurse_roster_import(text, jsonb) to authenticated;
grant execute on function public.fee_nurse_roster_set(text, date, text, text, text) to authenticated;
grant execute on function public.fee_nurse_roster_swap(text, date, text, date) to authenticated;
grant execute on function public.fee_nurse_save(jsonb) to authenticated;
grant execute on function fee.nurse_editor() to authenticated;

notify pgrst, 'reload schema';

select 'ตารางพยาบาล' as รายการ,
       (select count(*) from fee.nurse) as พยาบาลในทะเบียน,
       (select count(*) from fee.nurse_roster) as เวรในระบบ,
       '✅ ติดตั้งแล้ว' as สถานะ;
