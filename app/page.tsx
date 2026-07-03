"use client";

import { useState } from "react";
import s from "./landing.module.css";

/* ---------------- data ---------------- */

type Cycle = "monthly" | "yearly";

const PLANS = [
  {
    key: "starter",
    name: "Starter",
    tagline: "เริ่มต้นให้ LINE ทำงานเอง เหมาะกับร้านเดี่ยว",
    monthly: 990,
    popular: false,
    features: [
      { t: "ระบบบอทหลัก + แดชบอร์ดผู้ดูแล", on: true },
      { t: "ผู้ช่วยงาน: สั่งงาน ปฏิทิน เตือนตามเวลา สรุปเช้า", on: true },
      { t: "บรอดแคสต์ & แคมเปญ ส่งข้อความหาลูกค้า", on: true },
      { t: "เชื่อม LINE OA เดิม · 1 Webhook ติดตั้งครั้งเดียว", on: true },
      { t: "ตรวจสลิป · คอมเมิร์ซ · จองคิว", on: false },
    ],
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "ครบสำหรับร้านที่ขายและดูแลลูกค้าจริงจัง",
    monthly: 2990,
    popular: true,
    features: [
      { t: "ทุกอย่างใน Starter", on: true },
      { t: "ตรวจสลิปอัตโนมัติ & OCR การชำระเงิน", on: true },
      { t: "คอมเมิร์ซ สั่งซื้อในแชท + จองคิว/นัดหมาย", on: true },
      { t: "ตอบอัตโนมัติ AI (FAQ) + CRM เก็บลีด", on: true },
      { t: "คอมมูนิตี้/ส่งคอร์ส + จัดการหลายสาขา", on: true },
    ],
  },
  {
    key: "business",
    name: "Business",
    tagline: "ครบทุกโมดูล + งานหลังบ้านสำหรับองค์กร",
    monthly: 4990,
    popular: false,
    features: [
      { t: "ทุกอย่างใน Pro", on: true },
      { t: "Receipt/ค่าใช้จ่าย OCR + e-KYC บัตรประชาชน", on: true },
      { t: "Internal Ops: งาน HR & ระบบอนุมัติ", on: true },
      { t: "รองรับปริมาณสูง + ทีมหลายคน", on: true },
      { t: "ซัพพอร์ตลำดับความสำคัญ (priority)", on: true },
    ],
  },
] as const;

const FEATURES = [
  {
    icon: "receipt",
    t: "ตรวจสลิปอัตโนมัติ",
    d: "ลูกค้าส่งสลิปโอนเงิน บอทอ่านยอด จับคู่ออเดอร์ และยืนยันให้ภายในวินาที ลดงานแอดมินและกันสลิปปลอม",
  },
  {
    icon: "bell",
    t: "ผู้ช่วยงาน & แจ้งเตือน",
    d: "สั่งงานในแชทได้เลย มีปฏิทิน เตือนตามเวลาที่ตั้ง และสรุปงานให้ทุกเช้า ไม่ต้องเปิดหลายแอป",
  },
  {
    icon: "megaphone",
    t: "บรอดแคสต์ & แคมเปญ",
    d: "ยิงโปรโมชันหาลูกค้าตรงกลุ่ม ตั้งเวลาส่งล่วงหน้า และวัดผลได้ เปลี่ยนแชทให้เป็นยอดขาย",
  },
  {
    icon: "chat",
    t: "ตอบอัตโนมัติด้วย AI",
    d: "ตอบคำถามซ้ำ ๆ จากคลังความรู้ของร้านด้วย AI ลูกค้าได้คำตอบทันทีตลอด 24 ชั่วโมง",
  },
  {
    icon: "cart",
    t: "คอมเมิร์ซ & จองคิว",
    d: "สั่งซื้อสินค้า จองคิว และนัดหมาย จบครบในแชทเดียว ไม่ต้องพาลูกค้าออกไปที่อื่น",
  },
  {
    icon: "users",
    t: "CRM & หลายสาขา",
    d: "เก็บข้อมูลลูกค้า ติดตามงานที่ต้องตามต่อ และดูแลได้หลายสาขาจากศูนย์กลางเดียว",
  },
  {
    icon: "wallet",
    t: "บันทึกรายรับ-รายจ่าย",
    d: "จดเงินในแชทด้วยการพิมพ์ธรรมดา ระบบจัดหมวดให้เอง สรุปรายวัน/สัปดาห์/เดือนเป็นกราฟการ์ดสวยในไลน์ + หน้ารายงานเว็บ",
  },
] as const;

