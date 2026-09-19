/* ============================================================================
 * tabs.ts — รายการแท็บของระบบ และกติกาว่าใครเห็นแท็บไหน
 *
 * ลำดับการตัดสินใจ:
 *   1. ถ้า IT กำหนดสิทธิ์รายบุคคลไว้ (fee.staff.tabs ไม่ null) ใช้ค่านั้นเป็นหลัก
 *   2. ถ้าไม่ได้กำหนด ใช้ค่าเริ่มต้นตามบทบาท (ฟังก์ชัน show ของแต่ละแท็บ)
 *
 * การซ่อนแท็บเป็นเรื่องความสะดวกของหน้าจอเท่านั้น
 * สิทธิ์จริงบังคับที่ RLS และ RPC ในฐานข้อมูลเสมอ
 * ==========================================================================*/
import { can } from './auth';

export interface TabDef {
  to: string;
  label: string;
  /** ค่าเริ่มต้นตามบทบาท — ใช้เมื่อ IT ยังไม่ได้กำหนดสิทธิ์รายบุคคล */
  show?: (role: string) => boolean;
  /** แท็บที่ปิดไม่ได้ (ไม่งั้นผู้ใช้จะเข้าระบบมาแล้วไม่เห็นอะไรเลย) */
  always?: boolean;
}

export const TABS: TabDef[] = [
  { to: '/',          label: 'ภาพรวม',      always: true },
  { to: '/import',    label: 'นำเข้าข้อมูล', show: (r) => can.editData(r) },
  { to: '/shifts',    label: 'ใบเวรแพทย์' },
  { to: '/clock',     label: 'ลงเวลา' },
  { to: '/calc',      label: 'คำนวณ' },
  { to: '/reconcile', label: 'กระทบยอด' },
  { to: '/approve',   label: 'อนุมัติ' },
  { to: '/email',     label: 'ส่งเมลแพทย์', show: (r) => ['admin', 'hr', 'acct'].includes(r) },
  { to: '/registry',  label: 'ทะเบียน' },
  { to: '/settings',  label: 'ตั้งค่า' },
];

/** แท็บที่ผู้ใช้คนนี้เห็นได้จริง */
export function visibleTabs(role: string, tabs?: string[] | null): TabDef[] {
  return TABS.filter((t) => {
    if (t.always) return true;
    if (tabs && tabs.length) return tabs.includes(t.to);  // IT กำหนดเอง
    if (tabs && !tabs.length) return false;               // กำหนดเป็น "ไม่เห็นเลย"
    return !t.show || t.show(role);                       // ค่าเริ่มต้นตามบทบาท
  });
}
