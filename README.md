# MersiFee v2 — ระบบค่าหัตถการและค่าตอบแทนแพทย์ Mersi Clinic

เว็บแอปแทนระบบเดิมที่รันบน Google Apps Script · 14 สาขา

**สแตก:** React + Vite → Cloudflare Pages · Postgres → Supabase (ฟรีทั้งหมด)
ใช้โปรเจกต์ Supabase เดียวกับ Mersi CRM (`yrzgorkgxhjxwgpkdggo`) แต่แยก schema `fee`
บัญชีผู้ใช้และรหัสผ่านใช้ร่วมกับ CRM

---

## ตั้งค่า Cloudflare Pages (ทำครั้งเดียว)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages**
2. **Connect to Git** → เลือก repo `mersiclinicthailand/mersifee`
3. ตั้งค่า build:

   | ช่อง | ค่า |
   |---|---|
   | Framework preset | **None** (หรือ Vite) |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | เว้นว่าง |

4. กด **Save and Deploy**

ตั้งเสร็จแล้ว **ครั้งต่อไปแค่ `git push` Cloudflare จะ build และ deploy ให้เอง**
ไม่ต้องอัปโหลดไฟล์ผ่านเบราว์เซอร์อีกเลย

### ตัวแปรสภาพแวดล้อม

ไฟล์ `.env` ถูก commit ไว้ในรีโปแล้ว build จึงผ่านทันทีโดยไม่ต้องตั้งอะไรเพิ่ม

ถ้าต้องการย้ายไปโปรเจกต์ Supabase อื่น ให้ตั้งที่ Cloudflare →
**Settings → Environment variables** (ค่าที่ตั้งตรงนั้นจะทับไฟล์ `.env`):

```
VITE_SUPABASE_URL       = https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY  = sb_publishable_xxxx
```

> **กุญแจใน `.env` เป็น publishable key** — ออกแบบมาให้อยู่ในโค้ดฝั่งเบราว์เซอร์ได้
> มันถูกฝังใน bundle อยู่แล้วไม่ว่าจะ commit หรือไม่ ความปลอดภัยจริงมาจาก RLS
> ที่ฐานข้อมูล ไม่ใช่การซ่อนกุญแจนี้ · ผู้ที่ยังไม่ล็อกอินเรียก RPC ของระบบไม่ได้เลย
> และอ่านตารางใน schema `fee` ไม่ได้
>
> ถึงอย่างนั้น **ควรตั้งรีโปเป็น private** เพราะเป็นระบบจ่ายเงินภายใน

---

## โครงไฟล์

```
src/
  lib/
    core.ts      ยูทิลิตี้พื้นฐาน — วันที่ไทย เวลา ตัวเลข แฮช (พอร์ตตรงจาก Code.gs)
    calc.ts      เครื่องคำนวณ calcCore — ฟังก์ชันบริสุทธิ์ ทดสอบด้วย node ได้
    export.ts    สร้างไฟล์ Excel ตามฟอร์มเดิม ด้วย ExcelJS ในเบราว์เซอร์
    parse.ts     อ่านไฟล์ Excel ที่นำเข้า (SheetJS) — ไฟล์ไม่ถูกอัปโหลดขึ้นเซิร์ฟเวอร์
    api.ts       ชั้นเรียกข้อมูล — หนึ่งหน้าจอ = หนึ่งคำขอ + แคชผูกกับรอบ
    auth.tsx     ล็อกอินด้วยชื่อผู้ใช้ (บัญชีร่วมกับ Mersi CRM)
    supabase.ts  ตั้งค่า client
  pages/         9 แท็บ: ภาพรวม นำเข้า ใบเวร ลงเวลา คำนวณ กระทบยอด อนุมัติ ทะเบียน ตั้งค่า
  components/    ชิ้นส่วน UI ที่ใช้ร่วมกัน (การ์ด ตาราง ป้ายสถานะ แผ่นเซ็น)

verify/
  parity.mjs     เทียบเครื่องคำนวณตัวใหม่กับ Code.gs ตัวเดิมทีละค่า (33 กรณี)
  e2e.mjs        ตรวจยอดปลายทางจากข้อมูลที่อยู่ใน Postgres จริง (15 กรณี)
  export.mjs     ตรวจไฟล์ Excel ที่สร้าง ทีละเซลล์ (69 กรณี)

supabase/
  Migrate.gs     สคริปต์ย้ายข้อมูลจากชีตเดิม — วางในชีต MersiFee_DB แล้วรันครั้งเดียว
```

## คำสั่ง

```bash
npm install
npm run dev       # เปิดที่ localhost:5173
npm run build     # สร้าง dist/ (Cloudflare ใช้คำสั่งนี้)
npm run preview   # ดู dist ที่ build แล้ว
```

## ชุดทดสอบ

```bash
npx tsc -p tsconfig.verify.json
sed -i "s#from './core'#from './core.js'#g; s#from './calc'#from './calc.js'#g" verify/build/*.js
node verify/e2e.mjs && node verify/export.mjs
```

`parity.mjs` ต้องใช้ไฟล์จากระบบเดิมซึ่งไม่ได้อยู่ในรีโป ระบุพาธเอง:

```bash
LEGACY_CODE=/path/to/Code.gs FIXTURE=/path/to/fixture_bn_2026-08.json node verify/parity.mjs
```

**ผลล่าสุด: ผ่าน 117 / ไม่ผ่าน 0** — ยอดบางนา ส.ค. 69 ตรงไฟล์ต้นฉบับทุกบาท
(ค่าเวร 176,545 · ค่ามือ 191,550 · รวม 368,095 · สุทธิ 357,052.15)

---

## ฐานข้อมูล

Schema `fee` ถูก apply ไว้ที่โปรเจกต์ `yrzgorkgxhjxwgpkdggo` แล้ว
(migration `fee_01_schema` ถึง `fee_09_jnum_default_fix`)

ดึงไฟล์ SQL มาเก็บในรีโป:

```bash
npx supabase login
npx supabase link --project-ref yrzgorkgxhjxwgpkdggo
npx supabase db pull --schema fee
```

**หลักที่ยึด:** สิทธิ์และกติกาทั้งหมดบังคับที่ฐานข้อมูล (RLS + RPC)
การซ่อนเมนูที่หน้าเว็บเป็นแค่ความสะดวก ไม่ใช่การควบคุมสิทธิ์ · ผู้จัดทำ ผู้ตรวจ
และผู้อนุมัติต้องเป็นคนละบัญชี · รอบที่อนุมัติแล้วล็อกตาย แม้แต่ผู้ดูแลระบบก็แก้ไม่ได้
