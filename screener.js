/* Pre-LOI Screener (admin only). Upload a CSV of active MLS listings (Redfin "Download All" export, or just
   addresses), screen on days on market + property type, then enrich each survivor with Propwire / Google AI
   info to check equity and price the offers. Nothing here submits a lead or sends email: results are saved
   to the admin-only "Auto Pre-LOI Before Contact" tab through adminSavePreLoi.
   Uses globals from app.js: api, sessionToken, escapeHtml, computeMaoSuite, parseAICompsResponse, loadPreLoi. */

const SCR = {
  rows: [], sel: null,
  cfg: { asset: "sf", minDom: 180, minOwnerEquityPct: 90 },   // qualification = days on market + Propwire owner equity only
  AGENT_EMAIL: "montanoemmanuel@gmail.com", AGENT_NAME: "Emmanuel's LOI Helper Agent", PHONE: "5206336437",
  LOI_URL: "https://pharaohm33.github.io/loi-generator/",
  REHAB_PSF: { light: 25, moderate: 40, heavy: 55, gut: 75 },   // quick estimate when no rehab number is entered
  HM_RATE: 9.5,
  // "Seller-friendly" flip structure, copied from the 257 E Ashurst Dr link using its ACTUAL ratios (not rounded):
  //   carry price $420,000 / ARV $600,500;  cash offer $200,000 / carry;  seller cash at closing $128,000 / carry;
  //   buyer cash back at closing $27,548 / carry.
  // The generator's acquisition fee is 50% of the buyer's net cash and the seller bears half of closing costs, so the
  // hard money loan is the lever: each deal's LTV is SOLVED so buyer cash back hits that same % of the carry price
  // (it came out at 40% on Ashurst; bigger rehab or a different ARV/price mix moves it).
  CARRY_PCT_OF_ARV: 420000 / 600500, CASH_PCT_OF_CARRY: 200000 / 420000, CARRY_DOWN: 128000 / 420000, CASHBACK_PCT: 27548 / 420000,
  LTV_MIN: 0.10, LTV_MAX: 0.70,
  // Buyer profit at the balloon exit = the generator's "Sale + CF" column: ARV x (1+3%)^yrs less 6% sale costs, less the
  // seller carry, less the hard money loan, less the interest paid (static CF). Must be at least the greater of
  // $35,000 per year of the hold or 10% of the carry purchase price, or the carry price steps down until it is.
  APPRECIATION: 0.03, SALE_COSTS: 0.06, MIN_PROFIT_PER_YEAR: 35000, MIN_PROFIT_PCT_OF_PRICE: 0.10, MIN_CARRY_PCT_OF_ARV: 0.40,
  GEN: { esc1: 0.02, esc2: 0.015, pts: 0.02, agent: 0.03, acq: 0.50, taf: 0.025, sellerClosingShare: 0.5 },
  // Full rehab / gut: cash back to the buyer at closing = the full holding cost (24 months of hard money
  // interest) + the greater of $30,000 or 6% of ARV, so there is room for the assignment fee and extra cash
  // for the buyer. Seller cash at closing is whatever is left of the loan after that and closing costs.
  GUT_BUFFER_MIN: 30000, GUT_BUFFER_PCT: 0.06, EST_CLOSING_PCT: 0.085
};

/* ---------- CSV ---------- */
function scrParseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function scrLoad(text) {
  const grid = scrParseCsv(text);
  const hdr = grid[0].map(h => h.trim().toUpperCase());
  const col = (...names) => hdr.findIndex(h => names.some(n => h === n || h.startsWith(n)));
  const ix = { type: col("PROPERTY TYPE"), addr: col("ADDRESS"), city: col("CITY"), st: col("STATE"), zip: col("ZIP"),
    price: col("PRICE"), beds: col("BEDS"), baths: col("BATHS"), sqft: col("SQUARE FEET"), lot: col("LOT SIZE"),
    yr: col("YEAR BUILT"), dom: col("DAYS ON MARKET"), url: col("URL"), mls: col("MLS#"), status: col("STATUS") };
  const num = v => Number(String(v || "").replace(/[^0-9.]/g, "")) || 0;
  const out = [];
  if (ix.addr < 0) {   // plain address list: one per line, no header
    grid.forEach(r => { const a = r.join(", ").trim(); if (a) out.push({ address: a, street: a, city: "", state: "", zip: "", dom: null }); });
  } else {
    grid.slice(1).forEach(r => {
      if (!r[ix.addr] || r.length < 5) return;          // Redfin's "some MLS listings are not included" note row
      out.push({
        type: (r[ix.type] || "").trim(), street: r[ix.addr].trim(), city: (r[ix.city] || "").trim(),
        state: (r[ix.st] || "").trim(), zip: (r[ix.zip] || "").trim(), price: num(r[ix.price]), beds: r[ix.beds] || "",
        baths: r[ix.baths] || "", sqft: num(r[ix.sqft]), lot: num(r[ix.lot]), year: r[ix.yr] || "",
        dom: ix.dom >= 0 && r[ix.dom] !== "" ? num(r[ix.dom]) : null, url: (r[ix.url] || "").trim(),
        mls: (r[ix.mls] || "").trim(), status: (r[ix.status] || "").trim()
      });
    });
  }
  out.forEach((d, i) => { d.id = i; d.address = `${d.street}, ${d.city}, ${d.state} ${d.zip}`.replace(/(, )+$/, ""); });
  return out;
}

/* ---------- stage 1: days on market + property type ---------- */
function scrStage1(d) {
  if (d.skipped) return { ok: false, why: d.skipped };
  const c = SCR.cfg, want = c.asset === "land" ? "Vacant Land" : "Single Family Residential";
  if (d.status && d.status !== "Active") return { ok: false, why: "Not active (" + d.status + ")" };
  if (d.type && d.type !== want) return { ok: false, why: d.type };
  if (d.dom !== null && d.dom < c.minDom) return { ok: false, why: `Only ${d.dom} days on market` };
  if (d.dom === null) return { ok: true, note: "Needs days on market" };
  return { ok: true };
}

