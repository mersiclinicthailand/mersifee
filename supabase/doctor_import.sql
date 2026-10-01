-- ============================================================================
-- doctor_import.sql — นำเข้าทะเบียนแพทย์จากไฟล์ Excel "Data หมอ Update"
--
-- ไฟล์คือรายชื่อแพทย์ทั้งหมด (master) — นำเข้าซ้ำได้บ่อยเท่าที่ต้องการ
--   · คลังรายชื่อ (doctor_pool): เพิ่มคนใหม่ + อัปเดตข้อมูลตามไฟล์ทุกแถว
--     (คนในคลังที่ไม่อยู่ในไฟล์ใหม่ = เก็บไว้ ไม่ลบ)
--   · ทะเบียนแพทย์ (doctor) ของคนที่ขึ้นทะเบียนแล้ว:
--       FILL      = เติมเฉพาะช่องที่ยังว่าง (ค่าเริ่มต้น — ไม่ทับข้อมูลที่ HR แก้ไว้)
--       OVERWRITE = ทับทุกช่องที่ไฟล์มีค่าและต่างจากเดิม
--       NONE      = ไม่แตะทะเบียน
--     ไม่เคยเขียนค่าว่างทับข้อมูลเดิม
--   · p_dry = true → คืนผลเปรียบเทียบอย่างเดียว ไม่เขียนอะไร (ใช้แสดงตัวอย่างก่อนยืนยัน)
-- รันซ้ำได้
-- ============================================================================
create or replace function public.fee_doctor_import(
  p_rows jsonb, p_doc_mode text default 'FILL', p_dry boolean default true, p_file text default '',
  p_skip text[] default '{}')
returns jsonb language plpgsql security definer set search_path = fee, public as $$
declare
  v_mode text := upper(coalesce(nullif(p_doc_mode,''), 'FILL'));
  v_pool_new int; v_pool_chg int; v_pool_same int; v_changes jsonb; v_not_in_file jsonb;
  v_doc_upd int := 0;
