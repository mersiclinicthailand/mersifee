-- ============================================================================
-- roster_autolink.sql — แก้ "เพิ่ม/แก้แพทย์แล้ว รายการในกล่องต้องดำเนินการไม่หาย"
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → New query → วางทั้งก้อน → Run (รันซ้ำได้)
--
-- สาเหตุ: รายการ "ชื่อในตารางแพทย์ ยังไม่รู้ว่าใคร" มาจากช่องในตารางแพทย์ที่ยังไม่มีเลข ว.
--         ตอนเพิ่ม/แก้แพทย์ในทะเบียน ระบบไม่ได้ย้อนไปจับคู่ช่องในตารางแพทย์ให้
--         ช่องนั้นจึงยังว่าง → ยังขึ้นในรายการ
--
-- แก้:
--   1) ทุกครั้งที่เพิ่ม/แก้แพทย์ (ชื่อ ชื่อเล่น) → จับคู่ตารางแพทย์ที่ยังว่างใหม่ให้อัตโนมัติ
--   2) ปุ่มใหม่ "จับคู่" ในกล่องต้องดำเนินการ → เลือกหมอที่มีอยู่แล้ว (เช่น หมอก๊อต = หมอก๊อด ว.63225)
--      ระบบเติมเลข ว. ให้ทุกช่องที่เขียนชื่อนั้น + จำชื่อไว้ ไฟล์ตารางเวรเดือนหน้าจับคู่ได้เอง
--   3) จับคู่ข้อมูลที่ค้างอยู่ทั้งหมดใหม่ 1 รอบตอนรันไฟล์นี้
-- ============================================================================

/* ----------------- 1) จับคู่ช่องที่ยังว่าง ใช้ร่วมกันทุกจุด ----------------- */
create or replace function fee.roster_relink_all()
returns int language plpgsql security definer set search_path to '' as $fn$
declare n int;
begin
  update fee.roster r
     set lic_no = x.lic, pool_lic = null, updated_at = now()
    from (select r2.branch, r2.work_date,
                 fee.roster_find_lic(fee.strip_title(r2.doc_label), r2.branch) lic
            from fee.roster r2
           where coalesce(r2.lic_no, '') = '' and not fee.roster_is_off(r2.doc_label)) x
   where r.branch = x.branch and r.work_date = x.work_date and x.lic is not null;
  get diagnostics n = row_count;
  return n;
end $fn$;

/* ----------------- 2) เพิ่ม/แก้แพทย์ → จับคู่ใหม่อัตโนมัติ ----------------- */
create or replace function fee.doctor_after_save()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  perform fee.roster_relink_all();
  return null;
end $fn$;

drop trigger if exists doctor_relink_roster on fee.doctor;
create trigger doctor_relink_roster
  after insert or update of nick_name, full_name, lic_no on fee.doctor
  for each statement execute function fee.doctor_after_save();

/* ----------------- 3) จับคู่ "ชื่อในตารางแพทย์" กับหมอที่มีอยู่ ----------------- */
create or replace function public.fee_roster_assign_label(p_label text, p_lic text)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_role text; v_user text; v_n int; v_alias int := 0; b text;
begin
  select s.role::text into v_role from fee.staff s where s.id = auth.uid();
  if v_role is null or v_role not in ('admin', 'hr', 'acct', 'it') then
    raise exception 'บทบาทนี้ไม่มีสิทธิ์แก้ตารางแพทย์';
  end if;
  if not exists (select 1 from fee.doctor d where d.lic_no = btrim(p_lic)) then
    raise exception 'ไม่พบแพทย์ ว.% ในทะเบียน', p_lic;
  end if;
  select coalesce(p.username, '') into v_user from public.profiles p where p.id = auth.uid();

  update fee.roster r
     set lic_no = btrim(p_lic), pool_lic = null, updated_by = coalesce(v_user, ''), updated_at = now()
   where r.doc_label = p_label and coalesce(r.lic_no, '') = '';
  get diagnostics v_n = row_count;

  -- จำชื่อนี้ไว้ทุกสาขาที่เคยใช้ ไฟล์ตารางเวรครั้งหน้าจะจับคู่เอง (ถ้าตารางจับคู่ชื่อรับไม่ได้ ข้ามไป ไม่ล้มทั้งงาน)
  for b in select distinct r.branch from fee.roster r where r.doc_label = p_label loop
    begin
      insert into fee.alias (alias, branch, lic_no)
      values (fee.strip_title(p_label), b, btrim(p_lic))
      on conflict do nothing;
      v_alias := v_alias + 1;
    exception when others then null;
    end;
  end loop;

  return jsonb_build_object('updated', v_n, 'aliases', v_alias);
end $fn$;

revoke all on function public.fee_roster_assign_label(text, text) from public, anon;
grant execute on function public.fee_roster_assign_label(text, text) to authenticated;
revoke all on function fee.roster_relink_all() from public, anon, authenticated;

/* ----------------- 4) จับคู่ข้อมูลที่ค้างอยู่ทั้งหมด 1 รอบ ----------------- */
select fee.roster_relink_all() as จับคู่ใหม่ได้_เวร;