/* ---------- pricing (the site's own MAO math) ---------- */
const scrRound = n => Math.round(n / 500) * 500;
const scrMoney = n => (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString();

// Estimate of the LOI generator's "Cash at Close" math (cash template: acquisition fee = 50% of net cash,
// escrow 2% + 1.5%, 2 points, 3% agent fee, TAF 2.5%, closing costs split). Close, not exact: check the generator.
function scrModel(pp, cac, loan, asIs) {
  const g = SCR.GEN, esc2 = Math.max(pp - cac, 0) * g.esc2;      // 2nd escrow is on the seller carry, not the price
  const noAcq = pp * (g.esc1 + g.agent) + esc2 + loan * g.pts;
  const tafPrinNoAcq = Math.max(0, (asIs - loan) + (noAcq - esc2)), tafNo = tafPrinNoAcq * g.taf;
  const B0 = loan - cac - noAcq - tafNo, t = tafPrinNoAcq > 0 ? g.taf : 0;
  const acq = Math.max(0, B0) * g.acq / (1 + g.acq * t), closing = noAcq + acq;
  const taf = Math.max(0, (asIs - loan) + (closing - esc2)) * g.taf;
  return { closing, acq, taf, cashBack: loan - cac - closing - taf, sellerNet: cac - closing * g.sellerClosingShare };
}

function scrPrice(d, f) {
  const land = SCR.cfg.asset === "land";
  const list = d.price || 0;
  const val = f.pwValue || 0, mort = f.pwMortgage || 0;
  let ownerEquityPct = null;   // only known when Propwire equity is actually shown
  if (f.pwEquityPct !== null && f.pwEquityPct !== undefined) ownerEquityPct = f.pwEquityPct;
  else if (val && f.pwMortgageSet) ownerEquityPct = (val - mort) / val * 100;
  if (ownerEquityPct === null) return { ready: false, noEquity: true };
  const lowEquity = ownerEquityPct < SCR.cfg.minOwnerEquityPct;
  const arvMid = f.arvLow && f.arvHigh ? scrRound((f.arvLow + f.arvHigh) / 2) : (f.arvLow || f.arvHigh || 0);
  const tier = f.tier || "moderate";
  // Rehab = manual override, else the MIDDLE of Google AI's range (never the high end), else a per-sq-ft tier guess.
  const aiRehab = f.rehabLow || f.rehabHigh ? scrRound(((f.rehabLow || f.rehabHigh) + (f.rehabHigh || f.rehabLow)) / 2) : 0;
  const rehab = land ? 0 : (f.rehab || aiRehab || (d.sqft ? scrRound(d.sqft * SCR.REHAB_PSF[tier]) : 0));
  const rehabSource = land ? "" : f.rehab ? "manual" : aiRehab ? "Google AI range (middle)" : "per-sq-ft tier guess";
  if (!arvMid) return { ready: false, ownerEquityPct, lowEquity };
  const months = f.gut ? 24 : 12;
  const suite = computeMaoSuite(arvMid, rehab, land ? "Land" : "Residential Property (1-4 units)", undefined, "On-Market");
  let cashOffer, carryOffer = 0, carryDown = 0, mao, ltv = 0, ltvNote = "";
  const asIs = arvMid - rehab, years = months / 12;
  let hmLoan = 0, hmMonthly = 0, gutPlan = null, modelCarry = null, modelCash = null, profit = null, priceNote = "";
  if (land) { mao = suite.maoCash; cashOffer = scrRound(mao); }
  else {
    mao = suite.maoHardMoney20;                                     // reference only
    const buffer = Math.max(SCR.GUT_BUFFER_MIN, SCR.GUT_BUFFER_PCT * arvMid);
    const profitFor = (carry, down, loan) => arvMid * Math.pow(1 + SCR.APPRECIATION, years) * (1 - SCR.SALE_COSTS) - (carry - down) - loan - loan * SCR.HM_RATE / 100 * years;
    const build = carry => {
      const cash = scrRound(SCR.CASH_PCT_OF_CARRY * carry), baseDown = scrRound(SCR.CARRY_DOWN * carry);
      const targetFor = loan => f.gut ? loan * SCR.HM_RATE / 100 / 12 * months + buffer : SCR.CASHBACK_PCT * carry;
      const gap = (r, cac) => scrModel(carry, cac, asIs * r, asIs).cashBack - targetFor(asIs * r);
      const minProfit = Math.max(SCR.MIN_PROFIT_PER_YEAR * years, SCR.MIN_PROFIT_PCT_OF_PRICE * carry);
      // Smallest LTV at which buyer cash back reaches its target for a given seller cash at closing (null = even the max LTV can't).
      const solveR = cac => {
        if (gap(SCR.LTV_MAX, cac) < 0) return null;
        if (gap(SCR.LTV_MIN, cac) > 0) return SCR.LTV_MIN;
        let lo = SCR.LTV_MIN, hi = SCR.LTV_MAX;
        for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (gap(m, cac) < 0) lo = m; else hi = m; }
        return Math.round((lo + hi) / 2 * 1000) / 1000;
      };
      const profitAt = (cac, r) => profitFor(carry, cac, asIs * r);
      const notes = [];
      let down = baseDown, r = solveR(down);
      if (r === null) {
        // Shortfall at the max LTV: cut the seller's cash at closing until the buyer's cash back hits the target.
        r = SCR.LTV_MAX;
        if (gap(r, 0) < 0) { down = 0; notes.push("even with $0 to the seller the loan can't fund the target cash back"); }
        else { let cLo = 0, cHi = down; for (let i = 0; i < 40; i++) { const m = (cLo + cHi) / 2; if (gap(r, m) < 0) cHi = m; else cLo = m; } down = scrRound((cLo + cHi) / 2); notes.push(`max LTV reached, so the seller's cash at closing was cut from ${scrMoney(baseDown)} to ${scrMoney(down)} to cover the target cash back`); }
      }
      let profit = profitAt(down, r);
      if (profit < minProfit) {
        // Not enough buyer profit at the Ashurst ratios: trade seller cash at closing for a smaller loan (less
        // interest and payoff at exit) until the minimum is met, keeping the buyer's cash back on target.
        const startDown = down, startR = r;
        for (let d = down - 500; d >= 0; d -= 500) {
          const rr = solveR(d); if (rr === null) continue;
          if (profitAt(d, rr) >= minProfit) { down = d; r = rr; profit = profitAt(d, rr); break; }
          if (d - 500 < 0) { down = d; r = rr; profit = profitAt(d, rr); }       // best effort at $0 down
        }
        if (down !== startDown) notes.push(`to meet the buyer profit minimum, the seller's cash at closing went from ${scrMoney(startDown)} to ${scrMoney(down)} and LTV from ${(startR * 100).toFixed(1)}% to ${(r * 100).toFixed(1)}%`);
      }
      return { carry, cash, down, r, note: notes.join("; "), loan: asIs * r, profit, minProfit };
    };
    const carryRaw = Math.round(SCR.CARRY_PCT_OF_ARV * arvMid / 1000) * 1000;
    let c = build(list ? Math.min(list, carryRaw) : carryRaw);
    const startCarry = c.carry;
    while (c.profit < c.minProfit && c.carry - 1000 >= SCR.MIN_CARRY_PCT_OF_ARV * arvMid) c = build(c.carry - 1000);
    if (c.carry < startCarry) priceNote = `carry price reduced from ${scrMoney(startCarry)} to ${scrMoney(c.carry)} to keep the buyer's profit at the minimum`;
    carryOffer = c.carry; cashOffer = c.cash; carryDown = c.down; ltv = c.r; ltvNote = c.note;
    hmLoan = c.loan; hmMonthly = hmLoan * SCR.HM_RATE / 100 / 12;
    modelCarry = scrModel(carryOffer, carryDown, hmLoan, asIs);
    modelCash = scrModel(cashOffer, cashOffer, hmLoan, asIs);
    profit = { sale: c.profit, min: c.minProfit, ok: c.profit >= c.minProfit, years, withCashBack: c.profit + modelCarry.cashBack };
    if (f.gut) gutPlan = { holding: hmMonthly * months, buffer, target: modelCarry.cashBack, cashBack: modelCarry.cashBack, estClosing: modelCarry.closing, shortfall: 0 };
  }
  const why = [];
  if (d.dom !== null && d.dom < SCR.cfg.minDom) why.push(`${d.dom} days on market`);
  if (profit && !profit.ok) why.push(`buyer profit ${scrMoney(profit.sale)} is under the ${scrMoney(profit.min)} minimum even at the lowest carry price`);
  if (lowEquity) why.push(`owner equity ${ownerEquityPct.toFixed(0)}% < ${SCR.cfg.minOwnerEquityPct}%`);
  const offerToList = list ? cashOffer / list * 100 : null;   // informational only: low and dual offers are fine
  return { ready: true, land, arvMid, rehab, rehabSource, asIs, months, suite, mao, cashOffer, carryOffer, carryDown, hmLoan, hmMonthly, ltv, ltvNote, profit, priceNote,
    reserves: hmMonthly * months, gutPlan, modelCarry, modelCash, ownerEquityPct, offerToList, equityAfterRehab: arvMid - list - rehab, qualifies: why.length === 0, why };
}

