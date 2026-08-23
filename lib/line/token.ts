import { getServiceClient } from "../db";
import { decrypt } from "../crypto";

/**
 * ดึง LINE access token ของบอทตัวหนึ่ง (ถอดรหัสฝั่งเซิร์ฟเวอร์).
 *
 * เดิมฟังก์ชันนี้เป็น private อยู่ใน slip-verification/handler.ts — พอโมดูลที่ 17 ต้องใช้
 * push ข้อความเหมือนกัน จึงยกออกมาเป็นของกลางแทนที่จะคัดลอก เพราะโค้ดถอดรหัสโทเคน
 * ควรมีที่เดียว: วันไหนเปลี่ยนวิธีเก็บโทเคน จะได้ไม่มีสำเนาที่ลืมแก้
 */
export async function getBotAccessToken(botId: string): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_bots")
    .select("access_token_enc")
    .eq("id", botId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load access token for bot ${botId}`);
  }

  // access_token_enc เป็นคอลัมน์ text แบบ base64 (migration 0002) — ส่งสตริงเข้าไปตรง ๆ
  return decrypt(data.access_token_enc);
}