const STEPS = [
  { t: "เชื่อม LINE OA ของคุณ", d: "กรอก Channel & Token ของ LINE OA ที่มีอยู่ หรือให้ทีมเราตั้งค่าให้ ใช้ได้กับบัญชีเดิม ไม่ต้องเปิดใหม่" },
  { t: "วาง Webhook เดียว", d: "ก๊อป URL ที่ระบบสร้างให้ ไปวางใน LINE Developer Console เพียงครั้งเดียว จบ" },
  { t: "เปิดใช้งานทันที", d: "เลือกโมดูลตามแพ็กเกจ บอทเริ่มทำงานทันที ปรับเปิด-ปิดโมดูลได้ทุกเมื่อ" },
] as const;

const MATRIX: { t: string; a: [boolean, boolean, boolean] }[] = [
  { t: "ระบบบอทหลัก + แดชบอร์ดผู้ดูแล", a: [true, true, true] },
  { t: "ผู้ช่วยงาน: Todo / ปฏิทิน / สรุปเช้า", a: [true, true, true] },
  { t: "บรอดแคสต์ & แคมเปญ", a: [true, true, true] },
  { t: "ตรวจสลิป & OCR การชำระเงิน", a: [false, true, true] },
  { t: "คอมเมิร์ซ & สั่งซื้อในแชท", a: [false, true, true] },
  { t: "จองคิว & นัดหมาย", a: [false, true, true] },
  { t: "ตอบอัตโนมัติ AI (FAQ) & Support", a: [false, true, true] },
  { t: "CRM & เก็บลีด", a: [false, true, true] },
  { t: "คอมมูนิตี้ & ส่งคอร์ส", a: [false, true, true] },
  { t: "จัดการหลายสาขา", a: [false, true, true] },
  { t: "บันทึกรายรับ-รายจ่าย & รายงาน", a: [false, true, true] },
  { t: "Receipt/ค่าใช้จ่าย OCR & e-KYC", a: [false, false, true] },
  { t: "Internal Ops: HR & อนุมัติ", a: [false, false, true] },
];

const FAQS = [
  { q: "ต้องเขียนโค้ดหรือมีทีมไอทีไหม?", a: "ไม่ต้องเลย ทุกอย่างตั้งค่าผ่านหน้าเว็บ เชื่อม LINE OA แล้ววาง Webhook หนึ่งครั้ง บอทก็เริ่มทำงาน ถ้าติดตรงไหนทีมเราช่วยตั้งให้" },
  { q: "ใช้กับ LINE OA เดิมของร้านได้ไหม?", a: "ได้ ใช้กับบัญชี LINE Official Account เดิมได้ทันที ไม่ต้องเปิดใหม่ ไม่ต้องย้ายเพื่อน/ลูกค้า" },
  { q: "ยกเลิกได้ไหม มีสัญญาผูกมัดหรือเปล่า?", a: "ยกเลิกได้ทุกเมื่อ ไม่มีสัญญาผูกมัด เมื่อยกเลิกยังใช้งานได้จนจบรอบที่จ่ายไว้ รายปีก็ใช้ครบปี" },
  { q: "จ่ายเงินอย่างไร?", a: "รองรับ PromptPay / โอนธนาคาร เลือกได้ทั้งรายเดือนและรายปี รายปีถูกกว่า (ฟรี 2 เดือน)" },
  { q: "ตรวจสลิปแม่นแค่ไหน ต้องต่อ API เพิ่มไหม?", a: "โมดูลตรวจสลิปใช้ผู้ให้บริการ OCR ที่แม่นยำ รองรับสลิปธนาคารไทย ระบบพร้อมใช้ บางโมดูลขั้นสูงต่อ API ภายนอกเพิ่มได้ตามต้องการ" },
  { q: "ข้อมูลลูกค้าปลอดภัยไหม?", a: "ข้อมูล Channel และ Token ถูกเข้ารหัสระดับแอป (AES-256) แยกข้อมูลของแต่ละร้านออกจากกัน และไม่แชร์ข้ามบัญชี" },
];

