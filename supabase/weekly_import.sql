-- ============================================================================
-- weekly_import.sql — นำเข้ารายงานค่าหัตถการรายสัปดาห์ + ปิดยอดสิ้นเดือน
--                     + อัตราสำรอง (ไม่บล็อกเมื่อไม่มีอัตราตรงสาขา/วันที่)
--
-- หลักการ
--   · นำเข้าแบบ WEEK      = แทนที่เฉพาะแถวในช่วงวันที่ของไฟล์ ข้อมูลวันอื่นของเดือนอยู่ครบ
--   · นำเข้าแบบ MONTH_END = ปิดยอดสิ้นเดือน แทนที่ทั้งเดือน (ไฟล์เต็มเดือน)
--   · นำเข้าแบบ FULL      = แบบเดิม (ทั้งเดือน) — ฟังก์ชันเดิม fee_import_proc ยังใช้ได้
--   · ทุกครั้งที่นำเข้า เก็บ "ยอดของไฟล์นั้น" แยกรายแพทย์รายวันไว้ใน fee.import_day
--     ไม่ลบทิ้งแม้ถูกไฟล์ใหม่แทนที่ → ย้อนดูยอดแต่ละสัปดาห์ได้ตลอด
--   · ยอดเดิมในช่วงวันที่ก่อนแทนที่ (prev_sum) ถูกบันทึกไว้เพื่อเทียบส่วนต่าง
-- รันซ้ำได้ (idempotent)
-- ============================================================================

alter table fee.import_log add column if not exists mode      text not null default 'FULL';
alter table fee.import_log add column if not exists date_from date;
alter table fee.import_log add column if not exists date_to   date;
alter table fee.import_log add column if not exists prev_sum  numeric;
alter table fee.import_log add column if not exists label     text not null default '';

create table if not exists fee.import_day (
  import_id uuid    not null references fee.import_log(id) on delete cascade,
  pid       text    not null,
  lic_no    text    not null default '',
  emp_raw   text    not null default '',   -- ใช้เมื่อยังจับคู่ชื่อไม่ได้ (lic_no ว่าง)
  work_date date,
  amount    numeric not null default 0,
  rows      integer not null default 0
);
create index if not exists import_day_imp on fee.import_day(import_id);
create index if not exists import_day_pid on fee.import_day(pid);

alter table fee.import_day enable row level security;
drop policy if exists p_impday_r on fee.import_day;
create policy p_impday_r on fee.import_day for select to authenticated
  using (exists (select 1 from fee.period p where p.pid = import_day.pid and fee.can(p.branch)));
grant select on fee.import_day to authenticated;
-- ไม่มี policy เขียน: snapshot แก้/ลบจากหน้าเว็บไม่ได้ เขียนผ่านฟังก์ชันนำเข้าเท่านั้น

