import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/subscribe/verify-slip — self-hosted slip verification + multi-layer anti-replay.
 *
 * We mock:
 *  - lib/payments/slip-decode: so we control the decode result (found/not-found, rawQr, transRef,
 *    imageHash) without doing real image processing in the unit test.
 *  - lib/db: a tiny in-memory Supabase builder over two tables —
 *      upl_customer_subscriptions (lookup by manage_token/payment_ref, then update→active)
 *      upl_payment_slips          (the .or() duplicate scan + the insert with a UNIQUE guard)
 *
 * Proven behaviors: clean slip activates; a repeated raw_qr / image_hash / trans_ref is rejected
 * as duplicate_slip; a QR-less slip leaves the sub pending (no_qr, needsManual).
 */

// ── Mock the decoder ─────────────────────────────────────────────────────────────────────
type Decode = {
  foundQr: boolean;
  rawQr: string | null;
  transRef: string | null;
  sendingBank: string | null;
  imageHash: string;
};
let nextDecode: Decode = {
  foundQr: true,
  rawQr: "RAWQR-DEFAULT",
  transRef: "TXNREF-DEFAULT",
  sendingBank: "A000000677010112",
  imageHash: "hash-default",
};
vi.mock("../lib/payments/slip-decode", () => ({
  decodeSlip: vi.fn(async () => nextDecode),
}));

// ── In-memory DB state ───────────────────────────────────────────────────────────────────
type Sub = {
  id: string;
  status: "pending" | "active" | "canceled" | "past_due";
  manage_token: string;
  payment_ref: string;
  amount: number;
  plan_key: string;
  billing_cycle: string;
  business_name: string;
  activated_at: string | null;
  payment_verified_at: string | null;
  payment_channel: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
};
type Slip = {
  id: string;
  subscription_id: string;
  raw_qr: string | null;
  trans_ref: string | null;
  sending_bank: string | null;
  image_hash: string;
};

let subs: Sub[] = [];
let slips: Slip[] = [];
let slipSeq = 0;

function seedSub(over: Partial<Sub> = {}): Sub {
  const s: Sub = {
    id: "sub-1",
    status: "pending",
    manage_token: "tok-1",
    payment_ref: "UPL-AAAA1111",
    amount: 2990,
    plan_key: "pro",
    billing_cycle: "monthly",
    business_name: "Test Shop",
    activated_at: null,
    payment_verified_at: null,
    payment_channel: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ...over,
  };
  return s;
}

// A minimal PostgREST-ish builder covering exactly the calls the route makes.
vi.mock("../lib/db", () => {
  function makeBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" | "update" = "select";
    let insertRow: Record<string, unknown> | null = null;
    let updatePatch: Record<string, unknown> | null = null;
    let orExpr: string | null = null;

    function matchSubs(): Sub[] {
      return subs.filter((s) => {
        if (filters.manage_token !== undefined && s.manage_token !== filters.manage_token) return false;
        if (filters.payment_ref !== undefined && s.payment_ref !== filters.payment_ref) return false;
        if (filters.id !== undefined && s.id !== filters.id) return false;
        return true;
      });
    }

    // Parse the route's .or("raw_qr.eq.X,image_hash.eq.Y,trans_ref.eq.Z") into matches.
    function matchSlipsByOr(): Slip[] {
      if (!orExpr) return [];
      const clauses = orExpr.split(",").map((c) => {
        const [col, _eq, ...rest] = c.split(".");
        return { col, val: rest.join(".") };
      });
      return slips.filter((sl) =>
        clauses.some(({ col, val }) => (sl as Record<string, unknown>)[col] != null && String((sl as Record<string, unknown>)[col]) === val)
      );
    }

    const builder: any = {
      select: () => builder,
      insert: (row: Record<string, unknown>) => {
        op = "insert";
        insertRow = row;
        // Resolve eagerly like PostgREST when awaited without a terminal .select().
        return {
          then: (resolve: (r: { data: unknown; error: unknown }) => void) => {
            // Enforce the DB UNIQUE constraints (image_hash / raw_qr / trans_ref).
            const clash = slips.find(
              (sl) =>
                sl.image_hash === row.image_hash ||
                (row.raw_qr != null && sl.raw_qr === row.raw_qr) ||
                (row.trans_ref != null && sl.trans_ref === row.trans_ref)
            );
            if (clash) return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            const created: Slip = {
              id: `slip-${++slipSeq}`,
              subscription_id: String(row.subscription_id),
              raw_qr: (row.raw_qr as string | null) ?? null,
              trans_ref: (row.trans_ref as string | null) ?? null,
              sending_bank: (row.sending_bank as string | null) ?? null,
              image_hash: String(row.image_hash),
            };
            slips.push(created);
            return resolve({ data: created, error: null });
          },
        };
      },
      update: (patch: Record<string, unknown>) => {
        op = "update";
        updatePatch = patch;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      or: (expr: string) => {
        orExpr = expr;
        return builder;
      },
      limit: () => builder,
      order: () => builder,
      // Terminal for the duplicate scan: `.or(...).select("id").limit(1)` is awaited directly.
      then: (resolve: (r: { data: unknown; error: unknown }) => void) => {
        if (table === "upl_payment_slips" && op === "select") {
          return resolve({ data: matchSlipsByOr().map((s) => ({ id: s.id })), error: null });
        }
        return resolve({ data: null, error: null });
      },
      maybeSingle: async () => {
        if (table === "upl_customer_subscriptions") {
          if (op === "update") {
            const [hit] = matchSubs();
            if (!hit) return { data: null, error: null };
            Object.assign(hit, updatePatch);
            return { data: { ...hit }, error: null };
          }
          const [hit] = matchSubs();
          return { data: hit ? { ...hit } : null, error: null };
        }
        return { data: null, error: null };
      },
    };
    return builder;
  }

  return { getServiceClient: () => ({ from: (t: string) => makeBuilder(t) }) };
});