/* ---------- links + notes ---------- */
function scrLoiLink(d, p) {
  const t = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const q = {
    address: d.address, units: 1, prop_type: p.land ? "land" : "residential", sqft: d.sqft || "", appreciation: 3, noi_growth: 2,
    purchase_price: p.land ? p.cashOffer : p.carryOffer, cash_at_closing: p.land ? p.cashOffer : p.carryDown,
    dual_cash_price: p.land ? "" : p.cashOffer, as_is_value: p.asIs, arv: p.arvMid, rehab: p.rehab,
    sr_rate: SCR.HM_RATE, sr_amort: 30, sr_term: 12, sr_ltv: Math.round(p.ltv * 1000) / 10, sr_dscr: 1.25, sr_points: 2,
    hm_ltc: 90, hm_arv_pct: 75, hm_rehab_pct: 100, hm_rehab_months: p.months, sc_rate: 0, sc_term: p.months / 12, monthly_principal: 0,
    esc1_pct: 2, esc2_pct: 1.5, acq_pct: 50, broker_pct: 0, taf_pct: 2.5, park_escrow: "N", exit_type: "sale", exit_sale_costs: 6,
    exit_refi_ltv: 75, exit_refi_rate: 7.5, exit_dscr_req: 1.25, exit_amort: 30, exit_refi_costs: 2.5, exit_refi_fees: 15000,
    exit_reserve_mo: p.months, ac_phone: "520 633 6437", ac_email1: "SuedeBuffaloOfficial@gmail.com", buyer_company: "Suede Buffalo LLC",
    offer_expiry: t, loi_agent_fee: 3, loi_agent_fee_type: "pct", closing_cost_party: "split", appraisal_contingency: "off",
    acq_fee_basis: "at_closing", seller_security_type: "equity", mode: "principal_only", loan_type: "hard_money", static_cf: 1
  };
  if (p.land) q.no_sc = 1; else q.dual_offer_active = 1;
  const u = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => { if (v !== "" && v !== null && v !== undefined) u.set(k, v); });
  return SCR.LOI_URL + "?" + u.toString();
}

function scrAnswers(d, f, p) {
  const land = p.land;
  return {
    email: SCR.AGENT_EMAIL, role: "Wholesaler", name: SCR.AGENT_NAME, phone: SCR.PHONE,
    street: d.street, city: d.city, state: d.state, zip: d.zip, beds: String(d.beds || ""), baths: String(d.baths || ""),
    sqft: String(d.sqft || ""), askingPrice: String(d.price || ""), priceSought: String(d.price || ""), yearBuilt: String(d.year || ""),
    assetType: land ? "Land" : "Residential Property (1-4 units)", units: "1", marketStatus: "On-Market", sourceLink: d.url || "",
    arv: String(p.arvMid), arvRange: f.arvLow && f.arvHigh ? `$${f.arvLow.toLocaleString()} – $${f.arvHigh.toLocaleString()}` : "",
    rehabEstimate: String(p.rehab), rehabEstimateLow: String(f.rehabLow || ""), rehabEstimateHigh: String(f.rehabHigh || ""), rehabAiText: f.rehabAiText || "", dealType: "Cash Deal", estMortgageBalance: String(f.pwMortgage || 0),
    sellerContactName: f.owner || ""
  };
}

function scrResumeLink(a) {
  return "https://sendmyseller.com/?resume=" + encodeURIComponent(JSON.stringify({ a, s: 19 }));
}

function scrNotes(d, f, p, loi, resume) {
  const land = p.land;
  const L = [
    `PRE-LOI (not contacted, not submitted): ${d.address}`,
    `Source: ${d.url || "uploaded list"}${d.mls ? "  MLS# " + d.mls : ""}   List: ${scrMoney(d.price)}   Days on market: ${d.dom ?? "?"}`,
    "", "PICK UP WHERE WE LEFT OFF",
    `- LOI Generator (${land ? "cash template, land" : "cash template + dual offer"}, pre-filled): ${loi}`,
    `- sendmyseller.com resume link (do NOT submit): ${resume}`, "", "UNDERWRITING",
    land ? `- As-is value (middle of range): ${scrMoney(p.arvMid)}` : `- ARV (middle of comp range): ${scrMoney(p.arvMid)}   Rehab: ${scrMoney(p.rehab)}   As-is: ${scrMoney(p.asIs)}`,
    land ? `- Cash offer (land): ${scrMoney(p.cashOffer)}   [site MAO: ${scrMoney(p.mao)}]`
         : `- Hard Money Buyer MAO (20% down): ${scrMoney(p.mao)}\n- Offer A, all cash (${(SCR.CASH_PCT_OF_CARRY * 100).toFixed(1)}% of the carry price): ${scrMoney(p.cashOffer)}\n- Offer B, seller carry (${(SCR.CARRY_PCT_OF_ARV * 100).toFixed(1)}% of ARV, capped at list): ${scrMoney(p.carryOffer)} (${scrMoney(p.carryDown)} at closing, balance carried ${p.months} months at 0%)`,
  ];
  if (p.gutPlan) {
    const g = p.gutPlan;
    L.push(`- GUT cash at closing: buyer gets ${scrMoney(g.cashBack)} back = holding cost ${scrMoney(g.holding)} (${p.months} mo of hard money interest) + cushion ${scrMoney(g.buffer)} (greater of ${scrMoney(SCR.GUT_BUFFER_MIN)} or ${SCR.GUT_BUFFER_PCT * 100}% of ARV) for assignment fee / extra buyer cash. Seller cash at closing ${scrMoney(p.carryDown)}, rest carried. Estimated with the generator's fee structure; confirm in the LOI generator.${g.shortfall ? " NOTE: the loan can't fully fund this; short by " + scrMoney(g.shortfall) + "." : ""}`);
  }
  if (p.profit) L.push(`- Buyer profit at the ${p.profit.years}-year balloon exit (sale at 3% appreciation less 6% costs, less carry, loan and interest): ${scrMoney(p.profit.sale)}; minimum is the greater of ${scrMoney(SCR.MIN_PROFIT_PER_YEAR * p.profit.years)} or ${SCR.MIN_PROFIT_PCT_OF_PRICE * 100}% of price = ${scrMoney(p.profit.min)} -> ${p.profit.ok ? "OK" : "BELOW MINIMUM"}. With cash back at closing: ${scrMoney(p.profit.withCashBack)}.${p.priceNote ? " " + p.priceNote + "." : ""}`);
  if (p.modelCarry) L.push(`- Estimated (check in the generator): carry offer -> seller nets ${scrMoney(p.modelCarry.sellerNet)} at closing after their half of closing costs, buyer cash back ${scrMoney(p.modelCarry.cashBack)}. Cash offer -> seller nets ${scrMoney(p.modelCash.sellerNet)}, buyer ${p.modelCash.cashBack >= 0 ? "cash back " + scrMoney(p.modelCash.cashBack) : "brings " + scrMoney(-p.modelCash.cashBack)}.`);
  if (!land) L.push(`- Hard money: ${scrMoney(p.hmLoan)} at ${(p.ltv * 100).toFixed(1)}% LTV, ${SCR.HM_RATE}% -> ${scrMoney(p.hmMonthly)}/mo interest; reserves for ${p.months} months: ${scrMoney(p.reserves)}`);
  L.push(`- Owner equity (Propwire): ${p.ownerEquityPct === null ? "n/a" : p.ownerEquityPct.toFixed(0) + "%"}   Offer vs list: ${p.offerToList === null ? "n/a" : p.offerToList.toFixed(0) + "%"}`);
  L.push(`- Screen: ${p.qualifies ? "QUALIFIES" : "DOES NOT QUALIFY (" + p.why.join("; ") + ")"}`);
  if (f.owner || f.pwNotes) L.push(`- Propwire notes: ${[f.owner, f.pwNotes].filter(Boolean).join(" | ")}`);
  return L.join("\n");
}