-- ย้อนเติมข้อมูลของไฟล์ที่ใช้อยู่ก่อนหน้านี้ (นำเข้าแบบทั้งเดือน)
update fee.import_log set
  date_from = coalesce(date_from, to_date(ym || '-01', 'YYYY-MM-DD')),
  date_to   = coalesce(date_to, (to_date(ym || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date)
where kind = 'PROC';

insert into fee.import_day(import_id, pid, lic_no, emp_raw, work_date, amount, rows)
select i.id, p.pid, p.lic_no, case when p.lic_no = '' then p.emp_raw else '' end,
       p.bill_date, round(sum(p.fee), 2), count(*)
from fee.import_log i
join fee.proc p on p.pid = i.pid and p.is_doctor
where i.kind = 'PROC' and i.status = 'OK'
  and not exists (select 1 from fee.import_day d where d.import_id = i.id)
group by i.id, p.pid, p.lic_no, case when p.lic_no = '' then p.emp_raw else '' end, p.bill_date;

-- อัตรากลาง (สำรองชั้นสุดท้าย) — แก้ได้ที่หน้า ตั้งค่า · ว่าง = ไม่ใช้ (กลับไปบล็อก)
insert into fee.config(key, value, note)
values ('DEFAULT_HOURLY_RATE', '700',
        'อัตรากลาง/ชม. ใช้คำนวณไปก่อนเมื่อแพทย์ไม่มีอัตราในทะเบียนและไม่มีในคลังรายชื่อ (ขึ้นคำเตือน ไม่บล็อก) · เว้นว่าง = บล็อกจนกว่าจะตั้งอัตรา')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- คำนวณสรุปของรอบใหม่จากแถวดิบทั้งหมด (ใช้ร่วมกันทั้งนำเข้าและจับคู่ใหม่)
-- ---------------------------------------------------------------------------
create or replace function fee.rebuild_proc(p_pid text)
returns void language plpgsql security definer set search_path = fee, public as $$
declare v_un jsonb; v_dup int;
begin
  delete from fee.proc_day where pid = p_pid;
  insert into fee.proc_day(pid, lic_no, work_date, amount, rows)
  select p_pid, lic_no, bill_date, round(sum(fee),2), count(*)
  from fee.proc where pid = p_pid and is_doctor and lic_no <> '' and bill_date is not null
  group by lic_no, bill_date;

  select coalesce(jsonb_agg(jsonb_build_object('name', emp_raw, 'count', c, 'sum', s)), '[]'::jsonb)
    into v_un
  from (select emp_raw, count(*) c, round(sum(fee),2) s from fee.proc
        where pid = p_pid and is_doctor and lic_no = '' group by emp_raw) q;

  select count(*) into v_dup from (
    select fingerprint from fee.proc
    where pid = p_pid and is_doctor and fingerprint <> ''
    group by fingerprint having count(*) > 1) q;

  update fee.period set unmatched = v_un, dup_groups = v_dup,
         status = case when status = 'NONE' then 'DRAFT' else status end
   where pid = p_pid;
  perform fee.refresh_summary(p_pid);
end $$;

-- ---------------------------------------------------------------------------
-- นำเข้ารายงานค่าหัตถการ (รุ่นใหม่)
-- ---------------------------------------------------------------------------
create or replace function public.fee_import_proc2(
  p_branch text, p_ym text, p_rows jsonb, p_file text, p_hash text,
  p_mode text default 'FULL', p_from date default null, p_to date default null,
  p_label text default '')
returns jsonb language plpgsql security definer set search_path = fee, public as $$
declare
  v_pid text; v_other text; v_id uuid;
  m_start date := to_date(p_ym || '-01', 'YYYY-MM-DD');
  m_end   date := (to_date(p_ym || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;
  v_from date; v_to date; v_mode text := upper(coalesce(nullif(p_mode,''), 'FULL'));
  n_doc int; n_all int; v_sum numeric; v_prev numeric; n_out int;
begin
  if v_mode not in ('WEEK','MONTH_END','FULL') then
    raise exception 'ชนิดการนำเข้าไม่ถูกต้อง: %', p_mode;
  end if;
  v_pid := fee.ensure_period(p_branch, p_ym);
  perform fee.assert_editable(v_pid);

  if v_mode = 'WEEK' then
    v_from := greatest(coalesce(p_from, m_start), m_start);
    v_to   := least(coalesce(p_to, m_end), m_end);
    if v_from > v_to then raise exception 'ช่วงวันที่ไม่ถูกต้อง'; end if;
  else
    v_from := m_start; v_to := m_end;
  end if;

  -- แถวที่วันที่อยู่นอกช่วง = ไฟล์ไม่ตรงกับช่วงที่เลือก → หยุด (กันยอดซ้อน)
  select count(*) into n_out from jsonb_array_elements(p_rows) r
   where nullif(r->>'billDate','') is not null
     and ((r->>'billDate')::date < v_from or (r->>'billDate')::date > v_to);
  if n_out > 0 then
    raise exception 'ไฟล์มี % แถวที่วันที่อยู่นอกช่วง % ถึง % — ตรวจช่วงวันที่ที่เลือก', n_out, v_from, v_to;
  end if;

  -- ไฟล์เดียวกันเคยเข้า "รอบอื่น" = เลือกสาขา/เดือนผิด ต้องหยุดถาม
  select pid into v_other from fee.import_log
   where file_hash = p_hash and kind = 'PROC' and pid <> v_pid and status in ('OK','PARTIAL') limit 1;
  if v_other is not null then
    raise exception 'ไฟล์นี้เคยนำเข้าที่รอบ % แล้ว — ตรวจว่าเลือกสาขา/เดือนถูกต้องหรือไม่', v_other;
  end if;

  select coalesce(sum(fee),0) into v_prev from fee.proc
   where pid = v_pid and is_doctor and bill_date between v_from and v_to;

  -- สถานะไฟล์เดิม: ถูกครอบทั้งช่วง = แทนที่แล้ว · ทับบางส่วน = แทนที่บางส่วน
  update fee.import_log set status = case
      when coalesce(date_from, m_start) >= v_from and coalesce(date_to, m_end) <= v_to then 'REPLACED'
      else 'PARTIAL' end
   where pid = v_pid and kind = 'PROC' and status in ('OK','PARTIAL')
     and coalesce(date_from, m_start) <= v_to and coalesce(date_to, m_end) >= v_from;

  if v_mode = 'WEEK' then
    delete from fee.proc where pid = v_pid and bill_date between v_from and v_to;
  else
    delete from fee.proc where pid = v_pid;
  end if;

  insert into fee.proc(pid, branch, ym, bill_date, hn, emp_raw, lic_no, course, qty, doc_no,
                       fee, is_doctor, import_id, src_row, fingerprint)
  select v_pid, p_branch, p_ym,
         nullif(r->>'billDate','')::date, coalesce(r->>'hn',''), coalesce(r->>'empRaw',''),
         coalesce(r->>'licNo',''), coalesce(r->>'course',''),
         coalesce((r->>'qty')::numeric,0), coalesce(r->>'docNo',''),
         coalesce((r->>'fee')::numeric,0), coalesce((r->>'isDoctor')::boolean,false),
         p_hash, (r->>'srcRow')::int, coalesce(r->>'fingerprint','')
  from jsonb_array_elements(p_rows) r;

  select count(*) filter (where coalesce((r->>'isDoctor')::boolean,false)), count(*),
         coalesce(sum((r->>'fee')::numeric) filter (where coalesce((r->>'isDoctor')::boolean,false)),0)
    into n_doc, n_all, v_sum from jsonb_array_elements(p_rows) r;

  insert into fee.import_log(pid, branch, ym, kind, file_name, file_hash, rows_read,
                             rows_doctor, rows_other, sum_doctor_fee, by_user,
                             mode, date_from, date_to, prev_sum, label)
  values (v_pid, p_branch, p_ym, 'PROC', p_file, p_hash, n_all, n_doc, n_all - n_doc,
          v_sum, fee.username(), v_mode, v_from, v_to, v_prev, coalesce(p_label,''))
  returning id into v_id;

  -- snapshot ยอดของไฟล์นี้ — เก็บถาวร
  insert into fee.import_day(import_id, pid, lic_no, emp_raw, work_date, amount, rows)
  select v_id, v_pid, lic, case when lic = '' then emp else '' end, d, round(sum(f),2), count(*)
  from (select coalesce(r->>'licNo','') lic, coalesce(r->>'empRaw','') emp,
               nullif(r->>'billDate','')::date d, coalesce((r->>'fee')::numeric,0) f
        from jsonb_array_elements(p_rows) r
        where coalesce((r->>'isDoctor')::boolean,false)) q
  group by lic, case when lic = '' then emp else '' end, d;

  perform fee.rebuild_proc(v_pid);
  perform fee.audit_write('IMPORT_PROC', v_pid,
    format('%s %s–%s · อ่าน %s แถว / แพทย์ %s แถว / ยอด %s (ยอดเดิมในช่วง %s)',
           v_mode, v_from, v_to, n_all, n_doc, v_sum, v_prev));

  return jsonb_build_object('pid', v_pid, 'importId', v_id, 'mode', v_mode,
                            'dateFrom', v_from, 'dateTo', v_to,
                            'rowsRead', n_all, 'rowsDoctor', n_doc, 'rowsOther', n_all - n_doc,
                            'sumDoctorFee', v_sum, 'prevSum', v_prev);
end $$;
grant execute on function public.fee_import_proc2(text,text,jsonb,text,text,text,date,date,text) to authenticated;

-- ฟังก์ชันเดิม (หน้าเว็บรุ่นก่อน) — ยังใช้ได้ เท่ากับนำเข้าแบบทั้งเดือน
create or replace function public.fee_import_proc(p_branch text, p_ym text, p_rows jsonb, p_file text,
  p_hash text, p_unmatched jsonb default '[]'::jsonb, p_dup_groups integer default 0)
returns jsonb language plpgsql security definer set search_path = fee, public as $$
begin
  return public.fee_import_proc2(p_branch, p_ym, p_rows, p_file, p_hash, 'FULL', null, null, '');
end $$;

-- ---------------------------------------------------------------------------
-- ประวัติการนำเข้า + ยอดรายแพทย์ของแต่ละไฟล์ (snapshot)
-- ---------------------------------------------------------------------------
create or replace function public.fee_import_history(p_branch text, p_ym text)
returns jsonb language plpgsql stable security definer set search_path = fee, public as $$
declare v_pid text := p_branch || '-' || replace(p_ym,'-','');
begin
  if not fee.can(p_branch) then raise exception 'ไม่มีสิทธิ์เข้าถึงข้อมูลสาขา %', p_branch; end if;
  return (
    select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
      select jsonb_build_object(
        'id', i.id, 'mode', i.mode, 'label', i.label, 'fileName', i.file_name,
        'dateFrom', i.date_from, 'dateTo', i.date_to,
        'rowsRead', i.rows_read, 'rowsDoctor', i.rows_doctor, 'sumDoctorFee', i.sum_doctor_fee,
        'prevSum', i.prev_sum, 'status', i.status, 'by', i.by_user, 'at', i.at,
        'doctors', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'licNo', q.lic_no, 'name', q.nm, 'amount', q.amt, 'rows', q.n, 'days', q.days)
                   order by q.amt desc), '[]'::jsonb)
          from (select d.lic_no,
                       coalesce(nullif(doc.nick_name,''), doc.full_name, d.emp_raw) nm,
                       sum(d.amount) amt, sum(d.rows) n, count(distinct d.work_date) days
                from fee.import_day d left join fee.doctor doc on doc.lic_no = d.lic_no and d.lic_no <> ''
                where d.import_id = i.id
                group by d.lic_no, coalesce(nullif(doc.nick_name,''), doc.full_name, d.emp_raw)) q)
      ) x
      from fee.import_log i where i.pid = v_pid and i.kind = 'PROC') s);