import { POST } from "../app/api/subscribe/verify-slip/route";

const BASE = "https://uplinebot.example.com";
// A tiny valid base64 payload (content irrelevant — decodeSlip is mocked).
const IMAGE_B64 = Buffer.from("fake-image-bytes").toString("base64");

function req(body: unknown): NextRequest {
  return new NextRequest(`${BASE}/api/subscribe/verify-slip`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  subs = [seedSub()];
  slips = [];
  slipSeq = 0;
  nextDecode = {
    foundQr: true,
    rawQr: "RAWQR-DEFAULT",
    transRef: "TXNREF-DEFAULT",
    sendingBank: "A000000677010112",
    imageHash: "hash-default",
  };
});

describe("verify-slip — input guards", () => {
  it("400 when neither token nor ref is provided", async () => {
    const res = await POST(req({ image: IMAGE_B64 }));
    expect(res.status).toBe(400);
  });

  it("400 when the image is missing", async () => {
    const res = await POST(req({ token: "tok-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("image is required");
  });

  it("404 when the subscription is not found", async () => {
    const res = await POST(req({ token: "does-not-exist", image: IMAGE_B64 }));
    expect(res.status).toBe(404);
  });
});

describe("verify-slip — activation on a clean slip", () => {
  it("activates the pending subscription and records the slip", async () => {
    const res = await POST(req({ token: "tok-1", image: IMAGE_B64 }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.subscription.status).toBe("active");
    expect(json.subscription.payment_channel).toBe("web");
    expect(json.subscription.payment_verified_at).toBeTruthy();
    expect(json.subscription.activated_at).toBeTruthy();
    // exactly one slip stored, linked to the sub
    expect(slips).toHaveLength(1);
    expect(slips[0].subscription_id).toBe("sub-1");
    expect(slips[0].raw_qr).toBe("RAWQR-DEFAULT");
  });

  it("works by payment_ref too", async () => {
    const res = await POST(req({ ref: "UPL-AAAA1111", image: IMAGE_B64 }));
    expect((await res.json()).subscription.status).toBe("active");
  });

  it("is idempotent for an already-active subscription (no new slip)", async () => {
    subs = [seedSub({ status: "active" })];
    const res = await POST(req({ token: "tok-1", image: IMAGE_B64 }));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.alreadyActive).toBe(true);
    expect(slips).toHaveLength(0);
  });
});

describe("verify-slip — multi-layer anti-replay", () => {
  it("rejects a duplicate raw_qr (used on another subscription)", async () => {
    // Pre-existing slip on a different sub with the SAME raw_qr, different hash/ref.
    slips = [{ id: "old", subscription_id: "sub-other", raw_qr: "RAWQR-DEFAULT", trans_ref: "OTHER", sending_bank: null, image_hash: "other-hash" }];
    const res = await POST(req({ token: "tok-1", image: IMAGE_B64 }));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.reason).toBe("duplicate_slip");
    // sub stays pending
    expect(subs[0].status).toBe("pending");
  });

  it("rejects a duplicate image_hash", async () => {
    nextDecode = { ...nextDecode, rawQr: "UNIQUE-QR", transRef: "UNIQUE-REF" };
    slips = [{ id: "old", subscription_id: "sub-other", raw_qr: "SOMETHING-ELSE", trans_ref: "ELSE", sending_bank: null, image_hash: "hash-default" }];
    const json = await (await POST(req({ token: "tok-1", image: IMAGE_B64 }))).json();
    expect(json.reason).toBe("duplicate_slip");
    expect(subs[0].status).toBe("pending");
  });

  it("rejects a duplicate trans_ref", async () => {
    nextDecode = { ...nextDecode, rawQr: "UNIQUE-QR-2", imageHash: "unique-hash-2" };
    slips = [{ id: "old", subscription_id: "sub-other", raw_qr: "OTHER-QR", trans_ref: "TXNREF-DEFAULT", sending_bank: null, image_hash: "another-hash" }];
    const json = await (await POST(req({ token: "tok-1", image: IMAGE_B64 }))).json();
    expect(json.reason).toBe("duplicate_slip");
    expect(subs[0].status).toBe("pending");
  });

  it("allows a slip whose transRef is null and does not false-match other null-ref slips", async () => {
    nextDecode = { foundQr: true, rawQr: "FRESH-QR", transRef: null, sendingBank: null, imageHash: "fresh-hash" };
    // An existing slip also has a null trans_ref — must NOT be treated as a duplicate.
    slips = [{ id: "old", subscription_id: "sub-other", raw_qr: "DIFFERENT-QR", trans_ref: null, sending_bank: null, image_hash: "different-hash" }];
    const json = await (await POST(req({ token: "tok-1", image: IMAGE_B64 }))).json();
    expect(json.ok).toBe(true);
    expect(json.subscription.status).toBe("active");
  });
});

describe("verify-slip — no QR leaves it pending", () => {
  it("returns no_qr + needsManual and does not activate or store a slip", async () => {
    nextDecode = { foundQr: false, rawQr: null, transRef: null, sendingBank: null, imageHash: "hash-noqr" };
    const res = await POST(req({ token: "tok-1", image: IMAGE_B64 }));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.reason).toBe("no_qr");
    expect(json.needsManual).toBe(true);
    expect(subs[0].status).toBe("pending");
    expect(slips).toHaveLength(0);
  });
});