function scrGmailLink(d, notes) {
  const su = `Pre-LOI (not sent) - ${d.street}, ${d.city} ${d.state}`;
  return "https://mail.google.com/mail/?view=cm&fs=1&su=" + encodeURIComponent(su) + "&body=" + encodeURIComponent(notes);
}

// The comps and rehab prompts are the wizard's own (compsPromptResidential / compsPromptLand / repairPromptText
// in app.js), so the machine-read summary block and the comp rules match what the lead form uses.
const scrNum = v => (v === "" || v === undefined || v === null || isNaN(Number(v))) ? "" : String(Number(v));   // "2.0" -> "2"
function scrAddressLine(d) { return `${d.street || ""}, ${d.city || ""}, ${d.state || ""} ${d.zip || ""}`.trim(); }

function scrCompsPrompt(d) {
  const land = SCR.cfg.asset === "land";
  if (land) {
    const acres = d.lot ? (d.lot / 43560).toFixed(2).replace(/\.?0+$/, "") : "";
    const details = acres ? `${acres} acre(s) (${d.lot.toLocaleString()} square feet)` : "[ACREAGE/SQUARE FEET]";
    return compsPromptLand(scrAddressLine(d), details, "");
  }
  const details = d.beds && d.baths
    ? `${scrNum(d.beds)} bedroom(s), ${scrNum(d.baths)} bathroom(s), ${d.sqft ? d.sqft + " square feet" : "[SQUARE FEET]"}`
    : (d.sqft ? `${d.sqft} square feet` : "[BEDROOMS/BATHROOMS/SQUARE FEET]");
  return compsPromptResidential(scrAddressLine(d), details, "");
}

function scrRehabPrompt(d, arvMid) {
  return repairPromptText(scrAddressLine(d), arvMid, scrNum(d.beds), scrNum(d.baths), true,
    d.url || "https://www.zillow.com/homes/" + encodeURIComponent(d.address.replace(/,/g, "").replace(/\s+/g, "-")) + "_rb/");
}

// Copies the prompt (always) and opens Google AI with it pre-filled when it fits in a URL.
function scrAskGoogleAi(prompt) {
  navigator.clipboard.writeText(prompt).catch(() => {});
  const q = encodeURIComponent(prompt), url = "https://www.google.com/search?udm=50&q=";
  window.open(q.length <= 7000 ? url + q : url, "_blank", "noopener");
  return q.length <= 7000;
}

/* ---------- one-press helpers: bookmarklets for Propwire / Google AI + "Fill from clipboard" ---------- */
const SCR_BM_PROPWIRE = `(function(){var t=document.body.innerText,g=function(r){var m=t.match(r);return m?m[1]:''};
var o={src:'propwire',url:location.href,address:decodeURIComponent(location.pathname.split('/')[2]||'').replace(/-/g,' '),
value:g(/\\$([\\d,]+)\\s*\\n\\s*Estimated Property Value/),mortgage:g(/\\$([\\d,]+)\\s*\\n\\s*Est\\. Mortgage Balance/),
equityAmt:g(/\\$([\\d,]+)\\s*\\n\\s*Est\\. Equity/),equityPct:g(/(\\d+(?:\\.\\d+)?)%\\s*\\n\\s*Equity/),
lastSold:g(/Last sold ([A-Za-z]+ \\d+, \\d{4})/),owner:g(/Owner Name\\s*\\n\\s*([^\\n]+)/),
tags:['Free & Clear','High Equity','Absentee Owners','Tired Landlords','Vacant','Pre-Foreclosure','Tax Delinquent','Out-of-State Owners','Senior Owner'].filter(function(x){return t.replace(/Tax Delinquent\\?/g,'').indexOf(x)>-1})};
var s=JSON.stringify(o);(navigator.clipboard?navigator.clipboard.writeText(s):Promise.reject()).then(function(){alert('Propwire copied: '+(o.equityPct||'?')+'% equity for '+o.address+'. Now press Fill from clipboard in SendMySeller.')},function(){prompt('Copy this:',s)})})();`;
const SCR_BM_GOOGLE = `(function(){var t=document.body.innerText,m=t.match(/---COMPS SUMMARY---[\\s\\S]*?---END SUMMARY---/i),out=m?m[0]:t.slice(0,20000);
(navigator.clipboard?navigator.clipboard.writeText(out):Promise.reject()).then(function(){alert(m?'Comps summary copied. Now press Fill from clipboard in SendMySeller.':'No summary block found; copied page text instead.')},function(){prompt('Copy this:',out.slice(0,3000))})})();`;
const scrBmHref = code => "javascript:" + encodeURIComponent(code.replace(/\n/g, ""));

function scrNorm(x) { return String(x || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(street|st|drive|dr|avenue|ave|road|rd|lane|ln|court|ct|place|pl|boulevard|blvd|circle|cir|way|terrace|ter)\b/g, "").replace(/\s+/g, " ").trim(); }

const scrSet = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); } };
const scrMsg = (id, t, ok) => { const m = document.getElementById(id); if (m) { m.textContent = t; m.style.color = ok === false ? "#b45309" : ok ? "#166534" : ""; } };
const scrNumOf = x => Number(String(x || "").replace(/[^0-9.]/g, ""));