end $$;
grant execute on function public.fee_import_history(text,text) to authenticated;

-- จับคู่ชื่อใหม่ — ใช้ตัวสรุปร่วม (dup/unmatched คำนวณจากข้อมูลทั้งเดือน)
create or replace function public.fee_rematch(p_branch text, p_ym text)
returns jsonb language plpgsql security definer set search_path = fee, public as $$
declare v_pid text := p_branch || '-' || replace(p_ym,'-',''); n int; v_un jsonb;
begin
  if not fee.can(p_branch) then raise exception 'ไม่มีสิทธิ์สาขา %', p_branch; end if;
  perform fee.assert_editable(v_pid);

  update fee.proc pr set lic_no = a.lic_no
  from fee.alias a
  where pr.pid = v_pid and pr.is_doctor and pr.lic_no = ''
    and trim(pr.emp_raw) = a.alias and (a.branch = '' or a.branch = p_branch);
  get diagnostics n = row_count;

  perform fee.rebuild_proc(v_pid);
  select unmatched into v_un from fee.period where pid = v_pid;
  perform fee.audit_write('REMATCH', v_pid, format('จับคู่เพิ่ม %s รายการ', n));
  return jsonb_build_object('matched', n, 'unmatched', coalesce(v_un, '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- fee_workspace: เพิ่มอัตราของแพทย์ในรอบนี้ทุกสาขา (ใช้อธิบาย/สำรอง), อัตราในคลังรายชื่อ,
--                และข้อมูลช่วงวันที่ของแต่ละไฟล์ที่นำเข้า
-- ---------------------------------------------------------------------------
create or replace function public.fee_workspace(p_branch text, p_ym text)
returns jsonb language plpgsql stable security definer set search_path = fee, public as $function$
declare v jsonb; v_pid text := p_branch || '-' || replace(p_ym,'-','');
begin
  if not fee.can(p_branch) then raise exception 'ไม่มีสิทธิ์เข้าถึงข้อมูลสาขา %', p_branch; end if;
  select jsonb_build_object(
    'pid', v_pid, 'branch', p_branch, 'ym', p_ym,
    'period', (select to_jsonb(p) from fee.period p where p.pid = v_pid),
    'procDays', (select coalesce(jsonb_agg(jsonb_build_object(
        'licNo', d.lic_no, 'workDate', d.work_date, 'amount', d.amount, 'rows', d.rows)), '[]'::jsonb)
        from fee.proc_day d where d.pid = v_pid),
    'shifts', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'licNo', s.lic_no, 'workDate', s.work_date,
        'timeIn', s.time_in, 'timeOut', s.time_out, 'breakMin', s.break_min,
        'specialAmt', coalesce(s.special_amt::text,''), 'handOverride', coalesce(s.hand_override::text,''),
        'deductOther', s.deduct_other, 'kind', s.kind, 'note', s.note, 'source', s.source,
        'signId', coalesce(s.sign_id::text,''), 'signedAt', coalesce(s.signed_at::text,''))
        order by s.lic_no, s.work_date, s.time_in), '[]'::jsonb)
        from fee.shift s where s.pid = v_pid
          and (fee.lic() is null or s.lic_no = fee.lic())),
    'doctors', (select coalesce(jsonb_agg(jsonb_build_object(
        'licNo', d.lic_no, 'fullName', d.full_name, 'nickName', d.nick_name,
        'bank', d.bank, 'bankAcc', d.bank_acc, 'idCard', d.id_card,
        'address', d.address, 'contact', d.contact,
        'payeeType', d.payee_type, 'payeeName', d.payee_name)), '[]'::jsonb)
        from fee.doctor d where d.status = 'ACTIVE'),
    'rates', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'licNo', r.lic_no, 'branch', r.branch, 'hourlyRate', r.hourly_rate,
        'taxBase', r.tax_base, 'taxRate', r.tax_rate, 'handMethod', r.hand_method,
        'effFrom', r.eff_from, 'effTo', coalesce(r.eff_to::text,''))), '[]'::jsonb)
        from fee.rate r
        where r.branch = '' or r.branch = p_branch
           or regexp_replace(r.lic_no, '^[^0-9A-Za-z]+', '') in (
                select s.lic_no from fee.shift s where s.pid = v_pid
                union select d.lic_no from fee.proc_day d where d.pid = v_pid)),
    'poolRates', (select coalesce(jsonb_agg(jsonb_build_object(
        'licNo', pl.lic_no, 'rateHourly', pl.rate_hourly, 'rateCode', pl.rate_code)), '[]'::jsonb)
        from fee.doctor_pool pl
        where coalesce(pl.rate_hourly,0) > 0 and pl.lic_no in (
                select s.lic_no from fee.shift s where s.pid = v_pid
                union select d.lic_no from fee.proc_day d where d.pid = v_pid)),
    'adjusts', (select coalesce(jsonb_agg(jsonb_build_object(
        'licNo', a.lic_no, 'kind', a.kind, 'amount', a.amount, 'reason', a.reason)), '[]'::jsonb)
        from fee.adjust a where a.pid = v_pid and a.approved_by is not null),
    'signs', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'licNo', g.lic_no, 'kind', g.kind, 'refId', g.ref_id,
        'signerName', g.signer_name, 'signedAt', g.signed_at, 'method', g.method,
        'dataHash', g.data_hash, 'fileUrl', g.file_url, 'by', g.by_user, 'note', g.note)), '[]'::jsonb)
        from fee.sign g where g.pid = v_pid),
    'aliases', (select coalesce(jsonb_agg(jsonb_build_object(
        'alias', a.alias, 'licNo', a.lic_no, 'branch', a.branch,
        'confirmedBy', a.confirmed_by, 'confirmedAt', a.confirmed_at)), '[]'::jsonb)
        from fee.alias a where a.branch = '' or a.branch = p_branch),
    'imports', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'fileName', i.file_name, 'rowsRead', i.rows_read,
        'rowsDoctor', i.rows_doctor, 'rowsOther', i.rows_other,
        'sumDoctorFee', i.sum_doctor_fee, 'status', i.status,
        'mode', i.mode, 'dateFrom', i.date_from, 'dateTo', i.date_to,
        'prevSum', i.prev_sum, 'label', i.label,
        'by', i.by_user, 'at', i.at, 'note', i.note) order by i.at desc), '[]'::jsonb)
        from fee.import_log i where i.pid = v_pid),
    'history', (select coalesce(jsonb_agg(jsonb_build_object(
        'step', h.step, 'action', h.action, 'actor', h.actor, 'at', h.at, 'note', h.note)
        order by h.at desc), '[]'::jsonb)
        from fee.approval h where h.pid = v_pid)
  ) into v;
  return v;
end $function$;
