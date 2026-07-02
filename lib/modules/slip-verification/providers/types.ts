/**
 * Shared provider interface so switching the default Slip Verification provider
 * (SlipOK vs EasySlip — see SYSTEM-DESIGN.md §4.3 and SPEC.md §17 Open Questions)
 * is a config change, not a rewrite.
 */
export interface SlipVerifyResult {
  bank: string;
  amount: number;
  ref: string;
  txnTime: string; // ISO 8601
  isValid: boolean;
}

export interface SlipProvider {
  verify(imageBuffer: Buffer): Promise<SlipVerifyResult>;
}