// Google AI ARV comps answer -> ARV low/high (the wizard's own parser)
function scrApplyComps(text, msgId = "scr-msg-comps") {
  const land = SCR.cfg.asset === "land", r = parseAICompsResponse(text, land, false);
  if (!(r.arvLow || r.arvHigh || r.arvEstimate)) { scrMsg(msgId, `Couldn't find ${land ? "an As-Is Value range" : "an ARV range"}. Paste the full answer including the ---COMPS SUMMARY--- block.`, false); return false; }
  scrSet("scr-arv-low", r.arvLow || r.arvEstimate); scrSet("scr-arv-high", r.arvHigh || r.arvEstimate);
  SCR.sel.comps = { sold: r.soldComps, active: r.activeComps };
  scrMsg(msgId, `Parsed: ${land ? "as-is value" : "ARV"} $${(r.arvLow || r.arvEstimate).toLocaleString()} to $${(r.arvHigh || r.arvEstimate).toLocaleString()} (${r.soldComps.length} sold, ${r.activeComps.length} active comps). The offer uses the middle.`, true);
  return true;
}

// Google AI rehab answers are long: the page echoes the question ("...to reach an ARV of $540,000"), then lists
// per-sq-ft rates, tiers and finally a total. parseRehabText (the wizard's parser) takes the FIRST dollar figure,
// which here is the ARV or a $/sq ft rate. So pick the most likely total-repair range first, then hand just that
// snippet to the same parser.
function scrBestRehab(text) {
  const t = text.replace(/how much fix and flip investor repair[^\n]*/gi, " ");    // the echoed question
  const re = /\$\s*[\d,]+(?:\.\d+)?\s*[KkMm]?\s*(?:to|and|–|-|—)\s*\$?\s*[\d,]+(?:\.\d+)?\s*[KkMm]?/g;
  let m, best = null;
  while ((m = re.exec(t))) {
    const snip = m[0], r = parseRehabText(snip);
    if (r.low == null || r.low < 3000) continue;                                   // $15 to $25 per sq ft
    const before = t.slice(Math.max(0, m.index - 140), m.index), after = t.slice(m.index + snip.length, m.index + snip.length + 30);
    if (/^\s*(?:\/|per)\s*(?:sq|square)/i.test(after)) continue;                    // a rate, not a total
    let score = 0;
    if (/total|overall|estimated|budget|all[- ]in|recommend|bottom line|realistic|expect/i.test(before)) score += 3;
    if (/repair|rehab|renovat|cost/i.test(before)) score += 1;
    if (/contingency|including/i.test(after)) score += 1;
    if (!best || score >= best.score) best = { score, low: r.low, high: r.high != null ? r.high : r.low, ctx: (before.slice(-60) + snip).replace(/\s+/g, " ").trim() };
  }
  if (best) return best;
  const single = t.match(/(?:total|estimated|budget|repair)[^$\n]{0,60}\$\s*([\d,]+)/i);
  if (single && Number(single[1].replace(/,/g, "")) >= 3000) { const v = Number(single[1].replace(/,/g, "")); return { low: v, high: v, ctx: single[0] }; }
  return null;
}

// Google AI rehab answer -> rehab low/high
function scrApplyRehab(text, msgId = "scr-msg-rehab") {
  const r = scrBestRehab(text);
  if (!r) { scrMsg(msgId, "Couldn't find a total repair amount in that answer. Enter rehab low/high manually.", false); return false; }
  SCR.sel.rehabAiText = text.slice(0, 6000);
  scrSet("scr-rehab-low", r.low); scrSet("scr-rehab-high", r.high);
  const arvMid = SCR.sel.f && SCR.sel.f.arvLow && SCR.sel.f.arvHigh ? (SCR.sel.f.arvLow + SCR.sel.f.arvHigh) / 2 : 0;
  const mid = (r.low + r.high) / 2, high = arvMid && mid > arvMid * 0.5;
  scrMsg(msgId, `Parsed rehab $${r.low.toLocaleString()} to $${r.high.toLocaleString()} from "…${r.ctx}". The offer uses the middle.${high ? " WARNING: that is over half the ARV, so check it's the total repair figure." : ""}`, !high);
  return true;
}

// Propwire: the bookmarklet's JSON, or the raw text of the property page (select all, copy)
function scrParsePropwireText(t) {
  const g = r => { const m = t.match(r); return m ? m[1] : ""; };
  return { src: "propwire", address: g(/^\s*([^\n]+)\n\s*[A-Za-z .]+, [A-Z]{2} \d{5}/m),
    value: g(/\$([\d,]+)\s*\n\s*Estimated Property Value/), mortgage: g(/\$([\d,]+)\s*\n\s*Est\. Mortgage Balance/),
    equityAmt: g(/\$([\d,]+)\s*\n\s*Est\. Equity/), equityPct: g(/(\d+(?:\.\d+)?)%\s*\n\s*Equity/),
    lastSold: g(/Last sold ([A-Za-z]+ \d+, \d{4})/), owner: g(/Owner Name\s*\n\s*([^\n]+)/),
    tags: ["Free & Clear", "High Equity", "Absentee Owners", "Tired Landlords", "Vacant", "Pre-Foreclosure", "Tax Delinquent", "Out-of-State Owners", "Senior Owner"]
      .filter(x => t.replace(/Tax Delinquent\?/g, "").indexOf(x) > -1), url: "" };
}

function scrApplyPropwire(text, msgId = "scr-msg-pw") {
  let o = null; try { o = JSON.parse(text); } catch (e) {}
  if (!o || o.src !== "propwire") o = scrParsePropwireText(text);
  if (o.equityPct === "" && !o.value) { scrMsg(msgId, "Couldn't find Propwire equity or value. Open the property's detail page, then copy with the bookmarklet (or select all and copy) and paste again.", false); return false; }
  const d = SCR.sel.d, same = !o.address || scrNorm(o.address).includes(scrNorm(d.street).split(" ").slice(0, 2).join(" "));
  if (o.equityPct !== "") scrSet("scr-pw-eq", scrNumOf(o.equityPct));
  if (o.value) scrSet("scr-pw-val", scrNumOf(o.value));
  if (o.mortgage !== "") scrSet("scr-pw-mort", scrNumOf(o.mortgage));
  if (o.owner) scrSet("scr-owner", o.owner);
  scrSet("scr-pw-notes", [o.tags && o.tags.length ? o.tags.join(", ") : "", o.lastSold ? "Last sold " + o.lastSold : "", o.url].filter(Boolean).join(" | "));
  scrMsg(msgId, `Parsed: ${o.equityPct !== "" ? o.equityPct + "% equity" : "value " + o.value}.${same ? "" : " WARNING: Propwire address (" + o.address + ") doesn't look like " + d.street + "."}`, same);
  return true;
}

// "Fill from clipboard": works out which kind of data is on the clipboard and drops it in its box + parses it
async function scrFillFromClipboard() {
  const msg = t => scrMsg("scr-fill-msg", t);
  let t = "";
  try { t = (await navigator.clipboard.readText()).trim(); } catch (e) { msg("Couldn't read the clipboard. Allow clipboard access, or paste into the boxes below and press Parse."); return; }
  if (!t) { msg("Clipboard is empty."); return; }
  const into = (id) => { const el = document.getElementById(id); if (el) el.value = t; };
  let o = null; try { o = JSON.parse(t); } catch (e) {}
  if ((o && o.src === "propwire") || /Estimated Property Value/.test(t)) { into("scr-in-pw"); scrApplyPropwire(t); msg("Clipboard looked like Propwire data."); }
  else if (/COMPS SUMMARY|ARV (RANGE|ESTIMATE)|AS-IS VALUE/i.test(t)) { into("scr-in-comps"); scrApplyComps(t); msg("Clipboard looked like Google AI comps."); }
  else if (SCR.cfg.asset !== "land" && scrBestRehab(t)) { into("scr-in-rehab"); scrApplyRehab(t); msg("Clipboard looked like a Google AI rehab answer."); }
  else msg("Clipboard doesn't look like Propwire or Google AI data.");
}