/* ---------------- helpers ---------------- */

const baht = (n: number) => "฿" + n.toLocaleString("th-TH");

/* ---------------- page ---------------- */

export default function LandingPage() {
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [openFaq, setOpenFaq] = useState<number>(0);
  const yearly = cycle === "yearly";

  return (
    <div className={s.page}>
      {/* NAV */}
      <nav className={s.nav}>
        <div className={`${s.container} ${s.navInner}`}>
          <div className={s.brand}>
            <span className={s.brandMark}><LineGlyph /></span>
            UP&nbsp;Line
            <span className={s.brandBadge}>LINE Bot OS</span>
          </div>
          <div className={s.navLinks}>
            <a href="#features">ฟีเจอร์</a>
            <a href="#how">วิธีใช้งาน</a>
            <a href="#pricing">ราคา</a>
            <a href="#faq">คำถามที่พบบ่อย</a>
          </div>
          <div className={s.navCta}>
            <a className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} href="/dashboard">เข้าสู่ระบบ</a>
            <a className={`${s.btn} ${s.btnBlue} ${s.btnSm}`} href="#pricing">เริ่มใช้งาน</a>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <header className={s.hero}>
        <div className={`${s.container} ${s.heroGrid}`}>
          <div className={s.reveal}>
            <span className={s.eyebrow}><span className={s.dot} /> ระบบพร้อมใช้ · ไม่ต้องเขียนโค้ด</span>
            <h1 className={s.h1}>
              เปลี่ยน LINE OA ให้ <span className={s.hl}>ทำงานเองได้ 24 ชม.</span>
            </h1>
            <p className={s.lead}>
              ตรวจสลิปอัตโนมัติ ตอบลูกค้าทันที จัดคิว-นัดหมาย ส่งโปรโมชัน และปิดการขาย —
              รวมทุกอย่างไว้ในระบบเดียว ติดตั้งกับ LINE OA เดิมเสร็จใน 10 นาที
            </p>
            <div className={s.heroCtas}>
              <a className={`${s.btn} ${s.btnPrimary}`} href="#pricing">เริ่มใช้งาน เริ่มต้น {baht(990)}/เดือน <ArrowRight /></a>
              <a className={`${s.btn} ${s.btnGhost}`} href="#features">ดูฟีเจอร์ทั้งหมด</a>
            </div>
            <div className={s.trust}>
              <span><Check /> เชื่อม LINE OA เดิมได้ทันที</span>
              <span><Check /> ยกเลิกเมื่อไรก็ได้</span>
              <span><Check /> ซัพพอร์ตภาษาไทย</span>
            </div>
          </div>

          <div className={s.heroArt}>
            <div className={s.phone}>
              <div className={s.phoneBar}>
                <span className={s.phoneAvatar}>UP</span>
                <div>
                  <div className={s.phoneName}>ร้านของคุณ · LINE OA</div>
                  <div className={s.phoneStatus}>● ออนไลน์ · ตอบอัตโนมัติ</div>
                </div>
              </div>
              <div className={s.chat}>
                <div className={`${s.bubble} ${s.bubbleIn}`} style={{ animationDelay: "0.05s" }}>สนใจสั่งสินค้าครับ โอนแล้วส่งสลิปเลยไหม?</div>
                <div className={`${s.bubble} ${s.bubbleOut}`} style={{ animationDelay: "0.15s" }}>ได้เลยค่ะ ส่งสลิปมาได้เลย ระบบตรวจให้อัตโนมัติ 🙏</div>
                <div className={s.bubbleCard} style={{ animationDelay: "0.28s" }}>
                  <div className={s.slipRow}>
                    <span className={s.slipCheck}><Check /></span>
                    <div>
                      <div className={s.slipAmt}>ยอด {baht(1200)} · ตรวจสอบแล้ว</div>
                      <div className={s.slipMeta}>ธ.กสิกรไทย · 14:32 · จับคู่ออเดอร์ #1042</div>
                    </div>
                  </div>
                </div>
                <div className={`${s.bubble} ${s.bubbleIn}`} style={{ animationDelay: "0.4s" }}>ขอจองคิวรับของพรุ่งนี้ 10 โมงด้วยครับ</div>
                <div className={`${s.bubble} ${s.bubbleOut}`} style={{ animationDelay: "0.5s" }}>จองคิว 10:00 พรุ่งนี้ให้แล้วค่ะ ✅ เดี๋ยวเตือนก่อนถึงเวลา</div>
              </div>
              <span className={`${s.floatChip} ${s.chipTL}`}><Bolt /> ตอบใน &lt; 1 วิ</span>
              <span className={`${s.floatChip} ${s.chipBR}`}><Check /> ปิดการขายเอง</span>
            </div>
          </div>
        </div>
      </header>

      {/* STAT STRIP */}
      <section className={s.stats}>
        <div className={`${s.container} ${s.statsGrid}`}>
          <div className={s.stat}><div className={s.statNum}>24/7</div><div className={s.statLabel}>ทำงานไม่มีวันหยุด</div></div>
          <div className={s.stat}><div className={s.statNum}>&lt; 1 วิ</div><div className={s.statLabel}>ตอบลูกค้าทันที</div></div>
          <div className={s.stat}><div className={s.statNum}>14</div><div className={s.statLabel}>โมดูลพร้อมใช้</div></div>
          <div className={s.stat}><div className={s.statNum}>10 นาที</div><div className={s.statLabel}>ติดตั้งเสร็จ</div></div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className={s.section}>
        <div className={s.container}>
          <div className={s.sectionHead}>
            <div className={s.kicker}>ความสามารถ</div>
            <h2 className={s.h2}>ทุกอย่างที่ LINE ธุรกิจต้องมี ในระบบเดียว</h2>
            <p className={s.sub}>ไม่ต้องต่อหลายเครื่องมือ ไม่ต้องจ้างเขียนบอทเอง เลือกเปิดเฉพาะโมดูลที่ร้านคุณใช้จริง</p>
          </div>
          <div className={s.featGrid}>
            {FEATURES.map((f) => (
              <article key={f.t} className={s.featCard}>
                <div className={s.featIcon}><FeatureIcon name={f.icon} /></div>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* HOW */}
      <section id="how" className={s.section} style={{ paddingTop: 0 }}>
        <div className={s.container}>
          <div className={s.sectionHead}>
            <div className={s.kicker}>เริ่มใช้ใน 3 ขั้นตอน</div>
            <h2 className={s.h2}>ติดตั้งครั้งเดียว ใช้ได้ทันที</h2>
            <p className={s.sub}>ไม่ต้องย้ายบัญชี ไม่ต้องเขียนโค้ด — เชื่อมกับ LINE OA เดิมของคุณ</p>
          </div>
          <div className={s.steps}>
            {STEPS.map((st, i) => (
              <div key={st.t} className={s.step}>
                <div className={s.stepNum}>{i + 1}</div>
                <h3>{st.t}</h3>
                <p>{st.d}</p>
                <span className={s.stepArrow}><ArrowRight /></span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className={s.section} style={{ paddingTop: 0 }}>
        <div className={s.container}>
          <div className={s.sectionHead}>
            <div className={s.kicker}>ราคา</div>
            <h2 className={s.h2}>เลือกแพ็กเกจที่ใช่ ปรับได้ทุกเมื่อ</h2>
            <p className={s.sub}>ราคาเดียวจบ รวมทุกโมดูลในแพ็กเกจ ไม่มีค่าติดตั้งแอบแฝง · รายปีฟรี 2 เดือน</p>
          </div>

          <div style={{ display: "flex", justifyContent: "center" }}>
            <div className={s.priceToggle} role="group" aria-label="เลือกรอบการชำระเงิน">
              <button className={`${s.toggleBtn} ${!yearly ? s.active : ""}`} onClick={() => setCycle("monthly")} aria-pressed={!yearly}>
                รายเดือน
              </button>
              <button className={`${s.toggleBtn} ${yearly ? s.active : ""}`} onClick={() => setCycle("yearly")} aria-pressed={yearly}>
                รายปี <span className={s.saveTag}>ประหยัด 17%</span>
              </button>
            </div>
          </div>

          <div className={s.priceGrid}>
            {PLANS.map((p) => {
              const yearTotal = p.monthly * 10; // 2 months free
              const perMonth = yearly ? Math.round(yearTotal / 12) : p.monthly;
              const save = p.monthly * 12 - yearTotal;
              return (
                <div key={p.key} className={`${s.priceCard} ${p.popular ? s.priceCardPopular : ""}`}>
                  {p.popular && <span className={s.popularTag}>ยอดนิยม</span>}
                  <div className={s.planName}>{p.name}</div>
                  <div className={s.planTagline}>{p.tagline}</div>
                  <div className={s.priceRow}>
                    <span className={s.priceAmt}>{baht(perMonth)}</span>
                    <span className={s.priceUnit}>/ เดือน</span>
                  </div>
                  <div className={s.priceNote}>
                    {yearly ? `เรียกเก็บ ${baht(yearTotal)}/ปี · ประหยัด ${baht(save)}` : "เก็บรายเดือน ยกเลิกได้ทุกเมื่อ"}
                  </div>
                  <hr />
                  <ul className={s.featList}>
                    {p.features.map((f) => (
                      <li key={f.t} className={f.on ? "" : s.off}>
                        {f.on ? <Check /> : <Dash />} {f.t}
                      </li>
                    ))}
                  </ul>
                  <a
                    className={`${s.btn} ${p.popular ? s.btnPrimary : s.btnGhost} ${s.btnBlock}`}
                    href={`/subscribe?plan=${p.key}&cycle=${cycle}`}
                  >
                    เลือก {p.name} <ArrowRight />
                  </a>
                </div>
              );
            })}
          </div>

          {/* matrix */}
          <div className={s.matrixWrap}>
            <table className={s.matrix}>
              <thead>
                <tr>
                  <th>โมดูล</th>
                  <th>Starter</th>
                  <th>Pro</th>
                  <th>Business</th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((row) => (
                  <tr key={row.t}>
                    <td className={s.grp}>{row.t}</td>
                    {row.a.map((on, i) => (
                      <td key={i} className={s.mid}>
                        {on ? <span className="yes"><Check /></span> : <span className="no"><Dash /></span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className={s.section} style={{ paddingTop: 0 }}>
        <div className={s.container}>
          <div className={s.sectionHead}>
            <div className={s.kicker}>คำถามที่พบบ่อย</div>
            <h2 className={s.h2}>เรื่องที่ลูกค้าถามก่อนเริ่ม</h2>
          </div>
          <div className={s.faqWrap}>
            {FAQS.map((f, i) => (
              <div key={f.q} className={s.faq} data-open={openFaq === i}>
                <button className={s.faqQ} onClick={() => setOpenFaq(openFaq === i ? -1 : i)} aria-expanded={openFaq === i}>
                  {f.q} <Chevron />
                </button>
                <div className={s.faqA}>
                  <div className={s.faqAInner}>{f.a}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className={s.container}>
        <div className={s.ctaBand}>
          <h2>พร้อมให้ LINE ทำงานแทนคุณหรือยัง?</h2>
          <p>เริ่มวันนี้ เชื่อม LINE OA เดิม แล้วปล่อยให้บอทตรวจสลิป ตอบลูกค้า และปิดการขายให้ 24 ชั่วโมง</p>
          <a className={`${s.btn}`} href="#pricing">เริ่มใช้งาน {baht(990)}/เดือน <ArrowRight /></a>
        </div>
      </section>

      {/* FOOTER */}
      <footer className={s.footer}>
        <div className={s.container}>
          <div className={s.footGrid}>
            <div style={{ maxWidth: 320 }}>
              <div className={s.brand} style={{ marginBottom: 12 }}>
                <span className={s.brandMark}><LineGlyph /></span> UP&nbsp;Line
              </div>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7 }}>
                ระบบปฏิบัติการสำหรับ LINE ธุรกิจ — เปลี่ยนแชทให้เป็นยอดขายและงานที่ทำเองได้อัตโนมัติ
              </p>
            </div>
            <div className={s.footCol}>
              <h4>ผลิตภัณฑ์</h4>
              <a href="#features">ฟีเจอร์</a>
              <a href="#pricing">ราคา</a>
              <a href="#how">วิธีใช้งาน</a>
              <a href="/guide.html">คู่มือการใช้งาน</a>
            </div>
            <div className={s.footCol}>
              <h4>เริ่มต้น</h4>
              <a href="/subscribe?plan=pro&cycle=monthly">สมัครใช้งาน</a>
              <a href="/dashboard">เข้าสู่ระบบผู้ดูแล</a>
              <a href="/account">จัดการสมาชิก</a>
              <a href="#faq">คำถามที่พบบ่อย</a>
            </div>
          </div>
          <div className={s.footBottom}>
            <span>© 2026 UP Line · by TONPALEARN</span>
            <span>สร้างด้วย ❤️ สำหรับธุรกิจไทย</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ---------------- icons ---------------- */

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Check() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...base}><path d="M20 6 9 17l-5-5" /></svg>;
}
function Dash() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...base}><path d="M5 12h14" /></svg>;
}
function ArrowRight() {
  return <svg width="17" height="17" viewBox="0 0 24 24" {...base}><path d="M5 12h14M13 5l7 7-7 7" /></svg>;
}
function Chevron() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...base}><path d="m6 9 6 6 6-6" /></svg>;
}
function Bolt() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...base}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>;
}
function LineGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5c0-4.5-4-8-9-8s-9 3.5-9 8c0 4 3.2 7.2 7.5 7.9.9.2.8.6.7 1.3l-.2 1c-.1.6.4.8.9.5C15 20 21 16.5 21 11.5z" /></svg>;
}

function FeatureIcon({ name }: { name: string }) {
  switch (name) {
    case "receipt":
      return <svg width="24" height="24" viewBox="0 0 24 24" {...base}><path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z" /><path d="M9 8h6M9 12h6" /></svg>;
    case "bell":
      return <svg width="24" height="24" viewBox="0 0 24 24" {...base}><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 21a2 2 0 0 0 4 0" /></svg>;
    case "megaphone":
      return <svg width="24" height="24" viewBox="0 0 24 24" {...base}><path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z" /><path d="M14 8a4 4 0 0 1 0 8M18 5a8 8 0 0 1 0 14" /></svg>;
    case "chat":
      return <svg width="24" height="24" viewBox="0 0 24 24" {...base}><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></svg>;
    case "cart":
      return <svg width="24" height="24" viewBox="0 0 24 24" {...base}><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2 3h3l2.5 12.5A2 2 0 0 0 9.5 17H18a2 2 0 0 0 2-1.6L21.5 8H6" /></svg>;
    case "users":
      return <svg width="24" height="24" viewBox="0 0 24 24" {...base}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>;
    case "wallet":
      return <svg width="24" height="24" viewBox="0 0 24 24" {...base}><path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" /><path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" /><path d="M22 11h-5a2 2 0 0 0 0 4h5v-4z" /></svg>;
    default:
      return null;
  }
}
