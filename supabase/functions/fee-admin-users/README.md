# fee-admin-users

Edge Function สำหรับสร้าง/ลบ/รีเซ็ตรหัสผ่านบัญชีผู้ใช้ (เรียกได้เฉพาะบทบาท it / admin)

ตัวฟังก์ชัน deploy ขึ้น Supabase ไปแล้ว (version 2) ดูหรือแก้ได้ที่
Dashboard -> Edge Functions -> fee-admin-users

ดึงซอร์สลงมาเก็บในรีโปได้ด้วย:

    npx supabase login
    npx supabase link --project-ref yrzgorkgxhjxwgpkdggo
    npx supabase functions download fee-admin-users