/* ---------- UI ---------- */
function scrOrder() {
  return SCR.rows.map(d => ({ d, s: scrStage1(d) })).sort((a, b) => (b.s.ok - a.s.ok) || ((b.d.dom || 0) - (a.d.dom || 0)));
}

// No Propwire equity shown (or not enough equity): mark the deal skipped and open the next one in line.
function scrSkipToNext(reason) {
  const cur = SCR.sel && SCR.sel.d;
  if (cur) cur.skipped = reason;
  const next = scrOrder().find(x => x.s.ok);
  scrRenderTable();
  const panel = document.getElementById("scr-prepare");
  if (next) scrPrepare(next.d.id);
  else { panel.hidden = false; panel.innerHTML = `<p class="small-muted">No more deals to review in this list.</p>`; }
}

function scrRenderTable() {
  const box = document.getElementById("scr-results");
  if (!SCR.rows.length) { box.innerHTML = ""; return; }
  const st = SCR.rows.map(d => ({ d, s: scrStage1(d) }));
  const pass = st.filter(x => x.s.ok), skip = st.length - pass.length;
  const sorted = scrOrder();
  box.innerHTML = `<p class="small-muted"><strong>${pass.length}</strong> of ${st.length} pass days on market + property type; ${skip} skipped.</p>
    <table class="crm-table"><thead><tr><th>Address</th><th>Type</th><th>List</th><th>Days</th><th>$/sf</th><th>Screen</th><th></th></tr></thead><tbody>
    ${sorted.map(({ d, s }) => `<tr style="cursor:default; ${s.ok ? "" : "opacity:.5"}">
      <td>${escapeHtml(d.street)}<br><span class="small-muted">${escapeHtml(d.city)}, ${escapeHtml(d.state)} ${escapeHtml(d.zip)}</span></td>
      <td>${escapeHtml(d.type || "")}</td><td>${d.price ? scrMoney(d.price) : "—"}</td><td>${d.dom ?? "?"}</td>
      <td>${d.price && d.sqft ? "$" + Math.round(d.price / d.sqft) : "—"}</td>
      <td>${s.ok ? `<span style="color:#065f46">Pass${s.note ? " — " + s.note : ""}</span>` : `<span class="small-muted">${escapeHtml(s.why)}</span>`}</td>
      <td>${s.ok ? `<button type="button" class="btn primary" data-scr-prep="${d.id}">Prepare</button>` : ""}</td></tr>`).join("")}
    </tbody></table>`;
  box.querySelectorAll("[data-scr-prep]").forEach(b => b.onclick = () => scrPrepare(Number(b.dataset.scrPrep)));
}