begin
  if not fee.has_role(array['admin','it','hr']) then
    raise exception 'เฉพาะฝ่ายบุคคลหรือผู้ดูแลระบบเท่านั้น';
  end if;
  if v_mode not in ('FILL','OVERWRITE','NONE') then raise exception 'โหมดไม่ถูกต้อง: %', p_doc_mode; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'ไม่มีข้อมูลแพทย์ในไฟล์';
  end if;

  drop table if exists _imp; drop table if exists _chg;
  create temp table _imp on commit drop as
  select nullif(btrim(lic_no),'') lic_no,
         nullif(btrim(full_name),'') full_name, nullif(btrim(nick_name),'') nick_name,
         birth_date, nullif(btrim(id_card),'') id_card, nullif(btrim(contact),'') contact,
         nullif(btrim(address),'') address, nullif(btrim(bank),'') bank,
         nullif(btrim(bank_acc),'') bank_acc, nullif(btrim(source_branch),'') source_branch,
         fee.as_email(nullif(btrim(email),'')) email, nullif(btrim(note),'') note,
         nullif(btrim(rate_code),'') rate_code, rate_hourly
  from jsonb_to_recordset(p_rows) as x(
    lic_no text, full_name text, nick_name text, birth_date date, id_card text, contact text,
    address text, bank text, bank_acc text, source_branch text, email text, note text,
    rate_code text, rate_hourly numeric)
  where nullif(btrim(lic_no),'') is not null;

  -- เลข ว. ซ้ำในไฟล์ → ใช้แถวสุดท้าย (ตัวแปลงฝั่งเว็บรวมไว้ให้แล้ว แต่กันไว้อีกชั้น)
  delete from _imp a using _imp b where a.lic_no = b.lic_no and a.ctid < b.ctid;

  /* ---------- เปรียบเทียบกับคลังรายชื่อ ---------- */
  -- แพทย์ใหม่ = ไม่อยู่ทั้งในคลังและทะเบียน · เปลี่ยน = อยู่ในคลัง (ยังไม่ขึ้นทะเบียน) และข้อมูลต่างจากเดิม
  select count(*) filter (where p.lic_no is null and d.lic_no is null),
         count(*) filter (where p.lic_no is not null and d.lic_no is null and (
            p.full_name is distinct from coalesce(i.full_name, p.full_name)
         or p.nick_name is distinct from coalesce(i.nick_name, p.nick_name)
         or p.id_card   is distinct from coalesce(i.id_card,   p.id_card)
         or p.contact   is distinct from coalesce(i.contact,   p.contact)
         or p.address   is distinct from coalesce(i.address,   p.address)
         or p.bank      is distinct from coalesce(i.bank,      p.bank)
         or p.bank_acc  is distinct from coalesce(i.bank_acc,  p.bank_acc)
         or p.email     is distinct from coalesce(i.email,     p.email)
         or p.rate_code is distinct from coalesce(i.rate_code, p.rate_code)
         or p.source_branch is distinct from coalesce(i.source_branch, p.source_branch)
         or p.birth_date is distinct from coalesce(i.birth_date, p.birth_date))),
         0
    into v_pool_new, v_pool_chg, v_pool_same
  from _imp i left join fee.doctor_pool p on p.lic_no = i.lic_no
              left join fee.doctor d on d.lic_no = i.lic_no;
  v_pool_same := (select count(*) from _imp i where not exists (select 1 from fee.doctor d where d.lic_no = i.lic_no))
                 - v_pool_new - v_pool_chg;

  /* ---------- เปรียบเทียบกับทะเบียนแพทย์ (คนที่ขึ้นทะเบียนแล้ว) ---------- */
  create temp table _chg on commit drop as
  select d.lic_no, coalesce(nullif(d.nick_name,''), d.full_name) who, f.field, f.old_v, f.new_v
  from _imp i join fee.doctor d on d.lic_no = i.lic_no
  cross join lateral (values
    ('full_name', d.full_name, i.full_name), ('nick_name', d.nick_name, i.nick_name),
    ('id_card', d.id_card, i.id_card), ('contact', d.contact, i.contact),
    ('address', d.address, i.address), ('bank', d.bank, i.bank),
    ('bank_acc', d.bank_acc, i.bank_acc), ('email', d.email, i.email)
  ) f(field, old_v, new_v)
  where f.new_v is not null
    and coalesce(f.old_v,'') <> f.new_v
    and (v_mode = 'OVERWRITE'
         or (v_mode = 'FILL' and (coalesce(btrim(f.old_v),'') = ''
              -- ชื่อชั่วคราวที่ระบบตั้งให้ตอนยังไม่รู้ชื่อจริง ("แพทย์ ว.61540 (ฮาย)") นับเป็นช่องว่าง
              or (f.field = 'full_name' and f.old_v ~ '^แพทย์ ว\.'))));

  -- ช่องที่ HR เอาติ๊กออกในหน้าตัวอย่าง ("เลข ว.|ชื่อช่อง") → ไม่แก้
  delete from _chg where lic_no || '|' || field = any(coalesce(p_skip, '{}'));

  select coalesce(jsonb_agg(jsonb_build_object('licNo', lic_no, 'who', who, 'field', field,
           'old', coalesce(old_v,''), 'new', new_v) order by who, field), '[]'::jsonb)
    into v_changes from _chg;

  -- คนในทะเบียนที่ไม่มีในไฟล์ (เพิ่มเองในระบบ) — แจ้งให้ทราบเฉย ๆ ไม่ลบ
  select coalesce(jsonb_agg(jsonb_build_object('licNo', d.lic_no,
           'who', coalesce(nullif(d.nick_name,''), d.full_name)) order by d.lic_no), '[]'::jsonb)
    into v_not_in_file
  from fee.doctor d where not exists (select 1 from _imp i where i.lic_no = d.lic_no);

  if not p_dry then
    /* คลังรายชื่อ: เพิ่ม/อัปเดต (ค่าว่างในไฟล์ไม่ลบค่าเดิม) */
    insert into fee.doctor_pool(lic_no, full_name, nick_name, birth_date, id_card, contact, address,
                                bank, bank_acc, source_branch, payee_type, payee_name,
                                rate_code, rate_hourly, email, note, imported_at, promoted_at)
    select i.lic_no, coalesce(i.full_name,''), i.nick_name, i.birth_date, i.id_card, i.contact, i.address,
           i.bank, i.bank_acc, i.source_branch, 'PERSON', '', i.rate_code, i.rate_hourly, i.email, i.note, now(),
           case when exists (select 1 from fee.doctor d where d.lic_no = i.lic_no) then now() end
    from _imp i
    on conflict (lic_no) do update set
      full_name = coalesce(nullif(excluded.full_name,''), doctor_pool.full_name),
      nick_name = coalesce(excluded.nick_name, doctor_pool.nick_name),
      birth_date = coalesce(excluded.birth_date, doctor_pool.birth_date),
      id_card = coalesce(excluded.id_card, doctor_pool.id_card),
      contact = coalesce(excluded.contact, doctor_pool.contact),
      address = coalesce(excluded.address, doctor_pool.address),
      bank = coalesce(excluded.bank, doctor_pool.bank),
      bank_acc = coalesce(excluded.bank_acc, doctor_pool.bank_acc),
      source_branch = coalesce(excluded.source_branch, doctor_pool.source_branch),
      rate_code = coalesce(excluded.rate_code, doctor_pool.rate_code),
      rate_hourly = coalesce(excluded.rate_hourly, doctor_pool.rate_hourly),
      email = coalesce(excluded.email, doctor_pool.email),
      note = coalesce(excluded.note, doctor_pool.note),
      imported_at = now();

    /* ทะเบียนแพทย์: ใช้รายการเปลี่ยนที่คำนวณไว้แล้ว */
    if v_mode <> 'NONE' then
      update fee.doctor d set
        full_name = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'full_name'), d.full_name),
        nick_name = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'nick_name'), d.nick_name),
        id_card   = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'id_card'),   d.id_card),
        contact   = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'contact'),   d.contact),
        address   = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'address'),   d.address),
        bank      = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'bank'),      d.bank),
        bank_acc  = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'bank_acc'),  d.bank_acc),
        email     = coalesce((select new_v from _chg c where c.lic_no = d.lic_no and c.field = 'email'),     d.email),
        updated_at = now()
      where d.lic_no in (select lic_no from _chg);
      get diagnostics v_doc_upd = row_count;
    end if;

    perform fee.audit_write('DOCTOR_IMPORT', coalesce(nullif(p_file,''), 'excel'),
      format('ไฟล์ %s แถว · คลังใหม่ %s · คลังอัปเดต %s · ทะเบียนแก้ %s คน (%s ช่อง, โหมด %s)',
             (select count(*) from _imp), v_pool_new, v_pool_chg, v_doc_upd,
             jsonb_array_length(v_changes), v_mode));
  end if;

  return jsonb_build_object(
    'dry', p_dry, 'mode', v_mode, 'rows', (select count(*) from _imp),
    'poolNew', v_pool_new, 'poolChanged', v_pool_chg, 'poolSame', v_pool_same,
    'registered', (select count(*) from _imp i join fee.doctor d on d.lic_no = i.lic_no),
    'docChanges', v_changes, 'docUpdated', v_doc_upd,
    'notInFile', v_not_in_file);
end $$;
grant execute on function public.fee_doctor_import(jsonb, text, boolean, text, text[]) to authenticated;
