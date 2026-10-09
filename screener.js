/* Pre-LOI Screener (admin only). Upload a CSV of active MLS listings (Redfin "Download All" export, or just
   addresses), screen on days on market + property type, then enrich each survivor with Propwire / Google AI
   info to check equity and price the offers. Nothing here submits a lead or sends email: results are saved
   to the admin-only "Auto Pre-LOI Before Contact" tab through adminSavePreLoi.
   Uses globals from app.js: api, sessionToken, escapeHtml, computeMaoSuite, parseAICompsResponse, loadPreLoi. */

const SCR = {
  rows: [], sel: null,
  cfg: { asset: "sf", minDom: 180, minOwnerEquityPct: 25, minOfferToListPct: 70 },
  AGENT_EMAIL: "montanoemmanuel@gmail.com", AGENT_NAME: "Emmanuel's LOI Helper Agent", PHONE: "5206336437",
  LOI_URL: "https://pharaohm33.github.io/loi-generator/",
  REHAB_PSF: { light: 25, moderate: 40, heavy: 55, gut: 75 },   // quick estimate when no rehab number is entered
  HM_LTV: 60, HM_RATE: 9.5,
  CASH_DISCOUNT: 0.20,      // flip cash offer = Hard Money Buyer MAO (20% Down) less this
  CARRY_PREMIUM: 0.10, CARRY_DOWN: 0.40
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

function scrPrice(d, f) {
  const land = SCR.cfg.asset === "land";
  const list = d.price || 0;
  const arvMid = f.arvLow && f.arvHigh ? scrRound((f.arvLow + f.arvHigh) / 2) : (f.arvLow || f.arvHigh || 0);
  const tier = f.tier || "moderate";
  const rehab = land ? 0 : (f.rehab || (d.sqft ? scrRound(d.sqft * SCR.REHAB_PSF[tier]) : 0));
  if (!arvMid) return { ready: false };
  const months = f.gut ? 24 : 12;
  const suite = computeMaoSuite(arvMid, rehab, land ? "Land" : "Residential Property (1-4 units)", undefined, "On-Market");
  let cashOffer, carryOffer = 0, carryDown = 0, mao;
  if (land) { mao = suite.maoCash; cashOffer = scrRound(mao); }
  else {
    mao = suite.maoHardMoney20;
    cashOffer = scrRound(mao * (1 - SCR.CASH_DISCOUNT));
    carryOffer = scrRound(cashOffer * (1 + SCR.CARRY_PREMIUM));
    carryDown = scrRound(carryOffer * SCR.CARRY_DOWN);
  }
  const asIs = arvMid - rehab;
  const hmLoan = land ? 0 : asIs * SCR.HM_LTV / 100, hmMonthly = hmLoan * SCR.HM_RATE / 100 / 12;
  const val = f.pwValue || 0, mort = f.pwMortgage || 0;
  const ownerEquityPct = val ? (val - mort) / val * 100 : null;
  const why = [];
  if (d.dom !== null && d.dom < SCR.cfg.minDom) why.push(`${d.dom} days on market`);
  if (ownerEquityPct !== null && ownerEquityPct < SCR.cfg.minOwnerEquityPct) why.push(`owner equity ${ownerEquityPct.toFixed(0)}% < ${SCR.cfg.minOwnerEquityPct}%`);
  const offerToList = list ? cashOffer / list * 100 : null;
  if (offerToList !== null && offerToList < SCR.cfg.minOfferToListPct) why.push(`cash offer is ${offerToList.toFixed(0)}% of list (min ${SCR.cfg.minOfferToListPct}%)`);
  return { ready: true, land, arvMid, rehab, asIs, months, suite, mao, cashOffer, carryOffer, carryDown, hmLoan, hmMonthly,
    reserves: hmMonthly * months, ownerEquityPct, offerToList, equityAfterRehab: arvMid - list - rehab, qualifies: why.length === 0, why };
}

/* ---------- links + notes ---------- */
function scrLoiLink(d, p) {
  const t = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const q = {
    address: d.address, units: 1, prop_type: p.land ? "land" : "residential", sqft: d.sqft || "", appreciation: 3, noi_growth: 2,
    purchase_price: p.land ? p.cashOffer : p.carryOffer, cash_at_closing: p.land ? p.cashOffer : p.carryDown,
    dual_cash_price: p.land ? "" : p.cashOffer, as_is_value: p.asIs, arv: p.arvMid, rehab: p.rehab,
    sr_rate: SCR.HM_RATE, sr_amort: 30, sr_term: 12, sr_ltv: SCR.HM_LTV, sr_dscr: 1.25, sr_points: 2,
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
    rehabEstimate: String(p.rehab), dealType: "Cash Deal", estMortgageBalance: String(f.pwMortgage || 0),
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
         : `- Hard Money Buyer MAO (20% down): ${scrMoney(p.mao)}\n- Offer A, all cash (MAO less ${SCR.CASH_DISCOUNT * 100}%): ${scrMoney(p.cashOffer)}\n- Offer B, seller carry: ${scrMoney(p.carryOffer)} (${scrMoney(p.carryDown)} at closing, balance carried ${p.months} months at 0%)`,
  ];
  if (!land) L.push(`- Hard money: ${scrMoney(p.hmLoan)} at ${SCR.HM_LTV}% LTV, ${SCR.HM_RATE}% -> ${scrMoney(p.hmMonthly)}/mo interest; reserves for ${p.months} months: ${scrMoney(p.reserves)}`);
  L.push(`- Owner equity (Propwire): ${p.ownerEquityPct === null ? "n/a" : p.ownerEquityPct.toFixed(0) + "%"}   Offer vs list: ${p.offerToList === null ? "n/a" : p.offerToList.toFixed(0) + "%"}`);
  L.push(`- Screen: ${p.qualifies ? "QUALIFIES" : "DOES NOT QUALIFY (" + p.why.join("; ") + ")"}`);
  if (f.owner || f.pwNotes) L.push(`- Propwire notes: ${[f.owner, f.pwNotes].filter(Boolean).join(" | ")}`);
  return L.join("\n");
}

function scrGmailLink(d, notes) {
  const su = `Pre-LOI (not sent) - ${d.street}, ${d.city} ${d.state}`;
  return "https://mail.google.com/mail/?view=cm&fs=1&su=" + encodeURIComponent(su) + "&body=" + encodeURIComponent(notes);
}

function scrCompsPrompt(d) {
  const land = SCR.cfg.asset === "land";
  const what = land ? "AS-IS VALUE" : "ARV";
  return `Act as a professional real estate analyst. For ${d.address}${land ? " (vacant land" + (d.lot ? ", " + d.lot.toLocaleString() + " sq ft lot" : "") + ")" : ` (${d.beds || "?"} bed, ${d.baths || "?"} bath, ${d.sqft || "?"} sq ft, built ${d.year || "?"})`}, list sold comps from the last 6 months within 1 mile${land ? " (similar zoning and size)" : " with similar beds, baths and square footage, fully renovated for ARV"}. For each give address, price, sq ft, price per sq ft, distance and sold date. Anchor on the most recent and closest comps and do not average everything.

At the very end output EXACTLY this block (machine-read):
---COMPS SUMMARY---
SOLD COMPS:
[ADDRESS | PRICE | SQFT | PRICE/SQFT | BEDS | BATHS | DISTANCE | SOLD DATE]
ACTIVE COMPS:
[ADDRESS | PRICE | SQFT | PRICE/SQFT | BEDS | BATHS | DISTANCE | DAYS ON MARKET]
${what} RANGE: $[low] to $[high]
${what} ESTIMATE: $[single best estimate]
---END SUMMARY---`;
}

/* ---------- UI ---------- */
function scrRenderTable() {
  const box = document.getElementById("scr-results");
  if (!SCR.rows.length) { box.innerHTML = ""; return; }
  const st = SCR.rows.map(d => ({ d, s: scrStage1(d) }));
  const pass = st.filter(x => x.s.ok), skip = st.length - pass.length;
  const sorted = [...st].sort((a, b) => (b.s.ok - a.s.ok) || ((b.d.dom || 0) - (a.d.dom || 0)));
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
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
      <button type="button" class="btn secondary" id="scr-copy-prompt">Copy Google AI comps prompt</button>
      <a class="link-btn" target="_blank" rel="noopener" href="https://www.google.com/search?udm=50&q=${encodeURIComponent(d.address)}">Open Google AI</a>
      <a class="link-btn" target="_blank" rel="noopener" href="https://propwire.com/search?q=${encodeURIComponent(d.address)}">Open Propwire</a>
    </div>
    <label>Paste Google AI response (parses the summary block)</label>
    <textarea id="scr-ai" rows="4" placeholder="Paste the full response, including ---COMPS SUMMARY---"></textarea>
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin:10px 0;">
      <div><label>${land ? "As-is value low" : "ARV low"}</label><input type="number" id="scr-arv-low"></div>
      <div><label>${land ? "As-is value high" : "ARV high"}</label><input type="number" id="scr-arv-high"></div>
      ${land ? "" : `<div><label>Rehab $ (blank = by tier)</label><input type="number" id="scr-rehab"></div>
      <div><label>Rehab tier</label><select id="scr-tier"><option value="light">Light $25/sf</option><option value="moderate" selected>Moderate $40/sf</option><option value="heavy">Heavy $55/sf</option><option value="gut">Gut $75/sf</option></select></div>`}
      <div><label>Propwire est. value</label><input type="number" id="scr-pw-val"></div>
      <div><label>Open mortgage balance</label><input type="number" id="scr-pw-mort"></div>
      <div><label>Owner name</label><input type="text" id="scr-owner"></div>
    </div>
    ${land ? "" : `<label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="scr-gut" style="width:auto;margin:0"> Full rehab / gut (24-month reserves and carry)</label>`}
    <label>Propwire / other notes</label><textarea id="scr-pw-notes" rows="2"></textarea>
    <div id="scr-calc" style="margin-top:12px;"></div></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const read = () => {
    const v = i => Number((document.getElementById(i) || {}).value) || 0;
    SCR.sel.f = { arvLow: v("scr-arv-low"), arvHigh: v("scr-arv-high"), rehab: v("scr-rehab"),
      tier: (document.getElementById("scr-tier") || {}).value, gut: !!(document.getElementById("scr-gut") || {}).checked,
      pwValue: v("scr-pw-val"), pwMortgage: v("scr-pw-mort"), owner: document.getElementById("scr-owner").value.trim(),
      pwNotes: document.getElementById("scr-pw-notes").value.trim() };
    scrRenderCalc();
  };
  panel.querySelectorAll("input,select,textarea").forEach(el => el.addEventListener("input", read));
  document.getElementById("scr-copy-prompt").onclick = () => navigator.clipboard.writeText(scrCompsPrompt(d)).then(() => { document.getElementById("scr-copy-prompt").textContent = "Copied"; });
  document.getElementById("scr-ai").addEventListener("input", e => {
    const t = e.target.value.trim(); if (!t) return;
    const r = parseAICompsResponse(t, land, false);
    if (r.arvLow || r.arvHigh) {
      document.getElementById("scr-arv-low").value = r.arvLow || r.arvEstimate;
      document.getElementById("scr-arv-high").value = r.arvHigh || r.arvEstimate;
      SCR.sel.comps = { sold: r.soldComps, active: r.activeComps };
      read();
    }
  });
  read();
}

function scrRenderCalc() {
  const { d, f } = SCR.sel, box = document.getElementById("scr-calc");
  const p = scrPrice(d, f); SCR.sel.p = p;
  if (!p.ready) { box.innerHTML = `<p class="small-muted">Enter an ARV range (or paste the Google AI response) to price the offers.</p>`; return; }
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  box.innerHTML = `<div class="banner ${p.qualifies ? "info" : "warn"}" style="text-align:left;">${p.qualifies ? "Qualifies for an offer." : "Does not qualify: " + escapeHtml(p.why.join("; ")) + "."}</div>
    <dl class="review-grid">
      ${row(p.land ? "As-is value (middle)" : "ARV (middle of range)", scrMoney(p.arvMid))}
      ${p.land ? "" : row("Rehab", scrMoney(p.rehab)) + row("As-is", scrMoney(p.asIs)) + row("Hard Money Buyer MAO (20% down)", scrMoney(p.mao))}
      ${row(p.land ? "Cash offer (land)" : "Offer A: all cash", scrMoney(p.cashOffer))}
      ${p.land ? "" : row("Offer B: seller carry", `${scrMoney(p.carryOffer)} (${scrMoney(p.carryDown)} down, ${p.months} mo)`) + row("Hard money loan", `${scrMoney(p.hmLoan)} → ${scrMoney(p.hmMonthly)}/mo`) + row(`Reserves (${p.months} mo)`, scrMoney(p.reserves))}
      ${row("Offer vs list", p.offerToList === null ? "n/a" : p.offerToList.toFixed(0) + "%")}
      ${row("Owner equity", p.ownerEquityPct === null ? "enter Propwire value + mortgage" : p.ownerEquityPct.toFixed(0) + "%")}
    </dl>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
      <button type="button" class="btn primary" id="scr-save">Save to Auto Pre-LOI Before Contact</button>
      <button type="button" class="btn secondary" id="scr-open-loi">Open LOI generator</button>
      <button type="button" class="btn secondary" id="scr-gmail">Draft in Gmail</button>
      <button type="button" class="btn secondary" id="scr-copy-notes">Copy notes</button>
    </div><p id="scr-msg" class="small-muted"></p>`;
  const build = () => {
    const a = scrAnswers(d, f, p), loi = scrLoiLink(d, p), resume = scrResumeLink(a);
    return { a, loi, resume, notes: scrNotes(d, f, p, loi, resume) };
  };
  const msg = t => { document.getElementById("scr-msg").textContent = t; };
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
    <p class="small-muted">Upload a Redfin "Download All" CSV (or a plain list of addresses). Deals are screened on days on market and property type, then you add Propwire and Google AI info to check equity and price the offers.</p>
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px;">
      <div><label>Asset class</label><select id="scr-asset"><option value="sf">Single family (dual offer)</option><option value="land">Land (cash offer)</option></select></div>
      <div><label>Min days on market</label><input type="number" id="scr-min-dom" value="180"></div>
      <div><label>Min owner equity %</label><input type="number" id="scr-min-eq" value="25"></div>
      <div><label>Min cash offer % of list</label><input type="number" id="scr-min-ratio" value="70"></div>
    </div>
    <input type="file" id="scr-file" accept=".csv,.txt" style="margin-top:10px;">
    <div id="scr-results" style="margin-top:10px;"></div><div id="scr-prepare" hidden></div>`;
  host.insertBefore(card, host.firstChild);
  const sync = () => {
    SCR.cfg.asset = document.getElementById("scr-asset").value;
    SCR.cfg.minDom = Number(document.getElementById("scr-min-dom").value) || 0;
    SCR.cfg.minOwnerEquityPct = Number(document.getElementById("scr-min-eq").value) || 0;
    SCR.cfg.minOfferToListPct = Number(document.getElementById("scr-min-ratio").value) || 0;
    document.getElementById("scr-prepare").hidden = true; scrRenderTable();
  };
  card.querySelectorAll("select,input[type=number]").forEach(el => el.addEventListener("change", sync));
  document.getElementById("scr-file").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    SCR.rows = scrLoad(await f.text()); sync();
  };
}
scrMount();