function scrPrepare(id) {
  const d = SCR.rows[id], land = SCR.cfg.asset === "land";
  SCR.sel = { d, f: { tier: "moderate" } };
  const panel = document.getElementById("scr-prepare");
  panel.hidden = false;
  panel.innerHTML = `<div class="card" style="margin-top:14px;">
    <h3 class="step-title" style="font-size:17px;">${escapeHtml(d.address)}</h3>
    <p class="small-muted">List ${d.price ? scrMoney(d.price) : "?"} · ${d.dom ?? "?"} days on market${d.sqft ? " · " + d.sqft.toLocaleString() + " sq ft" : ""}${d.lot && land ? " · " + d.lot.toLocaleString() + " sq ft lot" : ""}</p>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px; align-items:center;">
      <button type="button" class="btn secondary" id="scr-ask-comps">1. Ask Google AI: ${land ? "land comps" : "ARV comps"}</button>
      ${land ? "" : `<button type="button" class="btn secondary" id="scr-ask-rehab">2. Ask Google AI: rehab</button>`}
      <a class="btn secondary" target="_blank" rel="noopener" href="https://propwire.com/search">${land ? "2" : "3"}. Open Propwire</a>
      <button type="button" class="btn primary" id="scr-fill">Fill from clipboard</button>
    </div>
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:6px;">
      <button type="button" class="link-btn" id="scr-copy-comps">Copy comps prompt</button>
      ${land ? "" : `<button type="button" class="link-btn" id="scr-copy-rehab">Copy rehab prompt</button>`}
    </div>
    <details style="margin-bottom:8px;"><summary class="small-muted" style="cursor:pointer;">Show the exact prompts</summary>
      <p class="small-muted" style="margin:6px 0 2px;"><strong>Comps</strong></p><pre id="scr-show-comps" class="small-muted" style="white-space:pre-wrap;max-height:160px;overflow:auto;"></pre>
      ${land ? "" : `<p class="small-muted" style="margin:6px 0 2px;"><strong>Rehab</strong> (uses the middle of the ARV range once it is filled in)</p><pre id="scr-show-rehab" class="small-muted" style="white-space:pre-wrap;"></pre>`}
    </details>
    <p id="scr-fill-msg" class="small-muted" style="margin:0 0 10px;">Each Ask button copies the prompt and opens Google AI with it. On the answer (and on the Propwire property page) press the matching bookmarklet, then press Fill from clipboard.</p>
    <div style="margin:10px 0;">
      <label>Google AI: ARV comps answer</label>
      <textarea id="scr-in-comps" rows="3" placeholder="Paste the full answer, including ---COMPS SUMMARY---"></textarea>
      <button type="button" class="btn primary" id="scr-in-comps-btn" style="margin-top:6px;">Parse comps → ARV</button>
      <span id="scr-msg-comps" class="small-muted" style="margin-left:8px;"></span>
    </div>
    ${land ? "" : `    <div style="margin:10px 0;">
      <label>Google AI: rehab answer</label>
      <textarea id="scr-in-rehab" rows="3" placeholder="Paste the full answer to the rehab prompt"></textarea>
      <button type="button" class="btn primary" id="scr-in-rehab-btn" style="margin-top:6px;">Parse rehab</button>
      <span id="scr-msg-rehab" class="small-muted" style="margin-left:8px;"></span>
    </div>
`}
    <div style="margin:10px 0;">
      <label>Propwire (bookmarklet copy, or select-all text from the property page)</label>
      <textarea id="scr-in-pw" rows="3" placeholder="Paste Propwire data"></textarea>
      <button type="button" class="btn primary" id="scr-in-pw-btn" style="margin-top:6px;">Parse Propwire</button>
      <span id="scr-msg-pw" class="small-muted" style="margin-left:8px;"></span>
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin:10px 0;">
      <div><label>${land ? "As-is value low" : "ARV low"}</label><input type="number" id="scr-arv-low"></div>
      <div><label>${land ? "As-is value high" : "ARV high"}</label><input type="number" id="scr-arv-high"></div>
      ${land ? "" : `<div><label>Rehab low (Google AI)</label><input type="number" id="scr-rehab-low"></div>
      <div><label>Rehab high (Google AI)</label><input type="number" id="scr-rehab-high"></div>
      <div><label>Rehab $ override (blank = middle of range)</label><input type="number" id="scr-rehab"></div>
      <div><label>Rehab tier</label><select id="scr-tier"><option value="light">Light $25/sf</option><option value="moderate" selected>Moderate $40/sf</option><option value="heavy">Heavy $55/sf</option><option value="gut">Gut $75/sf</option></select></div>`}
      <div><label>Propwire equity % (if shown)</label><input type="number" id="scr-pw-eq"></div>
      <div><label>Propwire est. value</label><input type="number" id="scr-pw-val"></div>
      <div><label>Open mortgage balance (0 = free &amp; clear)</label><input type="number" id="scr-pw-mort"></div>
      <div><label>Owner name</label><input type="text" id="scr-owner"></div>
    </div>
    ${land ? "" : `<label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="scr-gut" style="width:auto;margin:0"> Full rehab / gut (24-month reserves and carry)</label>`}
    <label>Propwire / other notes</label><textarea id="scr-pw-notes" rows="2"></textarea>
    <div id="scr-calc" style="margin-top:12px;"></div></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const read = () => {
    const v = i => Number((document.getElementById(i) || {}).value) || 0;
    SCR.sel.f = { arvLow: v("scr-arv-low"), arvHigh: v("scr-arv-high"), rehab: v("scr-rehab"), rehabLow: v("scr-rehab-low"), rehabHigh: v("scr-rehab-high"),
      rehabAiText: SCR.sel.rehabAiText || "",
      tier: (document.getElementById("scr-tier") || {}).value, gut: !!(document.getElementById("scr-gut") || {}).checked,
      pwValue: v("scr-pw-val"), pwMortgage: v("scr-pw-mort"),
      pwMortgageSet: document.getElementById("scr-pw-mort").value !== "",
      pwEquityPct: document.getElementById("scr-pw-eq").value !== "" ? Number(document.getElementById("scr-pw-eq").value) : null, owner: document.getElementById("scr-owner").value.trim(),
      pwNotes: document.getElementById("scr-pw-notes").value.trim() };
    scrRenderCalc();
  };
  panel.querySelectorAll("input,select,textarea").forEach(el => el.addEventListener("input", read));
  document.getElementById("scr-fill").onclick = scrFillFromClipboard;
  document.getElementById("scr-ask-comps").onclick = () => {
    const fit = scrAskGoogleAi(scrCompsPrompt(d));
    document.getElementById("scr-fill-msg").textContent = fit ? "Comps prompt copied and opened in Google AI. When the answer finishes, press the Google AI bookmarklet, then Fill from clipboard."
      : "Comps prompt copied. Google AI opened without it (too long for the link): paste it in, then use the bookmarklet and Fill from clipboard.";
  };
  const curArvMid = () => { const f = SCR.sel.f || {}; return f.arvLow && f.arvHigh ? scrRound((f.arvLow + f.arvHigh) / 2) : (f.arvLow || f.arvHigh || 0); };
  const showPrompts = () => {
    document.getElementById("scr-show-comps").textContent = scrCompsPrompt(d);
    const sr = document.getElementById("scr-show-rehab"); if (sr) sr.textContent = scrRehabPrompt(d, curArvMid());
  };
  showPrompts(); panel.addEventListener("input", showPrompts);
  document.getElementById("scr-copy-comps").onclick = () => navigator.clipboard.writeText(scrCompsPrompt(d)).then(() => scrMsg("scr-fill-msg", "Comps prompt copied.", true));
  const copyRehab = document.getElementById("scr-copy-rehab");
  if (copyRehab) copyRehab.onclick = () => navigator.clipboard.writeText(scrRehabPrompt(d, curArvMid())).then(() => scrMsg("scr-fill-msg", curArvMid() ? "Rehab prompt copied (ARV " + scrMoney(curArvMid()) + ")." : "Rehab prompt copied without an ARV yet. Parse the comps first so it can include the ARV.", true));
  const askRehab = document.getElementById("scr-ask-rehab");
  if (askRehab) askRehab.onclick = () => {
    const f = SCR.sel.f || {}, arvMid = f.arvLow && f.arvHigh ? scrRound((f.arvLow + f.arvHigh) / 2) : (f.arvLow || f.arvHigh || 0);
    if (!arvMid) { document.getElementById("scr-fill-msg").textContent = "Fill the ARV from step 1 first: the rehab prompt asks about the repair needed to reach that ARV."; return; }
    scrAskGoogleAi(scrRehabPrompt(d, arvMid));
    document.getElementById("scr-fill-msg").textContent = `Rehab prompt (ARV ${scrMoney(arvMid)}) copied and opened in Google AI. Press the bookmarklet on the answer, then Fill from clipboard.`;
  };
  const wire = (box, fn, msgId) => { const btn = document.getElementById(box + "-btn"); if (!btn) return;
    btn.onclick = () => { const t = document.getElementById(box).value.trim(); if (!t) { scrMsg(msgId, "Paste the answer first.", false); return; } fn(t); }; };
  wire("scr-in-comps", scrApplyComps, "scr-msg-comps");
  wire("scr-in-rehab", scrApplyRehab, "scr-msg-rehab");
  wire("scr-in-pw", scrApplyPropwire, "scr-msg-pw");
  read();
}

function scrRenderCalc() {
  const { d, f } = SCR.sel, box = document.getElementById("scr-calc");
  const p = scrPrice(d, f); SCR.sel.p = p;
  const skipBtn = (label) => `<button type="button" class="btn secondary" id="scr-skip">${label}</button>`;
  const wireSkip = (reason) => { const b = document.getElementById("scr-skip"); if (b) b.onclick = () => scrSkipToNext(reason); };
  if (p.noEquity) {
    box.innerHTML = `<div class="banner warn" style="text-align:left;">No Propwire equity shown. Enter the equity %, or the value and mortgage balance. If Propwire doesn't show equity, skip this one.</div>${skipBtn("Skip to next deal")}`;
    wireSkip("No Propwire equity shown"); return;
  }
  if (!p.ready) { box.innerHTML = `<p class="small-muted">Enter an ARV range (or paste the Google AI response) to price the offers.</p>${skipBtn("Skip to next deal")}`; wireSkip("Skipped"); return; }
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  box.innerHTML = `<div class="banner ${p.qualifies ? "info" : "warn"}" style="text-align:left;">${p.qualifies ? "Qualifies for an offer (owner equity " + p.ownerEquityPct.toFixed(0) + "%)." : "Does not qualify: " + escapeHtml(p.why.join("; ")) + ". Skip it rather than forcing a tight offer."}</div>
    <dl class="review-grid">
      ${row(p.land ? "As-is value (middle)" : "ARV (middle of range)", scrMoney(p.arvMid))}
      ${p.land ? "" : row("Rehab (" + p.rehabSource + ")", scrMoney(p.rehab)) + row("As-is", scrMoney(p.asIs)) + row("Hard Money Buyer MAO (20% down)", scrMoney(p.mao))}
      ${row(p.land ? "Cash offer (land)" : "Offer A: all cash", scrMoney(p.cashOffer))}
      ${p.land ? "" : row("Offer B: seller carry", `${scrMoney(p.carryOffer)} (${scrMoney(p.carryDown)} down, ${p.months} mo)`) + row("Hard money loan (LTV solved)", `${scrMoney(p.hmLoan)} at ${(p.ltv * 100).toFixed(1)}% LTV → ${scrMoney(p.hmMonthly)}/mo${p.ltvNote ? " (" + escapeHtml(p.ltvNote) + ")" : ""}`) + row(`Reserves (${p.months} mo)`, scrMoney(p.reserves))}
      ${p.gutPlan ? row("Gut: cash back to buyer at close", `${scrMoney(p.gutPlan.cashBack)} = holding ${scrMoney(p.gutPlan.holding)} + cushion ${scrMoney(p.gutPlan.buffer)}`) + row("Gut: cash to seller at close", scrMoney(p.carryDown) + (p.gutPlan.shortfall ? ` (loan short by ${scrMoney(p.gutPlan.shortfall)})` : "")) : ""}
      ${p.profit ? row(`Buyer profit at ${p.profit.years}-yr balloon exit (Sale + CF)`, `${scrMoney(p.profit.sale)} vs ${scrMoney(p.profit.min)} minimum ${p.profit.ok ? "✓" : "✗"}`) : ""}
      ${p.priceNote ? row("Price adjusted", escapeHtml(p.priceNote)) : ""}
      ${p.modelCarry ? row("Carry offer: seller nets at close (est.)", scrMoney(p.modelCarry.sellerNet)) + row("Carry offer: buyer cash back (est.)", scrMoney(p.modelCarry.cashBack)) + row("Cash offer: seller nets (est.)", scrMoney(p.modelCash.sellerNet)) : ""}
      ${row("Offer vs list", p.offerToList === null ? "n/a" : p.offerToList.toFixed(0) + "%")}
      ${row("Owner equity", p.ownerEquityPct === null ? "enter Propwire value + mortgage" : p.ownerEquityPct.toFixed(0) + "%")}
    </dl>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
      <button type="button" class="btn primary" id="scr-save">Save to Auto Pre-LOI Before Contact</button>
      <button type="button" class="btn secondary" id="scr-open-loi">Open LOI generator</button>
      <button type="button" class="btn secondary" id="scr-gmail">Draft in Gmail</button>
      <button type="button" class="btn secondary" id="scr-copy-notes">Copy notes</button>
      <button type="button" class="btn secondary" id="scr-skip">Skip to next deal</button>
    </div><p id="scr-msg" class="small-muted"></p>`;
  const build = () => {
    const a = scrAnswers(d, f, p), loi = scrLoiLink(d, p), resume = scrResumeLink(a);
    return { a, loi, resume, notes: scrNotes(d, f, p, loi, resume) };
  };
  const msg = t => { document.getElementById("scr-msg").textContent = t; };
  document.getElementById("scr-skip").onclick = () => scrSkipToNext(p.lowEquity ? `Owner equity ${p.ownerEquityPct.toFixed(0)}% < ${SCR.cfg.minOwnerEquityPct}%` : "Skipped");
  document.getElementById("scr-open-loi").onclick = () => window.open(build().loi, "_blank", "noopener");
  document.getElementById("scr-gmail").onclick = () => {
    const b = build(); let link = scrGmailLink(d, b.notes);
    if (link.length > 7500) { link = scrGmailLink(d, b.notes.replace(/- sendmyseller\.com resume link[^\n]*\n/, "- sendmyseller.com resume link: open this deal from the Auto Pre-LOI tab > Resume\n")); }
    window.open(link, "_blank", "noopener");
  };
  document.getElementById("scr-copy-notes").onclick = () => navigator.clipboard.writeText(build().notes).then(() => msg("Notes copied."));
  document.getElementById("scr-save").onclick = async () => {
    const b = build(); b.a.preLoiNotes = b.notes;
    if (SCR.sel.comps) { b.a.soldCompsJson = JSON.stringify(SCR.sel.comps.sold || []); b.a.activeCompsJson = JSON.stringify(SCR.sel.comps.active || []); }
    msg("Saving...");
    const r = await api("adminSavePreLoi", { token: sessionToken, email: SCR.AGENT_EMAIL, crmId: SCR.sel.crmId || "", stepIndex: 19, answers: b.a });
    if (!r.ok) { msg("Couldn't save: " + (r.error || "unknown error")); return; }
    SCR.sel.crmId = r.crmId; msg("Saved to Auto Pre-LOI Before Contact. Nothing was submitted and no email was sent.");
    if (typeof loadPreLoi === "function") loadPreLoi();
  };
}

