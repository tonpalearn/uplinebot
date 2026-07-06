"use client";

// Shared "upload your PromptPay slip to auto-verify" control, used on both the checkout
// (PayView) and the account (pending) pages. Reads the chosen image as base64 and POSTs it to
// /api/subscribe/verify-slip with the subscription's manage_token; the server decodes the QR,
// runs anti-replay, and activates the subscription. On success we call onActivated() so the
// parent can refresh its view. Styling matches the pages (inline styles + T tokens).

import { useRef, useState } from "react";
import { T } from "../ui-theme";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "success" }
  | { kind: "duplicate" }
  | { kind: "manual" } // no_qr or other soft failure → team will verify
  | { kind: "amount" } // slip read OK but amount unclear / below the plan price → team will verify
  | { kind: "error"; message: string };

// ~5MB cap mirrors the server guard; reject earlier for a friendlier message.
const MAX_BYTES = 5 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error("read_failed"));
    fr.readAsDataURL(file);
  });
}

export default function SlipUpload({
  manageToken,
  onActivated,
}: {
  manageToken: string;
  onActivated?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Allow re-picking the same file later.
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;

    if (file.size > MAX_BYTES) {
      setState({ kind: "error", message: "ไฟล์ใหญ่เกินไป (จำกัด 5MB)" });
      return;
    }

    setState({ kind: "uploading" });
    try {
      const image = await readAsDataUrl(file);
      const res = await fetch("/api/subscribe/verify-slip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: manageToken, image }),
      });
      const json = await res.json().catch(() => null);

      if (json?.ok) {
        setState({ kind: "success" });
        onActivated?.();
        return;
      }
      const reason = json?.reason as string | undefined;
      if (reason === "duplicate_slip") setState({ kind: "duplicate" });
      else if (reason === "amount_unverified") setState({ kind: "amount" });
      else if (reason === "no_qr") setState({ kind: "manual" });
      else setState({ kind: "manual" }); // any other soft failure → manual review, don't scare the user
    } catch {
      setState({ kind: "error", message: "อัปโหลดไม่สำเร็จ ลองใหม่อีกครั้ง" });
    }
  }

  const uploading = state.kind === "uploading";

  return (
    <div style={{ marginTop: 16 }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={onPick}
        disabled={uploading}
        style={{ display: "none" }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading || state.kind === "success"}
        style={{
          width: "100%",
          padding: "13px 18px",
          borderRadius: T.radius,
          border: `1.5px solid ${T.primary}`,
          background: state.kind === "success" ? T.successWeak : T.primaryWeak,
          color: state.kind === "success" ? T.success : T.primary,
          fontWeight: 800,
          fontSize: "0.95rem",
          cursor: uploading || state.kind === "success" ? "default" : "pointer",
          opacity: uploading ? 0.7 : 1,
        }}
      >
        {uploading
          ? "กำลังตรวจสลิป..."
          : state.kind === "success"
            ? "✅ ยืนยันแล้ว เปิดใช้งานเรียบร้อย"
            : "📤 อัปโหลดสลิปเพื่อยืนยันอัตโนมัติ"}
      </button>

      <Feedback state={state} />
    </div>
  );
}

function Feedback({ state }: { state: UploadState }) {
  if (state.kind === "idle" || state.kind === "uploading") {
    return (
      <p style={{ fontSize: "0.78rem", color: T.muted2, marginTop: 8, lineHeight: 1.5 }}>
        แนบรูปสลิปที่มี QR — ระบบจะอ่านและเปิดใช้งานให้อัตโนมัติภายในไม่กี่วินาที
      </p>
    );
  }
  if (state.kind === "success") {
    return (
      <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, background: T.successWeak, color: T.success, fontSize: "0.85rem", fontWeight: 600 }}>
        ชำระเงินยืนยันสำเร็จ บัญชีของคุณเปิดใช้งานแล้ว
      </div>
    );
  }
  if (state.kind === "duplicate") {
    return (
      <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, background: T.dangerWeak, color: T.danger, fontSize: "0.85rem", fontWeight: 600 }}>
        สลิปนี้ถูกใช้ไปแล้ว — กรุณาใช้สลิปการโอนของรายการนี้ หรือติดต่อทีมงาน
      </div>
    );
  }
  if (state.kind === "amount") {
    return (
      <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, background: "var(--surface-2)", color: T.muted, fontSize: "0.85rem" }}>
        อ่านยอดจากสลิปไม่ชัด/ไม่ตรง — ทีมงานจะตรวจและเปิดใช้งานให้ภายใน 1 ชม.ทำการ
      </div>
    );
  }
  if (state.kind === "manual") {
    return (
      <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, background: "var(--surface-2)", color: T.muted, fontSize: "0.85rem" }}>
        อ่านสลิปไม่สำเร็จ — ทีมงานจะตรวจสอบและเปิดใช้งานให้ภายใน 1 ชม.ทำการ
      </div>
    );
  }
  // error
  return (
    <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, background: T.dangerWeak, color: T.danger, fontSize: "0.85rem" }}>
      {state.message}
    </div>
  );
}
