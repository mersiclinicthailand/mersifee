-- ============================================================================
-- registry_todo.sql — รายชื่อแพทย์ที่ต้องขึ้นทะเบียน / กรอกข้อมูลให้ครบ
--
-- ดูเฉพาะแพทย์ที่ "มีงานจริง" ใน 3 เดือนล่าสุด (เดือนก่อน 2 เดือน → อนาคต)
-- จาก ตารางแพทย์ (roster) · ใบเวร (shift) · ยอดค่ามือ (proc_day)
-- แล้วแยกเป็น
--   UNREGISTERED — มีเลข ว. ในงาน แต่ไม่มีในทะเบียนแพทย์
--   POOL         — ตารางแพทย์จับคู่ได้แค่ในคลังรายชื่อ ยังไม่ขึ้นทะเบียน
--   UNKNOWN      — ชื่อในตารางแพทย์ที่ยังไม่รู้ว่าเป็นใคร (ไม่มีเลข ว.)
--   INCOMPLETE   — อยู่ในทะเบียนแล้ว แต่ข้อมูลไม่ครบ หรือไม่มีอัตราของสาขา/เดือนที่ทำงาน
-- รันซ้ำได้
-- ============================================================================
create or replace function public.fee_registry_todo()
returns jsonb language plpgsql stable security definer set search_path = fee, public as $$
declare v_cut text := to_char(date_trunc('month', now()) - interval '2 months', 'YYYY-MM');
begin
  if fee.me() is null then raise exception 'ต้องเข้าสู่ระบบ'; end if;
  return (
  with use as (            -- งานจริง: (lic, branch, ym)
    select r.lic_no lic, r.branch, r.ym from fee.roster r
     where r.ym >= v_cut and coalesce(r.lic_no,'') <> ''
    union select s.lic_no, s.branch, to_char(s.work_date,'YYYY-MM') from fee.shift s
     where to_char(s.work_date,'YYYY-MM') >= v_cut and coalesce(s.lic_no,'') <> ''
    union select d.lic_no, p.branch, p.ym from fee.proc_day d join fee.period p on p.pid = d.pid
     where p.ym >= v_cut and coalesce(d.lic_no,'') <> ''
  ),
  lics as (
    select lic, array_agg(distinct branch order by branch) branches, max(ym) last_ym
    from use group by lic
  ),
  gaps as (                -- สาขา/เดือนที่ทำงาน แต่ไม่มีอัตราที่มีผลในเดือนนั้นเลย
    select u.lic, jsonb_agg(distinct jsonb_build_object('branch', u.branch, 'ym', u.ym)) g
    from use u
    where not exists (
      select 1 from fee.rate r
      where regexp_replace(r.lic_no, '^[^0-9A-Za-z]+', '') = u.lic
        and (r.branch = '' or r.branch = u.branch)
        and coalesce(r.eff_from, date '1900-01-01') <= (to_date(u.ym || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
        and coalesce(r.eff_to, date '2999-12-31') >= to_date(u.ym || '-01','YYYY-MM-DD'))
    group by u.lic
  ),
  reg as (
    select l.lic, l.branches, l.last_ym, d.lic_no is not null registered,
           d.full_name, d.nick_name, d.status,
           array_remove(array[
             case when d.lic_no is not null and coalesce(trim(d.full_name),'') = '' then 'full_name' end,
             case when d.lic_no is not null and coalesce(trim(d.bank),'') = '' then 'bank' end,
             case when d.lic_no is not null and coalesce(trim(d.bank_acc),'') = '' then 'bank_acc' end,
             case when d.lic_no is not null and coalesce(trim(d.id_card),'') = '' then 'id_card' end,
             case when d.lic_no is not null and coalesce(trim(d.address),'') = '' then 'address' end,
             case when d.lic_no is not null and coalesce(trim(d.email),'') = '' then 'email' end,
             case when d.lic_no is not null and d.payee_type <> 'PERSON'
                       and coalesce(trim(d.payee_name),'') = '' then 'payee_name' end,
             case when d.lic_no is not null and d.status <> 'ACTIVE' then 'inactive' end
           ], null) missing,
           g.g rate_gaps,
           pl.full_name pool_name, pl.nick_name pool_nick
    from lics l
    left join fee.doctor d on d.lic_no = l.lic
    left join gaps g on g.lic = l.lic
    left join fee.doctor_pool pl on pl.lic_no = l.lic
  ),
  items as (
    select jsonb_build_object(
      'key', 'L:' || lic, 'licNo', lic,
      'kind', case when registered then 'INCOMPLETE' else 'UNREGISTERED' end,
      'name', coalesce(nullif(full_name,''), pool_name, ''),
      'nick', coalesce(nullif(nick_name,''), pool_nick, ''),
      'inPool', pool_name is not null,
      'branches', to_jsonb(branches), 'lastYm', last_ym,
      'missing', to_jsonb(missing), 'rateGaps', coalesce(rate_gaps, '[]'::jsonb)) j
    from reg
    where not registered or cardinality(missing) > 0 or rate_gaps is not null
    union all             -- จับคู่ได้แค่ในคลัง
    select jsonb_build_object(
      'key', 'P:' || r.pool_lic, 'licNo', r.pool_lic, 'kind', 'POOL',
      'name', coalesce(max(pl.full_name), ''), 'nick', coalesce(max(pl.nick_name), max(r.doc_label)),
      'inPool', true,
      'branches', to_jsonb(array_agg(distinct r.branch order by r.branch)), 'lastYm', max(r.ym),
      'missing', '[]'::jsonb, 'rateGaps', '[]'::jsonb, 'days', count(*))
    from fee.roster r left join fee.doctor_pool pl on pl.lic_no = r.pool_lic
    where r.ym >= v_cut and coalesce(r.lic_no,'') = '' and coalesce(r.pool_lic,'') <> ''
      and not exists (select 1 from fee.doctor d where d.lic_no = r.pool_lic)
      and not exists (select 1 from lics l where l.lic = r.pool_lic)
    group by r.pool_lic
    union all             -- ชื่อในตารางแพทย์ที่ยังไม่รู้ว่าใคร
    select jsonb_build_object(
      'key', 'U:' || r.doc_label, 'licNo', '', 'kind', 'UNKNOWN',
      'name', '', 'nick', r.doc_label, 'inPool', false,
      'branches', to_jsonb(array_agg(distinct r.branch order by r.branch)), 'lastYm', max(r.ym),
      'missing', '[]'::jsonb, 'rateGaps', '[]'::jsonb, 'days', count(*))
    from fee.roster r
    where r.ym >= v_cut and coalesce(r.lic_no,'') = '' and coalesce(r.pool_lic,'') = ''
      and coalesce(trim(r.doc_label),'') <> '' and not fee.roster_is_off(r.doc_label)
    group by r.doc_label
  )
  select coalesce(jsonb_agg(j order by
           case j->>'kind' when 'UNREGISTERED' then 0 when 'POOL' then 1 when 'UNKNOWN' then 2 else 3 end,
           j->>'lastYm' desc, j->>'nick'), '[]'::jsonb)
  from items);
end $$;
grant execute on function public.fee_registry_todo() to authenticated;