function scrMount() {
  const host = document.getElementById("preloi-panel");
  if (!host || document.getElementById("scr-card")) return;
  const card = document.createElement("div");
  card.className = "card"; card.id = "scr-card"; card.style.marginBottom = "16px";
  card.innerHTML = `<h3 class="step-title" style="font-size:18px;">Screen a list of active MLS deals</h3>
    <p class="small-muted">Upload a Redfin "Download All" CSV (or a plain list of addresses). Deals are screened on days on market and property type, then you add Propwire and Google AI info. Propwire owner equity (90%+ by default) is the only qualifier; no equity shown means skip. Offer price vs list doesn't matter.</p>
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px;">
      <div><label>Asset class</label><select id="scr-asset"><option value="sf">Single family (dual offer)</option><option value="land">Land (cash offer)</option></select></div>
      <div><label>Min days on market</label><input type="number" id="scr-min-dom" value="180"></div>
      <div><label>Min owner equity %</label><input type="number" id="scr-min-eq" value="90"></div>
    </div>
    <p class="small-muted" style="margin:10px 0 0;">One-press helpers: drag these to your bookmarks bar, then press them on the matching page.
      <a class="btn secondary" id="scr-bm-pw" style="cursor:grab;padding:4px 10px;">Copy Propwire equity</a>
      <a class="btn secondary" id="scr-bm-g" style="cursor:grab;padding:4px 10px;">Copy Google AI comps</a></p>
    <input type="file" id="scr-file" accept=".csv,.txt" style="margin-top:10px;">
    <div id="scr-results" style="margin-top:10px;"></div><div id="scr-prepare" hidden></div>`;
  host.insertBefore(card, host.firstChild);
  document.getElementById("scr-bm-pw").setAttribute("href", scrBmHref(SCR_BM_PROPWIRE));
  document.getElementById("scr-bm-g").setAttribute("href", scrBmHref(SCR_BM_GOOGLE));
  [["scr-bm-pw", "Copy Propwire equity"], ["scr-bm-g", "Copy Google AI comps"]].forEach(([id, label]) => {
    document.getElementById(id).addEventListener("click", e => { e.preventDefault(); alert("Drag \"" + label + "\" up to your bookmarks bar instead of clicking it here."); });
  });
  const sync = () => {
    SCR.cfg.asset = document.getElementById("scr-asset").value;
    SCR.cfg.minDom = Number(document.getElementById("scr-min-dom").value) || 0;
    SCR.cfg.minOwnerEquityPct = Number(document.getElementById("scr-min-eq").value) || 0;
    document.getElementById("scr-prepare").hidden = true; scrRenderTable();
  };
  card.querySelectorAll("select,input[type=number]").forEach(el => el.addEventListener("change", sync));
  document.getElementById("scr-file").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    SCR.rows = scrLoad(await f.text()); sync();
  };
}
scrMount();
