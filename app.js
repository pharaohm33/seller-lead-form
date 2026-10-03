/* Seller Lead Intake — front end. Talks only to the Apps Script backend
   configured in config.js. No other server exists. */

// ── AI RESPONSE PARSER ──
// Parses the structured summary block from Google AI Mode comps responses.
// Expects the ---COMPS SUMMARY--- block the prompt asks AI to output.
function parseAICompsResponse(text, isLand, isBusiness) {
  const parseDollar = s => {
    if (!s) return 0;
    const n = Number(String(s).replace(/[$,\s]/g, ""));
    return isNaN(n) ? 0 : n;
  };

  // Extract the summary block
  const blockMatch = text.match(/---COMPS SUMMARY---([\s\S]*?)---END SUMMARY---/i);
  const block = blockMatch ? blockMatch[1] : text;

  // Extract ARV range: "$175,500 to $194,000" or "$175,500–$194,000" or "ARV RANGE: $X to $Y"
  let arvLow = 0, arvHigh = 0, arvEstimate = 0;
  const rangeMatch = block.match(/ARV RANGE:\s*\$?([\d,]+)\s*(?:to|–|-)\s*\$?([\d,]+)/i)
    || text.match(/(?:ARV|Estimated ARV|value)\s*(?:Range|range)?:\s*\$?([\d,]+)\s*(?:to|–|-)\s*\$?([\d,]+)/i)
    || text.match(/\$?([\d,]+)\s*(?:to|–|-)\s*\$?([\d,]+)\s*(?:ARV|range)/i);
  if (rangeMatch) {
    arvLow = parseDollar(rangeMatch[1]);
    arvHigh = parseDollar(rangeMatch[2]);
  }
  const estimateMatch = block.match(/ARV ESTIMATE:\s*\$?([\d,]+)/i)
    || text.match(/(?:most likely|single best|best estimate|ARV estimate)[^$\d]*\$?([\d,]+)/i);
  if (estimateMatch) arvEstimate = parseDollar(estimateMatch[1]);
  if (!arvEstimate && arvLow && arvHigh) arvEstimate = Math.round((arvLow + arvHigh) / 2);

  // Parse individual comps from the summary block
  function parseCompLines(section) {
    const comps = [];
    const lines = section.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^(SOLD|ACTIVE|BUSINESS|ARV)/i.test(line)) continue;
      const parts = line.split("|").map(p => p.trim());
      if (parts.length >= 2) {
        const comp = { address: parts[0] };
        comp.price = parseDollar(parts[1]) || 0;
        if (isLand) {
          comp.acres = parts[2] || "";
          comp.pricePerUnit = parts[3] || "";
          comp.distance = parts[4] || "";
          comp.date = parts[5] || "";
        } else if (isBusiness) {
          comp.revenue = parts[2] || "";
          comp.earnings = parts[3] || "";
          comp.multiple = parts[4] || "";
          comp.location = parts[5] || "";
          comp.date = parts[6] || "";
        } else {
          comp.sqft = parts[2] || "";
          comp.pricePerSqft = parts[3] || "";
          comp.beds = parts[4] || "";
          comp.baths = parts[5] || "";
          comp.distance = parts[6] || "";
          comp.date = parts[7] || "";
        }
        if (comp.address && comp.address.length > 3) comps.push(comp);
      }
    }
    return comps;
  }

  const soldMatch = isBusiness
    ? block.match(/BUSINESS COMPS:\s*([\s\S]*?)(?=ARV RANGE:|$)/i)
    : block.match(/SOLD COMPS:\s*([\s\S]*?)(?=ACTIVE COMPS:|ARV RANGE:|$)/i);
  const activeMatch = !isBusiness && block.match(/ACTIVE COMPS:\s*([\s\S]*?)(?=ARV RANGE:|$)/i);
  const soldComps = soldMatch ? parseCompLines(soldMatch[1]) : [];
  const activeComps = activeMatch ? parseCompLines(activeMatch[1]) : [];

  return { arvLow, arvHigh, arvEstimate, soldComps, activeComps };
}

// Parses free-form text from a listing page (pasted, OCR'd, or scraped) to extract property fields.
function parseListingText(text) {
  const r = {};
  const clean = text.replace(/\n+/g, " ").replace(/\s+/g, " ");

  // Price: prefer the listing/asking price — look for "For sale $X" or plain "$X" (not Est. or Sold)
  // Avoid "Est. $X/mo" and "Last sold price" patterns by anchoring on "For sale" or standalone price
  const forSaleM = clean.match(/[Ff]or\s+sale\s+\$\s*([\d,]+)/);
  const priceM = clean.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]/);
  const priceK = clean.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]/);
  const priceRaw = clean.match(/\$\s*([\d]{3,}[,\d]*)/);
  if (forSaleM) r.price = forSaleM[1].replace(/,/g, "");
  else if (priceM) r.price = Math.round(parseFloat(priceM[1].replace(/,/g, "")) * 1_000_000);
  else if (priceK) r.price = Math.round(parseFloat(priceK[1].replace(/,/g, "")) * 1_000);
  else if (priceRaw) r.price = priceRaw[1].replace(/,/g, "");

  // Beds/baths/sqft — match Redfin "4 bd • 1 ba • 1,284 sq ft" and normal prose
  // Use the FIRST occurrence to get subject property stats, not nearby comps
  const bedsM = clean.match(/\b(\d+)\s*(?:bd|bed(?:room)?s?)\b/i);
  const bathsM = clean.match(/\b(\d+(?:\.\d)?)\s*(?:ba(?:\b)|bath(?:room)?s?)\b/i);
  // sqft: "1,284 sq ft" / "1284 sqft" / "2,365 SF" (LoopNet) / "Finished Sq. Ft. 1,284"
  const sqftM = clean.match(/\b([\d,]+)\s*(?:sq\.?\s*ft\.?|sqft|square\s*feet|\bSF\b)\b/i)
             || clean.match(/(?:[Ff]inished\s+Sq\.?\s*Ft\.?|Total\s+Sq\.?\s*Ft\.?)[:\s]+([\d,]+)/i);
  // acreage: "7.50 acres" / "1.14 Acres Lot" / "0.22 AC" (LoopNet)
  const acreM = clean.match(/\b([\d.]+)\s*(?:acres?|AC)\b/i);
  if (bedsM) r.beds = bedsM[1];
  if (bathsM) r.baths = bathsM[1];
  if (sqftM) r.sqft = (sqftM[1] || sqftM[2] || "").replace(/,/g, "");
  if (acreM) r.acreage = acreM[1];

  // Year built — handle both "Year Built 1956" and "1956 Year Built" (Redfin style)
  const yrLabelFirst = clean.match(/(?:year\s*built|yr\.?\s*built|built\s*in)[:\s]+(\d{4})/i);
  const yrValueFirst = clean.match(/\b(\d{4})\s+(?:year\s*built|yr\.?\s*built)/i);
  const yrFallback  = clean.match(/\b(19[2-9]\d|20[0-2]\d)\b/);
  if (yrLabelFirst) r.yearBuilt = yrLabelFirst[1];
  else if (yrValueFirst) r.yearBuilt = yrValueFirst[1];
  else if (yrFallback) r.yearBuilt = yrFallback[1];

  // Address parsing — handles:
  //   "123 Main St, Dallas, TX 75232"  (abbreviation)
  //   "7410 North Zanjero Blvd, Glendale, Arizona 85305"  (full state name)
  //   "7410 North Zanjero Blvd, Glendale, AZ 85305, Glendale, AZ 85305"  (Crexi duplicate)
  const US_STATE_NAMES = /Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming/i;
  const US_STATE_ABBR_MAP = {alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY"};
  // Negative lookbehind (?<![0-9,]) stops the regex from latching onto trailing digits of a price
  // (e.g. "000" from "$475,000") as a house number. Max 6 digits covers all real addresses.
  const addrM = clean.match(/(?<![0-9,])(\d{1,6}\s+[A-Za-z0-9 .#'-]+(?:St|Ave|Rd|Dr|Blvd|Boulevard|Ln|Way|Ct|Pl|Cir|Hwy|Pkwy|Trail|Terrace|Loop|Pass|Run|Path|Trl)[.,]?\s+[A-Za-z ]+,\s+(?:[A-Z]{2}|[A-Za-z ]+)\s+(\d{5}))/i);
  if (addrM) {
    const parts = addrM[1].split(",").map(s => s.trim());
    r.street = parts[0] || "";
    if (parts[1]) {
      const seg = parts[1].trim();
      const abbrM = seg.match(/^(.*?)\s+([A-Z]{2})$/);
      if (abbrM) { r.city = abbrM[1].trim(); r.state = abbrM[2]; }
      else {
        const fullM = seg.match(new RegExp("^(.*?)\\s+(" + US_STATE_NAMES.source + ")$", "i"));
        if (fullM) { r.city = fullM[1].trim(); r.state = US_STATE_ABBR_MAP[fullM[2].toLowerCase()] || fullM[2]; }
        else r.city = seg;
      }
    }
    // parts[2] holds "AZ 75232" or "Arizona 75232" when city and state are in separate comma segments
    if (parts[2]) {
      const p2 = parts[2].trim();
      const szAbbr = p2.match(/^([A-Z]{2})\s+(\d{5})/);
      const szFull = p2.match(new RegExp("^(" + US_STATE_NAMES.source + ")\\s+(\\d{5})", "i"));
      if (szAbbr) { if (!r.state) r.state = szAbbr[1]; r.zip = szAbbr[2]; }
      else if (szFull) { if (!r.state) r.state = US_STATE_ABBR_MAP[szFull[1].toLowerCase()] || szFull[1]; r.zip = szFull[2]; }
      else r.zip = (p2.match(/\d{5}/) || [])[0] || "";
    }
  }

  // Agent name — priority order:
  //   1. "Listing Contacts Tim Dulany" (Crexi — more specific than "Listed by Kidder Mathews" brokerage)
  //   2. "Listed by Chaz Cameli" / "Listing Agent: ..."
  //   3. "Contact Amber Brandt" (LoopNet — last resort, "Contact" is generic)
  const agentContacts = clean.match(/[Ll]isting\s+[Cc]ontacts\s+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/);
  const agentListedBy = clean.match(/(?:listed\s*by|listing\s*agent)[:\s•]+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i);
  const agentContact  = clean.match(/\bContact\s+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/);
  if (agentContacts) r.agentName = agentContacts[1];
  else if (agentListedBy) r.agentName = agentListedBy[1];
  else if (agentContact) r.agentName = agentContact[1];
  // Deduplicate if name appears twice consecutively (e.g. LoopNet shows name on two lines)
  if (r.agentName) {
    const ws = r.agentName.trim().split(/\s+/);
    const h = ws.length / 2;
    if (ws.length >= 4 && ws.length % 2 === 0 && ws.slice(0, h).join(" ") === ws.slice(h).join(" "))
      r.agentName = ws.slice(0, h).join(" ");
  }

  // Phone: "Contact: 714-580-6346" preferred; then "Brokerage Phone 6023304468" (Crexi); then first plain phone
  const contactPhoneM  = clean.match(/[Cc]ontact[:\s]+(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/);
  const brokerPhoneM   = clean.match(/[Bb]rokerage\s+[Pp]hone\s+(\d{10})/);
  const plainPhoneM    = clean.match(/(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/);
  if (contactPhoneM) r.agentPhone = contactPhoneM[1];
  else if (brokerPhoneM) { const d = brokerPhoneM[1]; r.agentPhone = `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`; }
  else if (plainPhoneM) r.agentPhone = plainPhoneM[1];

  // Email — skip listing platform domains, placeholder domains, and generic/no-reply prefixes
  const BLOCKED_EMAIL_DOMAINS = /^(?:redfin|zillow|loopnet|crexi|realtor|trulia|homes|movoto|homesnap|listhub|example|test|sample|fake|placeholder|domain|email|mailinator|guerrillamail|tempmail|throwam|yopmail)\.(?:com|org|net)$/i;
  const BLOCKED_EMAIL_PREFIXES = /^(?:noreply|no-reply|donotreply|do-not-reply|notifications?|support|info|contact|help|admin|hello|team|sales|marketing|bots?|mailer|unsubscribe|feedback|service|enquir|legal|privacy|press|media|example|user|username|youremail|yourname|name|email)\b/i;
  const emailAll = [...clean.matchAll(/([a-zA-Z0-9._%+\-]+@([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}))/g)];
  const realEmail = emailAll.find(m => !BLOCKED_EMAIL_DOMAINS.test(m[2]) && !BLOCKED_EMAIL_PREFIXES.test(m[1].split("@")[0]));
  if (realEmail) r.agentEmail = realEmail[1];

  // APN / Parcel ID — "APN 1234567890" / "Parcel ID: 123-456-789" / "Parcel # 12.34.56"
  // APNs don't contain spaces (they use hyphens/dots as separators), so we stop at the first space.
  const apnM = clean.match(/(?:APN|Assessor['']?s?\s+Parcel\s+(?:Number|No\.?)|Parcel\s+(?:ID|Number|No\.?|#))[:\s#]*([0-9][0-9A-Za-z\-./]{1,39})(?=\s|$|[,;])/i);
  if (apnM) r.parcelIds = apnM[1].trim();

  // Asset type — check Property Type / Home Type first, then Redfin's "Style" field (e.g.
  // "Style Single Family Residential" or "Style Lots / Land"), then fall back to keyword inference.
  // After whitespace-collapsing, field values run directly into the next label with only a single
  // space, so \s{2,} never fires — stop instead at a digit or a known next-field keyword.
  const ptM = clean.match(/(?:[Pp]roperty\s+[Tt]ype|[Hh]ome\s+[Tt]ype)[:\s•]+([A-Za-z][A-Za-z\s\-/]{1,45}?)(?=\s+(?:Year\b|Lot\b|HOA\b|MLS\b|Parcel\b|APN\b|Garage\b|Stories\b|Bath|Bed|Sq\s|Style\b|Status\b|Price\b|\d)|\s*[.,;]|$)/i);
  const styleM = clean.match(/\b[Ss]tyle[:\s•]+([A-Za-z][A-Za-z\s\/\-]{2,45}?)(?=\s+(?:Year\b|Lot\b|HOA\b|MLS\b|Parcel\b|APN\b|Garage\b|Stories\b|Bath|Bed|Sq\s|Type\b|Status\b|Price\b|Updated\b|Listed\b|\d)|\s*[.,;]|$)/i);
  const typeCandidate = ptM ? ptM[1] : (styleM ? styleM[1] : "");
  if (typeCandidate) {
    const tc = typeCandidate.toLowerCase().trim();
    if (/land|lot|vacant|acreage|raw/.test(tc)) r.assetType = "Land";
    else if (/multi.family|multifamily|apartment|commercial|retail|office|industrial|hospitality|hotel|mixed.use/.test(tc)) r.assetType = "Commercial Property";
    else if (ptM) r.assetType = "Residential Property (1-4 units)"; // only default to residential if explicit Property Type label was found
  }
  if (!r.assetType) {
    if (/\blands?\b|\bvacant\s*lot\b|\braw\s*land\b|\bacreage\b/i.test(clean)) r.assetType = "Land";
    else if (/\bcommercial\b|\bmultifamily\b|\boffice\b|\bretail\b|\bindustrial\b/i.test(clean)) r.assetType = "Commercial Property";
    else if (r.beds || /\bsingle.family\b|\bcondo\b|\btownhome\b|\btownhouse\b/i.test(clean)) r.assetType = "Residential Property (1-4 units)";
  }

  return r;
}

function parseRehabText(text) {
  const clean = text.replace(/\n+/g, " ").replace(/\s+/g, " ");
  function parseMoney(str) {
    const m = str.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*([KkMm]?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (/[Mm]/.test(m[2])) return Math.round(n * 1_000_000);
    if (/[Kk]/.test(m[2])) return Math.round(n * 1_000);
    return Math.round(n);
  }
  // Range: "$X to/and/–/-/— $Y"
  const rangeM = clean.match(/(\$[\d,]+(?:\.\d+)?\s*[KkMm]?)\s*(?:to|and|–|-|—)\s*(\$[\d,]+(?:\.\d+)?\s*[KkMm]?)/i);
  if (rangeM) return { low: parseMoney(rangeM[1]), high: parseMoney(rangeM[2]) };
  // Single value
  const singleM = clean.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[KkMm]?/);
  if (singleM) { const v = parseMoney(singleM[0]); return { low: v, high: v }; }
  return {};
}

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];

const COMMERCIAL_SUBTYPES = ["Multifamily","Office","Hotel/Motel","Mixed Use","Industrial","Retail","Hospitality","Agriculture","Mobile Home or RV Park","Self Storage","Single Family Portfolio","Other Commercial Portfolio"];

const ADMIN_CONTACT_PHONE = "+1 520 633 6437";

// Fixed preset for the STR (short-term rental) income path -- unlike the
// long-term-rental path, the submitter never types an expense ratio here;
// this business-set 25% is applied silently on top of whatever taxes and
// insurance they enter.
const STR_EXPENSE_RATIO = 25;

// How close ARV can be to asking price (as a fraction below it) and still count as "close enough"
// for the no-rehab seller-financing-only pivot in cashDealDetails -- a judgment call, tune here.
const ARV_VS_ASKING_CLOSE_PCT = 0.05;

// Highest share of asking price an on-market cash deal can land at and still let the seller's
// listing stay up during due diligence (cashDealOutcome) -- above it, the listing has to come off
// market. A judgment call (65 to 70% in practice), tune here.
const LISTING_CAN_STAY_UP_MAX_PCT_OF_ASKING = 0.70;

const LEAD_STATUSES = ["New", "Contacted", "Under Review", "Offer Sent", "Negotiation", "Verbally Accepted But Not Signed", "Offer Signed By Seller", "In Escrow To Close", "Hold Off", "Closed", "Dead"];

const STATUS_COLORS = {
  "New": { bg: "#e5e7eb", fg: "#374151" },
  "Contacted": { bg: "#dbeafe", fg: "#1d4ed8" },
  "Under Review": { bg: "#f5e7db", fg: "#b4622a" },
  "Offer Sent": { bg: "#1e3a8a", fg: "#ffffff" },
  "Negotiation": { bg: "#111827", fg: "#ffffff" },
  "Verbally Accepted But Not Signed": { bg: "#d1fae5", fg: "#065f46" },
  "Offer Signed By Seller": { bg: "#e1efe7", fg: "#1f6f4a" },
  "In Escrow To Close": { bg: "#14532d", fg: "#ffffff" },
  "Hold Off": { bg: "#fef3c7", fg: "#92400e" },
  "Closed": { bg: "#e5e7eb", fg: "#374151" },
  "Dead": { bg: "#fbeceb", fg: "#b3372c" }
};

function statusPillHtml(status) {
  const s = status || "New";
  const colors = STATUS_COLORS[s] || STATUS_COLORS["New"];
  return `<span class="status-pill" style="background:${colors.bg}; color:${colors.fg};">${escapeHtml(s)}</span>`;
}

// Display order, top to bottom, for the NON-ADMIN status view. Kept in
// sync manually with the identical array in backend/Code.gs (used there
// for the optional Sort Priority column) -- there's no shared-import
// between the two runtimes.
const STATUS_SORT_ORDER = [
  "In Escrow To Close",
  "Offer Signed By Seller",
  "Verbally Accepted But Not Signed",
  "Negotiation",
  "Offer Sent",
  "Under Review",
  "Contacted",
  "New",
  "Hold Off",
  "Closed",
  "Dead"
];

function statusSortIndex(status) {
  const idx = STATUS_SORT_ORDER.indexOf(status || "New");
  return idx === -1 ? STATUS_SORT_ORDER.length : idx;
}

// Admin's CRM table sorts "New" above "Offer Sent" so incoming leads that
// need a first look surface without scrolling, ahead of leads that are
// already in progress and just waiting on a response. Non-admins keep the
// order above so a submitter's own "Offer Sent" leads stay easy to find.
const ADMIN_STATUS_SORT_ORDER = [
  "In Escrow To Close",
  "Offer Signed By Seller",
  "Verbally Accepted But Not Signed",
  "Negotiation",
  "New",
  "Offer Sent",
  "Under Review",
  "Contacted",
  "Hold Off",
  "Closed",
  "Dead"
];

function adminStatusSortIndex(status) {
  const idx = ADMIN_STATUS_SORT_ORDER.indexOf(status || "New");
  return idx === -1 ? ADMIN_STATUS_SORT_ORDER.length : idx;
}

// "newest" ignores status entirely and sorts purely by submission date;
// "default" (or anything else) keeps the existing status-priority order,
// falling back to newest-first as the tiebreak within the same status.
function leadSortComparator(mode, statusIndexFn) {
  return (a, b) => {
    if (mode === "newest") return new Date(b["Submitted At"]) - new Date(a["Submitted At"]);
    const statusDiff = statusIndexFn(a["Status"]) - statusIndexFn(b["Status"]);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b["Submitted At"]) - new Date(a["Submitted At"]);
  };
}

const FOLLOWUP_REMINDER = `<strong>Follow-up reminder:</strong> If an offer has been sent to your lead and they
  haven't signed it yet, please follow up by phone or email roughly every 7 days. Log anything they counter
  with in the notes, or text admin directly at <strong>${ADMIN_CONTACT_PHONE}</strong>. You don't need to follow
  up if admin lets you know the deal is already closing, the seller is communicating directly and consistently
  with admin, or the lead is marked Dead. When a deal closes, admin will reach out to you directly — by text for
  the banking info needed to pay you, and by email for paperwork to sign.`;

async function api(action, payload) {
  const res = await fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action }, payload || {}))
  });
  return res.json();
}

/* ============================================================
   PUBLIC WIZARD
   ============================================================ */

const answers = {};

const steps = [
  {
    key: "intro",
    progress: false,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Before You Start</h2>
        <div class="banner danger">
          <strong>STOP — don't fill this out yet if you're working with us on deal acquisitions.</strong>
          Read the <strong>Outreach SOP</strong> (button at the top of the page) first, and send your
          outreach texts and/or make your calls to actually get a hold of a seller who's responsive and
          open to selling. Only start filling this out once you have that response. If you're the
          seller yourself, this doesn't apply to you — go ahead and continue below.
        </div>
        <div class="banner info">
          Any agreement on payment terms — down payment, monthly payments, timing, or price — will be
          discussed and confirmed directly with the admin you're in contact with before anything closes.
          Nothing submitted here is a binding offer.
        </div>
        <p>Admin contact: <strong>${ADMIN_CONTACT_PHONE}</strong></p>
        <p class="hint">This should take about 5 minutes. You can identify yourself as the seller, or as a
        connector/bird dog, wholesaler, realtor, consultant, associate, or referral bringing us a seller.</p>
        <p class="hint">If anything here is marked required and you don't have that information yet — for
        example, you're not the seller yourself and need to check with them — stop and use
        <strong>"Save My Progress"</strong> at the top of the page. That saves a link back to exactly where you
        left off (for your own use only, not for sharing with anyone else). Go get what's missing, then come
        back and pick up right where you stopped.</p>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:24px;">
          <button class="btn primary" id="start-btn">Start</button>
          <button class="btn primary" id="intro-next-btn">Next</button>
        </div>
        <div style="margin-top:12px;">
          <button class="btn secondary" id="check-status-btn" style="width:100%;">Check Status On My Existing Leads (Non-Admin)</button>
        </div>
      `;
      root.querySelector("#start-btn").onclick = () => goTo(1);
      root.querySelector("#intro-next-btn").onclick = () => goTo(1);
      root.querySelector("#check-status-btn").onclick = () => showStatusView();
    }
  },
  {
    key: "contact",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Who You Are</h2>
        <p class="step-sub">Tell us your role and how to reach you.</p>
        <label class="field-label">Your role <span class="req">*</span></label>
        <div class="choice-group" id="role-group">
          ${["Seller","Bird Dog / Connector","Wholesaler","Realtor","Consultant","Associate","Referral Source"]
            .map(r => `<button type="button" class="choice-btn" data-value="${r}">${r}</button>`).join("")}
        </div>
        <div class="error-text" id="role-error">Please select a role.</div>

        <label class="field-label">Your name <span class="req">*</span></label>
        <input type="text" id="name-input" placeholder="Full name">
        <div class="error-text" id="name-error">Your name is required.</div>

        <label class="field-label">Email address <span class="req">*</span></label>
        <input type="email" id="email-input" placeholder="name@example.com">
        <div class="error-text" id="email-error">A valid email address is required.</div>

        <label class="field-label">Phone number <span class="req">*</span></label>
        <input type="tel" id="phone-input" placeholder="(555) 555-5555">
        <div class="error-text" id="phone-error">A phone number is required.</div>

        <label class="field-label">Social media profile link <span class="small-muted">(optional)</span></label>
        <input type="text" id="social-input" placeholder="https://...">

        <label class="field-label">Who referred you? <span class="small-muted">(optional)</span></label>
        <div class="row2">
          <div>
            <input type="text" id="referrer-name-input" placeholder="Referrer's name">
          </div>
          <div>
            <input type="tel" id="referrer-phone-input" placeholder="Referrer's phone">
          </div>
        </div>

        <div class="banner info" id="save-progress-nudge" style="margin-top:16px;" hidden>
          The next step asks for the seller/realtor/broker's contact info, which is different for
          every deal — so <strong>right now, before you fill in the next page</strong> (after you
          fill out this page), is the best time to hit <strong>"Save My Progress"</strong> at the
          top of the page and bookmark the link. Reopening it later brings you right back here with
          your own name and contact info already filled in, ready for the next seller/realtor/broker
          and address etc.
        </div>
      `;
      const saveNudge = root.querySelector("#save-progress-nudge");
      const updateSaveNudge = () => { saveNudge.hidden = !answers.role || answers.role === "Seller"; };
      updateSaveNudge();
      root.querySelectorAll("#role-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.role) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#role-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.role = btn.dataset.value;
          updateSaveNudge();
        };
      });
      root.querySelector("#name-input").value = answers.name || "";
      root.querySelector("#email-input").value = answers.email || "";
      root.querySelector("#phone-input").value = answers.phone || "";
      root.querySelector("#social-input").value = answers.socialLink || "";
      root.querySelector("#referrer-name-input").value = answers.referrerName || "";
      root.querySelector("#referrer-phone-input").value = answers.referrerPhone || "";
    },
    validate(root) {
      answers.name = root.querySelector("#name-input").value.trim();
      answers.email = root.querySelector("#email-input").value.trim();
      answers.phone = root.querySelector("#phone-input").value.trim();
      answers.socialLink = root.querySelector("#social-input").value.trim();
      answers.referrerName = root.querySelector("#referrer-name-input").value.trim();
      answers.referrerPhone = root.querySelector("#referrer-phone-input").value.trim();
      let ok = true;
      toggleError(root, "#role-error", !answers.role); if (!answers.role) ok = false;
      toggleError(root, "#name-error", !answers.name); if (!answers.name) ok = false;
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.email);
      toggleError(root, "#email-error", !emailOk); if (!emailOk) ok = false;
      toggleError(root, "#phone-error", answers.phone.length < 7); if (answers.phone.length < 7) ok = false;
      return ok;
    }
  },
  {
    key: "listingAutofill",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Auto-Fill from Listing</h2>
        <p class="step-sub">Give us the listing and we'll pre-fill the form. Use either option below, or hit Skip to enter everything manually.</p>
        <div class="banner info" style="margin-bottom:14px;">⚡ <strong>Auto-fill is a work in progress</strong> — it's designed to save you as much time as possible so you can send offers fast. It won't always catch every field, especially on less common listing sites. Review what it fills in and correct anything that looks off before continuing.</div>

        <label class="field-label">Option 1 — Paste page text <span class="small-muted">(Ctrl+A → Ctrl+C on the listing page, paste here — works on Redfin, Crexi, Zillow, LoopNet, any site)</span></label>
        <textarea id="autofill-page-text" rows="5" placeholder="Go to the listing page, select all text (Ctrl+A), copy (Ctrl+C), then paste here. Captures address, beds, baths, sqft, price, agent name &amp; phone." style="font-size:13px;width:100%;box-sizing:border-box;resize:vertical;"></textarea>

        <label class="field-label" style="margin-top:16px;">Option 2 — Upload screenshot(s)</label>
        <input type="file" id="autofill-screenshots" accept="image/*" multiple style="margin-top:4px;">
        <p class="hint" style="margin-top:4px;">Processed free in your browser via OCR.</p>

        <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">
          <button class="btn primary" id="autofill-run-btn" style="flex:1;">Auto-Fill →</button>
          <button class="btn secondary" id="autofill-skip-btn" style="flex:1;">Skip / Enter Manually</button>
        </div>

        <div id="autofill-status" style="margin-top:12px;display:none;"></div>
        <div id="autofill-preview" style="margin-top:12px;display:none;"></div>
      `;

      // Wipe all listing-sourced fields the moment this step renders — old data from a previous
      // session's ?resume= URL must never survive to the address/contact/assetType steps.
      ["street","city","state","zip","beds","baths","sqft","acreage","askingPrice","yearBuilt",
       "sellerContactName","sellerContactPhone","sellerContactEmail","sourceLink","assetType","units",
       "priceSought","priceReasoning","arv","rehabEstimate","rehabEstimateLow","rehabEstimateHigh",
       "rehabAiText","parcelIds","_autofillUrl"].forEach(k => { delete answers[k]; });
      root.querySelector("#autofill-skip-btn").onclick = () => goTo(nextIndex(stepIndex));

      root.querySelector("#autofill-run-btn").onclick = async () => {
        const pasteText = root.querySelector("#autofill-page-text").value.trim();
        const files = root.querySelector("#autofill-screenshots").files;
        const statusEl = root.querySelector("#autofill-status");
        const previewEl = root.querySelector("#autofill-preview");
        statusEl.style.display = "block";
        previewEl.style.display = "none";

        if (!pasteText && (!files || files.length === 0)) {
          statusEl.innerHTML = `<div class="banner warn">Paste the listing page text or upload a screenshot first.</div>`;
          return;
        }

        let extracted = {};

        if (pasteText) {
          statusEl.innerHTML = `<div class="banner info">Parsing pasted text…</div>`;
          const fromText = parseListingText(pasteText);
          for (const [k, v] of Object.entries(fromText)) { if (v) extracted[k] = v; }
        }

        if (files && files.length > 0) {
          statusEl.innerHTML = `<div class="banner info">Running OCR on ${files.length} screenshot${files.length > 1 ? "s" : ""}… (this can take 10–20 seconds)</div>`;
          try {
            if (!window.Tesseract) {
              await new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = "https://unpkg.com/tesseract.js@4/dist/tesseract.min.js";
                s.onload = resolve; s.onerror = reject;
                document.head.appendChild(s);
              });
            }
            let fullText = "";
            for (const file of files) {
              const { data: { text } } = await Tesseract.recognize(file, "eng");
              fullText += "\n" + text;
            }
            const ocr = parseListingText(fullText);
            for (const [k, v] of Object.entries(ocr)) {
              if (v && !extracted[k]) extracted[k] = v;
            }
          } catch(e) {
            statusEl.innerHTML += `<div class="banner warn" style="margin-top:8px;">OCR failed: ${e.message}. Try a different screenshot or use the paste option.</div>`;
          }
        }

        if (Object.keys(extracted).length === 0) return;

        // Apply freshly extracted data
        if (extracted.street)    answers.street = extracted.street;
        if (extracted.city)      answers.city = extracted.city;
        if (extracted.state)     answers.state = extracted.state;
        if (extracted.zip)       answers.zip = extracted.zip;
        if (extracted.beds)      answers.beds = extracted.beds;
        if (extracted.baths)     answers.baths = extracted.baths;
        if (extracted.sqft)      answers.sqft = extracted.sqft;
        if (extracted.acreage)   answers.acreage = extracted.acreage;
        if (extracted.price) {
          const priceStr = String(extracted.price).replace(/[^0-9.]/g, "");
          answers.askingPrice = priceStr;
          answers.priceSought = priceStr;
          answers.priceReasoning = "For sale listing";
        }
        if (extracted.yearBuilt) answers.yearBuilt = extracted.yearBuilt;
        if (extracted.agentName)  answers.sellerContactName = extracted.agentName;
        if (extracted.agentPhone) answers.sellerContactPhone = extracted.agentPhone;
        if (extracted.agentEmail) answers.sellerContactEmail = extracted.agentEmail;
        if (extracted.parcelIds)  answers.parcelIds = extracted.parcelIds;
        if (extracted.assetType) answers.assetType = extracted.assetType;
        if (extracted.assetType === "Residential Property (1-4 units)") answers.units = "1";
        if (extracted.assetType === "Land") answers.units = "1";

        // Build preview card
        const rows = [
          ["Address", [extracted.street, extracted.city, extracted.state, extracted.zip].filter(Boolean).join(", ")],
          ["Asset Type", extracted.assetType || ""],
          ["Parcel ID / APN", extracted.parcelIds || ""],
          ["Asking Price", extracted.price ? "$" + Number(String(extracted.price).replace(/[^0-9.]/g, "")).toLocaleString() + "  ·  For sale listing" : ""],
          ["Beds / Baths / Sqft", [extracted.beds && extracted.beds + " bd", extracted.baths && extracted.baths + " ba", extracted.sqft && Number(extracted.sqft).toLocaleString() + " sqft"].filter(Boolean).join("  ·  ")],
          ["Acreage", extracted.acreage || ""],
          ["Year Built", extracted.yearBuilt || ""],
          ["Listing Agent", [extracted.agentName, extracted.agentPhone, extracted.agentEmail].filter(Boolean).join("  ·  ")],
        ].filter(([, v]) => v);

        statusEl.style.display = "none";
        previewEl.style.display = "block";
        previewEl.innerHTML = `
          <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px;">
            <strong style="color:#166534;">✓ ${rows.length} field${rows.length !== 1 ? "s" : ""} auto-filled — review below, then Continue</strong>
            <dl style="margin:10px 0 0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;">
              ${rows.map(([k,v]) => `<dt style="color:#6b7280;white-space:nowrap;">${k}</dt><dd style="margin:0;">${escapeHtml(v)}</dd>`).join("")}
            </dl>
            <p class="hint" style="margin-top:10px;">Fields already filled — you can still edit them in the steps ahead.</p>
            <button class="btn primary" id="autofill-continue-btn" style="margin-top:10px;width:100%;">Continue →</button>
          </div>`;
        previewEl.querySelector("#autofill-continue-btn").onclick = () => goTo(nextIndex(stepIndex));
      };
    },
    validate() { return true; }
  },
  {
    key: "sellerContact",
    progress: true,
    skip() { return answers.role === "Seller"; },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Seller / Realtor / Broker Contact</h2>
        <p class="step-sub">Since you're bringing us this deal rather than being the seller yourself, we need
        a way to reach the actual seller, realtor, or broker directly.</p>
        <label class="field-label">Their name <span class="req">*</span></label>
        <input type="text" id="sc-name-input" placeholder="Full name">
        <div class="error-text" id="sc-name-error">Required.</div>

        <label class="field-label">Their phone</label>
        <input type="tel" id="sc-phone-input" placeholder="(555) 555-5555">

        <label class="field-label">Their email</label>
        <input type="email" id="sc-email-input" placeholder="name@example.com">
        <div class="error-text" id="sc-contact-error">Please provide at least a phone or an email for them.</div>
      `;
      root.querySelector("#sc-name-input").value = answers.sellerContactName || "";
      root.querySelector("#sc-phone-input").value = answers.sellerContactPhone || "";
      root.querySelector("#sc-email-input").value = answers.sellerContactEmail || "";
    },
    validate(root) {
      answers.sellerContactName = root.querySelector("#sc-name-input").value.trim();
      answers.sellerContactPhone = root.querySelector("#sc-phone-input").value.trim();
      answers.sellerContactEmail = root.querySelector("#sc-email-input").value.trim();
      let ok = true;
      toggleError(root, "#sc-name-error", !answers.sellerContactName); if (!answers.sellerContactName) ok = false;
      const hasContact = !!(answers.sellerContactPhone || answers.sellerContactEmail);
      toggleError(root, "#sc-contact-error", !hasContact); if (!hasContact) ok = false;
      return ok;
    }
  },
  {
    key: "address",
    progress: true,
    render(root) {
      const isLand = answers.assetType === "Land";
      const isBusiness = answers.assetType === "Business";
      const isSFR = answers.assetType === "Residential Property (1-4 units)";
      const showPropwire = isLand || isSFR;
      root.innerHTML = `
        <h2 class="step-title">Property Address</h2>
        <p class="step-sub">Full U.S. address required for every submission.</p>

        ${showPropwire ? `
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.6;">
          <strong style="color:#166534;">🔍 Check equity on <a href="https://propwire.com/" target="_blank" rel="noopener">PropWire</a> before texting this seller</strong>
          ${isLand ? `
          <p style="margin:8px 0 0;">Look up this parcel on PropWire for the owner's existing debt or liens against the land's value. <strong>Free and clear (no debt)</strong> is the best case — it's required for the seller-financing option. <strong>Debt at or above 60% of As-Is Value:</strong> our offer can't cover the payoff — skip it and move on. <strong>No data shows for this parcel?</strong> Skip it — don't spend time on unknowns when there are plenty of parcels where you can verify the numbers quickly.</p>
          ` : `
          <p style="margin:8px 0 0;">Run this address through PropWire to check the seller's approximate existing debt vs. the property's value. <strong>Has equity (debt below our MAO):</strong> proceed with a normal cash offer. <strong>No equity (debt at or above MAO):</strong> don't quote a dollar figure — the wizard will give you a subject-to pitch instead. <strong>No debt/equity data on PropWire?</strong> Skip it and move to the next property — volume is the game.</p>
          `}
        </div>
        ` : ""}

        <label class="field-label">Street address <span class="req">*</span></label>
        <input type="text" id="street-input" placeholder="123 Main St">
        <div class="error-text" id="street-error">Street address is required.</div>

        <label class="field-label">Parcel ID / APN <span class="small-muted">(optional, if known — separate multiple with commas)</span></label>
        <input type="text" id="parcel-ids-input" placeholder="e.g. 123-456-789">

        <div class="row3" style="margin-top:16px;">
          <div>
            <label class="field-label">City <span class="req">*</span></label>
            <input type="text" id="city-input">
            <div class="error-text" id="city-error">Required.</div>
          </div>
          <div>
            <label class="field-label">State <span class="req">*</span></label>
            <select id="state-input">
              <option value="">--</option>
              ${US_STATES.map(s => `<option value="${s}">${s}</option>`).join("")}
            </select>
            <div class="error-text" id="state-error">Required.</div>
          </div>
          <div>
            <label class="field-label">Zip <span class="req">*</span></label>
            <input type="text" id="zip-input" maxlength="10">
            <div class="error-text" id="zip-error">Required.</div>
          </div>
        </div>

        <div class="banner warn" id="dup-address-banner" hidden style="margin-top:16px;"></div>

        ${(!isLand && !isBusiness) ? `
        <label class="field-label">Number of units <span class="req">*</span></label>
        <input type="number" id="units-input" min="1" step="1" placeholder="e.g. 1 for a single-family home">
        <div class="error-text" id="units-error">Enter the number of units (1 or more).</div>
        <p class="hint">Use <strong>Commercial Property</strong> (already selected) for 5+ unit properties.</p>
        ` : `
        <p class="hint" style="margin-top:12px;color:#6b7280;">Unit count automatically set to 1 for ${isLand ? "Land" : "Business"} deals.</p>
        `}
      `;
      root.querySelector("#street-input").value = answers.street || "";
      root.querySelector("#parcel-ids-input").value = answers.parcelIds || "";
      root.querySelector("#city-input").value = answers.city || "";
      root.querySelector("#state-input").value = answers.state || "";
      root.querySelector("#zip-input").value = answers.zip || "";
      if (!isLand && !isBusiness) root.querySelector("#units-input").value = answers.units || "";

      const checkDupAddress = async () => {
        const street = root.querySelector("#street-input").value.trim();
        const city = root.querySelector("#city-input").value.trim();
        const state = root.querySelector("#state-input").value;
        const zip = root.querySelector("#zip-input").value.trim();
        const banner = root.querySelector("#dup-address-banner");
        if (!street || !city || !state || !zip) { banner.hidden = true; return; }
        const res = await api("checkAddressDuplicate", { street, city, state, zip, email: answers.email });
        if (!res.ok || !res.duplicate) { banner.hidden = true; return; }
        const dateStr = formatDate(res.submittedAt);
        const statusStr = res.status || "New";
        if (res.partial) {
          banner.className = res.ownedByYou ? "banner info" : "banner warn";
          banner.textContent = res.ownedByYou
            ? `You may have already submitted this as part of a multi-property (portfolio) entry on ${dateStr}. Current status: ${statusStr}.`
            : `This address may be part of a previously submitted portfolio listing (multiple properties in one entry) from ${dateStr}, currently at status "${statusStr}" — unless that was you, this lead may already belong to someone else.`;
        } else if (res.ownedByYou) {
          banner.className = "banner info";
          banner.textContent = `You already submitted this address on ${dateStr}. Current status: ${statusStr}.`;
        } else {
          banner.className = "banner warn";
          banner.textContent = `This address was already submitted on ${dateStr}, currently at status "${statusStr}" — unless that was you, this lead likely already belongs to someone else.`;
        }
        banner.hidden = false;
      };
      ["#street-input", "#city-input", "#zip-input"].forEach(sel => {
        root.querySelector(sel).addEventListener("blur", checkDupAddress);
      });
      root.querySelector("#state-input").addEventListener("change", checkDupAddress);
    },
    validate(root) {
      const isLand = answers.assetType === "Land";
      const isBusiness = answers.assetType === "Business";
      answers.street = root.querySelector("#street-input").value.trim();
      answers.parcelIds = root.querySelector("#parcel-ids-input").value.trim();
      answers.city = root.querySelector("#city-input").value.trim();
      answers.state = root.querySelector("#state-input").value;
      answers.zip = root.querySelector("#zip-input").value.trim();
      if (isLand || isBusiness) {
        answers.units = "1";
      } else {
        answers.units = root.querySelector("#units-input").value;
      }
      let ok = true;
      toggleError(root, "#street-error", !answers.street); if (!answers.street) ok = false;
      toggleError(root, "#city-error", !answers.city); if (!answers.city) ok = false;
      toggleError(root, "#state-error", !answers.state); if (!answers.state) ok = false;
      toggleError(root, "#zip-error", !/^\d{5}(-\d{4})?$/.test(answers.zip)); if (!/^\d{5}(-\d{4})?$/.test(answers.zip)) ok = false;
      if (!isLand && !isBusiness) {
        const unitsOk = Number(answers.units) >= 1;
        toggleError(root, "#units-error", !unitsOk); if (!unitsOk) ok = false;
      }
      return ok;
    }
  },
  {
    // Moved ahead of assetType/dealType (used to sit right before "price") so Commercial's square
    // footage step below can tell on-market from off-market -- an off-market property has no listing
    // to read square footage off, so it needs the ask-seller/find-it-yourself treatment there.
    key: "sourcing",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Deal Sourcing</h2>
        <label class="field-label">Is this on-market or off-market? <span class="req">*</span></label>
        <div class="choice-group" id="market-group">
          ${["On-Market", "Off-Market"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="market-error">Please choose one.</div>

        <label class="field-label">Link to where you found this listing <span class="small-muted">(optional)</span></label>
        <input type="text" id="source-link-input" placeholder="https://...">
      `;
      root.querySelector("#source-link-input").value = answers.sourceLink || "";
      bindChoiceGroup(root, "#market-group", "marketStatus");
    },
    validate(root) {
      answers.sourceLink = root.querySelector("#source-link-input").value.trim();
      const ok = !!answers.marketStatus;
      toggleError(root, "#market-error", !ok);
      return ok;
    }
  },
  {
    key: "assetType",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Asset Type</h2>
        <label class="field-label">Type <span class="req">*</span></label>
        <div class="choice-group" id="top-type-group">
          ${["Residential Property (1-4 units)","Commercial Property","Land","Business"]
            .map(t => `<button type="button" class="choice-btn" data-value="${t}">${t}</button>`).join("")}
        </div>
        <div class="error-text" id="top-type-error">Please select an asset type.</div>
        <div id="sub-fields"></div>
      `;
      const subFields = root.querySelector("#sub-fields");
      // Dash-free like every other seller-facing script in this app.
      const SELLER_SQFT_SCRIPT = "Do you happen to know the approximate square footage of the building? "
        + "It's okay if you're not sure, just give me your best guess, I'll verify the exact number myself either way.";

      function renderSub() {
        if (answers.assetType === "Commercial Property") {
          subFields.innerHTML = `
            <label class="field-label">Commercial subtype <span class="req">*</span></label>
            <select id="subtype-input">
              <option value="">--</option>
              ${COMMERCIAL_SUBTYPES.map(s => `<option value="${s}">${s}</option>`).join("")}
            </select>
            <div class="error-text" id="subtype-error">Please select a subtype.</div>

            ${answers.marketStatus === "Off-Market" ? `
              <label class="field-label" style="margin-top:16px;">Seller Reported Square Footage
                <span class="small-muted">(optional — their best guess, for reference only. Verify the real number below either way.)</span></label>
              <input type="number" id="seller-sqft-input" min="0" step="1">
              <p class="hint">Ask the seller (text it or read it over the phone):
              <br><span class="small-muted">"${SELLER_SQFT_SCRIPT}"</span>
              <br><button type="button" class="btn secondary" id="seller-sqft-script-copy-btn" style="margin-top:8px;">Copy Text</button>
              </p>
            ` : ""}

            <label class="field-label" style="margin-top:16px;">Building Square Footage
              <span class="small-muted">(required unless acreage is filled in below, or skipped below for multifamily — whichever is the standard valuation metric for this asset type)</span></label>
            <input type="number" id="sqft-input" min="0" step="1" ${answers.matchByUnitsOnly ? "disabled" : ""}>
            ${answers.marketStatus === "Off-Market" ? `
              <p class="hint">Off-market properties have no listing to read this off of, so always verify
              it yourself even if the seller gave you a number. Go to <strong>google.com</strong>, search
              anything (typing "ai" works fine), click <strong>"AI Mode"</strong> near the top of the
              results, then ask:
              <br><span class="small-muted" id="sqft-research-prompt-hint"></span>
              <br><button type="button" class="btn secondary" id="sqft-research-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
              </p>
            ` : ""}
            <div id="units-only-match-block" style="margin-top:8px;" ${answers.assetSubtype === "Multifamily" ? "" : "hidden"}>
              <button type="button" class="btn ghost-small ${answers.matchByUnitsOnly ? "active" : ""}" id="units-only-match-btn">
                Skip square footage — match comps by unit count instead
              </button>
              <p class="hint" style="margin-top:6px;">Use this when square footage can't be reliably found or
              verified (common in small or rural non disclosure markets, and a wrong number here badly skews
              comps) — comps get matched by closest unit count instead of a bad or guessed square footage.</p>
            </div>
            <label class="field-label">Acreage
              <span class="small-muted">(required unless square footage is filled in above, or skipped above for multifamily)</span></label>
            <input type="number" id="acreage-input" min="0" step="0.01" placeholder="e.g. 5.25" ${answers.matchByUnitsOnly ? "disabled" : ""}>
            <div class="error-text" id="acreage-error">Enter either square footage or acreage.</div>
          `;
          subFields.querySelector("#subtype-input").value = answers.assetSubtype || "";
          subFields.querySelector("#sqft-input").value = answers.sqft || "";
          subFields.querySelector("#acreage-input").value = answers.acreage || "";
          {
            const unitsOnlyBlock = subFields.querySelector("#units-only-match-block");
            const unitsOnlyBtn = subFields.querySelector("#units-only-match-btn");
            const sqftInputEl = subFields.querySelector("#sqft-input");
            const acreageInputEl = subFields.querySelector("#acreage-input");
            unitsOnlyBtn.onclick = () => {
              answers.matchByUnitsOnly = !answers.matchByUnitsOnly;
              if (answers.matchByUnitsOnly) {
                answers.sqft = ""; sqftInputEl.value = "";
                answers.acreage = ""; acreageInputEl.value = "";
              }
              sqftInputEl.disabled = answers.matchByUnitsOnly;
              acreageInputEl.disabled = answers.matchByUnitsOnly;
              unitsOnlyBtn.classList.toggle("active", answers.matchByUnitsOnly);
              toggleError(subFields, "#acreage-error", false);
            };
            subFields.querySelector("#subtype-input").addEventListener("change", (e) => {
              unitsOnlyBlock.hidden = e.target.value !== "Multifamily";
            });
          }
          if (answers.marketStatus === "Off-Market") {
            subFields.querySelector("#seller-sqft-input").value = answers.sellerReportedSqft || "";
            wireCopyPromptButton(subFields, "#seller-sqft-script-copy-btn", () => SELLER_SQFT_SCRIPT);
            const buildSqftResearchPrompt = () => {
              const addr = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
              const unitsNum = Number(answers.units) || 1;
              // Reads the subtype select live rather than answers.assetSubtype, which isn't written
              // back until validate() runs on Next -- otherwise this would always show stale/blank.
              const subtype = subFields.querySelector("#subtype-input").value || "commercial";
              const unitsPart = unitsNum > 1 ? `a ${unitsNum} unit ${subtype} property` : `a ${subtype} property`;
              return `what is the county assessed building square footage for ${addr || "[SUBJECT ADDRESS]"}, ${unitsPart}? Check the county assessor/property tax records specifically -- that's the most reliable source for this, not a listing site's estimate.`;
            };
            const updateSqftPromptHint = () => {
              subFields.querySelector("#sqft-research-prompt-hint").textContent = `"${buildSqftResearchPrompt()}"`;
            };
            updateSqftPromptHint();
            subFields.querySelector("#subtype-input").addEventListener("change", updateSqftPromptHint);
            wireCopyPromptButton(subFields, "#sqft-research-prompt-copy-btn", buildSqftResearchPrompt);
          }
        } else if (answers.assetType === "Business") {
          subFields.innerHTML = `
            <label class="field-label">Business type <span class="req">*</span></label>
            <input type="text" id="subtype-input" placeholder="e.g. laundromat, car wash, self storage operator">
            <div class="error-text" id="subtype-error">Please describe the business type.</div>
          `;
          subFields.querySelector("#subtype-input").value = answers.assetSubtype || "";
        } else if (answers.assetType === "Residential Property (1-4 units)") {
          const units = Number(answers.units) || 1;
          const isMultiUnit = units >= 2 && units <= 4;
          if (!isMultiUnit) {
            subFields.innerHTML = `
              <div class="row2">
                <div>
                  <label class="field-label">Beds <span class="req">*</span></label>
                  <input type="number" id="beds-input" min="0" step="1">
                  <div class="error-text" id="beds-error">Required.</div>
                </div>
                <div>
                  <label class="field-label">Baths <span class="req">*</span></label>
                  <input type="number" id="baths-input" min="0" step="0.5">
                  <div class="error-text" id="baths-error">Required.</div>
                </div>
              </div>
              <label class="field-label">Square footage <span class="small-muted">(optional)</span></label>
              <input type="number" id="sqft-input" min="0" step="1">
            `;
            subFields.querySelector("#beds-input").value = answers.beds || "";
            subFields.querySelector("#baths-input").value = answers.baths || "";
            subFields.querySelector("#sqft-input").value = answers.sqft || "";
          } else {
            subFields.innerHTML = `
              <label class="field-label">Are all ${units} units the same layout (identical beds/baths)? <span class="req">*</span></label>
              <div class="choice-group" id="units-uniform-group">
                ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
              </div>
              <div class="error-text" id="units-uniform-error">Please choose one.</div>
              <div id="unit-mix-sub"></div>
            `;
            const mixSub = subFields.querySelector("#unit-mix-sub");
            const renderMixSub = () => {
              if (answers.unitsUniform === "Yes") {
                mixSub.innerHTML = `
                  <div class="row2">
                    <div>
                      <label class="field-label">Beds (per unit) <span class="req">*</span></label>
                      <input type="number" id="beds-input" min="0" step="1">
                      <div class="error-text" id="beds-error">Required.</div>
                    </div>
                    <div>
                      <label class="field-label">Baths (per unit) <span class="req">*</span></label>
                      <input type="number" id="baths-input" min="0" step="0.5">
                      <div class="error-text" id="baths-error">Required.</div>
                    </div>
                  </div>
                  <label class="field-label">Square footage per unit <span class="small-muted">(optional)</span></label>
                  <input type="number" id="sqft-input" min="0" step="1">
                `;
                mixSub.querySelector("#beds-input").value = answers.beds || "";
                mixSub.querySelector("#baths-input").value = answers.baths || "";
                mixSub.querySelector("#sqft-input").value = answers.sqft || "";
              } else if (answers.unitsUniform === "No") {
                mixSub.innerHTML = `
                  <label class="field-label">Describe each unit's beds/baths <span class="req">*</span></label>
                  <input type="text" id="unit-mix-input" placeholder="e.g. Unit A: 2bd/1ba, Unit B: 3bd/2ba">
                  <div class="error-text" id="unit-mix-error">Required.</div>
                `;
                mixSub.querySelector("#unit-mix-input").value = answers.assetSubtype || "";
              } else {
                mixSub.innerHTML = "";
              }
            };
            renderMixSub();
            subFields.querySelectorAll("#units-uniform-group .choice-btn").forEach(btn => {
              if (btn.dataset.value === answers.unitsUniform) btn.classList.add("selected");
              btn.onclick = () => {
                subFields.querySelectorAll("#units-uniform-group .choice-btn").forEach(b => b.classList.remove("selected"));
                btn.classList.add("selected");
                answers.unitsUniform = btn.dataset.value;
                toggleError(subFields, "#units-uniform-error", false);
                renderMixSub();
              };
            });
          }
        } else if (answers.assetType === "Land") {
          subFields.innerHTML = `
            <label class="field-label">Acreage <span class="small-muted">(required unless square footage is filled in below)</span></label>
            <input type="number" id="acreage-input" min="0" step="0.01" placeholder="e.g. 5.25">
            <label class="field-label">Square footage <span class="small-muted">(required unless acreage is filled in above — useful for small in-town lots)</span></label>
            <input type="number" id="sqft-input" min="0" step="1">
            <div class="error-text" id="acreage-error">Enter either acreage or square footage.</div>

            <label class="field-label" style="margin-top:16px;">Zoning
              <span class="small-muted">(optional, but highly encouraged — ask the seller or look it up if you're not sure. Skip if truly unknown.)</span></label>
            <div class="choice-group" id="land-zoning-group">
              ${["Single Family", "Multifamily", "Other"].map(z => `<button type="button" class="choice-btn" data-value="${z}">${z}</button>`).join("")}
            </div>
            <div id="land-zoning-other-wrap" hidden style="margin-top:8px;">
              <input type="text" id="land-zoning-other-input" placeholder="e.g. Agricultural, Commercial, Industrial...">
            </div>
          `;
          subFields.querySelector("#acreage-input").value = answers.acreage || "";
          subFields.querySelector("#sqft-input").value = answers.sqft || "";

          const isKnownZoning = answers.landZoning === "Single Family" || answers.landZoning === "Multifamily";
          const zoningOtherValue = (!isKnownZoning && answers.landZoning) ? answers.landZoning : "";
          const selectedZoningValue = isKnownZoning ? answers.landZoning : (zoningOtherValue ? "Other" : "");
          const zoningGroup = subFields.querySelector("#land-zoning-group");
          const zoningOtherWrap = subFields.querySelector("#land-zoning-other-wrap");
          const zoningOtherInput = subFields.querySelector("#land-zoning-other-input");
          zoningOtherInput.value = zoningOtherValue;
          zoningOtherWrap.hidden = selectedZoningValue !== "Other";
          zoningGroup.querySelectorAll(".choice-btn").forEach(btn => {
            if (btn.dataset.value === selectedZoningValue) btn.classList.add("selected");
            btn.onclick = () => {
              zoningGroup.querySelectorAll(".choice-btn").forEach(b => b.classList.remove("selected"));
              btn.classList.add("selected");
              zoningOtherWrap.hidden = btn.dataset.value !== "Other";
              if (btn.dataset.value === "Other") {
                answers.landZoning = zoningOtherInput.value.trim();
                zoningOtherInput.focus();
              } else {
                answers.landZoning = btn.dataset.value;
              }
            };
          });
          zoningOtherInput.oninput = () => { answers.landZoning = zoningOtherInput.value.trim(); };
        } else {
          subFields.innerHTML = "";
        }
      }
      renderSub();

      root.querySelectorAll("#top-type-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.assetType) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#top-type-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.assetType = btn.dataset.value;
          answers.assetSubtype = ""; answers.beds = ""; answers.baths = ""; answers.sqft = ""; answers.unitsUniform = ""; answers.acreage = ""; answers.landZoning = "";
          // Land is cash-only for now -- Seller Financing / Creative Finance isn't offered for it,
          // so lock the deal type here and skip asking (see the dealType step's skip()).
          if (answers.assetType === "Land") answers.dealType = "Cash Deal";
          renderSub();
        };
      });
    },
    validate(root) {
      let ok = true;
      toggleError(root, "#top-type-error", !answers.assetType); if (!answers.assetType) ok = false;
      if (answers.assetType === "Land") {
        answers.acreage = root.querySelector("#acreage-input").value;
        answers.sqft = root.querySelector("#sqft-input").value;
        const hasSize = !!(answers.acreage || answers.sqft);
        toggleError(root, "#acreage-error", !hasSize); if (!hasSize) ok = false;
      } else if (answers.assetType === "Commercial Property") {
        answers.assetSubtype = root.querySelector("#subtype-input").value;
        toggleError(root, "#subtype-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
        if (answers.marketStatus === "Off-Market") {
          answers.sellerReportedSqft = root.querySelector("#seller-sqft-input").value;
        }
        if (answers.assetSubtype !== "Multifamily") answers.matchByUnitsOnly = false;
        answers.sqft = root.querySelector("#sqft-input").value;
        answers.acreage = root.querySelector("#acreage-input").value;
        const hasCommercialSize = answers.matchByUnitsOnly || !!(answers.sqft || answers.acreage);
        toggleError(root, "#acreage-error", !hasCommercialSize); if (!hasCommercialSize) ok = false;
      } else if (answers.assetType === "Business") {
        answers.assetSubtype = root.querySelector("#subtype-input").value.trim();
        toggleError(root, "#subtype-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
      } else if (answers.assetType === "Residential Property (1-4 units)") {
        const units = Number(answers.units) || 1;
        const isMultiUnit = units >= 2 && units <= 4;
        if (!isMultiUnit) {
          answers.beds = root.querySelector("#beds-input").value;
          answers.baths = root.querySelector("#baths-input").value;
          answers.sqft = root.querySelector("#sqft-input").value;
          toggleError(root, "#beds-error", answers.beds === ""); if (answers.beds === "") ok = false;
          toggleError(root, "#baths-error", answers.baths === ""); if (answers.baths === "") ok = false;
        } else {
          toggleError(root, "#units-uniform-error", !answers.unitsUniform); if (!answers.unitsUniform) ok = false;
          if (answers.unitsUniform === "Yes") {
            answers.beds = root.querySelector("#beds-input").value;
            answers.baths = root.querySelector("#baths-input").value;
            answers.sqft = root.querySelector("#sqft-input").value;
            toggleError(root, "#beds-error", answers.beds === ""); if (answers.beds === "") ok = false;
            toggleError(root, "#baths-error", answers.baths === ""); if (answers.baths === "") ok = false;
          } else if (answers.unitsUniform === "No") {
            answers.assetSubtype = root.querySelector("#unit-mix-input").value.trim();
            toggleError(root, "#unit-mix-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
          }
        }
      }
      return ok;
    }
  },
  {
    key: "dealType",
    progress: true,
    // Land is cash-only for now -- assetType's button handler already forces
    // answers.dealType = "Cash Deal" when Land is selected, so this step has nothing to ask.
    skip() { return answers.assetType === "Land"; },
    render(root) {
      // The preforeclosure/auction category is cash-only under the hood -- no seller carryback
      // offers there (see preforeclosureDebtCheck's comment). Picking it sets dealCategory (for
      // that dedicated step, the SOP, and admin visibility) while dealType itself gets forced to
      // "Cash Deal" so every existing Cash Deal branch (ARV/MAO computation, Deal Status, the
      // showsCashDealFields display gates) just works without needing its own parallel logic.
      const DEAL_TYPE_OPTIONS = ["Cash Deal", "Seller Financing / Creative Finance", "Upcoming Auction/Preforeclosure Property"];
      root.innerHTML = `
        <h2 class="step-title">Deal Type</h2>
        <p class="step-sub">Is this an all-cash deal, does it need seller financing / a creative-finance
        structure, or is this a preforeclosure property with an upcoming auction date?</p>
        <div class="choice-group" id="deal-type-group">
          ${DEAL_TYPE_OPTIONS.map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="deal-type-error">Please choose one.</div>
      `;
      const selectedValue = answers.dealCategory === "Upcoming Auction/Preforeclosure Property"
        ? "Upcoming Auction/Preforeclosure Property"
        : answers.dealType;
      root.querySelectorAll("#deal-type-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === selectedValue) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#deal-type-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          if (btn.dataset.value === "Upcoming Auction/Preforeclosure Property") {
            answers.dealCategory = "Upcoming Auction/Preforeclosure Property";
            answers.dealType = "Cash Deal";
          } else {
            answers.dealCategory = "";
            answers.dealType = btn.dataset.value;
          }
          toggleError(root, "#deal-type-error", false);
        };
      });
    },
    validate(root) {
      const ok = !!answers.dealType;
      toggleError(root, "#deal-type-error", !ok);
      return ok;
    }
  },
  {
    key: "price",
    progress: true,
    // Auction/preforeclosure sellers have no asking price at all (see cashDealDetails) -- the offer
    // is built purely off As-Is Value/ARV/repair, so there's no "what price are they seeking" to ask.
    skip() { return answers.dealCategory === "Upcoming Auction/Preforeclosure Property"; },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Price</h2>
        <label class="field-label">What price is the seller seeking? <span class="req">*</span></label>
        <input type="number" id="price-input" placeholder="$">
        <div class="error-text" id="price-error">Required.</div>

        <label class="field-label">How did they arrive at that price? <span class="req">*</span></label>
        <textarea id="reasoning-input" placeholder="e.g. recent appraisal, comparable sales, remaining loan balance plus profit, an offer they already turned down..."></textarea>
        <div class="error-text" id="reasoning-error">Please describe how the price was determined.</div>
      `;
      root.querySelector("#price-input").value = answers.priceSought || "";
      root.querySelector("#reasoning-input").value = answers.priceReasoning || "";
    },
    validate(root) {
      answers.priceSought = root.querySelector("#price-input").value;
      answers.priceReasoning = root.querySelector("#reasoning-input").value.trim();
      let ok = true;
      toggleError(root, "#price-error", !answers.priceSought); if (!answers.priceSought) ok = false;
      toggleError(root, "#reasoning-error", !answers.priceReasoning); if (!answers.priceReasoning) ok = false;
      return ok;
    }
  },
  {
    key: "rentReadyCheck",
    progress: true,
    // Only relevant for residential Seller Financing deals -- Cash Deals already get the full
    // ARV/rehab/comps workflow unconditionally, and this question doesn't map cleanly onto
    // Commercial/Business/Land the way it does a rental house. A Seller filling this out about
    // their own property always sees it regardless of which Deal Type they picked -- we want both
    // the cash and seller-financing question sets from them either way, since admin (not the
    // seller's initial guess) decides which structure the deal actually ends up using.
    skip() {
      return (answers.dealType !== "Seller Financing / Creative Finance" && answers.role !== "Seller")
        || answers.assetType !== "Residential Property (1-4 units)";
    },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Property Condition</h2>
        <p class="step-sub">This determines what we need from you next.</p>
        <label class="field-label">Is the property currently in rent-ready condition? <span class="req">*</span></label>
        <div class="choice-group" id="rent-ready-group">
          ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="rent-ready-error">Please choose one.</div>
        <p class="hint">If <strong>No</strong>, the next step walks you through the same ARV, rehab estimate,
        and comps research used for cash deals. Admin uses that alongside the seller financing terms to
        structure a blended hard money + seller carryback offer.</p>
      `;
      bindChoiceGroup(root, "#rent-ready-group", "propertyRentReady");
    },
    validate(root) {
      const ok = !!answers.propertyRentReady;
      toggleError(root, "#rent-ready-error", !ok);
      return ok;
    }
  },
  {
    key: "cashDealDetails",
    progress: true,
    // Runs for both deal types now -- Seller Financing leads need the same ARV/rehab/comps data Cash
    // Deals do, since Make Your Offers (below) generates a cash offer alongside the seller-financing
    // one regardless of which dealType was picked. The wholesale-fee/MAO ceiling UI still stays
    // hidden from the associate for Seller Financing (see isSellerFinancing in render()/validate())
    // -- that's a display choice, not a reason to skip gathering the underlying numbers.
    skip() {
      return answers.dealType !== "Cash Deal" && answers.dealType !== "Seller Financing / Creative Finance";
    },
    render(root) {
      const isSeller = answers.role === "Seller";
      // Seller Financing runs through this step too (see skip() above) so Make Your Offers always has
      // real cash-offer numbers to work with. The Wholesale Fee input itself stays hidden here for
      // Seller Financing (it always uses the standard formula, no manual override) but the resulting
      // Cash Buyer MAO banner is shown either way -- the associate needs that number for the cash half
      // of the dual offer script.
      const isSellerFinancing = answers.dealType !== "Cash Deal";
      if (isSeller) {
        // A seller filling this out about their own property has no reason to run ARV/repair
        // research or see our internal offer-ceiling math -- just get the two things we
        // actually need from them directly.
        root.innerHTML = `
          <h2 class="step-title">${isSellerFinancing ? "Property Value & Repair Research" : "Cash Deal Details"}</h2>
          <label class="field-label">Why are you looking to sell, and anything else we should know about the property? <span class="req">*</span></label>
          <textarea id="cash-notes-input" placeholder="e.g. relocating, inherited the property, tired of managing it, needs repairs I can't afford..."></textarea>
          <div class="error-text" id="cash-notes-error">Required.</div>

          <label class="field-label">Lowest price you'd accept to get this done quickly <span class="small-muted">(optional)</span></label>
          <input type="number" id="bottom-dollar-input" placeholder="$">

          <div class="banner info">Thanks for sharing this — we'll take a look and get back to you.</div>
        `;
        root.querySelector("#cash-notes-input").value = answers.cashDealNotes || "";
        root.querySelector("#bottom-dollar-input").value = answers.bottomDollarPrice || "";
        return;
      }

      const isResidential = answers.assetType === "Residential Property (1-4 units)";
      const isLand = answers.assetType === "Land";
      const isCommercial = answers.assetType === "Commercial Property";
      const isBusiness = answers.assetType === "Business";
      const earningsType = answers.businessEarningsType || "SDE";
      const isMultifamilySubtype = answers.assetSubtype === "Multifamily";
      const hasCompsWorkflow = isResidential || isLand || isCommercial;
      const isOnMarket = answers.marketStatus === "On-Market";
      // Auction/preforeclosure sellers have no asking price at all -- the offer is built purely off
      // As-Is Value/ARV/repair, and since there's usually no listing or photos to research the
      // property's condition from, repair cost has to be estimated from purchase year, home age, and
      // what the seller says they've spent on upkeep instead (see the dedicated section below).
      const isPreforeclosureAuction = answers.dealCategory === "Upcoming Auction/Preforeclosure Property";
      const addressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
      const arvPrompt = `how much is this worth at full market value (ARV): ${addressLine}`;
      const assessedValuePrompt = `what is the county assessed value for this property: ${addressLine}`;
      const zillowAddressSlug = `${answers.street || ""} ${answers.city || ""} ${answers.state || ""} ${answers.zip || ""}`
        .trim().replace(/[^a-zA-Z0-9]+/g, "-");
      const zillowSearchUrl = `https://www.zillow.com/homes/${zillowAddressSlug}_rb/`;
      // Depends on the current ARV input value, so it's rebuilt live in recomputeCashDeal() rather
      // than computed once here -- feeding the current ARV back into the repair prompt lets the AI
      // estimate repairs against an actual target value instead of guessing blind. By the time repair
      // costs matter, that ARV is usually the AI-CMA-refined number (see Step 2 above), not Chase's
      // quick estimate, so it isn't attributed to a specific source here anymore.
      const buildRepairPrompt = (arv, picturesLink) => {
        const arvPart = arv ? ` to reach an ARV of $${Number(arv).toLocaleString()}` : "";
        // This deal doesn't add or convert bedrooms/bathrooms, so tell the AI to price the repair
        // for the CURRENT bed/bath count, not a hypothetical one -- this doesn't limit the repair
        // scope itself, which can still run anywhere from light cosmetic to a full gut.
        const bedBathPart = (isResidential && answers.beds && answers.baths)
          ? ` It's currently ${answers.beds} bed / ${answers.baths} bath -- estimate repair costs for that existing layout (however light or heavy the work actually is), with no bedroom or bathroom additions or conversions planned.`
          : "";
        return `how much fix and flip investor repair is needed at ${addressLine}${arvPart}?${bedBathPart} ${picturesLink || zillowSearchUrl}`;
      };
      // Auction/preforeclosure properties usually have no listing or photos to research condition
      // from, so repair cost gets estimated from purchase year, home age, and reported maintenance
      // spend instead. Assumes neglect starts the moment the seller fell behind on payments -- their
      // reported annual spend is taken at face value only for the years before that.
      const buildPreforeclosureRehabPrompt = (arv, yearBuilt, purchaseYear, monthsBehind, annualMaintenance) => {
        const currentYear = new Date().getFullYear();
        const yearsOwned = purchaseYear ? Math.max(currentYear - Number(purchaseYear), 0) : null;
        const onePctPerYear = arv ? Math.round(Number(arv) * 0.01) : null;
        return `Act as a professional home inspector and repair cost estimator. Explain your math simply, `
          + `no real estate jargon.\n\n`
          + `Estimate a realistic repair/rehab cost range (low to high) for this property, based on `
          + `deferred maintenance rather than a full inspection:\n`
          + `- Address: ${addressLine || "[SUBJECT ADDRESS]"}\n`
          + `- Year built: ${yearBuilt || "[unknown -- estimate typical system ages for the area]"}\n`
          + `- Current owner purchased the property in: ${purchaseYear || "[unknown]"}${yearsOwned ? ` (${yearsOwned} years ago)` : ""}\n`
          + `- Owner reports spending approximately $${Number(annualMaintenance || 0).toLocaleString()} per year on `
          + `general maintenance since they purchased the home\n`
          + `- Owner has been behind on mortgage payments for approximately ${monthsBehind || 0} months\n`
          + `- Estimated After Repair Value (ARV): $${Number(arv || 0).toLocaleString()}\n\n`
          + `Use this logic:\n`
          + `1. A well-maintained home typically needs about 1% of its value spent on maintenance every `
          + `year (the "1% rule"). At this home's ARV, that's approximately $${onePctPerYear ? onePctPerYear.toLocaleString() : "[1% of ARV]"} per year that should have been spent.\n`
          + `2. For the years the owner was current on their mortgage (before falling behind), take their `
          + `reported annual maintenance spend at face value as what was actually spent.\n`
          + `3. For the months the owner has been behind on payments, assume $0 was spent on maintenance `
          + `during that period -- assume neglect starts the moment someone falls behind on their mortgage.\n`
          + `4. For every year (or partial year) since purchase, calculate the shortfall between what `
          + `should have been spent (1% of ARV) and what was actually spent (the owner's reported number, `
          + `or $0 during the behind-on-payments period). Add up every year's shortfall for a cumulative `
          + `deferred maintenance total.\n`
          + `5. Give a LOW estimate assuming some of that deferred maintenance is cosmetic or `
          + `non-critical, and a HIGH estimate assuming a larger share of it has become real, needed `
          + `repairs (roofing, HVAC, plumbing, electrical, foundation) that tend to surface with age and `
          + `neglect -- not just the raw shortfall number.\n`
          + `6. Factor in the home's age for which major systems (roof, HVAC, water heater) are `
          + `statistically due or overdue for replacement, and call that out explicitly.\n\n`
          + `Give a final range, not just one number, and briefly explain how you got there.`;
      };
      // Dash-free (no hyphens/em dashes) like every other seller-facing script in this app. Broken
      // into short paragraphs (blank line between each) so it reads easily as a text message instead
      // of one dense block -- these are real newlines, so they carry through when copied/pasted.
      const buildPreforeclosureSellerScript = (purchaseYear) => {
        return `Did you originally buy the house in ${purchaseYear || "[year]"}, and about how much have you put into general maintenance each year since then?\n\n`
          + `It's okay if the answer is none, I just need to understand where things stand. If you can take pictures of the full house, inside and out, every room and every side, that lets me put together the most accurate offer.\n\n`
          + `Without pictures or without your cooperation here, we have to assume the highest possible repair cost, which means a substantially lower offer for you. Being fully honest and getting me those pictures only helps you.\n\n`
          + `If the numbers turn out inflated, we would have to come back and lower the offer later anyway, and time is not on your side right now.\n\n`
          + `Full honesty gives you the fairest offer we can make, and a real shot at walking away with something instead of nothing if this goes to auction.`;
      };
      const monthsBehindScript = "How many months behind are you on your mortgage payments? Just need "
        + "an honest number so I can figure out the best way to help.";
      const googleAiHow = `go to <strong>google.com</strong> and search anything (typing "ai" works fine, or just the
        address) — once results load, look at the row of tabs near the top of the page (next to "All", "Images",
        "News", "Shopping") and click <strong>"AI Mode"</strong>`;
      root.innerHTML = `
        <h2 class="step-title">${isSellerFinancing ? "Property Value & Repair Research" : "Cash Deal Details"}</h2>

        ${isPreforeclosureAuction ? `
          <p class="hint">You only reach this step once the seller has already responded to your
          initial text and is open to selling — this isn't a cold lead anymore, so it's fine to move
          straight into pricing.</p>
        ` : ""}

        ${(hasCompsWorkflow || isBusiness) ? `
          <!-- How this works accordion -->
          <details id="how-it-works-details" style="margin-bottom:16px;border:1px solid #ddd6fe;border-radius:8px;background:#faf5ff;">
            <summary style="cursor:pointer;padding:11px 14px;font-weight:600;color:#5b21b6;font-size:13px;list-style:none;display:flex;align-items:center;gap:6px;" onclick="this.parentElement.querySelector('.how-it-works-arrow').textContent=this.parentElement.open?'▶':'▼'">
              <span class="how-it-works-arrow">▶</span> How this works — tap to expand
            </summary>
            <div style="padding:0 14px 14px;">
              ${isBusiness ? `
                <p class="hint"><strong>Business valuation uses earnings multiples, not property comps.</strong> The prompt below asks Google AI to find recently sold comparable businesses and the typical ${earningsType} multiple range for this type of business — then calculates an estimated value from the subject's own earnings.</p>
              ` : isResidential ? (isSellerFinancing ? `
                <p class="hint"><strong>Get a baseline from Chase (optional).</strong> Use
                <a href="https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator" target="_blank" rel="noopener">Chase's Home Value Estimator</a>
                for a quick reference — admin uses this to sanity-check numbers. If no repairs are needed, that's your As-Is Value too. The Google AI comps in Step 1 below are the real source of truth.</p>
              ` : `
                <p class="hint"><strong>Chase Bank value is for admin reference only — it's optional.</strong> Use
                <a href="https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator" target="_blank" rel="noopener">Chase's Home Value Estimator</a>
                if you want a quick ballpark. The real offer is built from the Google AI comps below — those reflect actual recent sales, which is what buyers pay attention to.</p>
              `) : isLand ? `
                <p class="hint"><strong>There's no bank estimator for land</strong> — Google AI Mode is your primary source for value and comps here.</p>
              ` : ""}
              <ol class="hint" style="margin:0 0 10px 18px; padding:0;">
                <li>Go to <strong>google.com</strong>, search anything (typing "ai" works fine), and click the
                <strong>"AI Mode"</strong> tab near the top of the results.</li>
                <li>Press <strong>"Copy Comps Prompt"</strong> in Step 1 below, paste it into AI Mode.</li>
                <li>Google AI will pull real recent comps and calculate ${isBusiness ? `an estimated business value using ${earningsType} multiples` : isLand ? "a value range" : isCommercial ? "an ARV range from both a sales-comps and an income approach" : "an ARV range"} — this is your CMA.</li>
                <li>At the bottom of the AI response, press the <strong>Copy</strong> button — then paste it into Step 2 below. The form will auto-fill the ${isBusiness ? "value" : "ARV"} and comps for you.</li>
                <li><strong>Review before trusting</strong> — if anything looks off (a comp too far away, wrong condition, math that doesn't add up), note it below so admin can see your reasoning.</li>
              </ol>
              ${isResidential ? `
                <p class="hint"><strong>Beds/baths stay the same.</strong> The comps prompt already tells AI to match bed/bath count — no additions or conversions are planned for this deal.</p>
              ` : ""}
              ${isCommercial ? `
                <p class="hint"><strong>Comps must match the asset type first</strong> — never compare retail to multifamily. Expect 0.5–1 mile in urban areas, up to 3–5 miles rural. Up to 12 months old.</p>
              ` : ""}
              ${isBusiness ? `
                <p class="hint"><strong>Business comps use EBITDA/SDE multiples, not location.</strong> AI will look for recently sold businesses of the same type and revenue size to establish the typical multiple range — then multiply that by the subject's ${earningsType} to estimate value.</p>
              ` : isLand ? `
                ${isOnMarket ? `<p class="hint"><strong>City population must be 50,000+</strong> for on-market land deals.</p>` : ""}
                <p class="hint"><strong>For land, zoning match matters more than distance.</strong> A comp must match on zoning, topography, and access/utilities before distance is weighed. Expect 1–5 miles suburban, 10–50+ miles rural. Up to 24 months old in slow markets — AI will time-adjust prices automatically.</p>
              ` : isCommercial ? "" : `
                <p class="hint"><strong>Comps within 1 mile only — no exceptions.</strong> Under 1 year old, ideally under 6 months. Same beds, baths, and similar sqft.</p>
              `}
            </div>
          </details>

          <!-- STEP 1 -->
          <div style="border-left:3px solid #7c3aed;padding:4px 0 4px 12px;margin-bottom:8px;">
            <strong style="color:#7c3aed;font-size:14px;">Step 1 — Copy the research prompt</strong>
            <p class="hint" style="margin:3px 0 0;">Tap below, hit <strong>Copy</strong>, go to google.com → AI Mode → paste it in.</p>
          </div>

          ${isCommercial ? `
            <label class="field-label" style="margin-top:16px;">Current Occupancy <span class="req">*</span></label>
            <div class="choice-group" id="occupancy-status-group">
              ${["Fully Occupied", "Partially Occupied", "Vacant"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
            </div>
            <div class="error-text" id="occupancy-status-error">Please choose one.</div>

            <div id="occupancy-detail-block" style="margin-top:10px;" ${answers.commercialOccupancyStatus === "Partially Occupied" ? "" : "hidden"}>
              ${isMultifamilySubtype ? `
                <label class="field-label">How many of the ${answers.units || "?"} units are currently occupied/rented? <span class="req">*</span></label>
                <input type="number" id="occ-units-input" min="0" step="1" max="${answers.units || ""}">
                <div class="error-text" id="occ-units-error">Required.</div>
              ` : `
                <label class="field-label">Approximate current occupancy %
                  <span class="small-muted">(share of the building currently leased, by square footage or unit count)</span> <span class="req">*</span></label>
                <input type="number" id="occ-pct-input" min="0" max="100" step="1" placeholder="e.g. 60">
                <div class="error-text" id="occ-pct-error">Required.</div>
              `}
            </div>

            <label class="field-label" style="margin-top:16px;">Annual NOI
              <span class="small-muted">(current, as reported by the seller — feeds the Income Approach in the comps prompt below)</span></label>
            <input type="number" id="noi-input" placeholder="$" ${answers.commercialNoiUnknown ? "disabled" : ""}>
            <div style="margin-top:10px;">
              <button type="button" class="btn ghost-small ${answers.commercialNoiUnknown ? "active" : ""}" id="unknown-noi-btn">I don't know</button>
            </div>
          ` : ""}

          <button type="button" class="btn secondary" id="comps-prompt-toggle-btn" style="margin-top:6px;">Get Comps Research Prompt for Google AI &#9662;</button>
          <div id="comps-prompt-panel" hidden style="margin-top:10px;">
            <p class="hint">This is pre-filled with the ${isBusiness ? "business type and earnings" : `address/${isLand ? "acreage or square footage" : isCommercial ? "asset type/size" : "beds/baths/sqft"}`}
            already on file. Copy it, ${googleAiHow}, and paste it in.</p>
            <textarea id="comps-prompt-text" readonly rows="16" style="width:100%; font-size:12px; font-family:'IBM Plex Mono', ui-monospace, monospace;"></textarea>
            <button type="button" class="btn secondary" id="comps-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>

            ${answers.matchByUnitsOnly ? `
              <p class="hint" style="margin-top:16px;"><strong>If the prompt above doesn't find genuinely
              comparable sales</strong> (common in small or rural markets like this one), try this simpler
              fallback instead — it uses the area's average multifamily cap rate instead of hunting for
              exact comps, so it holds up better where sold data is thin:</p>
              <textarea id="unit-count-fallback-prompt-text" readonly rows="10" style="width:100%; font-size:12px; font-family:'IBM Plex Mono', ui-monospace, monospace;"></textarea>
              <button type="button" class="btn secondary" id="unit-count-fallback-prompt-copy-btn" style="margin-top:8px;">Copy Fallback Prompt</button>
            ` : ""}
          </div>

          ${isCommercial ? `
            <label class="field-label" style="margin-top:16px;">NOI Research Notes for Admin
              <span class="small-muted">(optional — if Google AI estimated a NOI or flagged a red flag on the number above, jot down its most likely NOI figure and reasoning here, e.g. "AI estimates NOI ~$29,700/yr from $550/unit market rent; flagged elevated insurance costs pushing expenses to ~50%")</span></label>
            <textarea id="noi-research-notes-input" placeholder="What did Google AI conclude about NOI/expenses for this property?"></textarea>
          ` : ""}

          <!-- STEP 2 -->
          <div style="border-left:3px solid #7c3aed;padding:4px 0 4px 12px;margin:16px 0 8px;">
            <strong style="color:#7c3aed;font-size:14px;">Step 2 — Paste Google AI response</strong>
            <p class="hint" style="margin:3px 0 0;">At the bottom of the AI response, press <strong>Copy</strong> — then paste the full response below. The form will auto-fill the ARV and comps table.</p>
          </div>
          <textarea id="ai-response-input" rows="6" placeholder="Paste the full Google AI response here..." style="width:100%;font-size:13px;font-family:inherit;border:1px solid #d1d5db;border-radius:6px;padding:10px;box-sizing:border-box;"></textarea>
          <button type="button" class="btn primary" id="parse-ai-btn" style="margin-top:8px;">Parse &amp; Auto-Fill Results →</button>
          <div id="ai-parse-results" style="margin-top:10px;" hidden></div>

          <!-- CMA Screenshots -->
          <label class="field-label" style="margin-top:16px;">CMA Screenshots
            <span class="small-muted">(optional — upload one or more screenshots of the AI response or listing)</span></label>
          <input type="file" id="cma-screenshots-input" accept="image/*" multiple>
          <div id="cma-screenshots-list" style="margin-top:8px;"></div>

          <label class="field-label" style="margin-top:16px;">${isLand ? "As-Is Value" : isBusiness ? "Estimated Business Value" : "ARV"}
            <span class="small-muted">${isLand ? "(current market value — land offers are based on this directly, not a post-repair value)" : isBusiness ? `(estimated from ${earningsType} multiples — this is the number offers are based on)` : "(After Repair Value)"}</span>${isResidential ? "" : ` <span class="req">*</span>`}</label>
          <input type="number" id="arv-input" placeholder="$">
          <div class="error-text" id="arv-error">Required.</div>
          <p class="hint">${isBusiness ? `The AI prompt anchors on the <strong>lowest multiple among the most recent comps</strong> — enter the resulting low-end value estimate here, not a blended or high-end figure.` : `The AI prompt anchors on the <strong>lowest comp(s) nearest to the property</strong> — enter that number here, not a blended or high-end figure.`}</p>
          ${isResidential && !isPreforeclosureAuction ? `<div class="banner danger" id="arv-vs-asking-banner" hidden style="margin-top:12px;"></div>` : ""}

          ${!isBusiness ? `
            <!-- STEP 3 header -->
            <div style="border-left:3px solid #7c3aed;padding:4px 0 4px 12px;margin:20px 0 4px;">
              <strong style="color:#7c3aed;font-size:14px;">Step 3 — Listing/photos link, rehab estimate &amp; remaining details</strong>
              <p class="hint" style="margin:3px 0 0;">Enter the listing or photos link first — it feeds directly into the repair estimate prompt below.</p>
            </div>
            <label class="field-label">Pictures / Listing Link <span class="small-muted">(paste the for-sale listing URL or photos link — this is what Google AI uses to see the property's condition)</span></label>
            <input type="text" id="pictures-link-input" placeholder="https://...">
          ` : ""}
        ` : ""}

        ${isLand ? `
          <label class="field-label" style="margin-top:16px;">Is the land free and clear
            <span class="small-muted">(no mortgage or liens against it)?</span></label>
          <div class="choice-group" id="land-free-clear-group">
            ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
          </div>

          <label class="field-label" style="margin-top:16px;">Would the seller be open to getting a small down payment now — likely <strong>5% down (+ realtor commission)</strong> — and get paid the rest after the property is developed and sold or refinanced, to receive their full asking price?</label>
          <div class="choice-group" id="land-willing-wait-group">
            ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
          </div>
          <p class="hint">If both are <strong>Yes</strong>, this qualifies for a <strong>100% of As-Is
          Value</strong> deferred offer (full asking price, with ~5% down at closing + the rest paid once
          developed/sold or refinanced) instead of the normal on-market/off-market percentage offer below —
          see the Make Your Offer banner once you've entered As-Is Value.</p>
        ` : ""}

        ${isCommercial ? `
          <div id="commercial-vacant-block" style="margin-top:16px;" ${answers.commercialOccupancyStatus === "Vacant" ? "" : "hidden"}>
            ${isOnMarket ? `
              <div class="banner info"><strong>This property isn't generating income right now.</strong>
              Since it's on-market, use the listing link (Pictures Link above) with Google AI to estimate
              rehab needs straight from the listing's own photos — see the rehab prompt below, no
              separate photos needed from you.</div>
            ` : `
              <div class="banner warn"><strong>This property isn't generating income and is off-market
              </strong> — there's no listing to pull photos from, so we need real pictures of it before
              we can put together an offer.</div>
              <label class="field-label" style="margin-top:12px;">Property Photos <span class="req">*</span>
                <span class="small-muted">(or add a Pictures Link above instead)</span></label>
              <input type="file" id="commercial-photos-input" accept="image/*" multiple>
              <div id="commercial-photos-list" style="margin-top:8px;"></div>
              <div class="error-text" id="commercial-photos-error">Upload at least one photo, or add a Pictures Link above, before continuing.</div>
            `}
          </div>
        ` : ""}

        ${isResidential && isPreforeclosureAuction ? `
          <div style="margin-top:16px;">
            <label class="field-label">Year Built</label>
            <input type="number" id="year-built-input" placeholder="e.g. 1998">
            <p class="hint">Look this up on <a href="https://www.zillow.com/" target="_blank" rel="noopener">Zillow</a>:
            search the address and check the property details for "Year Built."</p>

            <label class="field-label" style="margin-top:16px;">Purchase Year
              <span class="small-muted">(the year the seller bought the property)</span></label>
            <input type="number" id="purchase-year-input" placeholder="e.g. 2015">
            <p class="hint">Verify this on <a href="https://propwire.com/" target="_blank" rel="noopener">PropWire</a>:
            enter the address, then use the last sale date from the <strong>History</strong> tab right at
            the top of the result. You may need to create a free account or sign in first.</p>

            <label class="field-label" style="margin-top:16px;">Months Behind on Payments</label>
            <input type="number" id="months-behind-input" placeholder="e.g. 4">
            <p class="hint">Ask the seller (text it or read it over the phone):
            <br><span class="small-muted">"${monthsBehindScript}"</span>
            <br><button type="button" class="btn secondary" id="months-behind-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </p>

            <label class="field-label" style="margin-top:16px;">Annual Maintenance Spend
              <span class="small-muted">(what the seller says they've put in per year since buying)</span></label>
            <input type="number" id="annual-maintenance-input" placeholder="$">

            <p class="hint">Ask the seller (text it or read it over the phone):
            <br><span class="small-muted" id="preforeclosure-script-hint"></span>
            <br><button type="button" class="btn secondary" id="preforeclosure-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </p>

            <label class="field-label" style="margin-top:16px;">Property Photos
              <span class="small-muted">(from the seller, if they send any — optional but strongly encouraged)</span></label>
            <input type="file" id="property-photos-input" accept="image/*" multiple>
            <div id="property-photos-list" style="margin-top:8px;"></div>
            <label class="field-label" style="margin-top:12px; font-weight:normal;">Or link to photos
              <span class="small-muted">(a Google Photos/Drive album, Dropbox link, etc. -- instead of uploading files one by one)</span></label>
            <input type="text" id="property-photos-link-input" placeholder="https://...">
            <div class="error-text" id="property-photos-link-error"></div>

            <p class="hint" style="margin-top:16px;">Either way (photos or not), ${googleAiHow}, copy
            this prompt, and paste it into Google AI for a repair estimate range:
            <br><span class="small-muted" id="preforeclosure-repair-prompt-hint"></span>
            <br><button type="button" class="btn secondary" id="preforeclosure-repair-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
            </p>
          </div>
        ` : ""}

        ${!isLand && !isBusiness ? `
          ${isPreforeclosureAuction ? `
            <p class="hint" style="margin:16px 0;">This rehab estimate feeds the MAO used to decide cash
            vs subject-to on the Existing Debt &amp; Arrears step next.</p>
          ` : `
            <div class="banner warn" style="margin:16px 0;">
              <strong>⭐ If the property is currently generating income and/or needs no rehab to generate
              cash flow, enter 0 here</strong> rather than leaving it blank or guessing a small number —
              the site's logic for what text goes to the seller/realtor only works correctly when a true
              no-rehab deal reads as exactly 0. If it's below 50% occupancy and does need rehab, go ahead
              and enter a real rehab amount from the AI prompt results below.
            </div>
          `}
          <p class="hint">To estimate this, ${googleAiHow}. It's important to also give it the for-sale listing
          link or a link to pictures of the property so it can actually see the property's condition — a repair
          estimate without pictures is just a guess.${isResidential ? ` <strong>No bedroom or bathroom
          additions</strong> — this deal doesn't add or convert them, though the repair itself can
          still run as light or as heavy as the property actually needs.` : ""} Then ask:
          <br><span class="small-muted" id="repair-prompt-hint"></span>
          <br><button type="button" class="btn secondary" id="repair-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
          </p>
          <label class="field-label" style="margin-top:12px;">Paste Google AI's full response <span class="small-muted">(the form will auto-extract the repair estimate)</span></label>
          <textarea id="rehab-ai-text-input" rows="4" placeholder="Paste the full AI response here…" style="width:100%;box-sizing:border-box;font-size:13px;border:1px solid #d1d5db;border-radius:6px;padding:10px;"></textarea>
          <button type="button" class="btn secondary" id="rehab-ai-parse-btn" style="margin-top:8px;">Extract Estimate from Response</button>
          <div id="rehab-ai-parse-status" style="margin-top:6px;font-size:13px;display:none;"></div>
          <label class="field-label" style="margin-top:14px;">Rehab Estimate — Low <span class="small-muted">(auto-filled above, or enter manually)</span></label>
          <input type="number" id="rehab-low-input" placeholder="$">
          <label class="field-label">Rehab Estimate — High</label>
          <input type="number" id="rehab-high-input" placeholder="$">
          <div class="banner info" id="rehab-average-banner" hidden></div>

          ${hasCompsWorkflow ? `<div class="banner info" id="as-is-value-banner" hidden></div>` : ""}

          ${!isSellerFinancing && !isPreforeclosureAuction && isOnMarket ? `
            <label class="field-label" style="margin-top:16px;">Is this a full tear-down / rebuild? <span class="req">*</span>
              <span class="small-muted">(the structure comes down entirely -- not just a heavy gut/reno.
              This determines whether the 50% ARV off-market exception on the Deal Status step later
              applies to this deal.)</span></label>
            <div class="choice-group" id="tear-down-group">
              ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
            </div>
            <div class="error-text" id="tear-down-error">Please choose one.</div>
          ` : ""}
        ` : ""}

        ${isResidential ? `
          <label class="field-label" style="margin-top:4px;">Approximate As-Is Value
            <span class="small-muted">(optional — use <a href="https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator" target="_blank" rel="noopener">Chase's Home Value Estimator</a>. Chase's estimate accounts for approximate property condition and age, making it a useful proxy for current as-is value — it may already reflect repair needs for older homes.)</span></label>
          <input type="number" id="chase-estimate-input" placeholder="$">

          ${isPreforeclosureAuction ? `
            <div class="banner info" style="margin-top:16px;"><strong>No asking price here</strong> —
            auction/preforeclosure sellers don't have one. The offer is built entirely off As-Is Value,
            ARV, and the repair estimate below.</div>
          ` : `
            <label class="field-label" style="margin-top:16px;">Asking Price <span class="req">*</span>
              <span class="small-muted">(what the seller is asking/listing for)</span></label>
            <input type="number" id="asking-price-input" placeholder="$">
            <div class="error-text" id="asking-price-error">Required.</div>
          `}
        ` : ""}

        <label class="field-label">County Assessed Value <span class="small-muted">(optional — powerful negotiation tool)</span></label>
        <input type="number" id="assessed-value-input" placeholder="$">
        <p class="hint"><strong>Why this matters:</strong> The county's assessed value is an official government number the seller can't argue with. When it's lower than their asking price, it's a credible third-party anchor you can use to justify a lower offer — <em>"Even the county only values it at $X."</em>
        <br>Don't have it? ${googleAiHow}, then ask:
        <br><span class="small-muted">"${assessedValuePrompt}"</span>
        <br><button type="button" class="btn secondary" id="assessed-value-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
        </p>

        ${isPreforeclosureAuction ? "" : `
          <label class="field-label">Lowest price they'd accept to close quickly <span class="small-muted">(their bottom dollar — we'll see if we can make that work with the acquisition team, optional)</span></label>
          <input type="number" id="bottom-dollar-input" placeholder="$">

          <label class="field-label">Notes: why does the seller want to sell / what makes this a good lead?
            <span class="small-muted" id="cash-notes-hint"></span></label>
          <textarea id="cash-notes-input" placeholder="e.g. motivated seller, inherited property, tired landlord, needs to relocate..."></textarea>
          <div class="error-text" id="cash-notes-error">Since pictures${isLand ? "" : ", rehab estimate,"} and assessed value are all blank, please describe why this is a good lead.</div>
        `}

        ${!isSellerFinancing ? `
          <label class="field-label" style="margin-top:16px;">Wholesale Fee
            <span class="small-muted">(auto-filled at the greater of $25,000 or 3% of ${isLand ? "As-Is Value" : "ARV"} — override with a smaller number if you've negotiated one down for this deal)</span></label>
          <input type="number" id="wholesale-fee-input" placeholder="$">
        ` : `
          <div class="banner info" style="margin-top:16px;">Seller financing terms get structured from
          later steps — the Cash Buyer MAO below is calculated automatically (standard wholesale fee
          formula, no override) and feeds the cash-offer option in Make Your Offers.</div>
        `}

        ${isOnMarket ? `
          <div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:12px 14px;margin-top:16px;font-size:13px;line-height:1.5;">
            <strong>Pricing guidance:</strong> for best results, aim for around 70% of the price posted online for an accepted offer. Only use our highest MAO as a last resort, and round down to the nearest $5,000. The tighter the deal, the less likely it is to sell.
            <br><br>
            <strong>Assignment fee:</strong> push for AT LEAST <strong>$10,000</strong> — at that level, if a buyer asks for a price reduction we still have room to work with. The absolute worst-case floor is <strong>$5,000</strong>, but at $5K there is zero cushion: any buyer price-reduction request means we can't sell and have to find a new deal.
          </div>
        ` : ""}

        <div class="banner warn" id="max-offer-banner" hidden style="margin-top:16px;"></div>
        <div class="banner warn" id="assessed-max-offer-banner" hidden style="margin-top:16px;"></div>
      `;
      if (hasCompsWorkflow || isBusiness) root.querySelector("#arv-input").value = answers.arv || "";
      if (isResidential) {
        root.querySelector("#chase-estimate-input").value = answers.chaseEstimate || "";
        if (!isPreforeclosureAuction) root.querySelector("#asking-price-input").value = answers.askingPrice || "";
      }
      if (!isBusiness) root.querySelector("#pictures-link-input").value = answers.picturesLink || "";
      if (isResidential && isPreforeclosureAuction) {
        root.querySelector("#year-built-input").value = answers.yearBuilt || "";
        root.querySelector("#purchase-year-input").value = answers.purchaseYear || "";
        root.querySelector("#months-behind-input").value = answers.monthsBehindOnPayments || "";
        root.querySelector("#annual-maintenance-input").value = answers.annualMaintenanceSpend || "";
        wireCopyPromptButton(root, "#preforeclosure-script-copy-btn", () => buildPreforeclosureSellerScript(root.querySelector("#purchase-year-input").value));
        wireCopyPromptButton(root, "#months-behind-script-copy-btn", () => monthsBehindScript);
        wireCopyPromptButton(root, "#preforeclosure-repair-prompt-copy-btn", () => buildPreforeclosureRehabPrompt(
          root.querySelector("#arv-input").value,
          root.querySelector("#year-built-input").value,
          root.querySelector("#purchase-year-input").value,
          root.querySelector("#months-behind-input").value,
          root.querySelector("#annual-maintenance-input").value
        ));
        wireScreenshotUpload(root, {
          inputSelector: "#property-photos-input", listSelector: "#property-photos-list",
          answersKey: "propertyPhotoUrls", address: addressLine
        });
        root.querySelector("#property-photos-link-input").value = answers.propertyPhotosLink || "";
        root.querySelector("#property-photos-link-input").oninput = (e) => { answers.propertyPhotosLink = e.target.value.trim(); };
      }
      if (!isLand && !isBusiness) {
        root.querySelector("#rehab-low-input").value = answers.rehabEstimateLow || "";
        root.querySelector("#rehab-high-input").value = answers.rehabEstimateHigh || "";
        root.querySelector("#rehab-ai-text-input").value = answers.rehabAiText || "";
        if (!isSellerFinancing && !isPreforeclosureAuction && isOnMarket) {
          bindChoiceGroup(root, "#tear-down-group", "isTearDown");
        }
      }
      root.querySelector("#assessed-value-input").value = answers.countyAssessedValue || "";
      if (!isPreforeclosureAuction) {
        root.querySelector("#bottom-dollar-input").value = answers.bottomDollarPrice || "";
        root.querySelector("#cash-notes-input").value = answers.cashDealNotes || "";
      }
      if (!isSellerFinancing) root.querySelector("#wholesale-fee-input").value = answers.wholesaleFee || "";
      // Once a fee is already on file (fresh input, or restored from a save/resume link) treat it as
      // deliberately set and stop auto-overwriting it as ARV changes -- only a truly untouched field
      // keeps tracking the formula live.
      let feeManuallyEdited = !!answers.wholesaleFee;

      const recomputeCashDeal = () => {
        // Land and Business have no Rehab Estimate inputs -- offers run purely off the As-Is/Business
        // Value entered above, so rehab stays 0 and never gets subtracted from anything below.
        const rehabLow = (isLand || isBusiness) ? 0 : (Number(root.querySelector("#rehab-low-input").value) || 0);
        const rehabHigh = (isLand || isBusiness) ? 0 : (Number(root.querySelector("#rehab-high-input").value) || 0);
        const hasSupplementary = !!(!isBusiness && root.querySelector("#pictures-link-input")?.value.trim()
          || rehabLow || rehabHigh
          || root.querySelector("#assessed-value-input").value);
        if (!isPreforeclosureAuction) {
          root.querySelector("#cash-notes-hint").textContent = hasSupplementary
            ? "(optional)"
            : `(required since pictures${(isLand || isBusiness) ? "" : "/rehab estimate"}/assessed value are all blank)`;
        }

        const arv = Number(root.querySelector("#arv-input").value) || 0;
        const rehab = rehabLow && rehabHigh ? (rehabLow + rehabHigh) / 2 : (rehabLow || rehabHigh || 0);

        if (isResidential && isPreforeclosureAuction) {
          // Real newlines in the script (see buildPreforeclosureSellerScript) need converting to <br>
          // here so the paragraph breaks actually show on screen -- textContent would collapse them.
          const sellerScriptText = buildPreforeclosureSellerScript(root.querySelector("#purchase-year-input").value);
          root.querySelector("#preforeclosure-script-hint").innerHTML =
            `"${sellerScriptText.split("\n\n").map(p => escapeHtml(p)).join("<br><br>")}"`;
          root.querySelector("#preforeclosure-repair-prompt-hint").textContent = `"${buildPreforeclosureRehabPrompt(
            arv,
            root.querySelector("#year-built-input").value,
            root.querySelector("#purchase-year-input").value,
            root.querySelector("#months-behind-input").value,
            root.querySelector("#annual-maintenance-input").value
          )}"`;
        }

        if (!isLand && !isBusiness) {
          root.querySelector("#repair-prompt-hint").textContent = `"${buildRepairPrompt(arv, root.querySelector("#pictures-link-input").value.trim())}"`;
          const rehabAverageBanner = root.querySelector("#rehab-average-banner");
          if (rehabLow && rehabHigh) {
            rehabAverageBanner.hidden = false;
            rehabAverageBanner.innerHTML = `<strong>Rehab Estimate (average):</strong> $${rehab.toLocaleString(undefined, {maximumFractionDigits: 0})}
              <span class="small-muted">(average of your $${rehabLow.toLocaleString()} low and $${rehabHigh.toLocaleString()} high)</span>`;
          } else {
            rehabAverageBanner.hidden = true;
          }

          if (hasCompsWorkflow) {
            const asIsBanner = root.querySelector("#as-is-value-banner");
            if (!arv) {
              asIsBanner.hidden = true;
            } else {
              asIsBanner.hidden = false;
              asIsBanner.innerHTML = `<strong>As-Is Value:</strong> $${(arv - rehab).toLocaleString(undefined, {maximumFractionDigits: 0})}
                <span class="small-muted">(ARV minus the repair estimate)</span>`;
            }
          }
        }

        // A rehab deal needs ARV meaningfully ABOVE asking (that gap is the whole value-add play,
        // and it backs the 1-year seller-financing balloon at full appraised value). A no-rehab deal
        // has no way to raise value above asking (as-is value and ARV are the same thing), so it's
        // only viable if ARV lands AT OR very near asking -- that's exactly the case the 5-15 year
        // full-asking-price seller-financing balloon is built for. Below that gap either way, there's
        // no margin for a cash purchase and no case for a seller-financing pivot -- stop the deal.
        // "Very close" is a judgment call, set at 5% here; adjust ARV_VS_ASKING_CLOSE_PCT if that's
        // too tight or too loose in practice.
        if (isResidential && !isPreforeclosureAuction) {
          const askingPrice = Number(root.querySelector("#asking-price-input").value) || 0;
          const arvVsAskingBanner = root.querySelector("#arv-vs-asking-banner");
          const needsRehabLive = rehab > 0;
          if (!arv || !askingPrice) {
            arvVsAskingBanner.hidden = true;
            answers.arvBelowAskingBlocked = false;
            answers.forcedSellerFinancingOnly = false;
          } else if (arv < askingPrice) {
            const gapPct = (askingPrice - arv) / askingPrice;
            if (!needsRehabLive && gapPct <= ARV_VS_ASKING_CLOSE_PCT) {
              arvVsAskingBanner.hidden = false;
              arvVsAskingBanner.className = "banner warn";
              arvVsAskingBanner.innerHTML = `<strong>ARV is close to asking price and this property needs
                no rehab.</strong> A cash offer will not work here -- moving forward switches this to a
                seller financing offer only, at full asking price, and only works if the property will
                cash flow as a long term or short term rental (checked on the next income step).`;
              answers.arvBelowAskingBlocked = false;
              answers.forcedSellerFinancingOnly = true;
            } else {
              arvVsAskingBanner.hidden = false;
              arvVsAskingBanner.className = "banner danger";
              arvVsAskingBanner.innerHTML = `<strong>This deal does not pencil.</strong> ARV needs to be at
                or above the asking price${needsRehabLive ? ", and meaningfully higher once rehab is factored in," : ""}
                for this to work as either a cash purchase or a seller financing offer. Stop here and move
                on to another opportunity -- this lead can't be submitted with these numbers.`;
              answers.arvBelowAskingBlocked = true;
              answers.forcedSellerFinancingOnly = false;
            }
          } else {
            arvVsAskingBanner.hidden = true;
            answers.arvBelowAskingBlocked = false;
            answers.forcedSellerFinancingOnly = false;
          }
        }

        {
          const feeInput = isSellerFinancing ? null : root.querySelector("#wholesale-fee-input");
          const formulaFee = arv ? Math.max(25000, 0.03 * arv) : 0;
          if (feeInput && !feeManuallyEdited) feeInput.value = formulaFee || "";
          const wholesaleFee = feeInput ? (Number(feeInput.value) || formulaFee) : formulaFee;

          const maxOfferBanner = root.querySelector("#max-offer-banner");
          const landDeferredFullValue = isLand && answers.landFreeAndClear === "Yes" && answers.landWillingToWaitForDev === "Yes";
          const maoSuite = computeMaoSuite(arv, rehab, answers.assetType, wholesaleFee, answers.marketStatus, landDeferredFullValue);
          if (!maoSuite) {
            maxOfferBanner.hidden = true;
          } else {
            const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
            maxOfferBanner.hidden = false;
            if (maoSuite.isLand) {
              maxOfferBanner.innerHTML = maoSuite.landDeferredFullValue ? `
                <strong>Full Value Offer (Deferred):</strong> ${fmt(maoSuite.maoCash)}
                <br><span class="small-muted">(${maoSuite.cashExplanation})</span>
                <br><br><strong>This only applies because the land is free and clear and the seller agreed to ~5% down now with the rest paid once developed/sold or refinanced.</strong> If either answer changes, come back to this
                step to recompute the normal ${maoSuite.isOnMarket ? "on-market" : "off-market"} percentage-based offer instead.
              ` : `
                <strong>Opening Offer${maoSuite.isOnMarket ? " (On-Market/FSBO)" : " (Off-Market)"}:</strong> ${fmt(maoSuite.maoCash)}
                <br><span class="small-muted">(${maoSuite.cashExplanation})</span>
                <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
                <strong>${maoSuite.hm10Label} — hard ceiling:</strong> ${fmt(maoSuite.maoHardMoney10)}
                <br><span class="small-muted">(${maoSuite.hm10Explanation})</span>
                <br><br><strong>Start at the opening offer and negotiate up from there — never go above the
                ceiling.</strong>
                ${maoSuite.isOnMarket ? `
                  <br><span class="small-muted">If the seller won't accept anywhere at or below the ceiling,
                  this needs to come <strong>off-market</strong> before we can go any higher — let them know
                  we can revisit at a better number once the listing comes down.</span>
                ` : `
                  <br><span class="small-muted">Off-market gives more room than a live listing — it's fine to
                  work up to the ceiling if that's what it takes to close, just don't start there.</span>
                `}
              `;
            } else {
              maxOfferBanner.innerHTML = `
                <strong>Cash Buyer MAO:</strong> ${fmt(maoSuite.maoCash)}
                <br><span class="small-muted">(${maoSuite.cashExplanation})</span>
                <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
                <strong>Hard Money Buyer MAO (${maoSuite.hm10Label} Down):</strong> ${fmt(maoSuite.maoHardMoney10)}
                <br><span class="small-muted">(${maoSuite.hm10Explanation})</span>
                <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
                <strong>Hard Money Buyer MAO (${maoSuite.hm20Label} Down):</strong> ${fmt(maoSuite.maoHardMoney20)}
                <br><span class="small-muted">(${maoSuite.hm20Explanation})</span>
                <br><br><strong>Start well below the Cash Buyer number and try to close there in negotiation.</strong>
                <br><span class="small-muted">The hard money numbers show what a leveraged buyer could still pay and
                hit the same target return, since less of their own cash is tied up in the deal — useful when
                presenting to a hard-money buyer, or to justify going higher if the seller won't move off a price
                above the Cash Buyer number after you've already started low. This can take a while — use
                "Save My Progress" at the top of the page to pause here and come back once the seller has agreed
                to a number.</span>
              `;
            }
          }

          // Off-market negotiating strategy: county assessed value if we have it, otherwise fall
          // back to As-Is Value (ARV minus repairs) as the alternative base. This is a
          // talking-point number for working an off-market seller down, not the internal ceiling
          // -- county/as-is values are usually higher than a true ARV-based max offer, so cite the
          // high end of the repair estimate against this bigger, official-sounding number to
          // justify why the price needs to land near it. Only relevant off-market: on-market deals
          // already have a real listing/comps to negotiate against, so this trick doesn't apply.
          // County assessed value is a raw pre-repair-style figure (repairs get subtracted below);
          // As-Is Value already has repairs baked in, so it doesn't get subtracted again.
          const isOffMarket = answers.marketStatus === "Off-Market";
          const assessedValue = Number(root.querySelector("#assessed-value-input").value) || 0;
          const asIsValue = arv ? Math.max(arv - rehab, 0) : 0;
          const usingAssessed = assessedValue > 0;
          const negotiationBase = usingAssessed ? assessedValue : asIsValue;
          const negotiationLabel = usingAssessed ? "county assessed value" : (isLand ? "As-Is Value" : "As-Is Value (ARV minus repairs)");
          const assessedMaxOfferBanner = root.querySelector("#assessed-max-offer-banner");
          // Auction/preforeclosure deals don't have time for this kind of drawn-out negotiation --
          // these need to close in well under 20 days, which isn't realistic at a top-of-market price
          // anyway, so skip the negotiating-ceiling tool entirely regardless of on/off-market status.
          if (!isOffMarket || !negotiationBase || isPreforeclosureAuction) {
            assessedMaxOfferBanner.hidden = true;
          } else {
            const discountedBase = 0.90 * negotiationBase;
            // Same 8% selling costs (realtor commission + escrow/title fees) the main MAO formula
            // subtracts from ARV -- this banner was missing it entirely, which overstated the ceiling.
            const ceilingSellingCosts = 0.08 * negotiationBase;
            const negotiationOffer = usingAssessed
              ? (discountedBase - rehab - ceilingSellingCosts - wholesaleFee)
              : (discountedBase - ceilingSellingCosts - wholesaleFee);
            assessedMaxOfferBanner.hidden = false;
            assessedMaxOfferBanner.innerHTML = `
              <strong>Off-Market Negotiating Ceiling:</strong> $${negotiationOffer.toLocaleString(undefined, {maximumFractionDigits: 0})}
              <span class="small-muted">(90% of $${negotiationBase.toLocaleString()} ${negotiationLabel},
              ${(usingAssessed && !isLand) ? `minus $${rehab.toLocaleString()} repairs, ` : ""}minus $${ceilingSellingCosts.toLocaleString(undefined, {maximumFractionDigits: 0})}
              selling costs (8% of ${negotiationLabel} — realtor commission plus escrow/title fees), minus your
              $${wholesaleFee.toLocaleString(undefined, {maximumFractionDigits: 0})} wholesale fee)</span>
              <br><span class="small-muted">This is a negotiating tool for off-market deals, not a hard cap like
              the Max Offer above. Use the ${negotiationLabel} as your ceiling with the seller and cite the high end
              of your repair estimate to make the case for why the price needs to come down near here.</span>
            `;
          }
        }
      };
      // Assigned inside the hasCompsWorkflow block below, but declared out here so the isCommercial
      // NOI/occupancy handlers (wired before that block runs, but only ever called after render()
      // finishes) can call the real implementation through the same closure.
      let updateCompsPromptText = () => {};
      const recomputeTriggerSelectors = isBusiness
        ? ["#arv-input", "#assessed-value-input"]
        : ["#arv-input", "#pictures-link-input", "#assessed-value-input"];
      if (!isLand && !isBusiness) recomputeTriggerSelectors.push("#rehab-low-input", "#rehab-high-input");
      if (isResidential) {
        if (isPreforeclosureAuction) {
          recomputeTriggerSelectors.push("#year-built-input", "#purchase-year-input", "#months-behind-input", "#annual-maintenance-input");
        } else {
          recomputeTriggerSelectors.push("#asking-price-input");
        }
      }
      recomputeTriggerSelectors.forEach(sel => {
        root.querySelector(sel).oninput = recomputeCashDeal;
      });
      if (!isSellerFinancing) {
        root.querySelector("#wholesale-fee-input").oninput = () => {
          feeManuallyEdited = true;
          recomputeCashDeal();
        };
      }

      if (isLand) {
        bindChoiceGroup(root, "#land-free-clear-group", "landFreeAndClear");
        bindChoiceGroup(root, "#land-willing-wait-group", "landWillingToWaitForDev");
        root.querySelectorAll("#land-free-clear-group .choice-btn, #land-willing-wait-group .choice-btn").forEach(btn => {
          const rebindClick = btn.onclick;
          btn.onclick = () => { rebindClick(); recomputeCashDeal(); };
        });
      }

      if (!isLand && !isBusiness) {
        root.querySelector("#repair-prompt-copy-btn").onclick = () => {
          const arv = Number(root.querySelector("#arv-input").value) || 0;
          const text = buildRepairPrompt(arv, root.querySelector("#pictures-link-input").value.trim());
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              alert("Prompt copied to clipboard.");
            }).catch(() => {
              prompt("Copy this prompt:", text);
            });
          } else {
            prompt("Copy this prompt:", text);
          }
        };
        root.querySelector("#rehab-ai-parse-btn").onclick = () => {
          const text = root.querySelector("#rehab-ai-text-input").value;
          const parsed = parseRehabText(text);
          const statusEl = root.querySelector("#rehab-ai-parse-status");
          statusEl.style.display = "block";
          if (parsed.low != null) {
            root.querySelector("#rehab-low-input").value = parsed.low;
            root.querySelector("#rehab-high-input").value = parsed.high != null ? parsed.high : parsed.low;
            statusEl.innerHTML = `<span style="color:#166534;">✓ Extracted: low $${Number(parsed.low).toLocaleString()} / high $${Number(parsed.high != null ? parsed.high : parsed.low).toLocaleString()}</span>`;
            recomputeCashDeal();
          } else {
            statusEl.innerHTML = `<span style="color:#b45309;">Couldn't find a dollar amount — enter the repair estimate manually.</span>`;
          }
        };
      }

      wireCopyPromptButton(root, "#assessed-value-prompt-copy-btn", () => assessedValuePrompt);

      if (isCommercial) {
        root.querySelector("#noi-research-notes-input").value = answers.noiResearchNotes || "";
        const noiInput = root.querySelector("#noi-input");
        noiInput.value = answers.commercialNOI || "";
        noiInput.oninput = () => updateCompsPromptText();
        root.querySelector("#unknown-noi-btn").onclick = () => {
          answers.commercialNoiUnknown = !answers.commercialNoiUnknown;
          if (answers.commercialNoiUnknown) answers.commercialNOI = "";
          noiInput.value = answers.commercialNOI || "";
          noiInput.disabled = answers.commercialNoiUnknown;
          root.querySelector("#unknown-noi-btn").classList.toggle("active", answers.commercialNoiUnknown);
          updateCompsPromptText();
        };

        const occStatusGroup = root.querySelector("#occupancy-status-group");
        const occDetailBlock = root.querySelector("#occupancy-detail-block");
        const commercialVacantBlock = root.querySelector("#commercial-vacant-block");
        const occUnitsInput = root.querySelector("#occ-units-input");
        const occPctInput = root.querySelector("#occ-pct-input");
        if (occUnitsInput) occUnitsInput.value = answers.commercialUnitsOccupied || "";
        if (occPctInput) occPctInput.value = answers.commercialOccupancyPct || "";
        if (occUnitsInput) occUnitsInput.oninput = () => updateCompsPromptText();
        if (occPctInput) occPctInput.oninput = () => updateCompsPromptText();
        if (!isOnMarket) {
          wireScreenshotUpload(root, {
            inputSelector: "#commercial-photos-input", listSelector: "#commercial-photos-list",
            answersKey: "propertyPhotoUrls", address: addressLine
          });
        }
        occStatusGroup.querySelectorAll(".choice-btn").forEach(btn => {
          if (btn.dataset.value === answers.commercialOccupancyStatus) btn.classList.add("selected");
          btn.onclick = () => {
            occStatusGroup.querySelectorAll(".choice-btn").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            answers.commercialOccupancyStatus = btn.dataset.value;
            toggleError(root, "#occupancy-status-error", false);
            occDetailBlock.hidden = answers.commercialOccupancyStatus !== "Partially Occupied";
            if (commercialVacantBlock) commercialVacantBlock.hidden = answers.commercialOccupancyStatus !== "Vacant";
            updateCompsPromptText();
          };
        });
      }

      if (hasCompsWorkflow || isBusiness) {
        const compsPromptToggleBtn = root.querySelector("#comps-prompt-toggle-btn");
        const compsPromptPanel = root.querySelector("#comps-prompt-panel");
        compsPromptToggleBtn.onclick = () => {
          compsPromptPanel.hidden = !compsPromptPanel.hidden;
          compsPromptToggleBtn.innerHTML = compsPromptPanel.hidden
            ? "Get Comps Research Prompt for Google AI &#9662;"
            : "Hide Comps Research Prompt &#9652;";
          updateCompsPromptText();
        };
        // Address/beds/baths/sqft (or acreage, for land) are already on file by this point in the
        // wizard (collected in the address and asset type steps) -- pre-fill the prompt with them
        // instead of leaving the associate to retype everything by hand. Commercial's NOI/occupancy
        // fields live on this same step (unlike everything else here, set on an earlier step), so
        // this whole thing is a function re-run on every relevant edit rather than computed once at
        // initial render -- otherwise it would permanently show blank/stale NOI and occupancy.
        updateCompsPromptText = () => {
        const detailsPart = isBusiness
          ? ""
          : isLand
          ? (answers.acreage
              ? `${answers.acreage} acre(s)${answers.sqft ? ` (${answers.sqft} square feet)` : ""}${answers.landZoning ? `, zoned ${answers.landZoning}` : ""}`
              : (answers.sqft ? `${answers.sqft} square feet${answers.landZoning ? `, zoned ${answers.landZoning}` : ""}` : "[ACREAGE/SQUARE FEET]"))
          : isCommercial
          ? (isMultifamilySubtype && answers.matchByUnitsOnly
              ? `${answers.units || "[UNIT COUNT]"} units (square footage not reliably known -- match by unit count instead, not square footage)`
              : `${isMultifamilySubtype && answers.units ? `${answers.units} units, ` : ""}${
                  answers.acreage
                    ? `${answers.acreage} acre(s)${answers.sqft ? ` (${answers.sqft} square feet)` : ""}`
                    : (answers.sqft ? `${answers.sqft} square feet` : "[SQUARE FEET/ACREAGE]")
                }`)
          : (answers.beds && answers.baths
              ? `${answers.beds} bedroom(s), ${answers.baths} bathroom(s), ${answers.sqft ? answers.sqft + " square feet" : "[SQUARE FEET]"}`
              : (answers.sqft ? `${answers.sqft} square feet` : "[BEDROOMS/BATHROOMS/SQUARE FEET]"));
        // Feeds both the "Current occupancy" line and the Income Approach paragraph below -- an
        // in-place NOI on a partially occupied or vacant property understates what it earns fully
        // leased, so Google AI needs to know the occupancy behind whatever NOI number it's given.
        // Reads the units/pct inputs straight from the DOM (like the ARV/rehab reads above) rather
        // than from answers.commercialUnitsOccupied/commercialOccupancyPct, since those aren't
        // written back to answers until validate() runs on Next.
        const liveUnitsOccupied = root.querySelector("#occ-units-input")?.value;
        const livePctOccupied = root.querySelector("#occ-pct-input")?.value;
        const liveNOI = isCommercial && !answers.commercialNoiUnknown ? root.querySelector("#noi-input")?.value : "";
        const matchByUnitsOnly = isMultifamilySubtype && !!answers.matchByUnitsOnly;
        const occupancyPart = !isCommercial ? "" : answers.commercialOccupancyStatus === "Fully Occupied"
          ? "Fully occupied (100%)"
          : answers.commercialOccupancyStatus === "Vacant"
          ? "Vacant (0% occupied)"
          : answers.commercialOccupancyStatus === "Partially Occupied"
          ? (isMultifamilySubtype && liveUnitsOccupied
              ? `Partially occupied — ${liveUnitsOccupied} of ${answers.units || "?"} units currently occupied (~${Math.round((Number(liveUnitsOccupied) / (Number(answers.units) || 1)) * 100)}% occupancy)`
              : livePctOccupied
              ? `Partially occupied — approximately ${livePctOccupied}% occupied`
              : "Partially occupied")
          : "";
        // Land runs on its own template rather than sharing residential's via ternaries -- the
        // underlying methodology genuinely differs (utility/zoning-match-first, distance-second,
        // time-adjusted comps for land vs. a flat distance cutoff for homes), so weaving them
        // together got harder to read than just writing two prompts.
        root.querySelector("#comps-prompt-text").value = isLand
? `Act as a professional real estate data analyst specializing in land valuation. Explain your math simply and avoid real estate jargon — I have no real estate experience.

Find recent comparable land sales (comps) and an estimated As-Is Value (current market value — this is NOT an after-repair or projected value, land doesn't get "fixed up") for this property:
- Address: ${addressLine || "[SUBJECT ADDRESS]"}
- Details: ${detailsPart}

For land, what a comp has in common matters more than how close it is. Search live for up to 3 properties that meet ALL of these rules, prioritizing the most recent and closest qualifying matches first, in this order of importance:
1. Identical or equivalent zoning to the subject property — never treat a commercially-zoned parcel as comparable to a residentially-zoned one, even if they're next to each other.
2. Comparable topography and usability — a flat, buildable lot is not comparable to a steep, unusable, or landlocked one without a clear value adjustment. Note each comp's topography and any notable features (wooded, cleared, waterfront, floodplain, etc.).
3. Comparable access and utilities — road access (paved vs. dirt vs. none) and utility hookups (electric, water, septic/sewer) should be similar, or clearly flagged as different along with how that affects value.
4. Similar in acreage (or square footage, for small in-town lots) to the subject property — avoid comps that are dramatically larger or smaller.

Only after a comp passes ALL four rules above should distance be weighed — prefer the closest qualifying comps, but a comp farther away that matches on zoning/topography/access beats a closer one that doesn't. Distance tiers as a rough guide: Urban/Dense Suburban — 0.25 to 1 mile; Suburban/Master-Planned — 1 to 2 miles; Rural/Unique Acreage — 3 to 10 miles (up to 30 miles in sparse markets with very few land sales). Always state each comp's straight-line distance and note if you had to go unusually far to find a qualifying match.

Recency: 1 to 2 years is acceptable as a catch-all for land — prefer more recent sales where available. For any comp older than 6 months, apply a reasonable adjustment to its sale price to reflect market movement (appreciation or depreciation) between the sale date and today, show that adjustment explicitly, and use the adjusted price (not the raw historical price) in the calculation below.

If this is a non-disclosure state and you can't find actual sold prices, use active for-sale listings instead that meet the other rules, and clearly label them as asking prices, not confirmed sale prices.

For each comp, list:
- Full address
- Sale price (or asking price, if using the non-disclosure fallback), the exact date sold (or listed date for active comps), and for active for-sale listings also include how many days it has been on the market (days on market / DOM)
- Zoning, topography, and access/utilities
- Straight-line distance from the subject address, in miles
- Total acreage (and square footage, if it's a small lot)
- Price per Acre (or Price per Square Foot for small lots) — show both the raw price and, for comps older than 6 months, the time-adjusted price

After listing the comps, calculate and show your work:
1. Acreage Difference %: (Average Comp Acreage - Subject Acreage) / Subject Acreage x 100
2. Estimated As-Is Value: rank the qualifying comps by recency first, then by distance from the subject — anchor on the lowest (time-adjusted) Price per Acre among the most recent and closest ones. Do not dilute that with a straight average across every comp you found, since a farther or older comp overstates what this specific parcel is worth today. State clearly which comp(s) you anchored on. Estimated As-Is Value = that lowest-and-nearest Price per Acre x Subject Acreage — give a final range, plus your single most likely estimate within that range, still favoring the low end unless you have a specific reason not to.

If the value comes out lower than what you might initially expect, say so plainly — that's an important finding, not something to smooth over.

At the very end of your response, after all analysis, output a structured summary block in EXACTLY this format (no deviations — this is machine-read):
---COMPS SUMMARY---
SOLD COMPS:
[For each sold comp: ADDRESS | PRICE | ACRES | PRICE/ACRE | DISTANCE | SOLD DATE (e.g. Jan 2025)]
ACTIVE COMPS:
[For each active/for-sale listing used: ADDRESS | PRICE | ACRES | PRICE/ACRE | DISTANCE | DAYS ON MARKET (e.g. 45 days)]
ARV RANGE: $[low] to $[high]
ARV ESTIMATE: $[single best estimate]
---END SUMMARY---`
: isCommercial
? `Act as a professional commercial real estate underwriter. Explain your math simply and avoid real estate jargon — I have no real estate experience.

Find recent comparable SOLD properties and an estimated market value (ARV) for this property:
- Address: ${addressLine || "[SUBJECT ADDRESS]"}
- Asset Type: ${answers.assetSubtype || "[ASSET TYPE]"}
- Size: ${detailsPart}${occupancyPart ? `
- Current occupancy: ${occupancyPart}` : ""}${liveNOI ? `
- Current reported annual NOI: $${Number(liveNOI).toLocaleString()}` : ""}

Search live for up to 3 comparable SOLD properties that meet ALL of these rules, prioritizing the most recent and closest qualifying matches first:
1. Same asset type as the subject (${answers.assetSubtype || "[ASSET TYPE]"}) — never comp a different commercial property type against this one, and never comp a single-family home, duplex, triplex, or fourplex against this multifamily property${isMultifamilySubtype ? (matchByUnitsOnly
  ? `. This property's square footage isn't reliably known, so ignore square footage and unit-count brackets entirely -- instead, rank candidate comps by how close their unit count is to this property's ${answers.units || "[UNIT COUNT]"} units, and use the closest matches available even if none are an exact match. Also try to match similar unit mix (studios, 1BR, 2BR, etc.) where you can find that detail`
  : `. For multifamily specifically, also match unit count within the same bracket (2 to 4, 5 to 9, 10 to 19, or 20+ units) and similar unit mix (studios, 1BR, 2BR, etc.) where you can find that detail`) : ""}.
2. Sold within the last 6 months — expand to 12 months only if this market or asset type doesn't have enough recent sales to work with.
3. Within roughly 0.5 to 1 mile in urban or suburban areas, expanding up to 3 to 5 miles only in rural markets with limited inventory. Do not cross a major highway, river, or railroad line to find a comp if a comparable one exists closer, since that can put it in a functionally different submarket.
4. Similar construction era/vintage and condition tier (turnkey/fully renovated, moderate deferred maintenance, or heavy deferred maintenance/needs a full renovation) — note each comp's tier explicitly, and flag any comp that recently had a new roof, updated plumbing, or modernized HVAC, since that inflates its price relative to what this property will still need.

If this is a non-disclosure state and you can't find actual sold prices, use active for-sale listings instead that meet the other rules, and clearly label them as asking prices, not confirmed sale prices.

For each comp, list:
- Full address
- Sale price (or asking price, if using the non-disclosure fallback) and the date
- ${matchByUnitsOnly ? "Unit count and Price per Unit" : "Square footage (or acreage, whichever is the standard valuation metric for this asset type) and Price per Square Foot (or Price per Acre)"}
- Cap rate at time of sale, if publicly available or reasonably estimable (NOI ÷ sale price) — flag clearly if you had to estimate rather than find a reported number
- Whether it sold vacant or with existing tenants/leases in place, and whether those leases were at or below current market rent
- Estimated straight-line distance from the subject address, in miles

After listing the comps, calculate BOTH approaches below and reconcile them if they meaningfully disagree:

1. Sales Comparison Approach: rank the qualifying comps by recency first, then by distance from the subject — anchor on the lowest ${matchByUnitsOnly ? "Price Per Unit" : "Price per Square Foot (or Acre)"} among the most recent and closest ones. Do not dilute that with a straight average across every comp you found, since a farther or older comp overstates what this specific property is worth today. State clearly which comp(s) you anchored on. ${matchByUnitsOnly
  ? `Estimated Value = that lowest-and-nearest Price Per Unit x Subject Unit Count (${answers.units || "[UNIT COUNT]"})`
  : `Estimated Value = that lowest-and-nearest Price per Square Foot (or Acre) x Subject Size`} — give a final range, plus your single most likely estimate within that range, still favoring the low end unless you have a specific reason not to.
2. Income Approach: ${liveNOI
  ? `Using the subject's current NOI of $${Number(liveNOI).toLocaleString()}${occupancyPart && answers.commercialOccupancyStatus !== "Fully Occupied" ? ` (in-place NOI — the property is only ${occupancyPart.toLowerCase()}, not fully occupied)` : ""} and the highest cap rate among the nearest sold comps above (the most conservative, lowest-value read, not an average across every comp), calculate Estimated Value = NOI ÷ that cap rate.${occupancyPart && answers.commercialOccupancyStatus !== "Fully Occupied" ? ` Since it isn't fully occupied, also estimate a stabilized NOI at full occupancy using typical market rents for this asset type and size, and show that as a second Income Approach value alongside the in-place one.` : ""} If this NOI implies unusually low operating expenses for a property like this in this market (a suspiciously high margin), flag that clearly as a possible red flag -- seller-reported NOI is often optimistic and may be missing real costs like insurance, maintenance, or property management -- and state what a more realistic NOI would likely be instead.`
  : `We don't have a confirmed current NOI for this property${occupancyPart ? ` (currently ${occupancyPart.toLowerCase()})` : ""}. If you can reasonably estimate one from market rents typical for this asset type and size${occupancyPart && answers.commercialOccupancyStatus !== "Fully Occupied" ? `, accounting for that occupancy level` : ""}, calculate an Income Approach value using that estimate and the highest cap rate among the nearest sold comps (not an average across every comp), but flag it clearly as an estimate rather than confirmed income. When estimating expenses to derive that NOI, flag plainly if operating costs (taxes and insurance especially) in this specific market tend to run meaningfully higher or lower than a typical 35 to 45% expense ratio, and state your single most likely NOI estimate, not just a range. Otherwise, lean primarily on the Sales Comparison Approach above since there's no reliable income data to anchor an Income Approach.`}

If the two approaches disagree by more than roughly 15%, say so plainly and explain the likely reason (below-market in-place rents, deferred capital expenditures, a below-market lease in place, etc.) — that's an important finding, not something to smooth over. Then give one final reconciled ARV: your single most likely estimate, not just a range, weighing both approaches but favoring the more conservative (lower) one unless the higher figure is clearly better supported by the data.`
: isBusiness
? `Act as a professional business valuation analyst. Explain your math simply and avoid business jargon — I have no business brokerage experience.

Find recent comparable business sales and an estimated market value for this business:
- Business Type: ${answers.assetSubtype || "[BUSINESS TYPE]"}
- Annual Revenue: ${answers.businessRevenue ? "$" + Number(answers.businessRevenue).toLocaleString() : "[REVENUE UNKNOWN]"}
- Annual ${earningsType}: ${answers.businessEarnings ? "$" + Number(answers.businessEarnings).toLocaleString() : "[EARNINGS UNKNOWN]"}

Search for up to 3 comparable recently sold businesses that meet ALL of these rules, prioritizing the most recent matches first:
1. Same or very similar business type and industry — never comp an unrelated business type against this one.
2. Sold within the last 2 years — prefer the most recent sales where available.
3. Similar revenue and size — ideally within roughly the same revenue bracket (under $500K, $500K–$2M, $2M–$10M, etc.).
4. ${earningsType} multiples are the standard valuation metric for this type of business.

For each comp, list:
- Business type and brief description
- Sale price
- Annual revenue at time of sale
- Annual ${earningsType} at time of sale
- Sale multiple (${earningsType} multiple = Sale Price ÷ ${earningsType})
- Location (city/state)
- Date of sale (or year)

After listing the comps:
1. ${earningsType} Multiple Range: state the typical ${earningsType} multiple range for this type of business at this revenue level, anchored on the most recent comps with the lowest multiples — do not average all comps indiscriminately, since older or outlier multiples overstate what a buyer would actually pay today.
2. Estimated Business Value: anchor on the lowest multiple among the most recent and most relevant comps. Estimated Value = Subject ${earningsType} ($${answers.businessEarnings ? Number(answers.businessEarnings).toLocaleString() : "[EARNINGS]"}) × that multiple — give a final range, plus your single most likely estimate within that range, still favoring the low end unless you have a specific reason not to.

If the value comes out lower than what the seller is asking, say so plainly — that's an important finding, not something to smooth over.

At the very end of your response, after all analysis, output a structured summary block in EXACTLY this format (no deviations — this is machine-read):
---COMPS SUMMARY---
BUSINESS COMPS:
[For each comp: BUSINESS TYPE | SALE PRICE | REVENUE | ${earningsType.toUpperCase()} | MULTIPLE | LOCATION | DATE]
ARV RANGE: $[low] to $[high]
ARV ESTIMATE: $[single best estimate]
---END SUMMARY---`
: `Act as a professional real estate data analyst. Explain your math simply and avoid real estate jargon — I have no real estate experience.

Find recent comparable sales (comps) and an estimated After Repair Value (ARV) for this property:
- Address: ${addressLine || "[SUBJECT ADDRESS]"}
- Details: ${detailsPart}

Search live for up to 3 properties that meet ALL of these rules, prioritizing the most recent and closest qualifying matches first:
1. Sold within the last 12 months — strongly prefer comps sold within the last 6 months if there are enough to choose from. Comps older than 12 months don't count, no exceptions.
2. Within a MAXIMUM of 1-mile STRAIGHT-LINE distance from the subject address (as the crow flies, not driving distance) — this is a hard limit, not a target, closer is always better. State your estimated straight-line distance for each one explicitly, and flag it clearly if you had to go close to the 1-mile edge because nothing closer was available.
3. In excellent, fully remodeled, or brand-new condition — skip anything described as a fixer-upper, needing TLC, sold as-is, or a renovation/investment project.
4. Same bedroom and bathroom count as the subject property (or as close as possible) — no bedroom or bathroom additions or conversions are planned, so a comp with more beds or baths would overstate what this property can actually sell for as-is. Also ideally a small starter home or bungalow, similar in size and character to the subject property.

If this is a non-disclosure state and you can't find actual sold prices, use active for-sale listings instead that meet the other three rules, and clearly label them as asking prices, not confirmed sale prices.

For each comp, list:
- Full address
- Exact sale price (or asking price, if using the non-disclosure fallback), the exact date sold (or listed date for active comps), and for active for-sale listings also include how many days it has been on the market (days on market / DOM)
- Estimated straight-line distance from the subject address, in miles
- Bedrooms, bathrooms, and total square feet
- Exact Price per Square Foot (price ÷ square feet)

After listing the comps, calculate and show your work:
1. Square Footage Difference %: (Average Comp SqFt - Subject SqFt) / Subject SqFt x 100
2. Estimated ARV: rank the qualifying comps by recency first, then by distance from the subject — anchor on the lowest Price per Square Foot among the most recent and closest ones. Do not dilute that with a straight average across every comp you found, since a farther or older comp overstates what this specific property will actually sell for today. State clearly which comp(s) you anchored on. Estimated ARV = that lowest-and-nearest Price per Square Foot x Subject SqFt — give a final range, plus your single most likely estimate within that range, still favoring the low end unless you have a specific reason not to.

If the ARV comes out lower than what a bank's automated home value estimate would show, say so plainly — that's an important finding, not something to smooth over.

At the very end of your response, after all analysis, output a structured summary block in EXACTLY this format (no deviations — this is machine-read):
---COMPS SUMMARY---
SOLD COMPS:
[For each sold comp: ADDRESS | PRICE | SQFT | PRICE/SQFT | BEDS | BATHS | DISTANCE | SOLD DATE (e.g. Jan 2025)]
ACTIVE COMPS:
[For each active/for-sale listing used: ADDRESS | PRICE | SQFT | PRICE/SQFT | BEDS | BATHS | DISTANCE | DAYS ON MARKET (e.g. 45 days)]
ARV RANGE: $[low] to $[high]
ARV ESTIMATE: $[single best estimate]
---END SUMMARY---`;

        if (matchByUnitsOnly) {
          const cityState = `${answers.city || "[CITY]"}, ${answers.state || "[STATE]"}`;
          const isFullyOccupied = answers.commercialOccupancyStatus === "Fully Occupied";
          const noiClause = liveNOI
            ? `with a confirmed annual NOI of $${Number(liveNOI).toLocaleString()}${!isFullyOccupied && occupancyPart ? ` (in place -- reflecting ${occupancyPart.toLowerCase()}, not full occupancy -- also estimate NOI and value at full/stabilized occupancy and show both)` : ""}`
            : `. I don't have a confirmed NOI yet -- estimate typical market rent per unit for a property this size and area, and use that to build a reasonable NOI`;
          root.querySelector("#unit-count-fallback-prompt-text").value =
`Act as a professional commercial real estate underwriter. Explain your math simply and avoid real estate jargon — I have no real estate experience.

What is the average sold cap rate for multifamily properties in ${cityState} (or the surrounding region if there isn't enough local data), and use it to evaluate this ${answers.units || "[UNIT COUNT]"} unit property${noiClause}.

Give me:
1. The market cap rate range you're using and where it comes from.
2. The implied property value at both ends of that range (NOI divided by cap rate), as a range, not one number -- plus your single most likely estimate, favoring the higher end of the cap rate range (the more conservative, lower-value read) unless the data clearly supports a lower cap rate.
3. If you're aware of any specific recent multifamily sales nearby, mention them for context, and if you find genuinely comparable ones, anchor toward whichever is the most recent and nearest (and lowest-priced among those) rather than a straight average -- but don't force a comp if you can't find a genuinely comparable one, a bad comp is worse than no comp.
4. ${liveNOI
  ? `If this NOI implies unusually low operating expenses for a property like this in this market (a suspiciously high margin), flag that clearly as a possible red flag -- seller-reported NOI is often optimistic and may be missing real costs like insurance, maintenance, or property management -- and state what a more realistic NOI would likely be instead.`
  : `A flag if operating expenses (taxes and insurance especially) in this specific market tend to run higher or lower than a typical 35 to 45% expense ratio, and your single most likely NOI estimate, not just a range.`}

If this suggests the property is worth meaningfully less than expected, say so plainly — that's an important finding, not something to smooth over.`;
        }
        };
        updateCompsPromptText();
        root.querySelector("#comps-prompt-copy-btn").onclick = () => {
          const text = root.querySelector("#comps-prompt-text").value;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              alert("Prompt copied to clipboard.");
            }).catch(() => {
              prompt("Copy this prompt:", text);
            });
          } else {
            prompt("Copy this prompt:", text);
          }
        };
        wireCopyPromptButton(root, "#unit-count-fallback-prompt-copy-btn", () => root.querySelector("#unit-count-fallback-prompt-text").value);

        // Parse & auto-fill from Google AI response
        const parseBtn = root.querySelector("#parse-ai-btn");
        const aiResponseInput = root.querySelector("#ai-response-input");
        const aiParseResults = root.querySelector("#ai-parse-results");
        if (parseBtn && aiResponseInput) {
          parseBtn.onclick = () => {
            const text = aiResponseInput.value.trim();
            if (!text) { alert("Paste the Google AI response first."); return; }
            const parsed = parseAICompsResponse(text, isLand, isBusiness);
            if (!parsed.arvLow && !parsed.arvHigh && !parsed.arvEstimate) {
              aiParseResults.hidden = false;
              aiParseResults.innerHTML = `<div class="banner warn">Couldn't find an ARV range in the response. Make sure you copied the full AI response including the summary block at the bottom, then try again.</div>`;
              return;
            }
            // Auto-fill ARV with the low estimate (conservative starting offer)
            const arvInput = root.querySelector("#arv-input");
            if (arvInput && parsed.arvLow) {
              arvInput.value = parsed.arvLow;
              recomputeCashDeal();
            }
            // Save comps data into answers for admin/submission
            answers.arvRange = parsed.arvLow && parsed.arvHigh ? `$${Number(parsed.arvLow).toLocaleString()} – $${Number(parsed.arvHigh).toLocaleString()}` : "";
            answers.soldCompsJson = parsed.soldComps.length ? JSON.stringify(parsed.soldComps) : "";
            answers.activeCompsJson = parsed.activeComps.length ? JSON.stringify(parsed.activeComps) : "";
            // Build results display
            const fmt = n => n ? "$" + Number(n).toLocaleString() : "—";
            const compRow = (c, isLandComp) => isLandComp
              ? `<tr><td>${c.address}</td><td>${fmt(c.price)}</td><td>${c.acres || "—"}</td><td>${c.pricePerUnit || "—"}</td><td>${c.distance || "—"}</td><td>${c.date || "—"}</td></tr>`
              : isBusiness
              ? `<tr><td>${c.address}</td><td>${fmt(c.price)}</td><td>${c.revenue || "—"}</td><td>${c.earnings || "—"}</td><td>${c.multiple || "—"}</td><td>${c.location || "—"}</td><td>${c.date || "—"}</td></tr>`
              : `<tr><td>${c.address}</td><td>${fmt(c.price)}</td><td>${c.sqft || "—"}</td><td>${c.pricePerSqft || "—"}</td><td>${c.beds || "—"}</td><td>${c.baths || "—"}</td><td>${c.distance || "—"}</td><td>${c.date || "—"}</td></tr>`;
            const colHeaders = isLand
              ? "<tr><th>Address</th><th>Price</th><th>Acres</th><th>Price/Acre</th><th>Distance</th><th>Date / DOM</th></tr>"
              : isBusiness
              ? `<tr><th>Business Type</th><th>Sale Price</th><th>Revenue</th><th>${earningsType}</th><th>Multiple</th><th>Location</th><th>Date</th></tr>`
              : "<tr><th>Address</th><th>Price</th><th>Sqft</th><th>$/Sqft</th><th>Beds</th><th>Baths</th><th>Distance</th><th>Date / DOM</th></tr>";
            const tableStyle = "width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;";
            const tdStyle = "border:1px solid #e5e7eb;padding:5px 7px;";
            const soldRows = parsed.soldComps.map(c => compRow(c, isLand)).join("").replace(/<td>/g, `<td style="${tdStyle}">`).replace(/<th>/g, `<th style="${tdStyle}background:#f3f4f6;font-weight:600;">`);
            const activeRows = parsed.activeComps.map(c => compRow(c, isLand)).join("").replace(/<td>/g, `<td style="${tdStyle}">`).replace(/<th>/g, `<th style="${tdStyle}background:#f3f4f6;font-weight:600;">`);
            const styledHeaders = colHeaders.replace(/<th>/g, `<th style="${tdStyle}background:#f3f4f6;font-weight:600;">`);
            aiParseResults.hidden = false;
            aiParseResults.innerHTML = `
              <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px;">
                <strong style="color:#166534;font-size:14px;">✓ Results parsed — ${isBusiness ? "Business Value" : "ARV"} auto-filled</strong>
                <div style="margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;">
                  <div><span class="small-muted">${isBusiness ? "Value Range" : "ARV Range"}</span><br><strong>${fmt(parsed.arvLow)} – ${fmt(parsed.arvHigh)}</strong></div>
                  <div><span class="small-muted">Best Estimate</span><br><strong>${fmt(parsed.arvEstimate)}</strong></div>
                  <div><span class="small-muted">${isBusiness ? "Starting Offer (low value)" : "Starting Offer (low ARV)"}</span><br><strong style="color:#7c3aed;">${fmt(parsed.arvLow)}</strong></div>
                </div>
                ${parsed.soldComps.length ? `
                  <div style="margin-top:12px;font-weight:600;font-size:12px;color:#374151;">${isBusiness ? "BUSINESS COMPS" : "SOLD COMPS"} (${parsed.soldComps.length})</div>
                  <table style="${tableStyle}">${styledHeaders}${soldRows}</table>
                ` : ""}
                ${parsed.activeComps.length ? `
                  <div style="margin-top:10px;font-weight:600;font-size:12px;color:#374151;">ACTIVE / FOR-SALE COMPS (${parsed.activeComps.length})</div>
                  <table style="${tableStyle}">${styledHeaders}${activeRows}</table>
                ` : ""}
              </div>`;
          };
        }

        // Screenshots upload straight to Drive as soon as they're picked (see uploadCmaScreenshot
        // in the backend) -- only the resulting links get stored in `answers`, never the raw image
        // data, so Save My Progress links and the final submission payload both stay small.
        const screenshotsList = root.querySelector("#cma-screenshots-list");
        const renderScreenshotsList = () => {
          const urls = answers.cmaScreenshotUrls || [];
          screenshotsList.innerHTML = urls.map((url, i) => `
            <div class="small-muted" style="margin-top:4px;">
              <a href="${url}" target="_blank" rel="noopener">Screenshot ${i + 1}</a>
              <button type="button" class="link-btn" data-remove-idx="${i}" style="margin-left:8px;">Remove</button>
            </div>
          `).join("");
          screenshotsList.querySelectorAll("[data-remove-idx]").forEach(btn => {
            btn.onclick = () => {
              answers.cmaScreenshotUrls.splice(Number(btn.dataset.removeIdx), 1);
              renderScreenshotsList();
            };
          });
        };
        renderScreenshotsList();

        const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        root.querySelector("#cma-screenshots-input").onchange = async (e) => {
          const files = Array.from(e.target.files);
          for (const file of files) {
            const statusEl = document.createElement("div");
            statusEl.className = "small-muted";
            statusEl.textContent = `Uploading ${file.name}...`;
            screenshotsList.appendChild(statusEl);
            try {
              const fileData = await readFileAsBase64(file);
              const res = await api("uploadCmaScreenshot", {
                fileName: file.name, fileData, contentType: file.type || "image/png", address: addressLine
              });
              if (res.ok) {
                answers.cmaScreenshotUrls = answers.cmaScreenshotUrls || [];
                answers.cmaScreenshotUrls.push(res.url);
                renderScreenshotsList();
              } else {
                statusEl.textContent = `Failed to upload ${file.name}: ${res.error || "unknown error"}`;
              }
            } catch (err) {
              statusEl.textContent = `Failed to upload ${file.name}: ${err.message}`;
            }
          }
          e.target.value = "";
        };
      }

      recomputeCashDeal();
    },
    validate(root) {
      const isSeller = answers.role === "Seller";
      // Not rendered at all for the preforeclosure category (see render()) -- guard against null
      // rather than assuming these two always exist.
      const notesEl = root.querySelector("#cash-notes-input");
      const bottomDollarEl = root.querySelector("#bottom-dollar-input");
      if (notesEl) answers.cashDealNotes = notesEl.value.trim();
      if (bottomDollarEl) answers.bottomDollarPrice = bottomDollarEl.value;
      if (isSeller) {
        const ok = !!answers.cashDealNotes;
        toggleError(root, "#cash-notes-error", !ok);
        return ok;
      }
      const isLand = answers.assetType === "Land";
      const isBusiness = answers.assetType === "Business";
      const isResidentialForChase = answers.assetType === "Residential Property (1-4 units)";
      answers.arv = root.querySelector("#arv-input")?.value || answers.arv || "";
      if (isResidentialForChase) answers.chaseEstimate = root.querySelector("#chase-estimate-input").value;
      if (!isBusiness) answers.picturesLink = root.querySelector("#pictures-link-input").value.trim();
      // Land and Business have no Rehab Estimate inputs -- offers run purely off As-Is/Business Value.
      if (!isLand && !isBusiness) answers.rehabAiText = root.querySelector("#rehab-ai-text-input").value.trim();
      answers.rehabEstimateLow = (isLand || isBusiness) ? "" : root.querySelector("#rehab-low-input").value;
      answers.rehabEstimateHigh = (isLand || isBusiness) ? "" : root.querySelector("#rehab-high-input").value;
      const rLow = Number(answers.rehabEstimateLow) || 0;
      const rHigh = Number(answers.rehabEstimateHigh) || 0;
      answers.rehabEstimate = rLow && rHigh ? String((rLow + rHigh) / 2) : String(rLow || rHigh || "");
      answers.countyAssessedValue = root.querySelector("#assessed-value-input").value;
      if ((answers.assetType === "Residential Property (1-4 units)" || answers.assetType === "Land") && answers.arv) {
        answers.asIsValue = Number(answers.arv) - (Number(answers.rehabEstimate) || 0);
      }
      const arvNum = Number(answers.arv) || 0;
      const isSellerFinancing = answers.dealType !== "Cash Deal";
      // The wholesale-fee input and MAO/ceiling banners stay hidden from the associate for Seller
      // Financing (admin structures that deal, not the associate) -- but the underlying numbers
      // still get computed either way, since Make Your Offers needs a cash figure to text out
      // regardless of which dealType this lead is. Seller Financing has no visible fee input to
      // read, so it always uses the plain formula fee instead of a manual override.
      const formulaFee = arvNum ? Math.max(25000, 0.03 * arvNum) : "";
      answers.wholesaleFee = isSellerFinancing
        ? formulaFee
        : (root.querySelector("#wholesale-fee-input").value || formulaFee);
      const landDeferredFullValue = isLand && answers.landFreeAndClear === "Yes" && answers.landWillingToWaitForDev === "Yes";
      const maoSuite = computeMaoSuite(arvNum, Number(answers.rehabEstimate) || 0, answers.assetType, answers.wholesaleFee, answers.marketStatus, landDeferredFullValue);
      if (maoSuite) {
        answers.maoCash = Math.round(maoSuite.maoCash);
        answers.maoHardMoney10 = Math.round(maoSuite.maoHardMoney10);
        answers.maoHardMoney20 = Math.round(maoSuite.maoHardMoney20);
        answers.maoBreakdown = maoSuite.fullBreakdown;
      }
      let ok = true;
      // Residential ARV is no longer a hard requirement: Chase is the primary source, but if it
      // doesn't have a value for the address, it's fine to skip ARV rather than guess -- the
      // alternative is pulling real matched comps (documented in Notes), not just leaving it blank
      // AND making something up. Commercial/business have no Chase-equivalent fallback, so ARV
      // stays required there.
      const isResidential = answers.assetType === "Residential Property (1-4 units)";
      const isPreforeclosureAuction = answers.dealCategory === "Upcoming Auction/Preforeclosure Property";
      if (!isResidential) {
        toggleError(root, "#arv-error", !answers.arv); if (!answers.arv) ok = false;
      } else {
        toggleError(root, "#arv-error", false);
      }
      if (!isPreforeclosureAuction) {
        const hasSupplementary = !!(answers.picturesLink || answers.rehabEstimate || answers.countyAssessedValue);
        if (!hasSupplementary) {
          toggleError(root, "#cash-notes-error", !answers.cashDealNotes); if (!answers.cashDealNotes) ok = false;
        } else {
          toggleError(root, "#cash-notes-error", false);
        }
      }

      if (isResidential && isPreforeclosureAuction) {
        answers.yearBuilt = root.querySelector("#year-built-input").value;
        answers.purchaseYear = root.querySelector("#purchase-year-input").value;
        answers.monthsBehindOnPayments = root.querySelector("#months-behind-input").value;
        answers.annualMaintenanceSpend = root.querySelector("#annual-maintenance-input").value;
        answers.propertyPhotosLink = root.querySelector("#property-photos-link-input").value.trim();
      }
      if (isResidential && !isPreforeclosureAuction) {
        answers.askingPrice = root.querySelector("#asking-price-input").value;
        const askingOk = !!answers.askingPrice;
        toggleError(root, "#asking-price-error", !askingOk); if (!askingOk) ok = false;

        const askingPriceNum = Number(answers.askingPrice) || 0;
        const needsRehabNow = (Number(answers.rehabEstimate) || 0) > 0;
        answers.forcedSellerFinancingOnly = false;
        if (arvNum && askingPriceNum && arvNum < askingPriceNum) {
          const gapPct = (askingPriceNum - arvNum) / askingPriceNum;
          if (!needsRehabNow && gapPct <= ARV_VS_ASKING_CLOSE_PCT) {
            // Close enough with no rehab -- pivot to seller-financing-only (cashflow requirement is
            // enforced in the income step). Only auto-flip a Cash Deal pick; leave an associate's own
            // Seller Financing pick alone, and remember we did this so it can be un-done below if the
            // numbers change back before submission.
            answers.forcedSellerFinancingOnly = true;
            if (answers.dealType === "Cash Deal") {
              answers.dealType = "Seller Financing / Creative Finance";
              answers.dealTypeAutoPivoted = true;
            }
          } else {
            const arvVsAskingBanner = root.querySelector("#arv-vs-asking-banner");
            arvVsAskingBanner.hidden = false;
            arvVsAskingBanner.className = "banner danger";
            arvVsAskingBanner.innerHTML = `<strong>This deal does not pencil.</strong> ARV needs to be at
              or above the asking price${needsRehabNow ? ", and meaningfully higher once rehab is factored in," : ""}
              for this to work as either a cash purchase or a seller financing offer. Stop here and move
              on to another opportunity -- this lead can't be submitted with these numbers.`;
            ok = false;
          }
        } else if (answers.dealTypeAutoPivoted) {
          // ARV came back above asking (or one of the numbers got cleared) -- undo the earlier
          // auto-pivot rather than leaving the lead stuck as Seller Financing for no reason.
          answers.dealType = "Cash Deal";
          answers.dealTypeAutoPivoted = false;
        }
      }
      const isCommercial = answers.assetType === "Commercial Property";
      if (isCommercial) {
        // NOI is optional either way (mirrors the "I don't know" debt field) -- occupancy status
        // is the one hard requirement, since even a rough vacant/partial/full read is needed to make
        // any sense of whatever NOI number (confirmed or estimated) ends up in the comps prompt.
        if (!answers.commercialNoiUnknown) answers.commercialNOI = root.querySelector("#noi-input").value;
        answers.noiResearchNotes = root.querySelector("#noi-research-notes-input").value.trim();
        const isMultifamilySubtype = answers.assetSubtype === "Multifamily";
        answers.commercialOccupancyStatus = answers.commercialOccupancyStatus || "";
        toggleError(root, "#occupancy-status-error", !answers.commercialOccupancyStatus);
        if (!answers.commercialOccupancyStatus) ok = false;
        if (answers.commercialOccupancyStatus === "Partially Occupied") {
          if (isMultifamilySubtype) {
            answers.commercialUnitsOccupied = root.querySelector("#occ-units-input").value;
            const unitsOccOk = answers.commercialUnitsOccupied !== "";
            toggleError(root, "#occ-units-error", !unitsOccOk); if (!unitsOccOk) ok = false;
            answers.commercialOccupancyPct = answers.units
              ? String(Math.round((Number(answers.commercialUnitsOccupied) / Number(answers.units)) * 100))
              : "";
          } else {
            answers.commercialOccupancyPct = root.querySelector("#occ-pct-input").value;
            const pctOk = answers.commercialOccupancyPct !== "";
            toggleError(root, "#occ-pct-error", !pctOk); if (!pctOk) ok = false;
          }
        } else if (answers.commercialOccupancyStatus === "Fully Occupied") {
          answers.commercialOccupancyPct = "100";
          answers.commercialUnitsOccupied = answers.units || "";
        } else if (answers.commercialOccupancyStatus === "Vacant") {
          answers.commercialOccupancyPct = "0";
          answers.commercialUnitsOccupied = "0";
        }
        // A vacant, off-market commercial property has no income AND no listing to pull condition
        // photos from -- without either one, there's nothing to base an offer on, so require real
        // pictures (or a link to them) before letting this lead through. On-market covers this via
        // the listing link instead (see the banner above), so it's exempt.
        const isOnMarket = answers.marketStatus === "On-Market";
        if (answers.commercialOccupancyStatus === "Vacant" && !isOnMarket) {
          const hasPhotos = !!((answers.propertyPhotoUrls && answers.propertyPhotoUrls.length) || answers.picturesLink);
          toggleError(root, "#commercial-photos-error", !hasPhotos);
          if (!hasPhotos) ok = false;
        }
      }
      // Feeds the Deal Status step's off-market/50%-ARV exception logic -- a full tear-down never
      // qualifies for that exception, so it has to be known before that step can gate correctly.
      if (!isLand && !isSellerFinancing && !isPreforeclosureAuction && answers.marketStatus === "On-Market") {
        toggleError(root, "#tear-down-error", !answers.isTearDown);
        if (!answers.isTearDown) ok = false;
      }
      return ok;
    }
  },
  {
    key: "debt",
    progress: true,
    // Duplicates what preforeclosureDebtCheck already asks (debt, plus arrears, PropWire guidance,
    // and the seller refusal script) in more depth for that category -- skip this generic version
    // there instead of asking about existing debt twice.
    skip() { return answers.dealCategory === "Upcoming Auction/Preforeclosure Property"; },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Existing Debt</h2>
        <p class="step-sub">What is the total debt currently on the property?</p>
        <input type="number" id="debt-input" placeholder="Total debt amount" ${answers.debtUnknown ? "disabled" : ""}>
        <div style="margin-top:10px;">
          <button type="button" class="btn ghost-small ${answers.debtUnknown ? "active" : ""}" id="unknown-debt-btn">
            I don't know
          </button>
        </div>
      `;
      root.querySelector("#debt-input").value = answers.totalDebt || "";
      root.querySelector("#unknown-debt-btn").onclick = () => {
        answers.debtUnknown = !answers.debtUnknown;
        if (answers.debtUnknown) answers.totalDebt = "";
        renderStep();
      };
    },
    validate(root) {
      if (!answers.debtUnknown) answers.totalDebt = root.querySelector("#debt-input").value;
      return true; // optional either way
    }
  },
  {
    key: "paymentStructure",
    progress: true,
    // Runs before seniorLoan now -- asking about the down-now/monthly/balloon structure first sets
    // up why the next question (letting a buyer place a new senior loan) is even being asked.
    skip() { return answers.dealType === "Cash Deal" && answers.role !== "Seller"; },
    render(root) {
      const structureScript = "Would you be open to a structure where the buyer pays some money down up "
        + "front, makes monthly payments after that, and pays off the remaining balance within an agreed "
        + "amount of time?";
      root.innerHTML = `
        <h2 class="step-title">Payment Structure</h2>
        <p class="step-sub">Would the seller accept: some down payment now, some paid monthly, and the
        remainder between the agreed purchase price and the down payment paid within a specific timeframe
        agreed by both parties? We need a yes or a no here to accept the lead.</p>
        <p class="hint">Ask them (text it or read it over the phone):
        <br><span class="small-muted">"${structureScript}"</span>
        <br><button type="button" class="btn secondary" id="structure-script-copy-btn" style="margin-top:8px;">Copy Text</button>
        </p>
        <div class="choice-group" id="structure-group">
          ${["Yes","No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="structure-error">Please choose Yes or No.</div>
        <div class="banner danger" id="structure-block-banner" ${answers.paymentStructureWilling === "No" ? "" : "hidden"}>
          We currently don't accept leads where the seller isn't willing to consider seller carry / seller
          financing (a down payment now, monthly payments, and the remainder paid over an agreed timeframe).
        </div>
      `;
      wireCopyPromptButton(root, "#structure-script-copy-btn", () => structureScript);
      root.querySelectorAll("#structure-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.paymentStructureWilling) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#structure-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.paymentStructureWilling = btn.dataset.value;
          root.querySelector("#structure-block-banner").hidden = btn.dataset.value !== "No";
          toggleError(root, "#structure-error", false);
        };
      });
    },
    validate(root) {
      const ok = !!answers.paymentStructureWilling;
      toggleError(root, "#structure-error", !ok);
      return ok && answers.paymentStructureWilling === "Yes";
    }
  },
  {
    key: "seniorLoan",
    progress: true,
    // A Seller filling this out about their own property sees this regardless of Deal Type -- we
    // want the seller-financing question set from them either way, not just when they happened to
    // pick that option (admin decides the actual structure, not the seller's initial guess).
    skip() { return answers.dealType === "Cash Deal" && answers.role !== "Seller"; },
    render(root) {
      const seniorLoanScript = "Would you be open to us bringing in outside financing that would sit in "
        + "first position on the property, with your seller financing behind it in second position?";
      root.innerHTML = `
        <h2 class="step-title">New Senior Financing</h2>
        <p class="step-sub">Would the seller be willing to let a buyer place a new senior (1st position)
        mortgage on the property? We need a yes or a no here to accept the lead.</p>
        <p class="hint">Ask them (text it or read it over the phone):
        <br><span class="small-muted">"${seniorLoanScript}"</span>
        <br><button type="button" class="btn secondary" id="senior-script-copy-btn" style="margin-top:8px;">Copy Text</button>
        </p>
        <div class="choice-group" id="senior-group">
          ${["Yes","No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="senior-error">Please choose Yes or No.</div>
        <div class="banner danger" id="senior-block-banner" ${answers.seniorLoanWilling === "No" ? "" : "hidden"}>
          We currently do not accept leads where the seller isn't willing to allow a buyer to take out a new
          senior (1st position) mortgage on the property.
        </div>
      `;
      wireCopyPromptButton(root, "#senior-script-copy-btn", () => seniorLoanScript);
      root.querySelectorAll("#senior-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.seniorLoanWilling) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#senior-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.seniorLoanWilling = btn.dataset.value;
          root.querySelector("#senior-block-banner").hidden = btn.dataset.value !== "No";
          toggleError(root, "#senior-error", false);
        };
      });
    },
    validate(root) {
      const ok = !!answers.seniorLoanWilling;
      toggleError(root, "#senior-error", !ok);
      return ok && answers.seniorLoanWilling === "Yes";
    }
  },
  {
    key: "downPayment",
    skip() { return answers.dealType === "Cash Deal" && answers.role !== "Seller"; },
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Down Payment</h2>
        <p class="step-sub">What does the seller intend to do with the down payment from this
        transaction, and roughly how much are they looking for? It's okay to skip this if they'd
        rather not say.</p>

        <label class="field-label">What will they use it for? <span class="small-muted">(optional)</span></label>
        <textarea id="dp-intent-input" placeholder="e.g. pay off their mortgage, move into a new place, medical bills..." ${answers.dpSkipped ? "disabled" : ""}></textarea>

        <label class="field-label" style="margin-top:16px;">Approximate dollar amount <span class="small-muted">(optional)</span></label>
        <input type="number" id="dp-input" placeholder="Down payment amount" ${answers.dpSkipped ? "disabled" : ""}>
        <div style="margin-top:10px;">
          <button type="button" class="btn ghost-small ${answers.dpSkipped ? "active" : ""}" id="skip-dp-btn">Skip / seller prefers not to answer</button>
        </div>
        <div id="nonneg-wrap"></div>
      `;
      root.querySelector("#dp-intent-input").value = answers.downPaymentIntent || "";
      root.querySelector("#dp-input").value = answers.downPaymentNeeded || "";
      const nonnegWrap = root.querySelector("#nonneg-wrap");
      function renderNonNeg() {
        if (!answers.dpSkipped && answers.downPaymentNeeded) {
          nonnegWrap.innerHTML = `
            <label class="field-label">Is the seller willing to accept less down if we're unable to give them their requested down? <span class="req">*</span></label>
            <div class="choice-group" id="nonneg-group">
              ${["Yes","No","Not Sure"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
            </div>
            <div class="error-text" id="nonneg-error">Please choose one.</div>
          `;
          bindChoiceGroup(root, "#nonneg-group", "downPaymentNonNegotiable");
        } else {
          nonnegWrap.innerHTML = "";
        }
      }
      renderNonNeg();
      root.querySelector("#dp-intent-input").oninput = (e) => {
        answers.downPaymentIntent = e.target.value;
      };
      root.querySelector("#dp-input").oninput = (e) => {
        answers.downPaymentNeeded = e.target.value;
        renderNonNeg();
      };
      root.querySelector("#skip-dp-btn").onclick = () => {
        answers.dpSkipped = !answers.dpSkipped;
        if (answers.dpSkipped) { answers.downPaymentNeeded = ""; answers.downPaymentNonNegotiable = ""; answers.downPaymentIntent = ""; }
        renderStep();
      };
    },
    validate(root) {
      if (answers.dpSkipped) return true;
      answers.downPaymentIntent = root.querySelector("#dp-intent-input").value.trim();
      answers.downPaymentNeeded = root.querySelector("#dp-input").value;
      if (!answers.downPaymentNeeded) return true; // treated as skipped
      const ok = !!answers.downPaymentNonNegotiable;
      toggleError(root, "#nonneg-error", !ok);
      return ok;
    }
  },
  {
    key: "income",
    progress: true,
    // Commercial NOI (plus occupancy) is now collected earlier in cashDealDetails -- for every
    // dealType, not just Seller Financing -- so Commercial no longer needs its own pass through
    // this step; it would just be asking the same question twice.
    skip() { return (answers.dealType === "Cash Deal" && answers.role !== "Seller") || answers.assetType === "Commercial Property"; },
    render(root) {
      const disclaimer = `
        <div class="banner warn">
          This information is required to move forward. If you're unable to find or confirm it for a given
          property or business, please continue searching for other opportunities that do have this
          information readily accessible — we're not able to evaluate deals without it.
        </div>
      `;
      const incomeAddressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
      const taxesInsurancePrompt = `what are the estimated annual property taxes and homeowners insurance for this property: ${incomeAddressLine}? Give a single best estimate for each, not just a range.`;
      const incomeGoogleAiHow = `go to <strong>google.com</strong> and search anything (typing "ai" works fine, or just the
        address) — once results load, look at the row of tabs near the top of the page (next to "All", "Images",
        "News", "Shopping") and click <strong>"AI Mode"</strong>`;
      if (answers.assetType === "Residential Property (1-4 units)") {
        // Only offered on the not-rent-ready Seller Financing path (see rentReadyCheck) -- if admin's
        // eventual buyer plans to resell rather than hold this as a rental, income/NOI research is
        // wasted effort. Ask admin if unsure whether the buyer intends to keep or sell.
        const showsSellSkip = answers.propertyRentReady === "No";
        if (showsSellSkip && answers.buyerIntendsToSell) {
          root.innerHTML = `
            <h2 class="step-title">Property Income (NOI)</h2>
            <div style="margin-bottom:16px;">
              <button type="button" class="btn ghost-small active" id="buyer-sells-btn">Admin's buyer intends to sell property (ask admin if unsure)</button>
            </div>
            <div class="banner info">Skipping income/NOI details since admin's buyer intends to sell this property.</div>
          `;
          root.querySelector("#buyer-sells-btn").onclick = () => {
            answers.buyerIntendsToSell = false;
            renderStep();
          };
          return;
        }
        root.innerHTML = `
          <h2 class="step-title">Property Income (NOI)</h2>
          ${answers.forcedSellerFinancingOnly ? `
            <div class="banner danger">ARV came in too close to asking price with no rehab needed, so
            this can only move forward as a seller financing offer if it actually cash flows as a long
            term or short term rental. If the NOI below isn't positive, stop here and move on to another
            opportunity -- this lead won't be submittable otherwise.</div>
            <div class="error-text" id="cashflow-required-error">This deal needs a positive NOI (long term
            or short term rental) to move forward -- it can't work as a cash purchase with these numbers.</div>
          ` : ""}
          ${showsSellSkip ? `
            <div style="margin-bottom:16px;">
              <button type="button" class="btn ghost-small" id="buyer-sells-btn">Admin's buyer intends to sell property (ask admin if unsure)</button>
              <p class="hint" style="margin-top:8px;">If admin's buyer for this deal plans to resell rather
              than hold it as a rental, tap this to skip the income/NOI questions below. If they intend to
              keep and rent it out, leave this off and fill out the section as normal.</p>
            </div>
          ` : ""}
          ${disclaimer}
          <label class="field-label">Is the property currently occupied by a paying tenant? <span class="req">*</span></label>
          <div class="choice-group" id="occupied-group">
            ${["Occupied (has a landlord/tenant)", "Vacant (no tenant)"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
          </div>
          <div class="error-text" id="occupied-error">Please choose one.</div>
          <div id="income-sub"></div>
        `;
        if (showsSellSkip) {
          root.querySelector("#buyer-sells-btn").onclick = () => {
            answers.buyerIntendsToSell = true;
            renderStep();
          };
        }
        const sub = root.querySelector("#income-sub");
        const renderIncomeSub = () => {
          if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
            const occUnits = Number(answers.units) || 1;
            const occIsMultiUniform = occUnits >= 2 && occUnits <= 4 && answers.unitsUniform === "Yes";
            sub.innerHTML = `
              <label class="field-label">Annual NOI <span class="req">*</span></label>
              <input type="number" id="noi-input" placeholder="$">
              <div class="error-text" id="noi-error">Required.</div>

              <label class="field-label" style="margin-top:16px;">Annual Property Taxes</label>
              <input type="number" id="occ-taxes-input" placeholder="$">
              <label class="field-label">Annual Insurance</label>
              <input type="number" id="occ-insurance-input" placeholder="$">
              <p class="hint">Don't have this from the seller? ${incomeGoogleAiHow}, then ask:
              <br><span class="small-muted">"${taxesInsurancePrompt}"</span>
              <br><button type="button" class="btn secondary" id="occ-taxes-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
              </p>

              <label class="field-label" style="margin-top:16px;">Does the seller have 12 months of rent rolls for this property? <span class="req">*</span></label>
              <div class="choice-group" id="rent-rolls-group">
                ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
              </div>
              <div class="error-text" id="rent-rolls-error">Please choose one.</div>
              <div id="pl-sub"></div>

              <label class="field-label" style="margin-top:16px;">Can the property be delivered vacant upon sale? <span class="req">*</span></label>
              <div class="choice-group" id="deliverable-vacant-group">
                ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
              </div>
              <div class="error-text" id="deliverable-vacant-error">Please choose one.</div>

              <label class="field-label">Current tenant lease term <span class="small-muted">(e.g. month-to-month, or a 1-year lease just renewed)</span> <span class="req">*</span></label>
              <input type="text" id="lease-term-input" placeholder="e.g. Month-to-month">
              <div class="error-text" id="lease-term-error">Required.</div>

              ${occUnits === 1 ? `
                <label class="field-label" style="margin-top:16px;">When does this tenant's lease end? <span class="small-muted">(a specific date, or "month-to-month" if there's no fixed end)</span> <span class="req">*</span></label>
                <input type="text" id="lease-end-input" placeholder="e.g. 6/30/2026, or month-to-month">
                <div class="error-text" id="lease-end-error">Required.</div>

                <label class="field-label">Would the tenant be willing to move out earlier if needed? <span class="req">*</span></label>
                <div class="choice-group" id="tenant-move-early-group">
                  ${["Yes", "No", "Not Sure"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
                </div>
                <div class="error-text" id="tenant-move-early-error">Please choose one.</div>
              ` : `
                <label class="field-label" style="margin-top:16px;">STR NOI Per Unit <span class="small-muted">(optional — for proforma awareness; with ${occUnits} units we wouldn't ask any tenant to leave at closing, so LTR NOI above is still the basis -- this is just what one unit could net under short-term rental once its lease naturally ends)</span></label>
                <input type="number" id="str-noi-per-unit-input" placeholder="$">
              `}

              <div id="str-comparison-sub"></div>
            `;
            sub.querySelector("#noi-input").value = answers.residentialNOI || "";
            sub.querySelector("#occ-taxes-input").value = answers.annualPropertyTaxes || "";
            sub.querySelector("#occ-insurance-input").value = answers.annualInsurance || "";
            wireCopyPromptButton(sub, "#occ-taxes-prompt-copy-btn", () => taxesInsurancePrompt);
            if (occUnits === 1) {
              sub.querySelector("#lease-end-input").value = answers.leaseEndDate || "";
              sub.querySelectorAll("#tenant-move-early-group .choice-btn").forEach(btn => {
                if (btn.dataset.value === answers.tenantWouldMoveEarly) btn.classList.add("selected");
                btn.onclick = () => {
                  sub.querySelectorAll("#tenant-move-early-group .choice-btn").forEach(b => b.classList.remove("selected"));
                  btn.classList.add("selected");
                  answers.tenantWouldMoveEarly = btn.dataset.value;
                  toggleError(sub, "#tenant-move-early-error", false);
                };
              });
            } else {
              sub.querySelector("#str-noi-per-unit-input").value = answers.strNoiPerUnit || "";
            }
            sub.querySelector("#lease-term-input").value = answers.currentLeaseTerm || "";
            wireMoneyEchoesIn(sub);

            const plSub = sub.querySelector("#pl-sub");
            const renderPlSub = () => {
              if (answers.hasRentRolls === "Yes") {
                plSub.innerHTML = `
                  <label class="field-label">Does the seller also have a profit &amp; loss statement for the last 12 months? <span class="req">*</span></label>
                  <div class="choice-group" id="has-pl-group">
                    ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
                  </div>
                  <div class="error-text" id="has-pl-error">Please choose one.</div>
                `;
                plSub.querySelectorAll("#has-pl-group .choice-btn").forEach(btn => {
                  if (btn.dataset.value === answers.hasProfitLoss) btn.classList.add("selected");
                  btn.onclick = () => {
                    plSub.querySelectorAll("#has-pl-group .choice-btn").forEach(b => b.classList.remove("selected"));
                    btn.classList.add("selected");
                    answers.hasProfitLoss = btn.dataset.value;
                    toggleError(plSub, "#has-pl-error", false);
                  };
                });
              } else {
                plSub.innerHTML = "";
                answers.hasProfitLoss = "";
              }
            };
            renderPlSub();
            sub.querySelectorAll("#rent-rolls-group .choice-btn").forEach(btn => {
              if (btn.dataset.value === answers.hasRentRolls) btn.classList.add("selected");
              btn.onclick = () => {
                sub.querySelectorAll("#rent-rolls-group .choice-btn").forEach(b => b.classList.remove("selected"));
                btn.classList.add("selected");
                answers.hasRentRolls = btn.dataset.value;
                toggleError(sub, "#rent-rolls-error", false);
                renderPlSub();
              };
            });

            // Only relevant if the property could actually transition to a different rental
            // strategy soon -- if a long lease was just renewed, this comparison isn't useful,
            // so skip it entirely rather than asking for vacancy-style info that won't apply.
            const strSub = sub.querySelector("#str-comparison-sub");
            const renderStrSub = () => {
              if (answers.deliverableVacant === "Yes") {
                const strHint = occIsMultiUniform
                  ? `Since all ${occUnits} units are identical, search <strong>airdna.co</strong> for a comp
                     matching <strong>ONE</strong> unit (a ${answers.beds || "?"} bed / ${answers.baths || "?"}
                     bath single family/condo), and enter that <strong>one unit's</strong> projected annual
                     revenue below — we'll multiply it by ${occUnits} units automatically for the property total.`
                  : `Look up this property's projected annual short-term rental revenue on <strong>airdna.co</strong>
                     by entering the address${occUnits > 1 ? " (enter the TOTAL for all units combined)" : ""}.`;
                const strLabel = occIsMultiUniform
                  ? "Projected Annual STR Revenue PER UNIT (airdna.co)"
                  : "Projected Annual STR Revenue (airdna.co)";
                strSub.innerHTML = `
                  <h3 class="step-title" style="font-size:18px; margin-top:24px;">Short-Term Rental Comparison
                    <span class="small-muted">(optional, but encouraged — speeds up admin's evaluation of the deal;
                    uses the Annual Property Taxes/Insurance entered above)</span></h3>
                  <p class="hint">${strHint}</p>
                  <a href="https://www.airdna.co/" target="_blank" rel="noopener" class="link-btn">Open airdna.co &rarr;</a>
                  <label class="field-label">${strLabel} <span class="small-muted">(optional)</span></label>
                  <input type="number" id="occ-str-revenue-input" placeholder="$">
                  <div class="banner info" id="computed-occ-str-noi-banner" hidden></div>
                `;
                strSub.querySelector("#occ-str-revenue-input").value = occIsMultiUniform && answers.strAnnualRevenue
                  ? (Number(answers.strAnnualRevenue) / occUnits)
                  : (answers.strAnnualRevenue || "");
                wireMoneyEchoesIn(strSub);
                const recomputeOccStr = () => {
                  const taxes = Number(sub.querySelector("#occ-taxes-input").value) || 0;
                  const insurance = Number(sub.querySelector("#occ-insurance-input").value) || 0;
                  const strRevenueEntered = Number(strSub.querySelector("#occ-str-revenue-input").value) || 0;
                  const banner = strSub.querySelector("#computed-occ-str-noi-banner");
                  if (!strRevenueEntered) {
                    banner.hidden = true;
                    answers.strAnnualRevenue = ""; answers.strNOI = "";
                    return;
                  }
                  const strRevenue = occIsMultiUniform ? strRevenueEntered * occUnits : strRevenueEntered;
                  const strGrossBeforeExpenses = strRevenue - taxes - insurance;
                  const strOtherExpenses = strRevenue * (STR_EXPENSE_RATIO / 100);
                  const strNOI = strGrossBeforeExpenses - strOtherExpenses;
                  banner.hidden = false;
                  banner.innerHTML = `
                    ${occIsMultiUniform ? `<div><strong>Total STR Revenue (${occUnits} units &times; $${strRevenueEntered.toLocaleString(undefined, {maximumFractionDigits: 0})}/unit):</strong> $${strRevenue.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>` : ""}
                    <div${occIsMultiUniform ? ' style="margin-top:6px;"' : ""}><strong>Gross STR Revenue Potential:</strong> $${strGrossBeforeExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>
                    <div style="margin-top:6px;"><strong>Likely Net Cashflow Per Year (STR):</strong> $${strNOI.toLocaleString(undefined, {maximumFractionDigits: 0})}
                      <span class="small-muted">(minus taxes, insurance, and a preset ${STR_EXPENSE_RATIO}% expense ratio)</span></div>
                    <div style="margin-top:6px;"><strong>Current Actual NOI (from rent rolls/P&amp;L):</strong> $${Number(answers.residentialNOI || 0).toLocaleString(undefined, {maximumFractionDigits: 0})}</div>
                  `;
                  answers.strAnnualRevenue = strRevenue;
                  answers.strNOI = strNOI;
                };
                strSub.querySelector("#occ-str-revenue-input").oninput = recomputeOccStr;
                sub.querySelector("#occ-taxes-input").oninput = recomputeOccStr;
                sub.querySelector("#occ-insurance-input").oninput = recomputeOccStr;
                recomputeOccStr();
              } else {
                strSub.innerHTML = "";
                answers.strAnnualRevenue = ""; answers.strNOI = "";
              }
            };
            renderStrSub();
            sub.querySelectorAll("#deliverable-vacant-group .choice-btn").forEach(btn => {
              if (btn.dataset.value === answers.deliverableVacant) btn.classList.add("selected");
              btn.onclick = () => {
                sub.querySelectorAll("#deliverable-vacant-group .choice-btn").forEach(b => b.classList.remove("selected"));
                btn.classList.add("selected");
                answers.deliverableVacant = btn.dataset.value;
                toggleError(sub, "#deliverable-vacant-error", false);
                renderStrSub();
              };
            });
          } else if (answers.residentialOccupied === "Vacant (no tenant)") {
            const units = Number(answers.units) || 1;
            const isMultiUniform = units >= 2 && units <= 4 && answers.unitsUniform === "Yes";
            const taxesInsuranceDesc = units > 1
              ? `the full ${units}-unit property (not a single unit)`
              : `a ${answers.beds || "?"} bed / ${answers.baths || "?"} bath home`;
            const strHint = isMultiUniform
              ? `Since all ${units} units are identical, search <strong>airdna.co</strong> for a comp matching
                 <strong>ONE</strong> unit (a ${answers.beds || "?"} bed / ${answers.baths || "?"} bath single
                 family/condo), and enter that <strong>one unit's</strong> projected annual revenue below — we'll
                 multiply it by ${units} units automatically for the property total.`
              : `Look up this property's projected annual short-term rental revenue on <strong>airdna.co</strong>
                 by entering the address${units > 1 ? " (enter the TOTAL for all units combined)" : ""}.`;
            const strLabel = isMultiUniform
              ? "Projected Annual STR Revenue PER UNIT (airdna.co)"
              : "Projected Annual STR Revenue (airdna.co)";
            sub.innerHTML = `
              <p class="hint">Look up annual property taxes and insurance for ${taxesInsuranceDesc} in
              ${answers.city || "this city"}${answers.state ? ", " + answers.state : ""}
              (search Google, or check the county assessor and an insurance quote, and use the
              middle of any range you find), and enter them below — these apply to both rental
              strategies below. Or ${incomeGoogleAiHow}, then ask:
              <br><span class="small-muted">"${taxesInsurancePrompt}"</span>
              <br><button type="button" class="btn secondary" id="vacant-taxes-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
              </p>
              <label class="field-label">Annual Property Taxes <span class="req">*</span></label>
              <input type="number" id="taxes-input" placeholder="$">
              <div class="error-text" id="taxes-error">Required.</div>
              <label class="field-label">Annual Insurance <span class="req">*</span></label>
              <input type="number" id="insurance-input" placeholder="$">
              <div class="error-text" id="insurance-error">Required.</div>

              <h3 class="step-title" style="font-size:18px; margin-top:24px;">Long-Term Rental</h3>
              <p class="hint">Look up the estimated monthly rental value on <strong>rentcast.io</strong> for this property.</p>
              <a href="https://www.rentcast.io/" target="_blank" rel="noopener" class="link-btn">Open rentcast.io &rarr;</a>
              <label class="field-label">Estimated Monthly Rent (rentcast.io) <span class="req">*</span></label>
              <input type="number" id="rent-input" placeholder="$">
              <div class="error-text" id="rent-error">Required.</div>
              ${units === 1 ? `
                <p class="hint">Since this is a single-family property, maintenance is estimated at
                <strong>1.1% of the $${Number(answers.priceSought || 0).toLocaleString()} purchase price</strong>
                (most DSCR lenders underwrite with maintenance included this way) — no separate expense ratio
                needed. The comparison below shows the figure with and without that maintenance estimate.</p>
              ` : `
                <label class="field-label">Expense Ratio % <span class="small-muted">(other operating expenses — maintenance, vacancy, management, capex — as a % of gross rent)</span> <span class="req">*</span></label>
                <input type="number" id="expense-ratio-input" placeholder="e.g. 35" min="0" max="100">
                <div class="error-text" id="expense-ratio-error">Required.</div>
              `}
              <div class="banner info" id="computed-ltr-noi-banner"></div>

              <h3 class="step-title" style="font-size:18px; margin-top:24px;">Short-Term Rental (STR)</h3>
              <p class="hint">${strHint}</p>
              <a href="https://www.airdna.co/" target="_blank" rel="noopener" class="link-btn">Open airdna.co &rarr;</a>
              <label class="field-label">${strLabel} <span class="req">*</span></label>
              <input type="number" id="str-revenue-input" placeholder="$">
              <div class="error-text" id="str-revenue-error">Required.</div>
              <div class="banner info" id="computed-str-noi-banner"></div>
            `;
            sub.querySelector("#taxes-input").value = answers.annualPropertyTaxes || "";
            sub.querySelector("#insurance-input").value = answers.annualInsurance || "";
            wireCopyPromptButton(sub, "#vacant-taxes-prompt-copy-btn", () => taxesInsurancePrompt);
            sub.querySelector("#rent-input").value = answers.rentcastMonthlyRent || "";
            if (units !== 1) {
              sub.querySelector("#expense-ratio-input").value = typeof answers.expenseRatio === "number" || /^\d+$/.test(answers.expenseRatio || "") ? answers.expenseRatio : "";
            }
            sub.querySelector("#str-revenue-input").value = isMultiUniform && answers.strAnnualRevenue
              ? (Number(answers.strAnnualRevenue) / units)
              : (answers.strAnnualRevenue || "");
            wireMoneyEchoesIn(sub);
            const recompute = () => {
              const taxes = Number(sub.querySelector("#taxes-input").value) || 0;
              const insurance = Number(sub.querySelector("#insurance-input").value) || 0;
              const rent = Number(sub.querySelector("#rent-input").value) || 0;
              const strRevenueEntered = Number(sub.querySelector("#str-revenue-input").value) || 0;
              const strRevenue = isMultiUniform ? strRevenueEntered * units : strRevenueEntered;

              const grossAnnualRent = rent * 12;
              const ltrGrossBeforeExpenses = grossAnnualRent - taxes - insurance;
              let ltrOtherExpenses, expenseRatio;
              if (units === 1) {
                ltrOtherExpenses = Number(answers.priceSought || 0) * 0.011;
                expenseRatio = "1.1% of price";
              } else {
                expenseRatio = Number(sub.querySelector("#expense-ratio-input").value) || 0;
                ltrOtherExpenses = grossAnnualRent * (expenseRatio / 100);
              }
              const ltrNOI = ltrGrossBeforeExpenses - ltrOtherExpenses;
              sub.querySelector("#computed-ltr-noi-banner").innerHTML = `
                <div><strong>Without Maintenance (Gross Rental Income Potential):</strong> $${ltrGrossBeforeExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">(monthly rent &times; 12, minus taxes and insurance only — no maintenance applied)</span></div>
                <div style="margin-top:6px;"><strong>With Maintenance (Likely Net Cashflow Per Year):</strong> $${ltrNOI.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">${units === 1
                    ? `(same as above, minus 1.1% of the $${Number(answers.priceSought || 0).toLocaleString()} purchase price: $${ltrOtherExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})})`
                    : `(same as above, minus the ${expenseRatio}% expense ratio)`}</span></div>
              `;

              const strGrossBeforeExpenses = strRevenue - taxes - insurance;
              const strOtherExpenses = strRevenue * (STR_EXPENSE_RATIO / 100);
              const strNOI = strGrossBeforeExpenses - strOtherExpenses;
              sub.querySelector("#computed-str-noi-banner").innerHTML = `
                ${isMultiUniform ? `<div><strong>Total STR Revenue (${units} units &times; $${strRevenueEntered.toLocaleString(undefined, {maximumFractionDigits: 0})}/unit):</strong> $${strRevenue.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>` : ""}
                <div${isMultiUniform ? ' style="margin-top:6px;"' : ""}><strong>Gross STR Revenue Potential:</strong> $${strGrossBeforeExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">(annual revenue minus taxes and insurance only — no expense ratio applied)</span></div>
                <div style="margin-top:6px;"><strong>Likely Net Cashflow Per Year:</strong> $${strNOI.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">(same as above, minus a preset ${STR_EXPENSE_RATIO}% expense ratio)</span></div>
              `;

              answers.annualPropertyTaxes = taxes;
              answers.annualInsurance = insurance;
              answers.rentcastMonthlyRent = rent;
              answers.expenseRatio = expenseRatio;
              answers.residentialNOI = ltrNOI;
              answers.strAnnualRevenue = strRevenue;
              answers.strNOI = strNOI;
            };
            ["#taxes-input", "#insurance-input", "#rent-input", "#str-revenue-input"].concat(units !== 1 ? ["#expense-ratio-input"] : []).forEach(sel => {
              sub.querySelector(sel).oninput = recompute;
            });
            recompute();
          } else {
            sub.innerHTML = "";
          }
        };
        renderIncomeSub();
        root.querySelectorAll("#occupied-group .choice-btn").forEach(btn => {
          if (btn.dataset.value === answers.residentialOccupied) btn.classList.add("selected");
          btn.onclick = () => {
            root.querySelectorAll("#occupied-group .choice-btn").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            answers.residentialOccupied = btn.dataset.value;
            toggleError(root, "#occupied-error", false);
            renderIncomeSub();
          };
        });
      } else if (answers.assetType === "Business") {
        root.innerHTML = `
          <h2 class="step-title">Business Earnings</h2>
          ${disclaimer}
          <label class="field-label">Approximate Annual Revenue <span class="req">*</span></label>
          <input type="number" id="revenue-input" placeholder="$">
          <div class="error-text" id="revenue-error">Required.</div>
          <label class="field-label" id="earnings-label">Approximate Annual Earnings <span class="req">*</span></label>
          <input type="number" id="earnings-input" placeholder="$">
          <div class="hint" id="earnings-hint"></div>
          <div class="error-text" id="earnings-error">Required.</div>
        `;
        const revenueInput = root.querySelector("#revenue-input");
        const earningsInput = root.querySelector("#earnings-input");
        revenueInput.value = answers.businessRevenue || "";
        earningsInput.value = answers.businessEarnings || "";
        const updateEarningsLabel = () => {
          const revenue = Number(revenueInput.value) || 0;
          const earnings = Number(earningsInput.value) || 0;
          const useEbitda = revenue > 5000000 || earnings > 1000000;
          answers.businessEarningsType = useEbitda ? "EBITDA" : "SDE";
          root.querySelector("#earnings-label").innerHTML = `Approximate Annual ${answers.businessEarningsType} <span class="req">*</span>`;
          root.querySelector("#earnings-hint").textContent = useEbitda
            ? "Based on this size, please provide EBITDA."
            : "Based on this size, please provide SDE (Seller's Discretionary Earnings).";
        };
        revenueInput.oninput = updateEarningsLabel;
        earningsInput.oninput = updateEarningsLabel;
        updateEarningsLabel();
      } else {
        root.innerHTML = `<p class="step-sub">Please go back and select an asset type first.</p>`;
      }
    },
    validate(root) {
      if (answers.assetType === "Residential Property (1-4 units)") {
        if (answers.propertyRentReady === "No" && answers.buyerIntendsToSell) return true;
        const ok1 = !!answers.residentialOccupied;
        toggleError(root, "#occupied-error", !ok1);
        if (!ok1) return false;

        // forcedSellerFinancingOnly (set in cashDealDetails when ARV lands too close to asking with
        // no rehab needed) means this deal only works if it actually cash flows as a rental -- checked
        // once this step's own required fields are satisfied, regardless of which occupied/vacant
        // sub-path produced the NOI numbers.
        const cashflowGateOk = () => {
          if (!answers.forcedSellerFinancingOnly) return true;
          const okCashflow = (Number(answers.residentialNOI) || 0) > 0 || (Number(answers.strNOI) || 0) > 0;
          toggleError(root, "#cashflow-required-error", !okCashflow);
          return okCashflow;
        };

        if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
          const occUnits = Number(answers.units) || 1;
          answers.residentialNOI = root.querySelector("#noi-input").value;
          answers.annualPropertyTaxes = root.querySelector("#occ-taxes-input").value;
          answers.annualInsurance = root.querySelector("#occ-insurance-input").value;
          answers.currentLeaseTerm = root.querySelector("#lease-term-input").value.trim();
          let okOcc = true;
          toggleError(root, "#noi-error", !answers.residentialNOI); if (!answers.residentialNOI) okOcc = false;
          toggleError(root, "#rent-rolls-error", !answers.hasRentRolls); if (!answers.hasRentRolls) okOcc = false;
          if (answers.hasRentRolls === "Yes") {
            toggleError(root, "#has-pl-error", !answers.hasProfitLoss); if (!answers.hasProfitLoss) okOcc = false;
          }
          toggleError(root, "#deliverable-vacant-error", !answers.deliverableVacant); if (!answers.deliverableVacant) okOcc = false;
          toggleError(root, "#lease-term-error", !answers.currentLeaseTerm); if (!answers.currentLeaseTerm) okOcc = false;
          if (occUnits === 1) {
            answers.leaseEndDate = root.querySelector("#lease-end-input").value.trim();
            toggleError(root, "#lease-end-error", !answers.leaseEndDate); if (!answers.leaseEndDate) okOcc = false;
            toggleError(root, "#tenant-move-early-error", !answers.tenantWouldMoveEarly); if (!answers.tenantWouldMoveEarly) okOcc = false;
          } else {
            answers.strNoiPerUnit = root.querySelector("#str-noi-per-unit-input").value;
          }
          const okCashflow = cashflowGateOk();
          return okOcc && okCashflow;
        }
        // Vacant (no tenant) -- always computes both LTR and STR so admin can compare
        const vacantUnits = Number(answers.units) || 1;
        const vacantIsMultiUniform = vacantUnits >= 2 && vacantUnits <= 4 && answers.unitsUniform === "Yes";
        answers.annualPropertyTaxes = root.querySelector("#taxes-input").value;
        answers.annualInsurance = root.querySelector("#insurance-input").value;
        answers.rentcastMonthlyRent = root.querySelector("#rent-input").value;
        // For single-family (units===1), expenseRatio/residentialNOI are already kept current
        // by recompute() (1.1%-of-price formula, no manual input to re-read here). Multi-unit
        // still has a manual Expense Ratio % input to validate.
        let ok = true;
        if (vacantUnits !== 1) {
          answers.expenseRatio = root.querySelector("#expense-ratio-input").value;
          toggleError(root, "#expense-ratio-error", !answers.expenseRatio); if (!answers.expenseRatio) ok = false;
        }
        const strRevenueEntered = root.querySelector("#str-revenue-input").value;
        // The input holds a PER-UNIT figure when units are uniform -- always store the
        // multiplied TOTAL in answers.strAnnualRevenue, matching what recompute() already
        // keeps in sync on every keystroke (redone here explicitly rather than relying on
        // that timing, since this is also what actually gets submitted).
        answers.strAnnualRevenue = vacantIsMultiUniform && strRevenueEntered
          ? Number(strRevenueEntered) * vacantUnits
          : strRevenueEntered;
        toggleError(root, "#taxes-error", !answers.annualPropertyTaxes); if (!answers.annualPropertyTaxes) ok = false;
        toggleError(root, "#insurance-error", !answers.annualInsurance); if (!answers.annualInsurance) ok = false;
        toggleError(root, "#rent-error", !answers.rentcastMonthlyRent); if (!answers.rentcastMonthlyRent) ok = false;
        toggleError(root, "#str-revenue-error", !strRevenueEntered); if (!strRevenueEntered) ok = false;
        const okCashflow = cashflowGateOk();
        return ok && okCashflow;
      } else if (answers.assetType === "Business") {
        answers.businessRevenue = root.querySelector("#revenue-input").value;
        answers.businessEarnings = root.querySelector("#earnings-input").value;
        let ok = true;
        toggleError(root, "#revenue-error", !answers.businessRevenue); if (!answers.businessRevenue) ok = false;
        toggleError(root, "#earnings-error", !answers.businessEarnings); if (!answers.businessEarnings) ok = false;
        return ok;
      }
      return true;
    }
  },
  {
    key: "preforeclosureDebtCheck",
    progress: true,
    // Preforeclosure/auction deals are cash-only -- no seller-financing pitch at all (see dealType's
    // comment). If the existing debt is at or above what we could pay in cash under any buyer
    // profile, there's no equity to work with, so a cash purchase is off the table entirely: the
    // associate stops short of naming a price and instead gathers what admin needs to structure a
    // subject-to offer directly with the seller (payoff statement, loan terms, notes).
    skip() { return answers.dealCategory !== "Upcoming Auction/Preforeclosure Property"; },
    render(root) {
      const refusalScript = "I want to ensure you get a fair offer and we don't waste time. If the "
        + "offer is below existing debt, we wasted a day or longer and we don't have much time to "
        + "prevent you from getting nothing if you do nothing.";
      const sellerName = answers.sellerContactName || "[Name]";
      const addressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
      const maoCandidates = [answers.maoCash, answers.maoHardMoney10, answers.maoHardMoney20]
        .map(Number).filter(n => n > 0);
      const cashOfferAmt = maoCandidates.length ? Math.round(Math.min(...maoCandidates)) : 0;
      const highestMao = maoCandidates.length ? Math.round(Math.max(...maoCandidates)) : 0;
      const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

      root.innerHTML = `
        <h2 class="step-title">Existing Debt &amp; Arrears</h2>
        <p class="step-sub">Look up the existing loan payoff for this property on
        <a href="https://propwire.com/" target="_blank" rel="noopener">PropWire</a>.</p>
        <label class="field-label">Existing Debt / Payoff Amount <span class="req">*</span></label>
        <input type="number" id="preforeclosure-debt-input" placeholder="$">
        <div class="error-text" id="preforeclosure-debt-error">Required.</div>
        <p class="hint">If PropWire doesn't show this, ask the seller directly. If they're hesitant to
        share it, use this:
        <br><span class="small-muted">"${refusalScript}"</span>
        <br><button type="button" class="btn secondary" id="refusal-script-copy-btn" style="margin-top:8px;">Copy Text</button>
        </p>

        <label class="field-label" style="margin-top:16px;">How far behind on payments (arrears) are they? <span class="req">*</span></label>
        <input type="number" id="arrears-input" placeholder="$">
        <p class="hint">Needed to know whether a subject-to structure is even workable here.</p>
        <div class="error-text" id="arrears-error">Required.</div>

        <div class="banner warn" id="equity-banner" style="margin-top:16px; display:none;"></div>
        <div id="equity-branch-content"></div>
      `;
      root.querySelector("#preforeclosure-debt-input").value = answers.preforeclosureDebt || "";
      root.querySelector("#arrears-input").value = answers.arrearsAmount || "";
      wireCopyPromptButton(root, "#refusal-script-copy-btn", () => refusalScript);

      const equityBanner = root.querySelector("#equity-banner");
      const branchContent = root.querySelector("#equity-branch-content");

      const renderBranch = () => {
        const debt = Number(root.querySelector("#preforeclosure-debt-input").value) || 0;
        if (!debt || !highestMao) {
          equityBanner.style.display = "none";
          branchContent.innerHTML = "";
          return;
        }
        equityBanner.style.display = "";
        const hasEquity = debt < highestMao;
        if (hasEquity) {
          equityBanner.className = "banner info";
          equityBanner.innerHTML = `<strong>This one has room to work as a cash deal.</strong> The
            existing debt is below what we could pay under any buyer profile.`;
          const offerScript = cashOfferAmt
            ? `Hi ${sellerName}, saw ${addressLine} is coming up for auction soon. Would you be open `
              + `to $${cashOfferAmt.toLocaleString()} cash to purchase outright? We can close before `
              + `the property goes to auction.`
            : "";
          const rentCheckScript = "Will you be able to rent somewhere else with this money and be "
            + "okay? I just want to make sure this actually helps you.";
          branchContent.innerHTML = offerScript ? `
            <div class="banner info" style="margin-top:12px;">
              <strong>Text this:</strong>
              <br><span class="small-muted">${offerScript}</span>
              <br><button type="button" class="btn secondary" id="offer-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </div>
            <p class="hint" style="margin-top:12px;">Start here and talk it through with them -- ask if
            they'll be able to rent somewhere else with this money and be okay:
            <br><span class="small-muted">"${rentCheckScript}"</span>
            <br><button type="button" class="btn secondary" id="rent-check-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </p>
            <p class="hint">If they say they won't be okay, or their need is greater (a family
            emergency, medical bills, etc.), go up to the highest MAO instead:
            <strong>${fmt(highestMao)}</strong>.</p>
          ` : "";
          wireCopyPromptButton(branchContent, "#offer-script-copy-btn", () => offerScript);
          if (offerScript) wireCopyPromptButton(branchContent, "#rent-check-script-copy-btn", () => rentCheckScript);
        } else {
          equityBanner.className = "banner danger";
          equityBanner.innerHTML = `<strong>No equity here</strong> — the existing debt is at or above
            the most we could pay in cash. This can't move forward as a cash purchase, and there's no
            specific dollar offer to give yet — text the script below instead, then gather what's below
            it and submit the lead to admin as a <strong>Subject To - Only Possible</strong> lead so
            admin can structure the actual offer directly with the seller.`;
          const subjectToScript = `We can put together an offer that saves your credit from being `
            + `damaged any further, and gets you as much money as possible at closing, by taking over `
            + `your existing mortgage payments.`;
          branchContent.innerHTML = `
            <div class="banner info" style="margin-top:12px;">
              <strong>Text this:</strong>
              <br><span class="small-muted">${subjectToScript}</span>
              <br><button type="button" class="btn secondary" id="subject-to-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </div>
            <div style="margin-top:16px;">
              <label class="field-label">Payoff Statement Screenshot <span class="small-muted">(optional, but strongly encouraged)</span></label>
              <p class="hint">Have the seller call their lender, request a payoff statement, and
              screenshot it for you to upload here.</p>
              <input type="file" id="payoff-screenshots-input" accept="image/*" multiple>
              <div id="payoff-screenshots-list" style="margin-top:8px;"></div>

              <label class="field-label" style="margin-top:16px;">Notes <span class="small-muted">(optional)</span></label>
              <textarea id="payoff-notes-input" placeholder="Anything relevant from the payoff statement or the call with the lender..."></textarea>

              <label class="field-label" style="margin-top:16px;">Loan details <span class="small-muted">(ask the seller as much of this as they know)</span></label>
              <div class="row2">
                <div>
                  <label class="field-label" style="font-weight:normal;">Monthly Payment (Total)</label>
                  <input type="number" id="loan-monthly-payment-input" placeholder="$">
                </div>
                <div>
                  <label class="field-label" style="font-weight:normal;">Monthly Principal</label>
                  <input type="number" id="loan-monthly-principal-input" placeholder="$">
                </div>
              </div>
              <div class="row2">
                <div>
                  <label class="field-label" style="font-weight:normal;">Monthly Interest</label>
                  <input type="number" id="loan-monthly-interest-input" placeholder="$">
                </div>
                <div>
                  <label class="field-label" style="font-weight:normal;">Monthly Taxes (escrow)</label>
                  <input type="number" id="loan-monthly-taxes-input" placeholder="$">
                </div>
              </div>
              <label class="field-label" style="font-weight:normal;">Monthly Insurance (escrow)</label>
              <input type="number" id="loan-monthly-insurance-input" placeholder="$">
            </div>
          `;
          branchContent.querySelector("#payoff-notes-input").value = answers.payoffStatementNotes || "";
          branchContent.querySelector("#payoff-notes-input").oninput = (e) => { answers.payoffStatementNotes = e.target.value; };
          branchContent.querySelector("#loan-monthly-payment-input").value = answers.loanMonthlyPayment || "";
          branchContent.querySelector("#loan-monthly-principal-input").value = answers.loanMonthlyPrincipal || "";
          branchContent.querySelector("#loan-monthly-interest-input").value = answers.loanMonthlyInterest || "";
          branchContent.querySelector("#loan-monthly-taxes-input").value = answers.loanMonthlyTaxes || "";
          branchContent.querySelector("#loan-monthly-insurance-input").value = answers.loanMonthlyInsurance || "";
          wireScreenshotUpload(branchContent, {
            inputSelector: "#payoff-screenshots-input", listSelector: "#payoff-screenshots-list",
            answersKey: "payoffStatementUrls", address: addressLine
          });
          wireMoneyEchoesIn(branchContent);
          wireCopyPromptButton(branchContent, "#subject-to-script-copy-btn", () => subjectToScript);
        }
      };
      root.querySelector("#preforeclosure-debt-input").addEventListener("input", renderBranch);
      renderBranch();
    },
    validate(root) {
      answers.preforeclosureDebt = root.querySelector("#preforeclosure-debt-input").value;
      answers.arrearsAmount = root.querySelector("#arrears-input").value;
      let ok = true;
      toggleError(root, "#preforeclosure-debt-error", !answers.preforeclosureDebt); if (!answers.preforeclosureDebt) ok = false;
      toggleError(root, "#arrears-error", !answers.arrearsAmount); if (!answers.arrearsAmount) ok = false;

      const maoCandidates = [answers.maoCash, answers.maoHardMoney10, answers.maoHardMoney20]
        .map(Number).filter(n => n > 0);
      const highestMao = maoCandidates.length ? Math.round(Math.max(...maoCandidates)) : 0;
      const debt = Number(answers.preforeclosureDebt) || 0;
      answers.subjectToOnlyPossible = (debt > 0 && highestMao > 0 && debt >= highestMao) ? "Yes" : "No";

      if (answers.subjectToOnlyPossible === "Yes") {
        const branchContent = root.querySelector("#equity-branch-content");
        answers.loanMonthlyPayment = branchContent.querySelector("#loan-monthly-payment-input").value;
        answers.loanMonthlyPrincipal = branchContent.querySelector("#loan-monthly-principal-input").value;
        answers.loanMonthlyInterest = branchContent.querySelector("#loan-monthly-interest-input").value;
        answers.loanMonthlyTaxes = branchContent.querySelector("#loan-monthly-taxes-input").value;
        answers.loanMonthlyInsurance = branchContent.querySelector("#loan-monthly-insurance-input").value;
        answers.payoffStatementNotes = branchContent.querySelector("#payoff-notes-input").value;
      }
      return ok;
    }
  },
  {
    key: "dualOfferTemplates",
    progress: true,
    // Runs for Cash Deal and Seller Financing alike -- cashDealDetails now computes the MAO/As-Is
    // Value numbers for both, so a cash offer can always be paired with the seller-financing one
    // regardless of which dealType this lead is. Land/Business don't fit the "cash vs.
    // seller-financed" framing, and a Seller filling this out about their own property has no one to
    // text these scripts to. Runs BEFORE cashDealOutcome (Deal Status) -- the associate needs the
    // actual offer text to send before they can have anything to report an outcome on. Skipped for
    // the preforeclosure/auction category even though dealType reads "Cash Deal" for it under the
    // hood -- that category is cash-only with no seller-financing pitch at all, and gets its own
    // dedicated cash-offer text in preforeclosureDebtCheck instead.
    skip() {
      return (answers.dealType !== "Cash Deal" && answers.dealType !== "Seller Financing / Creative Finance")
        || answers.assetType === "Business"
        || answers.role === "Seller"
        || answers.dealCategory === "Upcoming Auction/Preforeclosure Property";
    },
    render(root) {
      const isLand = answers.assetType === "Land";
      if (isLand) {
        const addressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
        const sellerName = answers.sellerContactName || "[Name]";
        const maoCandidates = [answers.maoCash, answers.maoHardMoney10].map(Number).filter(n => n > 0);
        const cashOfferAmt = maoCandidates.length ? Math.round(Math.min(...maoCandidates)) : 0;
        const highestMao = maoCandidates.length ? Math.round(Math.max(...maoCandidates)) : 0;
        const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
        const offerText = cashOfferAmt > 0 ? `Hi ${sellerName}, saw ${addressLine} is for sale. Would you be open to ${fmt(cashOfferAmt)} cash for it?` : "";
        const pushbackText = highestMao > 0 ? `The price reflects buying as-is, all cash, with no financing contingencies. We can close quickly. Would ${fmt(highestMao)} work?` : "";
        root.innerHTML = `
          <h2 class="step-title">Make Your Cash Offer</h2>
          <p class="step-sub">Land is always a cash deal — no seller financing option. Start at the opening offer and negotiate up to the ceiling if needed, but never go above it.</p>
          ${highestMao > 0 ? `
            <div class="banner warn" style="margin-bottom:16px;">
              <strong>Opening Offer:</strong> ${fmt(cashOfferAmt)}&nbsp;&nbsp;|&nbsp;&nbsp;<strong>Ceiling:</strong> ${fmt(highestMao)}
              <br><span class="small-muted">Start at the opening offer. If they push back, you can negotiate up to the ceiling — but never go above it.</span>
            </div>
            <div class="banner info" style="margin-top:12px;">
              <strong>Text this to make your offer:</strong><br>
              <span class="small-muted">${escapeHtml(offerText)}</span>
              <br><button type="button" class="btn secondary" id="land-offer-copy-btn" style="margin-top:8px;">Copy Text</button>
            </div>
            <div class="banner info" style="margin-top:10px;">
              <strong>If they push back on price:</strong><br>
              <span class="small-muted">${escapeHtml(pushbackText)}</span>
              <br><button type="button" class="btn secondary" id="land-pushback-copy-btn" style="margin-top:8px;">Copy Text</button>
            </div>
          ` : `
            <div class="banner warn" style="margin-bottom:16px;">No offer amount yet — go back to Cash Deal Details and enter an As-Is Value so the offer can be calculated.</div>
          `}
        `;
        if (cashOfferAmt > 0) {
          wireCopyPromptButton(root, "#land-offer-copy-btn", () => offerText);
          wireCopyPromptButton(root, "#land-pushback-copy-btn", () => pushbackText);
        }
        return;
      }
      const addressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
      const sellerName = answers.sellerContactName || "[Name]";
      const isMultifamily5Plus = Number(answers.units) > 4;
      // Drives whether the "who's the buyer / how does this get sold" FAQ script below shows -- that
      // script's whole pitch (exclusive agreement through due diligence so we can shop it to our buyer
      // network) only makes sense for a listed property. An already off-market property was never
      // something to "take off market" in the first place.
      const isOnMarket = answers.marketStatus === "On-Market";
      // This whole "fix and flip" seller-financing structure (down now, payoff within a year or two)
      // assumes the property needs work. A turnkey property with no rehab gets a different, longer-
      // horizon structure instead -- rehabEstimate is already 0/blank whenever nothing was entered.
      const needsRehab = Number(answers.rehabEstimate) > 0;
      const payoffWindow = isMultifamily5Plus ? "2 years" : "1 year";
      const baseValue = Number(answers.asIsValue) || Number(answers.arv) || 0;
      const downAmt = Math.round(baseValue * 0.20);
      const balanceAmt = baseValue - downAmt;
      const down20 = Math.round(baseValue * 0.20);
      const down50 = Math.round(baseValue * 0.50);
      const maoCandidates = [answers.maoCash, answers.maoHardMoney10, answers.maoHardMoney20]
        .map(Number).filter(n => n > 0);
      const cashOfferAmt = maoCandidates.length ? Math.round(Math.min(...maoCandidates)) : 0;
      const highestMao = maoCandidates.length ? Math.round(Math.max(...maoCandidates)) : 0;
      const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

      root.innerHTML = `
        <h2 class="step-title">Make Your Offers</h2>
        <p class="step-sub">One text, two options by default — a cash purchase or a seller-financed
        alternative. Never mention who's buying or whether it's an investor — just ask. Only drop an
        option below if the seller has already said no to it.</p>
        ${answers.forcedSellerFinancingOnly ? `
          <div class="banner warn" style="margin-bottom:16px;">ARV came in too close to asking price
          with no rehab needed on this one, so a cash offer isn't on the table -- this can only move
          forward as a seller financing offer at full asking price, contingent on it cash flowing as a
          rental (checked on the next step).</div>
        ` : highestMao > 0 ? `
          <div class="banner warn" style="margin-bottom:16px;">
            <strong>Highest Max Allowable Offer:</strong> ${fmt(highestMao)}
            <span class="small-muted">(the most you could offer this seller in cash and still hit a
            target return under any buyer profile — the text below intentionally opens lower than this
            so there's room to negotiate up)</span>
          </div>
        ` : `
          <div class="banner warn" style="margin-bottom:16px;">No cash offer number yet — go back to
          ${answers.dealType === "Cash Deal" ? "Cash Deal Details" : "Property Value & Repair Research"}
          and enter an ARV so a cash offer can be included below.</div>
        `}
        <div id="offer-script-wrap"></div>
      `;
      const wrap = root.querySelector("#offer-script-wrap");

      // Kept as two independent flags (not one "which option" choice) because either can get ruled
      // out on its own mid-conversation -- the script below adapts to whichever combination is live.
      const renderOfferScript = () => {
        // forcedSellerFinancingOnly (set in cashDealDetails when ARV lands too close to asking with
        // no rehab needed) rules cash out the same way a seller's own "no" does -- fold it into the
        // same flag rather than threading a second condition through every branch below.
        const cashDeclined = !!answers.sellerDeclinedCash || !!answers.forcedSellerFinancingOnly;
        const financeDeclined = !!answers.sellerDeclinedSellerFinancing;
        // Our written offer is a 30-day close for 1-4 units, full stop -- don't offer to move faster
        // for this seller. We HAVE closed in under 2 weeks before, so that track record is fair to
        // mention, but only as a past fact, not as a capability on offer for this particular deal.
        // 5+ units get a 45-60 day close, regardless of whether that deal needs rehab.
        // No hyphens or em dashes in anything copy-pasted below -- reads more like a real text and
        // less like something generated. Number ranges spell out "to" instead of using a hyphen.
        const cashClause = !cashOfferAmt ? "" : isMultifamily5Plus
          ? `$${cashOfferAmt.toLocaleString()} cash to purchase outright, with a 45 to 60 day close`
          : `$${cashOfferAmt.toLocaleString()} cash to purchase outright, with a 30 day close (our requirement for deals like this, though we have closed in under 2 weeks before)`;
        // Seller financing always gets framed as full asking price, contingent on the property
        // appraising at or above that -- this is the whole pitch for why they'd take financing over
        // a discounted cash offer, so it's baked into the clause itself rather than only mentioned
        // when cash has been ruled out.
        const financeClause = !baseValue ? "" : needsRehab
          ? `$${downAmt.toLocaleString()} down now, with the remaining $${balanceAmt.toLocaleString()} paid within ${payoffWindow}, at your full asking price as long as it appraises at or above that`
          : `seller financing, typically $${down20.toLocaleString()} to $${down50.toLocaleString()} down now, with the balance paid off over 5 to 15 years depending on terms, at your full asking price as long as it appraises at or above that`;

        let script = "";
        if (!cashDeclined && !financeDeclined && cashClause && financeClause) {
          script = `Hi ${sellerName}, saw ${addressLine} is for sale. Would you be open to ${cashClause}? As another option, we could also do ${financeClause}. Let me know which works better for you.`;
        } else if (!cashDeclined && cashClause) {
          script = `Hi ${sellerName}, saw ${addressLine} is for sale. Would you be open to ${cashClause}?`;
        } else if (!financeDeclined && financeClause) {
          script = `Hi ${sellerName}, saw ${addressLine} is for sale. Would you be open to ${financeClause}?`;
        }

        const showFinanceFollowup = !financeDeclined && baseValue;
        const sfQuestionLabel = needsRehab
          ? `Is the seller willing to accept 20% down for seller financing, paid off within ${payoffWindow}?`
          : "Is the seller willing to accept seller financing (20–50% down, 5–15 year payoff)?";
        const downPaymentResponse = needsRehab
          ? "Good question, I'll put a real offer together for you rather than guess over text. If 20% down "
            + "isn't enough, let me know what you have in mind and we'll review it and get back to you."
          : "Good question, it really depends on the terms we land on together, typically 20 to 50% down with "
            + "a 5 to 15 year payoff. Let me know what you're looking for and we'll put a real offer together for you.";
        // Same answer for cash whether they're just asking who the buyer is, or specifically pressing
        // on whether we're the end buyer -- one variable, used in both spots below.
        const cashBuyerScript = "We have a database of over 6 million buyers we can send this deal to "
          + "once we agree on cash terms together.";
        const whoBuyerScript = cashBuyerScript;
        const endBuyerScript = cashBuyerScript;
        // Same "only if asked" treatment as endBuyerScript above, for the seller financing side of the
        // deal: the seller carries the financing, while the buyer taking on the property separately
        // gets an investment loan against it, and we already have an end buyer lined up ready to close.
        const financeEndBuyerScript = "For seller financing, you'd be carrying it, and the buyer taking "
          + "over the property would be getting an investment loan on it. We already have an end buyer "
          + "ready to close on it right now.";
        const mfFinanceScript = "For seller financing, we already have a specific buyer ready to go.";

        wrap.innerHTML = `
          ${answers.forcedSellerFinancingOnly ? "" : `
            <label class="field-label" style="display:flex; align-items:center; gap:8px; font-weight:normal;">
              <input type="checkbox" id="cash-declined-checkbox" ${cashDeclined ? "checked" : ""}>
              Seller already said no to a cash offer <span class="small-muted">(e.g. won't negotiate on price at all)</span>
            </label>
          `}
          <label class="field-label" style="display:flex; align-items:center; gap:8px; font-weight:normal; margin-top:6px;">
            <input type="checkbox" id="finance-declined-checkbox" ${financeDeclined ? "checked" : ""}>
            Seller already said no to seller financing
          </label>
          ${script ? `
            <div class="banner info" style="margin-top:14px;">
              <strong>Text this:</strong>
              <br><span class="small-muted">${script}</span>
              <br><button type="button" class="btn secondary" id="offer-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </div>
          ` : (cashDeclined && financeDeclined) ? `
            <p class="hint">Both options are marked declined — nothing left to send. Uncheck one above if that's not right.</p>
          ` : `
            <p class="hint">Enter an ARV in ${answers.dealType === "Cash Deal" ? "Cash Deal Details" : "Property Value & Repair Research"} to generate an offer text.</p>
          `}
          ${isOnMarket && (!cashDeclined || !financeDeclined) ? `
            <div style="margin-top:16px;">
              <p class="hint"><strong>If they ask who the buyer is:</strong></p>
              ${!cashDeclined ? `
                <p class="hint"><span class="small-muted">Cash: "${whoBuyerScript}"</span>
                <br><button type="button" class="btn secondary" id="who-buyer-script-copy-btn" style="margin-top:6px;">Copy Text</button></p>
              ` : ""}
              ${!financeDeclined ? `
                <p class="hint" style="margin-top:${!cashDeclined ? "10px" : "0"};"><span class="small-muted">Seller Financing: "${mfFinanceScript}"</span>
                <br><button type="button" class="btn secondary" id="mf-finance-script-copy-btn" style="margin-top:6px;">Copy Text</button></p>
              ` : ""}
            </div>
            ${(!cashDeclined || !financeDeclined) ? `
              <div style="margin-top:12px;">
                <p class="hint"><strong>Only if they specifically ask whether we're the end buyer</strong>
                (don't volunteer this otherwise):</p>
                ${!cashDeclined ? `
                  <p class="hint"><span class="small-muted">Cash: "${endBuyerScript}"</span>
                  <br><button type="button" class="btn secondary" id="end-buyer-script-copy-btn" style="margin-top:6px;">Copy Text</button></p>
                ` : ""}
                ${!financeDeclined ? `
                  <p class="hint" style="margin-top:${!cashDeclined ? "10px" : "0"};"><span class="small-muted">Seller Financing: "${financeEndBuyerScript}"</span>
                  <br><button type="button" class="btn secondary" id="finance-end-buyer-script-copy-btn" style="margin-top:6px;">Copy Text</button></p>
                ` : ""}
              </div>
            ` : ""}
          ` : ""}
          ${showFinanceFollowup ? `
            <p class="hint" style="margin-top:16px;"><strong>If they ask how much down:</strong> don't commit
            to a number over text — just tell them you'll review and get back to them.
            <br><span class="small-muted">"${downPaymentResponse}"</span>
            <br><button type="button" class="btn secondary" id="down-payment-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </p>
            <label class="field-label" style="margin-top:16px;">${sfQuestionLabel} <span class="small-muted">(optional — fill in once you've asked)</span></label>
            <div class="choice-group" id="sf-accept-group">
              ${["Yes", "No", "Negotiating"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
            </div>
            <label class="field-label" style="margin-top:12px;">What are they negotiating for / countering with? <span class="small-muted">(optional)</span></label>
            <textarea id="sf-negotiation-notes" placeholder="e.g. wants 30% down instead of 20%, wants a shorter payoff term..."></textarea>
          ` : ""}
        `;
        if (!answers.forcedSellerFinancingOnly) {
          wrap.querySelector("#cash-declined-checkbox").onchange = (e) => {
            answers.sellerDeclinedCash = e.target.checked;
            renderOfferScript();
          };
        }
        wrap.querySelector("#finance-declined-checkbox").onchange = (e) => {
          answers.sellerDeclinedSellerFinancing = e.target.checked;
          renderOfferScript();
        };
        wireCopyPromptButton(wrap, "#offer-script-copy-btn", () => script);
        wireCopyPromptButton(wrap, "#down-payment-script-copy-btn", () => downPaymentResponse);
        wireCopyPromptButton(wrap, "#who-buyer-script-copy-btn", () => whoBuyerScript);
        wireCopyPromptButton(wrap, "#end-buyer-script-copy-btn", () => endBuyerScript);
        wireCopyPromptButton(wrap, "#finance-end-buyer-script-copy-btn", () => financeEndBuyerScript);
        wireCopyPromptButton(wrap, "#mf-finance-script-copy-btn", () => mfFinanceScript);
        if (showFinanceFollowup) {
          bindChoiceGroup(wrap, "#sf-accept-group", "sellerFinancingAccepted");
          const notesInput = wrap.querySelector("#sf-negotiation-notes");
          notesInput.value = answers.sellerFinancingNegotiationNotes || "";
          notesInput.oninput = (e) => { answers.sellerFinancingNegotiationNotes = e.target.value; };
        }
      };
      renderOfferScript();
    },
    validate() {
      return true; // informational/optional -- doesn't block submission either way
    }
  },
  {
    key: "cashDealOutcome",
    progress: true,
    // This is written from the associate's side of a negotiation with a third-party seller --
    // doesn't make sense to ask a seller "what price has the seller agreed to" about themselves.
    // Runs AFTER dualOfferTemplates (Make Your Offers) -- the associate needs the offer text from
    // that step to actually text the seller before there's any outcome to report here.
    skip() { return answers.dealType !== "Cash Deal" || answers.role === "Seller"; },
    render(root) {
      // Residential/commercial cash deals must pencil out under at least one buyer profile before
      // they can be submitted -- Business isn't held to this since it doesn't get a comparable MAO
      // suite the same way. Highest MAO = the most a buyer could still pay under ANY of the three
      // profiles (Cash, Hard Money low/high Down -- 10%/20% for residential/commercial, 30%/50%
      // for land); if the seller won't come down below that, the deal
      // doesn't work under any scenario and there's nothing to submit yet.
      const isEligibleAssetType = answers.assetType === "Residential Property (1-4 units)"
        || answers.assetType === "Commercial Property" || answers.assetType === "Land";
      const highestMao = Math.max(answers.maoCash || 0, answers.maoHardMoney10 || 0, answers.maoHardMoney20 || 0);
      const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
      // Reuses sellerDeclinedCash (also set on Make Your Offers) rather than a separate field --
      // "seller's floor is above our MAO" and "seller won't negotiate at all" both mean the same
      // thing downstream: no viable cash deal, pivot to a seller-financing-only offer at full
      // asking price with an appraisal contingency. Setting it here also updates what Make Your
      // Offers would generate if the associate goes back to it.
      // The pivot only exists if seller financing is actually still on the table -- if the seller
      // already ruled it out too (sellerDeclinedSellerFinancing, also from Make Your Offers), there's
      // no fallback structure at all, so this page has to stay a hard block until the cash price
      // actually comes down below MAO.
      const isPreforeclosureAuction = answers.dealCategory === "Upcoming Auction/Preforeclosure Property";
      const isLand = answers.assetType === "Land";
      // Preforeclosure has no seller-financing fallback at all (see dealType's comment) -- "seller
      // won't accept a price below MAO" means the same thing preforeclosureDebtCheck already checks
      // for (no equity), so the button there flags Subject To Only Possible instead of pivoting
      // dealType to Seller Financing, which isn't a real option for this category.
      // Land is also always cash-only -- no seller financing pivot exists for land.
      const financingAvailable = !isPreforeclosureAuction && !isLand && !answers.sellerDeclinedSellerFinancing;
      const cashRejected = isPreforeclosureAuction
        ? !!answers.subjectToOnlyPossible && answers.subjectToOnlyPossible !== "No"
        : (isLand || financingAvailable) && !!answers.sellerDeclinedCash;

      // Anyone but the seller themselves selling this as a cash deal, on an on-market (FSBO or MLS)
      // property that isn't preforeclosure/auction, needs the seller/listing agent to agree to an
      // Exclusive Agreement Through Due Diligence before this can submit: we close if we proceed past
      // due diligence, and the seller is free to go find another buyer if we don't. Whether the
      // listing itself can stay up during that window depends only on the accepted price as a share
      // of asking price (LISTING_CAN_STAY_UP_MAX_PCT_OF_ASKING) -- and that never applies to a full
      // tear-down, set on Cash Deal Details. The guidance block below turns that into the exact text
      // to send, so the associate never has to decide which scenario they're in.
      const isOnMarket = answers.marketStatus === "On-Market";
      const needsExclusiveDdAgreement = isEligibleAssetType && isOnMarket && !isPreforeclosureAuction;
      // Residential collects an explicit asking price on Cash Deal Details; every asset type
      // collects "price the seller is seeking" on the Price step, so that covers commercial/land.
      const askingBase = Number(answers.askingPrice) || Number(answers.priceSought) || 0;
      const stayUpPct = Math.round(LISTING_CAN_STAY_UP_MAX_PCT_OF_ASKING * 100);
      const stayUpMaxPrice = askingBase * LISTING_CAN_STAY_UP_MAX_PCT_OF_ASKING;
      const isTearDown = answers.isTearDown === "Yes";
      const sellerName = answers.sellerContactName || "[Name]";
      const addressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();

      root.innerHTML = `
        <h2 class="step-title">Deal Status</h2>
        <p class="hint">This page is for cash offers. Use the Max Allowable Offer below as your
        negotiating target.${isPreforeclosureAuction
          ? ` If the seller genuinely won't come down below it, let them know they'll get nothing if
          this goes to auction -- they either need to agree to a price below this number to continue
          as a cash deal, or use the button below to flag this as a subject-to lead instead, same as
          the debt/equity check earlier.`
          : isLand
          ? ` Land deals are always cash — there is no seller financing option. If the seller genuinely
          won't come down below the ceiling, the deal doesn't work at this price.`
          : financingAvailable
          ? ` If the seller genuinely won't come down below it, let them know we'd need to do this as
          seller financing instead, then use the button below to submit it that way, at the seller's
          full asking price with an appraisal contingency.`
          : ` The seller already said no to seller financing, so this has to close as a cash deal
          below that number — keep negotiating until it does.`}</p>
        <label class="field-label">Is this property currently under contract? <span class="req">*</span></label>
        <div class="choice-group" id="under-contract-group">
          ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="under-contract-error">Please choose one.</div>
        <p class="hint">Please don't put this under contract yourself — let admin handle that once we've
        double-checked the numbers against our current buyer pool and confirmed it still looks good on our end.</p>

        ${isEligibleAssetType && highestMao > 0 ? `
          <div class="banner warn" style="margin-top:16px;">
            <strong>Highest Max Allowable Offer:</strong> ${fmt(highestMao)}
            <span class="small-muted">(${answers.assetType === "Land"
              ? "the ceiling percentage of As-Is Value from the Cash Deal Details step -- 60% on-market, 70% off-market, or 100% if this qualifies as a free-and-clear deferred-value deal"
              : "the greater of the Cash Buyer / Hard Money 10% Down / Hard Money 20% Down numbers from the Cash Deal Details step"})</span>
            <br><span class="small-muted">The seller's accepted price has to land below this number for
            a cash offer to work. Negotiate toward it.${isPreforeclosureAuction
              ? ` If they won't come down that far, let them know they'll get nothing if this goes to
              auction, then flag it as subject-to below if they still won't move.`
              : isLand
              ? ` Land is always cash — there is no seller financing fallback. If they won't come down
              below this number, the deal doesn't work at this price.`
              : financingAvailable
              ? ` If they won't come down that far, let them know we'd need to go with seller financing instead.`
              : ` The seller already declined seller financing, so there's no fallback here -- it has to land below this number.`}</span>
          </div>
          ${isPreforeclosureAuction || isLand || financingAvailable ? `
            <div style="margin-top:12px;">
              <button type="button" class="btn ghost-small${cashRejected ? " active" : ""}" id="cash-rejected-btn">${isPreforeclosureAuction ? "Seller will not agree to a cash price below MAO" : "Seller will not come down to a cash price below the ceiling"}</button>
            </div>
            ${cashRejected ? `
              <div class="banner info" style="margin-top:12px;">${isPreforeclosureAuction
                ? `This will submit as a <strong>Subject To - Only Possible</strong> lead instead of a
                cash deal, same as picking "no equity" on the debt/equity check earlier.`
                : isLand
                ? `Land is cash-only — there is no seller financing fallback. The deal has to come in
                below the ceiling, or it doesn't work at this price. Submit this as-is so admin has
                the lead on file, or go back and keep negotiating.`
                : `This will submit as a seller financing offer only, at the seller's full asking price
                with an appraisal contingency, instead of a cash deal.`}</div>
            ` : ""}
          ` : ""}
        ` : ""}

        <label class="field-label" style="margin-top:16px;">${cashRejected
          ? "What price is the seller asking for the property?"
          : "What price has the seller agreed to accept?"}
          ${isEligibleAssetType
            ? `<span class="req">*</span>`
            : `<span class="small-muted">(optional — fill this in once you have it, even if that means coming back later)</span>`}
        </label>
        <input type="number" id="accepted-price-input" placeholder="$">
        <div class="error-text" id="accepted-price-error"></div>
        <p class="hint">Once you enter ${cashRejected ? "an asking price" : "an accepted price"}, admin will reach out to you with next steps for
        sending a formal offer (assuming it's not already under contract).</p>

        ${needsExclusiveDdAgreement ? `
          <div id="exclusive-dd-guidance" style="margin-top:16px;"></div>
          <label class="field-label" style="margin-top:12px;">Has the seller/listing agent agreed to an
            Exclusive Agreement Through Due Diligence? <span class="req">*</span></label>
          <div class="choice-group" id="exclusive-dd-group">
            <button type="button" class="choice-btn" data-value="Yes - Exclusive">Yes, Exclusive</button>
            <button type="button" class="choice-btn" data-value="Yes - Non-Exclusive">Yes, Non-Exclusive (fallback)</button>
            <button type="button" class="choice-btn" data-value="No">No</button>
          </div>
          <div class="error-text" id="exclusive-dd-error">Required before this can be submitted.</div>
        ` : ""}
      `;
      root.querySelector("#accepted-price-input").value = answers.sellerAcceptedPrice || "";
      bindChoiceGroup(root, "#under-contract-group", "underContract");
      if (needsExclusiveDdAgreement) {
        bindChoiceGroup(root, "#exclusive-dd-group", "exclusiveDdAgreed");
        // Every on-market cash deal here needs the seller/listing agent's agreement that we're the
        // buyer through due diligence (Exclusive, or the Non-Exclusive fallback) -- that part never
        // changes. The only thing that varies is whether the listing itself has to come down for that
        // window, and that's decided by the price, not by the associate: the text below is picked for
        // them, and the reply they get maps straight to one of the buttons underneath. No dashes in
        // anything copy-pasted, same as every other seller-facing script here.
        const guidanceEl = root.querySelector("#exclusive-dd-guidance");
        const updateExclusiveDdUi = () => {
          const price = Number(root.querySelector("#accepted-price-input").value) || 0;
          if (!price) {
            guidanceEl.innerHTML = `<div class="banner warn">Enter the price the seller agreed to above and this
              will show exactly what to text them about the listing and the agreement.</div>`;
            return;
          }
          const staysListed = !isTearDown && askingBase > 0 && price <= stayUpMaxPrice;
          const pctOfAsking = askingBase > 0 ? Math.round((price / askingBase) * 1000) / 10 : null;
          const reason = isTearDown
            ? `This is a full tear down, so the listing has to come off market during due diligence no matter the price.`
            : pctOfAsking === null
            ? `There's no asking price on file to compare this against, so assume the listing has to come off market.`
            : `${fmt(price)} is ${pctOfAsking}% of the ${fmt(askingBase)} asking price, which is ${staysListed ? "at or below" : "above"}
              the ${stayUpPct}% line (${fmt(stayUpMaxPrice)}).`;

          const stayListedText = `Hi ${sellerName}, we're set at ${fmt(price)} for ${addressLine}. You can keep the listing up while we do our due diligence. All we need is your agreement that we're the buyer at that price through our due diligence period. If we move past due diligence, we close. If we don't, you're free to go with another buyer. Does that work for you?`;
          const offMarketText = `Hi ${sellerName}, we're set at ${fmt(price)} for ${addressLine}. To lock that in, we need the property taken off the market (and off MLS if it's listed there) through our due diligence period, with your agreement that we're the buyer during that time. If we move past due diligence, we close. If we don't, you're free to go find another buyer. Your listing agent stays involved and gets paid by you as usual. Would you be open to that?`;
          const nonExclusiveText = `Totally understand. We can make it non exclusive: you're free to keep looking for a buyer on your own, as long as the property stays off the market (and off MLS) through the end of our due diligence period. If we don't bring a buyer by then, you're free to relist it. Your listing agent stays involved and gets paid by you as usual.`;
          const primaryText = staysListed ? stayListedText : offMarketText;

          guidanceEl.innerHTML = `
            <div class="banner warn"><strong>${staysListed
              ? "The listing can stay up during due diligence."
              : "The seller has to take the listing off market during due diligence."}</strong>
              <br><span class="small-muted">${reason} Either way, we still need the seller/listing agent
              to agree that we're the buyer through due diligence.</span></div>
            <div class="banner info" style="margin-top:10px;">
              <strong>Text this:</strong>
              <br><span class="small-muted">${escapeHtml(primaryText)}</span>
              <br><button type="button" class="btn secondary" id="exclusive-dd-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </div>
            ${staysListed ? "" : `
              <div class="banner info" style="margin-top:10px;">
                <strong>If they push back on full exclusivity, text this instead:</strong>
                <br><span class="small-muted">${escapeHtml(nonExclusiveText)}</span>
                <br><button type="button" class="btn secondary" id="exclusive-dd-fallback-copy-btn" style="margin-top:8px;">Copy Text</button>
              </div>
            `}
            <p class="hint" style="margin-top:10px;">${staysListed
              ? `If they agree, pick <strong>Yes, Exclusive</strong> below. If they won't agree to this, it can't
                be submitted yet, so keep negotiating.`
              : `If they agree to the first text, pick <strong>Yes, Exclusive</strong> below. If they only agree
                to the second one, pick <strong>Yes, Non-Exclusive (fallback)</strong>. If they won't agree to
                either, it can't be submitted yet, so keep negotiating.`}</p>
          `;
          wireCopyPromptButton(guidanceEl, "#exclusive-dd-script-copy-btn", () => primaryText);
          wireCopyPromptButton(guidanceEl, "#exclusive-dd-fallback-copy-btn", () => nonExclusiveText);
        };
        root.querySelector("#accepted-price-input").addEventListener("input", updateExclusiveDdUi);
        updateExclusiveDdUi();
      }

      if (isEligibleAssetType && highestMao > 0) {
        if (isPreforeclosureAuction || isLand || financingAvailable) {
          root.querySelector("#cash-rejected-btn").onclick = () => {
            if (isPreforeclosureAuction) {
              answers.subjectToOnlyPossible = cashRejected ? "No" : "Yes";
            } else {
              answers.sellerDeclinedCash = !answers.sellerDeclinedCash;
            }
            renderStep();
          };
        }
        if (!cashRejected) {
          root.querySelector("#accepted-price-input").oninput = (e) => {
            const price = Number(e.target.value) || 0;
            const errorEl = root.querySelector("#accepted-price-error");
            if (price && price >= highestMao) {
              errorEl.textContent = isPreforeclosureAuction
                ? `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- let the seller know they'll get nothing if this goes to auction. Keep negotiating toward that number, or press the "Seller will not agree to a cash price below MAO" button above to flag it as subject-to instead.`
                : isLand
                ? `This is at or above the ceiling (${fmt(highestMao)}) — land is always cash and there is no seller financing fallback. Keep negotiating toward that number, or press the button above to record that the seller won't come down.`
                : financingAvailable
                ? `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- keep negotiating toward that number. If the seller genuinely won't come down below it, let them know we'd need to do this as seller financing instead, then press the "Seller will not come down to a cash price below the ceiling" button above.`
                : `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- the seller already declined seller financing, so keep negotiating until this comes in below that number.`;
              errorEl.classList.add("show");
            } else {
              errorEl.classList.remove("show");
            }
          };
        } else if (!isPreforeclosureAuction) {
          root.querySelector("#accepted-price-input").oninput = (e) => {
            const price = Number(e.target.value) || 0;
            const errorEl = root.querySelector("#accepted-price-error");
            if (isLand && price && highestMao > 0 && price > highestMao) {
              // Land is always cash — no seller financing fallback even when cash offer is rejected.
              errorEl.textContent = `This is above the ceiling (${fmt(highestMao)}) — land is cash-only with no seller financing option. Either negotiate to a price below the ceiling, or this deal doesn't work.`;
              errorEl.classList.add("show");
            } else if (!isLand && price && highestMao > 0 && price > highestMao && answers.sellerFinancingAccepted !== "Yes") {
              // Cash being ruled out doesn't mean any price is now fair game -- once the asking price
              // is above MAO, the only thing that makes the deal pencil is the seller agreeing to
              // seller financing (20% down now, balance paid off within the payoff window).
              errorEl.textContent = `This is above the highest Max Allowable Offer (${fmt(highestMao)}) -- a price this high only works as seller financing. Go back to Make Your Offers and confirm with the seller/realtor that they accept seller financing (20% down, balance paid off within the payoff window) before this can be submitted.`;
              errorEl.classList.add("show");
            } else {
              errorEl.classList.remove("show");
            }
          };
        }
      }
    },
    validate(root) {
      const isEligibleAssetType = answers.assetType === "Residential Property (1-4 units)"
        || answers.assetType === "Commercial Property" || answers.assetType === "Land";
      const highestMao = Math.max(answers.maoCash || 0, answers.maoHardMoney10 || 0, answers.maoHardMoney20 || 0);
      const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
      const isPreforeclosureAuction = answers.dealCategory === "Upcoming Auction/Preforeclosure Property";
      const isLand = answers.assetType === "Land";
      const financingAvailable = !isPreforeclosureAuction && !isLand && !answers.sellerDeclinedSellerFinancing;
      const cashRejected = isPreforeclosureAuction
        ? !!answers.subjectToOnlyPossible && answers.subjectToOnlyPossible !== "No"
        : (isLand || financingAvailable) && !!answers.sellerDeclinedCash;

      answers.sellerAcceptedPrice = root.querySelector("#accepted-price-input").value;
      let ok = !!answers.underContract;
      toggleError(root, "#under-contract-error", !answers.underContract);

      const priceErrorEl = root.querySelector("#accepted-price-error");
      if (isEligibleAssetType) {
        const price = Number(answers.sellerAcceptedPrice) || 0;
        if (!answers.sellerAcceptedPrice) {
          priceErrorEl.textContent = cashRejected
            ? (isPreforeclosureAuction
              ? "Required -- enter the seller's asking price so admin can structure the subject-to offer."
              : isLand
              ? "Required -- enter the seller's asking price so admin has the lead on file."
              : "Required -- enter the seller's asking price so admin can structure the seller financing offer.")
            : "Required -- the seller needs to agree to a price before this lead can be submitted.";
          priceErrorEl.classList.add("show");
          ok = false;
        } else if (!cashRejected && highestMao > 0 && price >= highestMao) {
          priceErrorEl.textContent = isPreforeclosureAuction
            ? `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- let the seller know they'll get nothing if this goes to auction. Keep negotiating toward that number, or press the "Seller will not agree to a cash price below MAO" button above to flag it as subject-to instead.`
            : isLand
            ? `This is at or above the ceiling (${fmt(highestMao)}) — land is always cash and there is no seller financing fallback. Keep negotiating toward that number, or press the button above to record that the seller won't come down.`
            : financingAvailable
            ? `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- keep negotiating toward that number. If the seller genuinely won't come down below it, let them know we'd need to do this as seller financing instead, then press the "Seller will not come down to a cash price below the ceiling" button above.`
            : `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- the seller already declined seller financing, so keep negotiating until this comes in below that number.`;
          priceErrorEl.classList.add("show");
          ok = false;
        } else if (cashRejected && !isPreforeclosureAuction && !isLand && highestMao > 0 && price > highestMao && answers.sellerFinancingAccepted !== "Yes") {
          // Cash was ruled out, but that doesn't waive the MAO cap -- it just changes what has to be
          // true to justify going above it. A price above MAO only pencils if the seller has actually
          // agreed to seller financing (20% down, balance paid off within the payoff window); without
          // that confirmed, this would submit as a full-price cash-equivalent lead with no backing math.
          priceErrorEl.textContent = `This is above the highest Max Allowable Offer (${fmt(highestMao)}) -- a price this high only works as seller financing. Go back to Make Your Offers and confirm with the seller/realtor that they accept seller financing (20% down, balance paid off within the payoff window) before this can be submitted.`;
          priceErrorEl.classList.add("show");
          ok = false;
        } else if (cashRejected && isLand && highestMao > 0 && price > highestMao) {
          priceErrorEl.textContent = `This is above the ceiling (${fmt(highestMao)}) — land is cash-only with no seller financing option. Either negotiate to a price below the ceiling, or this deal doesn't work.`;
          priceErrorEl.classList.add("show");
          ok = false;
        } else {
          priceErrorEl.classList.remove("show");
        }
      } else {
        priceErrorEl.classList.remove("show");
      }

      // See render()'s comment above -- every on-market cash deal here needs at least the Non-Exclusive
      // fallback confirmed, regardless of whether the price (as a share of asking) lets the listing
      // itself stay up. That price only changes whether the listing comes down, never whether some
      // form of agreement (Exclusive or Non-Exclusive) is required.
      const isOnMarket = answers.marketStatus === "On-Market";
      if (isEligibleAssetType && isOnMarket && !isPreforeclosureAuction) {
        const agreed = answers.exclusiveDdAgreed === "Yes - Exclusive" || answers.exclusiveDdAgreed === "Yes - Non-Exclusive";
        toggleError(root, "#exclusive-dd-error", !agreed);
        if (!agreed) ok = false;
      }
      return ok;
    }
  },
  {
    key: "review",
    progress: true,
    render(root) {
      const rows = buildAnswerRows();
      root.innerHTML = `
        <h2 class="step-title">Review</h2>
        <p class="step-sub">Double check everything before submitting.</p>
        <dl class="review-grid">
          ${rows.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
        </dl>
        <div class="error-text show" id="submit-error" style="display:none;"></div>
      `;
    },
    validate() { return true; }
  }
];

// Move sourcing and assetType before address — asset class must be known before address
// so downstream logic (land seller financing, business branches, Propwire check) works correctly.
{
  const sourcing = steps.splice(steps.findIndex(s => s.key === "sourcing"), 1)[0];
  const assetType = steps.splice(steps.findIndex(s => s.key === "assetType"), 1)[0];
  const addressIdx = steps.findIndex(s => s.key === "address");
  steps.splice(addressIdx, 0, sourcing, assetType);
}

let stepIndex = 0;

function buildAnswerRows() {
  const rows = [
    ["Role", answers.role], ["Name", answers.name], ["Email", answers.email], ["Phone", answers.phone],
    ["Social Link", answers.socialLink || "—"],
    ["Referred By", answers.referrerName || "—"], ["Referrer Phone", answers.referrerPhone || "—"],
  ];
  if (answers.role && answers.role !== "Seller") {
    rows.push(
      ["Seller/Realtor/Broker Name", answers.sellerContactName || "—"],
      ["Seller/Realtor/Broker Phone", answers.sellerContactPhone || "—"],
      ["Seller/Realtor/Broker Email", answers.sellerContactEmail || "—"]
    );
  }
  rows.push(
    ["Address", `${answers.street}, ${answers.city}, ${answers.state} ${answers.zip}`],
    ["Parcel ID(s)", answers.parcelIds || "—"],
    ["Units", answers.units],
    ["Asset Type", answers.assetType],
    ["Subtype / Details", answers.assetType === "Commercial Property"
      ? [answers.assetSubtype, answers.sqft && `${answers.sqft} sqft`, answers.acreage && `${answers.acreage} acres`, answers.matchByUnitsOnly && "sqft skipped, matched by units"].filter(Boolean).join(", ")
      : (answers.assetSubtype || [answers.beds && `${answers.beds} bd`, answers.baths && `${answers.baths} ba`, answers.acreage && `${answers.acreage} acres`, answers.sqft && `${answers.sqft} sqft`].filter(Boolean).join(", "))],
    ["Deal Type", answers.dealType || "—"]
  );
  if (answers.assetType === "Commercial Property" && answers.marketStatus === "Off-Market") {
    rows.push(["Seller Reported Sq Ft", answers.sellerReportedSqft || "—"]);
  }
  if (answers.dealCategory) {
    rows.push(["Deal Category", answers.dealCategory]);
  }
  if (answers.assetType === "Land") {
    rows.push(["Zoning", answers.landZoning || "—"]);
  }
  // Seller Financing deals now collect the same ARV/rehab/comps data Cash Deals do (see
  // cashDealDetails' skip()), so admin has both that AND the income/NOI numbers below -- these two
  // blocks are independent (not else-if) specifically to allow that overlap.
  const showsCashDealFields = answers.dealType === "Cash Deal" || answers.dealType === "Seller Financing / Creative Finance";
  if (showsCashDealFields) {
    rows.push(
      ["Approximate As-Is Value (Chase)", answers.chaseEstimate || "—"],
      ["Asking Price", answers.askingPrice || "—"],
      ["ARV", answers.arv || "—"],
      ["As-Is Value", answers.asIsValue || "—"],
      ["Pictures Link", answers.picturesLink || "—"],
      ["Rehab Estimate — Low", answers.rehabEstimateLow || "—"],
      ["Rehab Estimate — High", answers.rehabEstimateHigh || "—"],
      ["Rehab Estimate (average)", answers.rehabEstimate || "—"],
      ["Rehab AI Response", answers.rehabAiText || "—"],
      ["County Assessed Value", answers.countyAssessedValue || "—"],
      ["CMA Screenshots", (answers.cmaScreenshotUrls || []).join("\n") || "—"],
      ["Bottom Dollar Price", answers.bottomDollarPrice || "—"],
      ["Notes (Why Sell / Good Lead)", answers.cashDealNotes || "—"]
    );
    if (answers.assetType === "Commercial Property") {
      rows.push(
        ["Occupancy Status", answers.commercialOccupancyStatus || "—"],
        ["Occupancy %", answers.commercialOccupancyPct || "—"],
        ["NOI", answers.commercialNoiUnknown ? "Unknown" : (answers.commercialNOI || "—")],
        ["NOI Research Notes", answers.noiResearchNotes || "—"]
      );
      if (answers.commercialOccupancyStatus === "Vacant" && answers.marketStatus !== "On-Market") {
        rows.push(["Property Photos", (answers.propertyPhotoUrls || []).join("\n") || "—"]);
      }
    }
    if (answers.role !== "Seller") {
      if (answers.dealType === "Cash Deal") {
        rows.push(
          ["Wholesale Fee", answers.wholesaleFee || "—"],
          ["Under Contract", answers.underContract || "—"],
          ["Seller Accepted Price", answers.sellerAcceptedPrice || "—"]
        );
        if (answers.assetType !== "Land" && answers.marketStatus === "On-Market"
          && answers.dealCategory !== "Upcoming Auction/Preforeclosure Property") {
          rows.push(["Full Tear-Down / Rebuild", answers.isTearDown || "—"]);
        }
        if (answers.marketStatus === "On-Market" && answers.dealCategory !== "Upcoming Auction/Preforeclosure Property"
          && (answers.assetType === "Residential Property (1-4 units)" || answers.assetType === "Commercial Property" || answers.assetType === "Land")) {
          rows.push(["Exclusive Agreement Through Due Diligence", answers.exclusiveDdAgreed || "—"]);
        }
      }
      // Make Your Offers runs for Cash Deal and Seller Financing alike (see dualOfferTemplates'
      // skip()) so these fields, and the Highest MAO it's built around, need to show for both --
      // previously gated to Cash Deal only, which silently hid all of this for Seller Financing.
      if (answers.assetType !== "Land" && answers.assetType !== "Business") {
        const maoCandidates = [answers.maoCash, answers.maoHardMoney10, answers.maoHardMoney20]
          .map(Number).filter(n => n > 0);
        if (maoCandidates.length) {
          rows.push(["Highest Max Allowable Offer", "$" + Math.round(Math.max(...maoCandidates)).toLocaleString()]);
        }
        rows.push(
          ["Seller Declined Cash Offer", answers.sellerDeclinedCash ? "Yes" : "No"],
          ["Seller Declined Seller Financing", answers.sellerDeclinedSellerFinancing ? "Yes" : "No"],
          ["Seller Financing Accepted (20% Down)", answers.sellerFinancingAccepted || "—"],
          ["Seller Financing Negotiation Notes", answers.sellerFinancingNegotiationNotes || "—"]
        );
      }
    }
  }
  if (answers.dealCategory === "Upcoming Auction/Preforeclosure Property") {
    rows.push(
      ["Year Built", answers.yearBuilt || "—"],
      ["Purchase Year", answers.purchaseYear || "—"],
      ["Months Behind on Payments", answers.monthsBehindOnPayments || "—"],
      ["Annual Maintenance Spend", answers.annualMaintenanceSpend || "—"],
      ["Property Photos", (answers.propertyPhotoUrls || []).join("\n") || "—"],
      ["Property Photos Link", answers.propertyPhotosLink || "—"],
      ["Existing Debt / Payoff Amount", answers.preforeclosureDebt || "—"],
      ["Arrears Amount", answers.arrearsAmount || "—"],
      ["Subject To Only Possible", answers.subjectToOnlyPossible || "—"]
    );
    if (answers.subjectToOnlyPossible === "Yes") {
      rows.push(
        ["Payoff Statement Screenshots", (answers.payoffStatementUrls || []).join("\n") || "—"],
        ["Payoff Statement Notes", answers.payoffStatementNotes || "—"],
        ["Loan Monthly Payment", answers.loanMonthlyPayment || "—"],
        ["Loan Monthly Principal", answers.loanMonthlyPrincipal || "—"],
        ["Loan Monthly Interest", answers.loanMonthlyInterest || "—"],
        ["Loan Monthly Taxes", answers.loanMonthlyTaxes || "—"],
        ["Loan Monthly Insurance", answers.loanMonthlyInsurance || "—"]
      );
    }
  }
  if (answers.dealType !== "Cash Deal" || answers.role === "Seller") {
    if (answers.assetType === "Residential Property (1-4 units)") {
      rows.push(["Rent Ready", answers.propertyRentReady || "—"]);
      if (answers.propertyRentReady === "No") {
        rows.push(["Buyer Intends To Sell", answers.buyerIntendsToSell ? "Yes" : "No"]);
      }
      if (!answers.buyerIntendsToSell) {
        rows.push(["Occupied Status", answers.residentialOccupied || "—"]);
      }
      if (answers.residentialOccupied === "Vacant (no tenant)") {
        rows.push(
          ["Annual Property Taxes", answers.annualPropertyTaxes || "—"],
          ["Annual Insurance", answers.annualInsurance || "—"],
          ["Rentcast Monthly Rent", answers.rentcastMonthlyRent || "—"],
          ["Expense Ratio %", answers.expenseRatio || "—"],
          ["Long-Term Rental NOI", answers.residentialNOI || "—"],
          ["STR Annual Revenue (airdna.co)", answers.strAnnualRevenue || "—"],
          ["Short-Term Rental NOI", answers.strNOI || "—"]
        );
      } else if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
        rows.push(
          ["Long-Term Rental NOI", answers.residentialNOI || "—"],
          ["Annual Property Taxes", answers.annualPropertyTaxes || "—"],
          ["Annual Insurance", answers.annualInsurance || "—"],
          ["Has 12mo Rent Rolls", answers.hasRentRolls || "—"],
          ["Has 12mo P&L", answers.hasRentRolls === "Yes" ? (answers.hasProfitLoss || "—") : "N/A"],
          ["Deliverable Vacant", answers.deliverableVacant || "—"],
          ["Current Lease Term", answers.currentLeaseTerm || "—"]
        );
        if (Number(answers.units) === 1) {
          rows.push(
            ["Lease End Date", answers.leaseEndDate || "—"],
            ["Tenant Would Move Early", answers.tenantWouldMoveEarly || "—"]
          );
        } else {
          rows.push(["STR NOI Per Unit", answers.strNoiPerUnit || "—"]);
        }
        if (answers.deliverableVacant === "Yes" && answers.strAnnualRevenue) {
          rows.push(
            ["STR Annual Revenue (airdna.co)", answers.strAnnualRevenue || "—"],
            ["Short-Term Rental NOI", answers.strNOI || "—"]
          );
        }
      }
    } else if (answers.assetType === "Business") {
      rows.push(
        ["Annual Revenue", answers.businessRevenue || "—"],
        [`Annual ${answers.businessEarningsType || "Earnings"}`, answers.businessEarnings || "—"]
      );
    }
  }
  rows.push(
    ["Total Debt", answers.debtUnknown ? "Unknown" : (answers.totalDebt || "—")],
    ["Willing: New Senior Loan", answers.seniorLoanWilling],
    ["Willing: Payment Structure", answers.paymentStructureWilling],
    ["Price Sought", answers.priceSought],
    ["Price Reasoning", answers.priceReasoning],
    ["Down Payment Intended Use", answers.dpSkipped || !answers.downPaymentIntent ? "—" : answers.downPaymentIntent],
    ["Down Payment Needed", answers.dpSkipped || !answers.downPaymentNeeded ? "Skipped" : answers.downPaymentNeeded],
    ["Seller Flexible on Down Payment", answers.downPaymentNonNegotiable || "N/A"],
    ["On/Off Market", answers.marketStatus || "—"],
    ["Listing Source Link", answers.sourceLink || "—"]
  );
  return rows;
}

// Shared by every "Copy Prompt" button (county assessed value, taxes, insurance, etc.) so each new
// one doesn't need to reimplement the clipboard-with-fallback dance.
function wireCopyPromptButton(root, buttonSelector, getText) {
  const btn = root.querySelector(buttonSelector);
  if (!btn) return;
  btn.onclick = () => {
    const text = getText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        alert("Prompt copied to clipboard.");
      }).catch(() => {
        prompt("Copy this prompt:", text);
      });
    } else {
      prompt("Copy this prompt:", text);
    }
  };
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Generic screenshot/image upload widget -- picks a file, uploads it via uploadCmaScreenshot (a
// generic Drive upload despite the CMA-specific name), and stores only the resulting URL in
// answers[answersKey] -- never the raw image data, so Save My Progress links and the submission
// payload both stay small. cashDealDetails has its own inline copy of this same pattern for CMA
// screenshots (left as-is to avoid touching already-verified code); this shared version is for
// new upload spots like the preforeclosure payoff statement.
function wireScreenshotUpload(root, { inputSelector, listSelector, answersKey, address }) {
  const input = root.querySelector(inputSelector);
  const list = root.querySelector(listSelector);
  if (!input || !list) return;
  const renderList = () => {
    const urls = answers[answersKey] || [];
    list.innerHTML = urls.map((url, i) => `
      <div class="small-muted" style="margin-top:4px;">
        <a href="${url}" target="_blank" rel="noopener">Screenshot ${i + 1}</a>
        <button type="button" class="link-btn" data-remove-idx="${i}" style="margin-left:8px;">Remove</button>
      </div>
    `).join("");
    list.querySelectorAll("[data-remove-idx]").forEach(btn => {
      btn.onclick = () => {
        answers[answersKey].splice(Number(btn.dataset.removeIdx), 1);
        renderList();
      };
    });
  };
  renderList();
  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const statusEl = document.createElement("div");
      statusEl.className = "small-muted";
      statusEl.textContent = `Uploading ${file.name}...`;
      list.appendChild(statusEl);
      try {
        const fileData = await readFileAsBase64(file);
        const res = await api("uploadCmaScreenshot", {
          fileName: file.name, fileData, contentType: file.type || "image/png", address
        });
        if (res.ok) {
          answers[answersKey] = answers[answersKey] || [];
          answers[answersKey].push(res.url);
          renderList();
        } else {
          statusEl.textContent = `Failed to upload ${file.name}: ${res.error || "unknown error"}`;
        }
      } catch (err) {
        statusEl.textContent = `Failed to upload ${file.name}: ${err.message}`;
      }
    }
    e.target.value = "";
  };
}

// Live "$1,234,567" echo shown right under a dollar-amount <input type="number">, so a fat-
// fingered extra or missing zero jumps out visually instead of silently feeding a wrong ARV/MAO/
// offer number downstream. Deliberately additive -- never touches the input's own type or value,
// so every existing Number(el.value) read elsewhere keeps working completely unchanged.
function wireMoneyEcho(input) {
  if (!input || input.dataset.moneyEchoWired) return;
  input.dataset.moneyEchoWired = "1";
  const echo = document.createElement("div");
  echo.className = "small-muted";
  echo.style.marginTop = "4px";
  input.insertAdjacentElement("afterend", echo);
  const update = () => {
    const n = Number(input.value);
    echo.textContent = (input.value !== "" && !isNaN(n)) ? "= $" + n.toLocaleString() : "";
  };
  input.addEventListener("input", update);
  update();
}

// Auto-wires every dollar-amount number input within `root`. Money fields in this app all use
// placeholder="$" by convention; MONEY_INPUT_IDS covers the handful that instead use a descriptive
// placeholder (e.g. "Total debt amount") since they're standalone fields with no adjacent label
// context. Exposed globally so nested sub-renders that swap in fresh inputs outside the normal
// renderStep() flow (the income step's occupied/vacant sub-sections) can re-wire themselves too.
const MONEY_INPUT_IDS = ["debt-input", "dp-input"];
function wireMoneyEchoesIn(root) {
  root.querySelectorAll('input[type="number"]').forEach(input => {
    if (input.placeholder === "$" || MONEY_INPUT_IDS.includes(input.id)) wireMoneyEcho(input);
  });
}

function bindChoiceGroup(root, selector, answerKey) {
  root.querySelectorAll(selector + " .choice-btn").forEach(btn => {
    if (btn.dataset.value === answers[answerKey]) btn.classList.add("selected");
    btn.onclick = () => {
      root.querySelectorAll(selector + " .choice-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      answers[answerKey] = btn.dataset.value;
    };
  });
}

function toggleError(root, selector, show) {
  const el = root.querySelector(selector);
  if (el) el.classList.toggle("show", !!show);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// Full MAO suite: Cash Buyer, Hard Money Buyer (10% down), Hard Money Buyer (20% down).
//
// Hard Money (10%/20% down) uses the given leveraged formula as-is:
//   MAO = (ARV - Rehab - Selling Costs - [Upfront Cash x (1+Target ROI)])
//         / (1 + [Down Payment% x (1+Target ROI)] + Financing Cost%) - Wholesale Fee
//
// Cash Buyer is NOT the "100% down payment" case of that same formula -- an earlier version plugged
// DP%=100% into it directly, which double counts return-of-capital (the leading "1" in the
// denominator already represents repaying the full price; adding another full "+100%" on top repays
// it a second time), understating Cash Buyer MAO by roughly half. Solving the same target-return-on-
// cash-invested equation with no debt at all collapses cleanly to the simpler, debt-free formula:
//   MAO = (ARV - Rehab - Selling Costs) / (1 + Target ROC) - Wholesale Fee
// with no Upfront Cash or Financing Cost terms, since an all-cash purchase has no loan to originate
// or pay interest on.
//
// Selling Costs are a flat 8% of ARV: realtor commission (~6%) plus title/escrow fees (~2%) on the
// resale side -- bumped up from a commission-only 6% since that left out real closing costs a seller
// pays at resale. Purchase Closing Costs are a separate, additional 1% of ARV on the BUY side: no
// commission (buyers don't typically pay realtor commission at purchase), just the buyer's customary
// share of title/escrow fees, applied to every variant (Cash and Hard Money alike, since purchase
// closing costs are paid regardless of financing method -- this is distinct from Upfront Cash, which
// is a hard-money-loan-specific fee). Upfront Cash (hard-money loan points/fees) is 2% of ARV for
// residential 1-4 units, 3% for anything else (commercial/business) -- only charged on the Hard
// Money variants. Financing Cost% = a flat 12% approximate hard money annual rate x (estimated hold
// months / 12); hold months come from a rehab-severity tier bucketed by rehab as a % of ARV (<10%
// light, 10-25% moderate, >=25% heavy) -- the exact ratio cutoffs aren't specified by the given
// timeline matrices (which bucket by scope of work, not a number we collect), so this is the closest
// quantitative proxy available and should be tuned if it doesn't match real deals.
//
// Target ROI/ROC differs by variant and asset type:
// - Hard Money (10%/20% down), any asset type, and Cash Buyer on commercial/business: a floor that
//   steps down as ARV grows for residential (25% under $250k, 20% from $250k-$500k, 15% at $500k+),
//   or is keyed to the rehab-severity tier for commercial/business (18% light TI, 22% heavy adaptive
//   reuse, 25% ground-up).
// - Cash Buyer on residential: a separate "Target ROC by Strategy & Scope" scale specifically for an
//   all-cash fix-and-flip exit (buy, rehab, resell -- not a buy-and-hold cap rate, which would need
//   rental income data this flow doesn't collect), keyed to the same rehab-severity tier: 8-11%
//   Cosmetic Refresh, 12-15% Moderate Value-Add, 16-20%+ Heavy Gut/Structural, using the midpoint of
//   each range (9.5%/13.5%/18%).
//
// With these parameters (12% hard money rate, 2-15% financing cost depending on hold length, 2-3%
// upfront loan fees, 20-25% Hard Money ROI vs 9.5-22% Cash ROC), Cash Buyer MAO comes out HIGHER
// than both Hard Money variants in every case tested -- residential and commercial, light and heavy
// rehab. That's not a bug: the given Hard Money formula's financing cost and upfront loan fees are
// real dollar drags that a cash buyer never pays, and on top of that Cash Buyer's target return here
// is usually well below Hard Money's, so the two effects compound instead of leverage winning out.
// If the goal is for Hard Money to show as more competitive than Cash, the fix is to tune Hard
// Money's ROI down and/or its financing-cost assumptions down, not the Cash formula.
//
// Wholesale Fee defaults to the greater of $25,000 or 3% of ARV, applied to every variant -- pass a
// 4th argument (wholesaleFeeOverride) to use a specific dollar amount instead, e.g. when an associate
// has negotiated a smaller fee for a given deal.
function computeMaoSuite(arv, rehab, assetType, wholesaleFeeOverride, marketStatus, landDeferredFullValue) {
  if (!arv) return null;
  const isLand = assetType === "Land";
  // Land has no separate ARV/rehab concept -- the value plugged in here is already the As-Is
  // Value entered in Cash Deal Details (rehab is always 0), so the explanation text should say
  // that instead of "ARV" to match.
  const valueLabel = isLand ? "As-Is Value" : "ARV";
  const money = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const pct0 = n => (n * 100).toFixed(0) + "%";
  const hasOverride0 = wholesaleFeeOverride !== undefined && wholesaleFeeOverride !== null && wholesaleFeeOverride !== "";
  const wholesaleFee0 = hasOverride0 ? Number(wholesaleFeeOverride) : Math.max(25000, 0.03 * arv);

  // Land skips the leveraged/hard-money underwriting model below entirely -- there's no rehab/
  // resale cycle to run a target-ROI formula against, so land offers are priced as a straight
  // percentage of As-Is Value (from the land comps prompt in Cash Deal Details) instead:
  //   - On-Market / FSBO: open at 50% of As-Is Value, ceiling at 60% -- if the seller won't accept
  //     anywhere in that band, the listing needs to come OFF market before we can go any higher (an
  //     on-market seller has a realtor/buyer pool already working the listing, so there's no case
  //     for paying more while it's still up).
  //   - Off-Market: base the offer at 60% of As-Is Value, with room to negotiate up to a 70%
  //     ceiling if that's what it takes to close -- an off-market seller came to us directly, so
  //     there's more room to work with than a live listing.
  //   - Free and clear (no mortgage/liens) AND the seller is willing to wait to get paid until the
  //     land is developed/sold: 100% of As-Is Value, paid out of development/resale proceeds
  //     instead of at closing (see landFreeAndClear / landWillingToWaitForDev in Cash Deal Details).
  // Every variant still nets out the wholesale/assignment fee the same way the leveraged formula
  // does below (the greater of $25,000 or 3% of As-Is Value, or a manually negotiated override).
  if (isLand) {
    const isOnMarket = marketStatus !== "Off-Market"; // default to the more conservative on-market band
    let openPct, ceilPct;
    if (landDeferredFullValue) { openPct = 1.00; ceilPct = 1.00; }
    else if (isOnMarket) { openPct = 0.50; ceilPct = 0.60; }
    else { openPct = 0.60; ceilPct = 0.70; }
    const openMao = (arv * openPct) - wholesaleFee0;
    const ceilMao = (arv * ceilPct) - wholesaleFee0;
    const feeNote = `minus a ${money(wholesaleFee0)} wholesale/assignment fee — the greater of $25,000 or 3% of As-Is Value`;
    const openExplanation = landDeferredFullValue
      ? `${money(arv)} As-Is Value at 100% (free and clear, paid once the land is developed/sold -- not at closing), ${feeNote}`
      : `${money(arv)} As-Is Value x ${pct0(openPct)} opening offer (${isOnMarket ? "On-Market/FSBO" : "Off-Market"}), ${feeNote}`;
    const ceilExplanation = landDeferredFullValue
      ? openExplanation
      : `${money(arv)} As-Is Value x ${pct0(ceilPct)} -- the absolute ceiling${isOnMarket
          ? ", above which this needs to come off-market before we can go any higher"
          : ", only go this high if it's what it takes to close off-market"}, ${feeNote}`;
    const openLabel = landDeferredFullValue ? "Full Value (Deferred)" : `Opening Offer (${pct0(openPct)})`;
    const ceilLabel = landDeferredFullValue ? "Full Value (Deferred)" : `Ceiling (${pct0(ceilPct)})`;
    const sheetBlurbLand = (label, mao, explanation) =>
      `Maximum Allowable Offer — ${label}: ${money(mao)}\n(${explanation}) = ${money(mao)}`;
    const fullBreakdownLand = landDeferredFullValue
      ? sheetBlurbLand(openLabel, openMao, openExplanation)
      : [sheetBlurbLand(openLabel, openMao, openExplanation), sheetBlurbLand(ceilLabel, ceilMao, ceilExplanation)].join("\n\n");
    return {
      isLand: true, isOnMarket, landDeferredFullValue: !!landDeferredFullValue,
      maoCash: openMao, maoHardMoney10: ceilMao, maoHardMoney20: ceilMao,
      cashExplanation: openExplanation, hm10Explanation: ceilExplanation, hm20Explanation: ceilExplanation,
      fullBreakdown: fullBreakdownLand, tierName: "Land", targetRoi: null, hm10Label: ceilLabel, hm20Label: ceilLabel
    };
  }

  const isCommercial = assetType !== "Residential Property (1-4 units)";
  const ratio = rehab / arv;
  let tierName, months, targetRoi, cashTargetRoc;
  if (isCommercial) {
    if (ratio < 0.10) { tierName = "Light Tenant Improvement"; months = 3.5; targetRoi = 0.18; }
    else if (ratio < 0.25) { tierName = "Heavy Adaptive Reuse / Value-Add"; months = 9; targetRoi = 0.22; }
    else { tierName = "Ground-Up / Major Expansion"; months = 15; targetRoi = 0.25; }
    cashTargetRoc = targetRoi;
  } else {
    if (ratio < 0.10) { tierName = "Cosmetic Refresh"; months = 2.5; cashTargetRoc = 0.095; }
    else if (ratio < 0.25) { tierName = "Moderate Rehab"; months = 5; cashTargetRoc = 0.135; }
    else { tierName = "Full Gut / Structural"; months = 8.5; cashTargetRoc = 0.18; }
    targetRoi = arv < 250000 ? 0.25 : (arv < 500000 ? 0.20 : 0.15);
  }
  const financingCostPct = 0.12 * (months / 12);
  const sellingCosts = 0.08 * arv;
  const purchaseClosingCosts = 0.01 * arv;
  const upfrontCashPct = isCommercial ? 0.03 : 0.02;
  const upfrontCash = upfrontCashPct * arv;
  const hasOverride = wholesaleFeeOverride !== undefined && wholesaleFeeOverride !== null && wholesaleFeeOverride !== "";
  const wholesaleFee = hasOverride ? Number(wholesaleFeeOverride) : Math.max(25000, 0.03 * arv);

  const pct1 = n => (n * 100).toFixed(1) + "%";

  // Cash Buyer has no loan at all, so it isn't the "100% down payment" case of the leveraged
  // formula below -- plugging DP%=100% into that formula's "1 + [DP%x(1+ROI)]" denominator double
  // counts return-of-capital (the leading "1" already represents repaying the full price; adding
  // "+100%" on top repays it a second time), which understates Cash Buyer MAO by roughly half.
  // Solving the same target-ROI-on-cash-invested equation with no debt at all collapses cleanly to:
  //   MAO = (ARV - Rehab - Selling Costs) / (1 + Target ROC) - Wholesale Fee
  // matching the fee-subtracted-after-division convention the leveraged formula also uses.
  const cashMao = ((arv - rehab - sellingCosts - purchaseClosingCosts) / (1 + cashTargetRoc)) - wholesaleFee;
  const cashExplanation = `${money(arv)} ${valueLabel}, minus ${money(rehab)} repairs, minus ${money(sellingCosts)} selling `
    + `costs (8% of ${valueLabel} -- realtor commission plus title/escrow fees), minus ${money(purchaseClosingCosts)} `
    + `purchase-side closing costs (1% of ${valueLabel} -- title/escrow only, no commission on the buy side; buyer and `
    + `seller customarily split closing costs this way), divided by 1 + a ${pct1(cashTargetRoc)} target ROC `
    + `for this deal profile (${tierName}) -- no financing cost or upfront loan fees, since an all-cash `
    + `purchase has no loan -- minus a ${money(wholesaleFee)} wholesale fee — the greater of $25,000 or 3% of ${valueLabel}`;
  const cash = { mao: cashMao, explanation: cashExplanation };

  function variant(downPaymentPct, downPaymentLabel, roi, roiLabel) {
    const numerator = arv - rehab - sellingCosts - purchaseClosingCosts - (upfrontCash * (1 + roi));
    const denominator = 1 + (downPaymentPct * (1 + roi)) + financingCostPct;
    const mao = (numerator / denominator) - wholesaleFee;
    const explanation = `${money(arv)} ${valueLabel}, minus ${money(rehab)} repairs, minus ${money(sellingCosts)} selling `
      + `costs (8% of ${valueLabel} -- realtor commission plus title/escrow fees), minus ${money(purchaseClosingCosts)} `
      + `purchase-side closing costs (1% of ${valueLabel} -- title/escrow only, no commission on the buy side; buyer `
      + `and seller customarily split closing costs this way), minus ${money(upfrontCash)} upfront hard money `
      + `loan fees (${pct0(upfrontCashPct)} of ${valueLabel}) grossed up by the target ${roiLabel}, all divided by `
      + `1 + [${downPaymentLabel} down payment x (1 + ${pct1(roi)} target ${roiLabel})] + `
      + `${pct1(financingCostPct)} financing cost (a 12% approximate hard money rate over an estimated `
      + `${months}-month ${tierName.toLowerCase()} hold), minus a ${money(wholesaleFee)} wholesale fee — `
      + `the greater of $25,000 or 3% of ${valueLabel}`;
    return { mao, explanation };
  }

  // Land no longer reaches this code at all (see the early return above) -- it's priced as a
  // straight percentage of As-Is Value, not this leveraged hard-money model, so these are always
  // the residential/commercial 10%/20% down payment figures now.
  const dp1Pct = 0.10;
  const dp1Label = "10%";
  const dp2Pct = 0.20;
  const dp2Label = "20%";
  const hm10 = variant(dp1Pct, dp1Label, targetRoi, "ROI");
  const hm20 = variant(dp2Pct, dp2Label, targetRoi, "ROI");

  const sheetBlurb = (label, mao, explanation) =>
    `Maximum Allowable Offer — ${label}: ${money(mao)}\n(${explanation}) = ${money(mao)}`;
  const fullBreakdown = [
    sheetBlurb("Cash Buyer", cash.mao, cash.explanation),
    sheetBlurb(`Hard Money Buyer (${dp1Label} Down)`, hm10.mao, hm10.explanation),
    sheetBlurb(`Hard Money Buyer (${dp2Label} Down)`, hm20.mao, hm20.explanation)
  ].join("\n\n");

  return {
    maoCash: cash.mao, maoHardMoney10: hm10.mao, maoHardMoney20: hm20.mao,
    cashExplanation: cash.explanation, hm10Explanation: hm10.explanation, hm20Explanation: hm20.explanation,
    fullBreakdown, tierName, targetRoi, hm10Label: dp1Label, hm20Label: dp2Label
  };
}

function shouldSkip(step) {
  return typeof step.skip === "function" && step.skip();
}

function nextIndex(from) {
  let i = from + 1;
  while (i < steps.length - 1 && shouldSkip(steps[i])) i++;
  return i;
}

function prevIndex(from) {
  let i = from - 1;
  while (i > 0 && shouldSkip(steps[i])) i--;
  return i;
}

function renderProgress() {
  const bar = document.getElementById("progress-bar");
  const trackable = steps.filter(s => s.progress && !shouldSkip(s));
  const currentTrackableIdx = steps.slice(0, stepIndex + 1).filter(s => s.progress && !shouldSkip(s)).length;
  bar.innerHTML = trackable.map((_, i) => `<div class="${i < currentTrackableIdx ? "done" : ""}"></div>`).join("");
}

function renderStep() {
  const container = document.getElementById("step-container");
  const step = steps[stepIndex];
  step.render(container);
  wireMoneyEchoesIn(container);
  renderProgress();

  if (stepIndex === 0) return; // intro provides its own full navigation

  if (stepIndex > 1 && answers.email) {
    const emailBanner = document.createElement("div");
    emailBanner.className = "banner info";
    emailBanner.style.marginBottom = "16px";
    emailBanner.innerHTML = `Submitting as <strong>${escapeHtml(answers.email)}</strong> — your leads (and any
      notes you add to them later) will be accessible using this exact email address, so please use one only
      you have access to.`;
    container.insertBefore(emailBanner, container.firstChild);
  }

  const nav = document.createElement("div");
  nav.className = "nav-row";
  const isLast = stepIndex === steps.length - 1;
  nav.innerHTML = `
    ${stepIndex > 0 ? `<button class="btn secondary" id="back-btn">Back</button>` : `<span></span>`}
    <button class="btn primary" id="next-btn">${isLast ? "Submit" : "Next"}</button>
  `;
  container.appendChild(nav);

  if (stepIndex > 0) container.querySelector("#back-btn").onclick = () => goTo(prevIndex(stepIndex));
  container.querySelector("#next-btn").onclick = () => {
    if (step.validate && !step.validate(container)) return;
    maybeEarlyCaptureEmail();
    if (isLast) { submitLead(container); return; }
    goTo(nextIndex(stepIndex));
  };
}

// Syncs to beehiiv (tagged seller-lead + role, same as a real submission)
// the moment email + role are known -- step 1, long before the 13-step
// wizard actually finishes. Without this, anyone who abandons partway
// through never gets captured at all. Fires once per session (harmless if
// it somehow fired twice -- beehiiv's reactivate_existing just re-syncs
// the same subscriber), fire-and-forget so a slow/failed network call
// never blocks navigation.
let earlyCaptureDone = false;
function maybeEarlyCaptureEmail() {
  if (earlyCaptureDone || !answers.email) return;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.email);
  if (!emailOk) return;
  earlyCaptureDone = true;
  rememberEmail(answers.email);
  api("earlyCaptureLead", { data: { name: answers.name, email: answers.email, role: answers.role } }).catch(() => {});
}

function goTo(idx) {
  stepIndex = idx;
  renderStep();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function submitLead(container) {
  const btn = container.querySelector("#next-btn");
  btn.disabled = true;
  btn.textContent = "Submitting...";
  const errBox = container.querySelector("#submit-error");
  try {
    const res = await api("submitLead", {
      data: {
        role: answers.role, name: answers.name, email: answers.email, phone: answers.phone, socialLink: answers.socialLink,
        referrerName: answers.referrerName, referrerPhone: answers.referrerPhone,
        sellerContactName: answers.sellerContactName, sellerContactPhone: answers.sellerContactPhone,
        sellerContactEmail: answers.sellerContactEmail,
        street: answers.street, parcelIds: answers.parcelIds, city: answers.city, state: answers.state, zip: answers.zip, units: answers.units,
        assetType: answers.assetType, assetSubtype: answers.assetSubtype,
        beds: answers.beds, baths: answers.baths, sqft: answers.sqft, sellerReportedSqft: answers.sellerReportedSqft, acreage: answers.acreage, landZoning: answers.landZoning,
        landFreeAndClear: answers.landFreeAndClear || "", landWillingToWaitForDev: answers.landWillingToWaitForDev || "",
        dealType: answers.dealType, dealCategory: answers.dealCategory,
        arv: answers.arv, askingPrice: answers.askingPrice, chaseEstimate: answers.chaseEstimate, asIsValue: answers.asIsValue, picturesLink: answers.picturesLink, rehabEstimate: answers.rehabEstimate,
        rehabEstimateLow: answers.rehabEstimateLow, rehabEstimateHigh: answers.rehabEstimateHigh, rehabAiText: answers.rehabAiText || "",
        countyAssessedValue: answers.countyAssessedValue,
        cmaScreenshotUrls: (answers.cmaScreenshotUrls || []).join("\n"),
        arvRange: answers.arvRange || "",
        soldCompsJson: answers.soldCompsJson || "",
        activeCompsJson: answers.activeCompsJson || "",
        bottomDollarPrice: answers.bottomDollarPrice,
        cashDealNotes: answers.cashDealNotes, wholesaleFee: answers.wholesaleFee,
        maoCash: answers.maoCash, maoHardMoney10: answers.maoHardMoney10, maoHardMoney20: answers.maoHardMoney20,
        maoBreakdown: answers.maoBreakdown,
        underContract: answers.underContract, sellerAcceptedPrice: answers.sellerAcceptedPrice,
        isTearDown: answers.isTearDown || "", exclusiveDdAgreed: answers.exclusiveDdAgreed || "",
        sellerDeclinedCash: answers.sellerDeclinedCash ? "Yes" : "",
        sellerDeclinedSellerFinancing: answers.sellerDeclinedSellerFinancing ? "Yes" : "",
        sellerFinancingAccepted: answers.sellerFinancingAccepted, sellerFinancingNegotiationNotes: answers.sellerFinancingNegotiationNotes,
        propertyRentReady: answers.propertyRentReady,
        buyerIntendsToSell: answers.buyerIntendsToSell ? "Yes" : "",
        occupiedStatus: answers.residentialOccupied, monthlyRentEstimate: answers.rentcastMonthlyRent,
        strAnnualRevenue: answers.strAnnualRevenue, strNOI: answers.strNOI,
        annualPropertyTaxes: answers.annualPropertyTaxes, annualInsurance: answers.annualInsurance,
        expenseRatio: answers.expenseRatio,
        hasRentRolls: answers.hasRentRolls, hasProfitLoss: answers.hasProfitLoss,
        deliverableVacant: answers.deliverableVacant, currentLeaseTerm: answers.currentLeaseTerm,
        leaseEndDate: answers.leaseEndDate, tenantWouldMoveEarly: answers.tenantWouldMoveEarly,
        strNoiPerUnit: answers.strNoiPerUnit,
        noi: answers.residentialNOI || answers.commercialNOI,
        commercialOccupancyStatus: answers.commercialOccupancyStatus, commercialOccupancyPct: answers.commercialOccupancyPct,
        noiResearchNotes: answers.noiResearchNotes,
        businessRevenue: answers.businessRevenue, businessEarningsType: answers.businessEarningsType,
        businessEarnings: answers.businessEarnings,
        totalDebt: answers.debtUnknown ? "" : answers.totalDebt,
        seniorLoanWilling: answers.seniorLoanWilling, paymentStructureWilling: answers.paymentStructureWilling,
        priceSought: answers.priceSought, priceReasoning: answers.priceReasoning,
        downPaymentIntent: answers.dpSkipped ? "" : answers.downPaymentIntent,
        downPaymentNeeded: answers.dpSkipped ? "" : answers.downPaymentNeeded,
        downPaymentNonNegotiable: answers.downPaymentNonNegotiable,
        marketStatus: answers.marketStatus, sourceLink: answers.sourceLink,
        preforeclosureDebt: answers.preforeclosureDebt, arrearsAmount: answers.arrearsAmount,
        subjectToOnlyPossible: answers.subjectToOnlyPossible,
        payoffStatementUrls: (answers.payoffStatementUrls || []).join("\n"),
        payoffStatementNotes: answers.payoffStatementNotes,
        loanMonthlyPayment: answers.loanMonthlyPayment, loanMonthlyPrincipal: answers.loanMonthlyPrincipal,
        loanMonthlyInterest: answers.loanMonthlyInterest, loanMonthlyTaxes: answers.loanMonthlyTaxes,
        loanMonthlyInsurance: answers.loanMonthlyInsurance,
        yearBuilt: answers.yearBuilt, purchaseYear: answers.purchaseYear,
        monthsBehindOnPayments: answers.monthsBehindOnPayments, annualMaintenanceSpend: answers.annualMaintenanceSpend,
        propertyPhotoUrls: (answers.propertyPhotoUrls || []).join("\n"),
        propertyPhotosLink: answers.propertyPhotosLink
      }
    });
    if (!res.ok) throw new Error(res.error || "Something went wrong.");
    const rows = buildAnswerRows();
    container.innerHTML = `
      <div class="success-box">
        <div class="check">&#9989;</div>
        <h2>Thank you</h2>
        <p class="step-sub">Your submission was received. Any agreed terms will still be confirmed directly
        with our admin (${ADMIN_CONTACT_PHONE}) before anything closes. Here's a copy of what was submitted:</p>
      </div>
      <div class="banner info" style="text-align:left;">${FOLLOWUP_REMINDER}</div>
      <dl class="review-grid" style="text-align:left;">
        ${rows.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
      </dl>
      <div class="nav-row" style="justify-content:center; gap:12px;">
        <button class="btn secondary" id="check-status-from-success-btn">Check Status On My Existing Leads (Non-Admin)</button>
        <button class="btn primary" id="submit-another-btn">Submit Another Lead</button>
      </div>
    `;
    container.querySelector("#submit-another-btn").onclick = () => {
      Object.keys(answers).forEach(k => delete answers[k]);
      goTo(0);
    };
    container.querySelector("#check-status-from-success-btn").onclick = () => {
      const justSubmittedEmail = answers.email;
      Object.keys(answers).forEach(k => delete answers[k]);
      answers.email = justSubmittedEmail;
      stepIndex = 0;
      showStatusView();
    };
  } catch (err) {
    errBox.style.display = "block";
    errBox.textContent = "Submission failed: " + err.message + ". Please try again.";
    btn.disabled = false;
    btn.textContent = "Submit";
  }
}

/* ---------- Save/resume progress via URL (client-side only, no backend) ---------- */

// These are all recomputed automatically from other saved answers (arv, rehabEstimate, assetType,
// countyAssessedValue) whenever the relevant step renders or validates -- leaving them out of the
// save/resume link keeps it shorter (maoBreakdown especially, a multi-paragraph blurb) without
// losing anything, since they're never a source of truth themselves.
const DERIVED_ANSWER_KEYS = ["asIsValue", "maoCash", "maoHardMoney10", "maoHardMoney20", "maoBreakdown", "_autofillUrl"];

function buildShareUrl() {
  const trimmedAnswers = {};
  Object.keys(answers).forEach(k => {
    if (!DERIVED_ANSWER_KEYS.includes(k)) trimmedAnswers[k] = answers[k];
  });
  const payload = JSON.stringify({ a: trimmedAnswers, s: stepIndex });
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("resume", payload); // URLSearchParams handles encoding
  return url.toString();
}

// Lightweight "remember me" -- no password, no account, just avoids
// retyping the same email on a repeat visit from the same browser. Wrapped
// in try/catch since localStorage can throw (private browsing, blocked
// site data) and a missing value must never break the page.
const REMEMBERED_EMAIL_KEY = "sms_email";
function rememberEmail(email) {
  if (!email) return;
  try { localStorage.setItem(REMEMBERED_EMAIL_KEY, email); } catch (e) {}
}
function getRememberedEmail() {
  try { return localStorage.getItem(REMEMBERED_EMAIL_KEY) || ""; } catch (e) { return ""; }
}

function restoreFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("resume"); // already decoded by URLSearchParams
  if (!raw) return false;
  try {
    const payload = JSON.parse(raw);
    Object.assign(answers, payload.a || {});
    stepIndex = Math.min(Math.max(payload.s || 0, 0), steps.length - 1);
    return true;
  } catch (e) {
    return false;
  }
}

function restartWizard() {
  if (!confirm("Restart and clear all progress on this form? This can't be undone.")) return;
  Object.keys(answers).forEach(k => delete answers[k]);
  window.history.replaceState(null, "", window.location.pathname);
  document.getElementById("admin-view").hidden = true;
  document.getElementById("status-view").hidden = true;
  document.getElementById("public-view").hidden = false;
  goTo(0);
}

document.getElementById("restart-btn").onclick = restartWizard;
document.getElementById("status-followup-reminder").innerHTML = FOLLOWUP_REMINDER;

document.getElementById("save-progress-btn").onclick = () => {
  // Every step only writes its fields into `answers` inside validate() (normally triggered by the
  // Next button) -- so without this, anything typed into the CURRENT step but not yet advanced past
  // was silently missing from the saved link. Run validate() here purely for that side effect (sync
  // DOM -> answers), ignore its pass/fail, and clear any error highlights it triggers, since saving
  // progress with required fields still blank is explicitly allowed.
  const stepContainer = document.getElementById("step-container");
  const currentStep = steps[stepIndex];
  if (currentStep.validate) {
    currentStep.validate(stepContainer);
    stepContainer.querySelectorAll(".error-text.show").forEach(el => el.classList.remove("show"));
  }
  const url = buildShareUrl();
  window.history.replaceState(null, "", url);
  const message = "This saved link lets you pick up exactly where you left off. It's for your own use — anyone who has this link can see and resume this data, so don't share it with anyone else.";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      alert("Link copied to your clipboard.\n\n" + message);
    }).catch(() => {
      prompt(message + "\n\nCopy this link:", url);
    });
  } else {
    prompt(message + "\n\nCopy this link:", url);
  }
};

if (!restoreFromUrl() && !answers.email) {
  answers.email = getRememberedEmail();
}
renderStep();

/* ============================================================
   NON-ADMIN: CHECK MY LEADS BY EMAIL
   No password on this path by design — knowing the email is the access
   check, matching how the backend's getLeadsByEmail/addPublicNote work.
   ============================================================ */

function showStatusView() {
  document.getElementById("public-view").hidden = true;
  document.getElementById("status-view").hidden = false;
  document.getElementById("status-email-input").value = answers.email || "";
  document.getElementById("status-leads-container").innerHTML = "";
  document.getElementById("status-pagination").innerHTML = "";
  document.getElementById("status-message").hidden = true;
  document.getElementById("status-email-error").classList.remove("show");
  statusSearchQuery = "";
  statusSortMode = "default";
  statusPage = 1;
  statusLeadsAll = [];
  statusLeadsEmail = "";
  document.getElementById("status-search-input").value = "";
  document.getElementById("status-search-input").hidden = true;
  document.getElementById("status-sort-select").value = "default";
  document.getElementById("status-sort-select").hidden = true;
}

function hideStatusView() {
  document.getElementById("status-view").hidden = true;
  document.getElementById("public-view").hidden = false;
}

document.getElementById("status-back-btn").onclick = hideStatusView;

document.getElementById("status-search-input").oninput = (e) => {
  statusSearchQuery = e.target.value.trim();
  statusPage = 1;
  renderStatusResultsTable(statusLeadsEmail, statusLeadsAll);
};

document.getElementById("status-sort-select").onchange = (e) => {
  statusSortMode = e.target.value;
  statusPage = 1;
  renderStatusResultsTable(statusLeadsEmail, statusLeadsAll);
};

document.getElementById("status-lookup-btn").onclick = async () => {
  const emailInput = document.getElementById("status-email-input");
  const email = emailInput.value.trim();
  const errEl = document.getElementById("status-email-error");
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  errEl.classList.toggle("show", !emailOk);
  if (!emailOk) return;
  rememberEmail(email);

  statusSearchQuery = "";
  statusPage = 1;
  document.getElementById("status-search-input").value = "";

  const msgEl = document.getElementById("status-message");
  msgEl.hidden = false;
  msgEl.className = "banner info";
  msgEl.textContent = "Looking up your leads...";
  document.getElementById("status-leads-container").innerHTML = "";

  const res = await api("getLeadsByEmail", { email });
  if (!res.ok) {
    msgEl.className = "banner danger";
    msgEl.textContent = res.error || "Something went wrong.";
    return;
  }
  if (res.leads.length === 0) {
    msgEl.className = "banner info";
    msgEl.textContent = "No leads found for that email address.";
    return;
  }
  msgEl.hidden = true;
  renderStatusResultsTable(email, res.leads);
};

function buildLeadFields(lead) {
  const fields = [
    ["Submitted", formatDate(lead["Submitted At"])],
    ["Role", lead["Role"]], ["Name", lead["Contact Name"]], ["Email", lead["Contact Email"]], ["Phone", lead["Contact Phone"]],
    ["Social Link", lead["Social Link"] || "—"],
    ["Referred By", lead["Referrer Name"] || "—"], ["Referrer Phone", lead["Referrer Phone"] || "—"],
  ];
  if (lead["Role"] && lead["Role"] !== "Seller") {
    fields.push(
      ["Seller/Realtor/Broker Name", lead["Seller Contact Name"] || "—"],
      ["Seller/Realtor/Broker Phone", lead["Seller Contact Phone"] || "—"],
      ["Seller/Realtor/Broker Email", lead["Seller Contact Email"] || "—"]
    );
  }
  fields.push(
    ["Address", `${lead["Street Address"]}, ${lead["City"]}, ${lead["State"]} ${lead["Zip"]}`],
    ["Parcel ID(s)", lead["Parcel IDs"] || "—"],
    ["Units", lead["Units"]],
    ["Asset Type", lead["Asset Type"]], ["Subtype", lead["Asset Subtype"] || "—"],
    ["Beds", lead["Beds"] || "—"], ["Baths", lead["Baths"] || "—"], ["Acreage", lead["Acreage"] || "—"], ["Sq Ft", lead["Sq Ft"] || "—"],
    ["Deal Type", lead["Deal Type"] || "—"]
  );
  if (lead["Asset Type"] === "Commercial Property" && lead["Market Status"] === "Off-Market") {
    fields.push(["Seller Reported Sq Ft", lead["Seller Reported Sq Ft"] || "—"]);
  }
  if (lead["Deal Category"]) {
    fields.push(["Deal Category", lead["Deal Category"]]);
  }
  if (lead["Asset Type"] === "Land") {
    fields.push(["Zoning", lead["Land Zoning"] || "—"]);
  }
  // Mirrors buildAnswerRows() -- Seller Financing deals now collect both the ARV/rehab/comps block
  // AND the income/NOI block, so these two ifs are independent (not else-if) to let both show.
  const showsCashDealFields = lead["Deal Type"] === "Cash Deal" || lead["Deal Type"] === "Seller Financing / Creative Finance";
  if (showsCashDealFields) {
    fields.push(
      ["Chase Bank Estimated Value", lead["Chase Estimated Value"] || "—"],
      ["Asking Price", lead["Asking Price"] || "—"],
      ["ARV", lead["ARV"] || "—"],
      ["As-Is Value", lead["As-Is Value"] || "—"],
      ["Pictures Link", lead["Pictures Link"] || "—"],
      ["Rehab Estimate — Low", lead["Rehab Estimate Low"] || "—"],
      ["Rehab Estimate — High", lead["Rehab Estimate High"] || "—"],
      ["Rehab Estimate (average)", lead["Rehab Estimate"] || "—"],
      ["County Assessed Value", lead["County Assessed Value"] || "—"],
      ["CMA Screenshots", lead["CMA Screenshot URLs"] || "—"],
      ["ARV Range (AI Comps)", lead["ARV Range"] || "—"],
      ["Bottom Dollar Price", lead["Bottom Dollar Price"] || "—"],
      ["Notes (Why Sell / Good Lead)", lead["Cash Deal Notes"] || "—"]
    );
    if (lead["Asset Type"] === "Commercial Property") {
      fields.push(
        ["Occupancy Status", lead["Commercial Occupancy Status"] || "—"],
        ["Occupancy %", lead["Commercial Occupancy %"] || "—"],
        ["NOI", lead["NOI"] || "—"],
        ["NOI Research Notes", lead["NOI Research Notes"] || "—"]
      );
      if (lead["Commercial Occupancy Status"] === "Vacant" && lead["Market Status"] !== "On-Market") {
        fields.push(["Property Photos", lead["Property Photo URLs"] || "—"]);
      }
    }
    if (lead["Role"] !== "Seller") {
      if (lead["Deal Type"] === "Cash Deal") {
        fields.push(
          ["Wholesale Fee", lead["Wholesale Fee"] || "—"],
          ["Under Contract", lead["Under Contract"] || "—"],
          ["Seller Accepted Price", lead["Seller Accepted Price"] || "—"]
        );
        if (lead["Asset Type"] !== "Land" && lead["Market Status"] === "On-Market"
          && lead["Deal Category"] !== "Upcoming Auction/Preforeclosure Property") {
          fields.push(["Full Tear-Down / Rebuild", lead["Full Tear-Down / Rebuild"] || "—"]);
        }
        if (lead["Market Status"] === "On-Market" && lead["Deal Category"] !== "Upcoming Auction/Preforeclosure Property"
          && (lead["Asset Type"] === "Residential Property (1-4 units)" || lead["Asset Type"] === "Commercial Property" || lead["Asset Type"] === "Land")) {
          fields.push(["Exclusive Agreement Through Due Diligence", lead["Exclusive Agreement Through Due Diligence"] || "—"]);
        }
      }
      // Make Your Offers runs for Cash Deal and Seller Financing alike, so these fields (and the
      // Highest MAO it's built around) need to show for both -- previously gated to Cash Deal only,
      // which silently hid all of this for Seller Financing leads.
      if (lead["Asset Type"] !== "Land" && lead["Asset Type"] !== "Business") {
        const maoCandidates = [lead["MAO Cash"], lead["MAO Hard Money (10% Down)"], lead["MAO Hard Money (20% Down)"]]
          .map(Number).filter(n => n > 0);
        if (maoCandidates.length) {
          fields.push(["Highest Max Allowable Offer", "$" + Math.round(Math.max(...maoCandidates)).toLocaleString()]);
        }
        fields.push(
          ["Seller Declined Cash Offer", lead["Seller Declined Cash"] || "No"],
          ["Seller Declined Seller Financing", lead["Seller Declined Seller Financing"] || "No"],
          ["Seller Financing Accepted (20% Down)", lead["Seller Financing Accepted"] || "—"],
          ["Seller Financing Negotiation Notes", lead["Seller Financing Negotiation Notes"] || "—"]
        );
      }
    }
  }
  if (lead["Deal Category"] === "Upcoming Auction/Preforeclosure Property") {
    fields.push(
      ["Year Built", lead["Year Built"] || "—"],
      ["Purchase Year", lead["Purchase Year"] || "—"],
      ["Months Behind on Payments", lead["Months Behind On Payments"] || "—"],
      ["Annual Maintenance Spend", lead["Annual Maintenance Spend"] || "—"],
      ["Property Photos", lead["Property Photo URLs"] || "—"],
      ["Property Photos Link", lead["Property Photos Link"] || "—"],
      ["Existing Debt / Payoff Amount", lead["Preforeclosure Debt"] || "—"],
      ["Arrears Amount", lead["Arrears Amount"] || "—"],
      ["Subject To Only Possible", lead["Subject To Only Possible"] || "—"]
    );
    if (lead["Subject To Only Possible"] === "Yes") {
      fields.push(
        ["Payoff Statement Screenshots", lead["Payoff Statement URLs"] || "—"],
        ["Payoff Statement Notes", lead["Payoff Statement Notes"] || "—"],
        ["Loan Monthly Payment", lead["Loan Monthly Payment"] || "—"],
        ["Loan Monthly Principal", lead["Loan Monthly Principal"] || "—"],
        ["Loan Monthly Interest", lead["Loan Monthly Interest"] || "—"],
        ["Loan Monthly Taxes", lead["Loan Monthly Taxes"] || "—"],
        ["Loan Monthly Insurance", lead["Loan Monthly Insurance"] || "—"]
      );
    }
  }
  if (lead["Deal Type"] !== "Cash Deal" || lead["Role"] === "Seller") {
    if (lead["Asset Type"] === "Residential Property (1-4 units)") {
      fields.push(["Rent Ready", lead["Rent Ready"] || "—"]);
      const buyerIntendsToSell = lead["Rent Ready"] === "No" && lead["Buyer Intends To Sell"] === "Yes";
      if (lead["Rent Ready"] === "No") {
        fields.push(["Buyer Intends To Sell", lead["Buyer Intends To Sell"] || "No"]);
      }
      if (!buyerIntendsToSell) {
        fields.push(["Occupied Status", lead["Occupied Status"] || "—"]);
      }
      if (lead["Occupied Status"] === "Vacant (no tenant)") {
        fields.push(
          ["Annual Property Taxes", lead["Annual Property Taxes"] || "—"],
          ["Annual Insurance", lead["Annual Insurance"] || "—"],
          ["Rentcast Monthly Rent", lead["Monthly Rent Estimate"] || "—"],
          ["Expense Ratio %", lead["Expense Ratio %"] || "—"],
          ["Long-Term Rental NOI", lead["NOI"] || "—"],
          ["STR Annual Revenue (airdna.co)", lead["STR Annual Revenue"] || "—"],
          ["Short-Term Rental NOI", lead["STR NOI"] || "—"]
        );
      } else if (lead["Occupied Status"] === "Occupied (has a landlord/tenant)") {
        fields.push(
          ["Long-Term Rental NOI", lead["NOI"] || "—"],
          ["Annual Property Taxes", lead["Annual Property Taxes"] || "—"],
          ["Annual Insurance", lead["Annual Insurance"] || "—"],
          ["Has 12mo Rent Rolls", lead["Has Rent Rolls"] || "—"],
          ["Has 12mo P&L", lead["Has Rent Rolls"] === "Yes" ? (lead["Has P&L"] || "—") : "N/A"],
          ["Deliverable Vacant", lead["Deliverable Vacant"] || "—"],
          ["Current Lease Term", lead["Current Lease Term"] || "—"]
        );
        if (Number(lead["Units"]) === 1) {
          fields.push(
            ["Lease End Date", lead["Lease End Date"] || "—"],
            ["Tenant Would Move Early", lead["Tenant Would Move Early"] || "—"]
          );
        } else {
          fields.push(["STR NOI Per Unit", lead["STR NOI Per Unit"] || "—"]);
        }
        if (lead["Deliverable Vacant"] === "Yes" && lead["STR Annual Revenue"]) {
          fields.push(
            ["STR Annual Revenue (airdna.co)", lead["STR Annual Revenue"] || "—"],
            ["Short-Term Rental NOI", lead["STR NOI"] || "—"]
          );
        }
      }
    } else if (lead["Asset Type"] === "Business") {
      fields.push(
        ["Annual Revenue", lead["Business Revenue"] || "—"],
        [`Annual ${lead["Business Earnings Type"] || "Earnings"}`, lead["Business Earnings"] || "—"]
      );
    }
  }
  fields.push(
    ["Total Debt", lead["Total Debt"]],
    ["Willing: New Senior Loan", lead["Senior Loan Willing"]],
    ["Willing: Payment Structure", lead["Payment Structure Willing"]],
    ["Price Sought", lead["Price Sought"]], ["Price Reasoning", lead["Price Reasoning"]],
    ["Down Payment Intended Use", lead["Down Payment Intent"] || "—"],
    ["Down Payment Needed", lead["Down Payment Needed"]],
    ["Seller Flexible on Down Payment", lead["Down Payment Non-Negotiable"]],
    ["On/Off Market", lead["Market Status"] || "—"],
    ["Listing Source Link", lead["Source Link"] || "—"],
    ["Status", lead["Status"] || "New"]
  );
  return fields;
}

let statusLeadsAll = [];
let statusLeadsEmail = "";
let statusSearchQuery = "";
let statusSortMode = "default";
let statusPage = 1;

// Shared between the admin CRM and a user's own "check status" lead list -- both can otherwise
// grow into an endless-scroll table once someone's been submitting leads for a while.
const LEADS_PAGE_SIZE = 100;

// containerId: element to render Prev/Next controls into. page/totalItems/pageSize: current state.
// onChange(newPage): called with the page to switch to; caller re-renders its own table.
function renderPaginationControls(containerId, page, totalItems, pageSize, onChange) {
  const container = document.getElementById(containerId);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalPages <= 1) { container.innerHTML = ""; return; }
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalItems);
  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; flex-wrap:wrap;">
      <span class="small-muted">Showing ${startItem}&ndash;${endItem} of ${totalItems}</span>
      <div style="display:flex; align-items:center; gap:10px;">
        <button type="button" class="btn secondary" id="${containerId}-prev" ${page <= 1 ? "disabled" : ""}>Previous</button>
        <span class="small-muted">Page ${page} of ${totalPages}</span>
        <button type="button" class="btn secondary" id="${containerId}-next" ${page >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    </div>
  `;
  container.querySelector(`#${containerId}-prev`).onclick = () => onChange(page - 1);
  container.querySelector(`#${containerId}-next`).onclick = () => onChange(page + 1);
}

function leadMatchesAddressSearch(lead, query) {
  if (!query) return true;
  const haystack = [lead["Street Address"], lead["City"], lead["State"], lead["Zip"]]
    .map(v => String(v || "").toLowerCase()).join(" ");
  return haystack.indexOf(query.toLowerCase()) !== -1;
}

function renderStatusResultsTable(email, leads) {
  statusLeadsAll = leads;
  statusLeadsEmail = email;
  const container = document.getElementById("status-leads-container");
  const paginationEl = document.getElementById("status-pagination");
  const searchInput = document.getElementById("status-search-input");
  const sortSelect = document.getElementById("status-sort-select");
  searchInput.hidden = leads.length <= 1;
  sortSelect.hidden = leads.length <= 1;

  const filteredLeads = leads
    .filter(lead => leadMatchesAddressSearch(lead, statusSearchQuery))
    .sort(leadSortComparator(statusSortMode, statusSortIndex));

  if (filteredLeads.length === 0) {
    container.innerHTML = `<p class="small-muted" style="padding:12px;">${leads.length === 0 ? "No leads found for that email address." : "No leads match your search."}</p>`;
    paginationEl.innerHTML = "";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / LEADS_PAGE_SIZE));
  if (statusPage > totalPages) statusPage = totalPages;
  const pageStart = (statusPage - 1) * LEADS_PAGE_SIZE;
  const visibleLeads = filteredLeads.slice(pageStart, pageStart + LEADS_PAGE_SIZE);

  container.innerHTML = `
    <table class="crm-table">
      <thead>
        <tr>
          <th>Submitted</th><th>Role</th><th>Contact</th><th>Address</th><th>Asset Type</th><th>Senior Loan</th><th>Payment Structure</th><th>Price Sought</th><th>Status</th>
        </tr>
      </thead>
      <tbody id="status-results-tbody"></tbody>
    </table>
  `;
  const tbody = document.getElementById("status-results-tbody");
  tbody.innerHTML = visibleLeads.map((l, i) => `
    <tr data-idx="${i}">
      <td>${formatDate(l["Submitted At"])}</td>
      <td>${escapeHtml(l["Role"] || "")}</td>
      <td>${escapeHtml(l["Contact Name"] || "")}<br><span class="small-muted">${escapeHtml(l["Contact Email"] || "")} · ${escapeHtml(l["Contact Phone"] || "")}</span></td>
      <td>${escapeHtml(l["Street Address"] || "")}<br><span class="small-muted">${escapeHtml(l["City"] || "")}, ${escapeHtml(l["State"] || "")}</span></td>
      <td>${escapeHtml(l["Asset Type"] || "")}</td>
      <td>${escapeHtml(l["Senior Loan Willing"] || "")}</td>
      <td>${escapeHtml(l["Payment Structure Willing"] || "")}</td>
      <td>${escapeHtml(String(l["Price Sought"] ?? ""))}</td>
      <td>${statusPillHtml(l["Status"])}</td>
    </tr>
  `).join("");
  tbody.querySelectorAll("tr").forEach(tr => {
    tr.onclick = () => openStatusDetail(visibleLeads[Number(tr.dataset.idx)], email, leads);
  });

  renderPaginationControls("status-pagination", statusPage, filteredLeads.length, LEADS_PAGE_SIZE, (newPage) => {
    statusPage = newPage;
    renderStatusResultsTable(email, leads);
  });
}

function openStatusDetail(lead, email, leads) {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const fields = buildLeadFields(lead).filter(([k]) => k !== "Status");

  panel.innerHTML = `
    <button class="link-btn" id="close-detail-btn" style="float:right;">Close ✕</button>
    <h2>Lead Detail</h2>
    <div style="margin:8px 0 16px;">${statusPillHtml(lead["Status"])}</div>
    <dl class="review-grid">
      ${fields.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
    </dl>
    <div class="notes-list">
      <strong>Notes</strong>
      <p class="small-muted" style="margin:2px 0 8px;">Notes from admin appear here too. You can only edit or delete notes you added yourself.</p>
      <div class="status-notes-container" data-lead-id="${lead["Lead ID"]}">
        ${(lead.notes || []).map(n => renderStatusNoteItem(n, email)).join("") || `<p class="small-muted">No notes yet.</p>`}
      </div>
      <textarea class="status-note-input" placeholder="Add a note (this can't edit or delete the property/business info above — only admin can do that)"></textarea>
      <button class="btn primary status-add-note-btn" style="margin-top:8px;">Add Note</button>
    </div>
  `;

  panel.querySelector("#close-detail-btn").onclick = () => overlay.hidden = true;
  panel.querySelector(".status-add-note-btn").onclick = async () => {
    const textarea = panel.querySelector(".status-note-input");
    const note = textarea.value.trim();
    if (!note) return;
    const res = await api("addPublicNote", { email, leadId: lead["Lead ID"], note });
    if (res.ok) {
      lead.notes = lead.notes || [];
      lead.notes.push({ noteId: res.noteId, timestamp: new Date().toISOString(), note, author: email });
      openStatusDetail(lead, email, leads);
    }
  };

  bindStatusNoteEdits(panel, email, leads, () => openStatusDetail(lead, email, leads));
}

function renderStatusNoteItem(n, email) {
  const isMine = !!(n.author && email && n.author.toLowerCase() === email.toLowerCase());
  const authorLabel = isMine ? "You" : (n.author || "Admin");
  const badgeStyle = isMine
    ? "background:var(--accent-light); color:var(--accent);"
    : "background:var(--navy); color:#fff;";
  return `
    <div class="note-item" data-note-id="${n.noteId || ""}">
      <span class="ts">
        ${formatDate(n.timestamp)}
        <span style="${badgeStyle} padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; margin-left:4px;">${escapeHtml(authorLabel)}</span>
      </span>
      <span class="note-text">${escapeHtml(n.note)}</span>
      ${isMine && n.noteId ? `
        <button type="button" class="link-btn status-edit-note-btn" style="margin-left:8px;">Edit</button>
        <button type="button" class="link-btn status-delete-note-btn" style="margin-left:8px; color:var(--danger);">Delete</button>
      ` : ""}
    </div>
  `;
}

function bindStatusNoteEdits(container, email, leads, rerender) {
  container.querySelectorAll(".status-edit-note-btn").forEach(btn => {
    btn.onclick = () => {
      const item = btn.closest(".note-item");
      const noteId = item.dataset.noteId;
      const noteTextEl = item.querySelector(".note-text");
      const currentText = noteTextEl.textContent;
      item.innerHTML = `
        <textarea class="status-edit-note-input">${escapeHtml(currentText)}</textarea>
        <div class="nav-row" style="margin-top:6px;">
          <button type="button" class="btn secondary status-cancel-edit-btn">Cancel</button>
          <button type="button" class="btn primary status-save-edit-btn">Save</button>
        </div>
      `;
      item.querySelector(".status-cancel-edit-btn").onclick = () => rerender();
      item.querySelector(".status-save-edit-btn").onclick = async () => {
        const newText = item.querySelector(".status-edit-note-input").value.trim();
        if (!newText) return;
        const saveBtn = item.querySelector(".status-save-edit-btn");
        saveBtn.disabled = true;
        const res = await api("editPublicNote", { email, noteId, newText });
        if (res.ok) {
          leads.forEach(l => {
            (l.notes || []).forEach(n => {
              if (n.noteId === noteId) n.note = newText;
            });
          });
          rerender();
        } else {
          saveBtn.disabled = false;
        }
      };
    };
  });

  container.querySelectorAll(".status-delete-note-btn").forEach(btn => {
    btn.onclick = async () => {
      const item = btn.closest(".note-item");
      const noteId = item.dataset.noteId;
      if (!confirm("Delete this note? This cannot be undone.")) return;
      const res = await api("deletePublicNote", { email, noteId });
      if (res.ok) {
        leads.forEach(l => {
          l.notes = (l.notes || []).filter(n => n.noteId !== noteId);
        });
        rerender();
      }
    };
  });
}

/* ============================================================
   ADMIN
   ============================================================ */

let sessionToken = sessionStorage.getItem("adminToken") || null;
let currentLeads = [];
let lastExportToken = null;
let deleteConfirmStep = 0;
let lastMaoCalcSuite = null;

const adminModal = document.getElementById("admin-modal");
const loginForm = document.getElementById("login-form");
const forgotForm = document.getElementById("forgot-form");

document.getElementById("admin-access-btn").onclick = () => {
  if (sessionToken) { showAdminView(); return; }
  adminModal.hidden = false;
  loginForm.hidden = false;
  forgotForm.hidden = true;
};
document.getElementById("admin-cancel-btn").onclick = () => adminModal.hidden = true;

document.getElementById("admin-login-btn").onclick = async () => {
  const pw = document.getElementById("admin-password-input").value;
  const errEl = document.getElementById("login-error");
  errEl.classList.remove("show");
  try {
    const res = await api("adminLogin", { password: pw });
    if (!res.ok) { errEl.textContent = res.error || "Login failed."; errEl.classList.add("show"); return; }
    sessionToken = res.token;
    sessionStorage.setItem("adminToken", sessionToken);
    adminModal.hidden = true;
    showAdminView();
  } catch (e) {
    errEl.textContent = "Could not reach the server. Check config.js.";
    errEl.classList.add("show");
  }
};

document.getElementById("forgot-password-link").onclick = () => {
  loginForm.hidden = true;
  forgotForm.hidden = false;
};
document.getElementById("forgot-cancel-btn").onclick = () => {
  forgotForm.hidden = true;
  loginForm.hidden = false;
};
document.getElementById("forgot-submit-btn").onclick = async () => {
  const codeWord = document.getElementById("code-word-input").value;
  const resultEl = document.getElementById("forgot-result");
  resultEl.textContent = "Checking...";
  const res = await api("forgotPassword", { codeWord });
  resultEl.textContent = res.message || "If the code word was correct, a recovery email was just sent.";
};

document.getElementById("admin-logout-btn").onclick = () => {
  sessionToken = null;
  sessionStorage.removeItem("adminToken");
  document.getElementById("admin-view").hidden = true;
  document.getElementById("public-view").hidden = false;
};

document.getElementById("mao-calc-public-btn").onclick = openMaoCalculator;
document.getElementById("outreach-sop-btn").onclick = openOutreachSop;

document.getElementById("crm-search-input").oninput = (e) => {
  crmSearchQuery = e.target.value.trim();
  crmPage = 1;
  renderCrmTable();
};

document.getElementById("crm-sort-select").onchange = (e) => {
  crmSortMode = e.target.value;
  crmPage = 1;
  renderCrmTable();
};

async function showAdminView() {
  document.getElementById("public-view").hidden = true;
  document.getElementById("admin-view").hidden = false;
  await loadLeads();
}

function adminMessage(text, type) {
  const el = document.getElementById("admin-message");
  el.hidden = !text;
  el.textContent = text;
  el.className = "banner " + (type || "info");
}

let crmSearchQuery = "";
let crmSortMode = "default";
let crmPage = 1;

async function loadLeads() {
  adminMessage("Loading leads...", "info");
  const res = await api("getLeads", { token: sessionToken });
  if (!res.ok) { adminMessage(res.error, "danger"); return; }
  currentLeads = res.leads;
  crmPage = 1;
  adminMessage("", "info");
  renderCrmTable();
}

function leadMatchesSearch(l, query) {
  if (!query) return true;
  const haystack = [
    l["Street Address"], l["City"], l["State"], l["Zip"],
    l["Contact Name"], l["Contact Email"]
  ].map(v => String(v || "").toLowerCase()).join(" ");
  return haystack.indexOf(query.toLowerCase()) !== -1;
}

function renderCrmTable() {
  const tbody = document.getElementById("crm-tbody");
  const emptyEl = document.getElementById("crm-empty");
  const paginationEl = document.getElementById("crm-pagination");

  const filteredLeads = currentLeads
    .filter(l => leadMatchesSearch(l, crmSearchQuery))
    .sort(leadSortComparator(crmSortMode, adminStatusSortIndex));

  if (filteredLeads.length === 0) {
    tbody.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = currentLeads.length === 0
      ? "No leads yet."
      : "No leads match your search.";
    paginationEl.innerHTML = "";
    return;
  }
  emptyEl.hidden = true;

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / LEADS_PAGE_SIZE));
  if (crmPage > totalPages) crmPage = totalPages;
  const pageStart = (crmPage - 1) * LEADS_PAGE_SIZE;
  const visibleLeads = filteredLeads.slice(pageStart, pageStart + LEADS_PAGE_SIZE);

  tbody.innerHTML = visibleLeads.map((l, i) => `
    <tr data-idx="${i}">
      <td>${formatDate(l["Submitted At"])}</td>
      <td>${escapeHtml(l["Role"] || "")}</td>
      <td>${escapeHtml(l["Contact Name"] || "")}<br><span class="small-muted">${escapeHtml(l["Contact Email"] || "")} · ${escapeHtml(l["Contact Phone"] || "")}</span></td>
      <td>${l["Role"] === "Seller" ? "—" : escapeHtml(l["Team"] || "—")}</td>
      <td>${escapeHtml(l["Street Address"] || "")}<br><span class="small-muted">${escapeHtml(l["City"] || "")}, ${escapeHtml(l["State"] || "")}</span></td>
      <td>${escapeHtml(l["Asset Type"] || "")}</td>
      <td>${escapeHtml(l["Senior Loan Willing"] || "")}</td>
      <td>${escapeHtml(l["Payment Structure Willing"] || "")}</td>
      <td>${escapeHtml(String(l["Price Sought"] ?? ""))}</td>
      <td>${escapeHtml(l["Closing Likelihood"] ? String(l["Closing Likelihood"]) + "/5" : "—")}</td>
      <td>${statusPillHtml(l["Status"])}</td>
    </tr>
  `).join("");
  tbody.querySelectorAll("tr").forEach(tr => {
    tr.onclick = () => openDetail(visibleLeads[Number(tr.dataset.idx)]);
  });

  renderPaginationControls("crm-pagination", crmPage, filteredLeads.length, LEADS_PAGE_SIZE, (newPage) => {
    crmPage = newPage;
    renderCrmTable();
  });
}

// Standalone MAO calculator, separate from the Cash Deal wizard step -- lets admin plug in
// numbers directly (e.g. a seller countered with a different rehab estimate) and, optionally, save
// the recalculated MAO suite onto an existing lead without having the associate re-run the wizard.
// Built on the same computeMaoSuite() the wizard step uses, so the math never drifts between the two.
// Available everywhere -- a header button open to anyone (bird dogs/connectors, wholesalers,
// admin, even a seller poking around) -- not just admin. It's independent of the lead wizard: no
// login or in-progress submission required, just plug in numbers and see the math. The "save
// straight onto an existing lead" section only appears when an admin session is active, since that
// needs full CRM access to pick from every lead on file; non-admins can still always use the
// calculator itself, they just email/text the numbers over instead of writing them to the sheet
// directly. Whenever someone actually submits a Cash Deal lead through the wizard (not this
// calculator), the same computeMaoSuite() math is already captured on that submission automatically
// (see cashDealDetails' validate()) -- this panel doesn't change that.
function openMaoCalculator() {
  const overlay = document.getElementById("mao-calc-overlay");
  const panel = document.getElementById("mao-calc-panel");
  const isAdmin = !!sessionToken;
  overlay.hidden = false;

  panel.innerHTML = `
    <button class="link-btn" id="close-mao-calc-btn" style="float:right;">Close ✕</button>
    <h2>MAO Calculator</h2>
    <p class="small-muted">Uses the same Maximum Allowable Offer math as the Cash Deal Details wizard step --
    open to bird dogs/connectors, wholesalers, and admin alike. Plug in numbers any time, independent of
    submitting a lead.</p>

    ${isAdmin ? `
      <label class="field-label">Save to an existing lead <span class="small-muted">(optional -- pre-fills ARV/Rehab/Asset Type below)</span></label>
      <select id="mao-calc-lead-select">
        <option value="">-- Select a lead --</option>
        ${currentLeads.map(l => `<option value="${escapeHtml(l["Lead ID"])}">${escapeHtml(l["Street Address"] || "(no address)")}, ${escapeHtml(l["City"] || "")} — ${escapeHtml(l["Contact Name"] || "")}</option>`).join("")}
      </select>
    ` : ""}

    <label class="field-label">ARV <span class="small-muted">(After Repair Value)</span></label>
    <input type="number" id="mao-calc-arv" placeholder="$">

    <label class="field-label">Rehab Estimate</label>
    <input type="number" id="mao-calc-rehab" placeholder="$">

    <label class="field-label">Asset Type</label>
    <select id="mao-calc-asset-type">
      <option value="Residential Property (1-4 units)">Residential Property (1-4 units)</option>
      <option value="Commercial Property">Commercial Property</option>
      <option value="Land">Land</option>
      <option value="Business">Business</option>
    </select>

    <div id="mao-calc-land-fields" hidden>
      <label class="field-label" style="margin-top:16px;">Market Status <span class="small-muted">(land only -- ARV field above is As-Is Value)</span></label>
      <select id="mao-calc-market-status">
        <option value="On-Market">On-Market / FSBO</option>
        <option value="Off-Market">Off-Market</option>
      </select>

      <label class="field-label" style="margin-top:16px;">
        <input type="checkbox" id="mao-calc-land-deferred" style="width:auto; margin-right:8px; vertical-align:middle;">
        Free and clear, and seller willing to wait to get paid until developed/sold (100% of value)
      </label>
    </div>

    <div class="banner warn" id="mao-calc-output" hidden style="margin-top:16px;"></div>

    ${isAdmin ? `
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border);">
        <button class="btn primary" id="mao-calc-save-btn" disabled>Save MAO to Selected Lead</button>
        <div id="mao-calc-save-message" class="small-muted" style="margin-top:8px;"></div>
      </div>
    ` : ""}
  `;

  panel.querySelector("#close-mao-calc-btn").onclick = () => overlay.hidden = true;
  wireMoneyEchoesIn(panel);

  const recompute = () => {
    const arv = Number(panel.querySelector("#mao-calc-arv").value) || 0;
    const rehab = Number(panel.querySelector("#mao-calc-rehab").value) || 0;
    const assetType = panel.querySelector("#mao-calc-asset-type").value;
    const isLandCalc = assetType === "Land";
    panel.querySelector("#mao-calc-land-fields").hidden = !isLandCalc;
    const marketStatus = isLandCalc ? panel.querySelector("#mao-calc-market-status").value : "";
    const landDeferred = isLandCalc && panel.querySelector("#mao-calc-land-deferred").checked;
    const output = panel.querySelector("#mao-calc-output");
    const saveBtn = panel.querySelector("#mao-calc-save-btn");
    const leadSelected = isAdmin && !!panel.querySelector("#mao-calc-lead-select").value;

    lastMaoCalcSuite = computeMaoSuite(arv, rehab, assetType, undefined, marketStatus, landDeferred);
    if (!lastMaoCalcSuite) {
      output.hidden = true;
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
    const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    output.hidden = false;
    if (lastMaoCalcSuite.isLand) {
      output.innerHTML = lastMaoCalcSuite.landDeferredFullValue ? `
        <strong>Full Value Offer (Deferred):</strong> ${fmt(lastMaoCalcSuite.maoCash)}
        <br><span class="small-muted">(${lastMaoCalcSuite.cashExplanation})</span>
      ` : `
        <strong>Opening Offer${lastMaoCalcSuite.isOnMarket ? " (On-Market/FSBO)" : " (Off-Market)"}:</strong> ${fmt(lastMaoCalcSuite.maoCash)}
        <br><span class="small-muted">(${lastMaoCalcSuite.cashExplanation})</span>
        <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
        <strong>${lastMaoCalcSuite.hm10Label} — hard ceiling:</strong> ${fmt(lastMaoCalcSuite.maoHardMoney10)}
        <br><span class="small-muted">(${lastMaoCalcSuite.hm10Explanation})</span>
      `;
    } else {
      output.innerHTML = `
        <strong>Cash Buyer MAO:</strong> ${fmt(lastMaoCalcSuite.maoCash)}
        <br><span class="small-muted">(${lastMaoCalcSuite.cashExplanation})</span>
        <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
        <strong>Hard Money Buyer MAO (${lastMaoCalcSuite.hm10Label} Down):</strong> ${fmt(lastMaoCalcSuite.maoHardMoney10)}
        <br><span class="small-muted">(${lastMaoCalcSuite.hm10Explanation})</span>
        <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
        <strong>Hard Money Buyer MAO (${lastMaoCalcSuite.hm20Label} Down):</strong> ${fmt(lastMaoCalcSuite.maoHardMoney20)}
        <br><span class="small-muted">(${lastMaoCalcSuite.hm20Explanation})</span>
      `;
    }
    if (saveBtn) saveBtn.disabled = !leadSelected;
  };

  if (isAdmin) {
    panel.querySelector("#mao-calc-lead-select").onchange = (e) => {
      const lead = currentLeads.find(l => l["Lead ID"] === e.target.value);
      if (lead) {
        if (lead["ARV"]) panel.querySelector("#mao-calc-arv").value = lead["ARV"];
        if (lead["Rehab Estimate"]) panel.querySelector("#mao-calc-rehab").value = lead["Rehab Estimate"];
        if (lead["Asset Type"]) panel.querySelector("#mao-calc-asset-type").value = lead["Asset Type"];
      }
      panel.querySelector("#mao-calc-save-message").textContent = "";
      recompute();
    };
  }
  ["#mao-calc-arv", "#mao-calc-rehab"].forEach(sel => { panel.querySelector(sel).oninput = recompute; });
  panel.querySelector("#mao-calc-asset-type").onchange = recompute;
  panel.querySelector("#mao-calc-market-status").onchange = recompute;
  panel.querySelector("#mao-calc-land-deferred").onchange = recompute;

  if (isAdmin) {
    panel.querySelector("#mao-calc-save-btn").onclick = async () => {
      const leadId = panel.querySelector("#mao-calc-lead-select").value;
      const msgEl = panel.querySelector("#mao-calc-save-message");
      if (!leadId || !lastMaoCalcSuite) return;
      msgEl.textContent = "Saving...";
      const res = await api("updateMaoForLead", {
        token: sessionToken, leadId,
        maoCash: Math.round(lastMaoCalcSuite.maoCash),
        maoHardMoney10: Math.round(lastMaoCalcSuite.maoHardMoney10),
        maoHardMoney20: Math.round(lastMaoCalcSuite.maoHardMoney20),
        maoBreakdown: lastMaoCalcSuite.fullBreakdown
      });
      if (res.ok) {
        msgEl.textContent = "Saved to the lead sheet.";
        const lead = currentLeads.find(l => l["Lead ID"] === leadId);
        if (lead) {
          lead["MAO Cash"] = Math.round(lastMaoCalcSuite.maoCash);
          lead["MAO Hard Money (10% Down)"] = Math.round(lastMaoCalcSuite.maoHardMoney10);
          lead["MAO Hard Money (20% Down)"] = Math.round(lastMaoCalcSuite.maoHardMoney20);
          lead["MAO Breakdown"] = lastMaoCalcSuite.fullBreakdown;
        }
      } else {
        msgEl.textContent = "Failed to save: " + (res.error || "unknown error");
      }
    };
  }
}

// FSBO cold-text SOP, open to anyone (same access pattern as the MAO Calculator) -- a reference
// panel, not tied to the wizard's own state, so it's safe to open at any point in a submission.
function openOutreachSop() {
  const overlay = document.getElementById("outreach-sop-overlay");
  const panel = document.getElementById("outreach-sop-panel");
  overlay.hidden = false;
  panel.innerHTML = `
    <style>
      .sop-tab { border:1px solid #e5e7eb; border-radius:8px; margin-bottom:10px; overflow:hidden; }
      .sop-tab > summary { background:#f9fafb; padding:12px 16px; cursor:pointer; font-weight:700; font-size:14px; list-style:none; display:flex; align-items:center; justify-content:space-between; user-select:none; }
      .sop-tab > summary::-webkit-details-marker { display:none; }
      .sop-tab > summary::after { content:"▶"; font-size:11px; color:#6b7280; margin-left:8px; }
      .sop-tab[open] > summary { background:#ede9fe; color:#7c3aed; border-bottom:1px solid #ddd6fe; }
      .sop-tab[open] > summary::after { content:"▼"; color:#7c3aed; }
      .sop-tab-body { padding:16px; }
    </style>

    <button class="link-btn" id="close-outreach-sop-btn" style="float:right;">Close ✕</button>
    <h2>Acquisition SOP</h2>
    <p class="small-muted">Three outreach tracks, run alongside each other. Option 2 (preforeclosure
    auction) has the higher probability of getting accepted and closing fast — prioritize it first
    each day, then fill remaining volume with Option 1 and Option 3 (land).</p>

    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 16px;margin:14px 0;font-size:13px;line-height:1.6;">
      <strong style="font-size:14px;color:#166534;">📈 Volume of outreach to close your next deal faster</strong>
      <p style="margin:8px 0 0;">Send text offers to <strong>at least 15 properties per day</strong> — ideally <strong>30 if possible</strong>. At that pace, the math works heavily in your favor: most sellers won't respond, some will counter, and a handful will be ready to move. Hitting 15–30 outreach texts daily gives you an <strong>extremely high probability of having a deal under contract within a few weeks</strong>. Below that, the funnel gets too narrow and deals take much longer to materialize. Treat the daily number as a non-negotiable, not a goal.</p>
    </div>

    <div class="banner info"><strong>Batch workflow, all tracks:</strong> send your day's outreach
    texts to your <em>entire</em> list first, before opening the wizard for any single property —
    don't fill in property details until one actually responds. Fill in your own info at the very
    start of the wizard (Contact step), then hit <strong>"Save My Progress"</strong> at the top of the
    page <em>before</em> entering any property specifics — that gives you one reusable link with your
    own info already saved. When a property responds, open that link, fill in that property's
    address/seller info fresh, and continue through to submission. When the next property responds
    later in the day, reopen that <em>same</em> saved link again and repeat — no need to retype your
    own info each time.</div>

    <div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;line-height:1.6;">
      ⭐ <strong>Just starting out? Focus here first (simplest to close):</strong>
      <ol style="margin:6px 0 0 18px;padding:0;">
        <li><strong>Option 3a — On-Market Land</strong> (Redfin/Zillow land listings, 50k+ city population) — fewest moving parts, always a cash deal, no financing complexity.</li>
        <li><strong>Option 1 — Redfin 180+ day single-family listings</strong> — sellers who've been on market 6+ months are the most motivated and most likely to accept a discount. Aim for <strong>1 year on market</strong> for light-to-medium rehab deals, or <strong>2+ years on market</strong> for heavy rehab properties.</li>
      </ol>
      <p style="margin:8px 0 0;"><strong>Speed tip for both:</strong> skip any property where <a href="https://propwire.com/" target="_blank" rel="noopener">PropWire</a> shows no debt/equity data — don't investigate, just move to the next one. Volume is the game; time spent on unknowns is time not spent on motivated sellers you <em>can</em> price quickly.</p>
    </div>

    <details class="sop-tab">
      <summary>Option 1: FSBO + On Market Acquisition</summary>
      <div class="sop-tab-body">
        <p class="small-muted">This SOP is for deals that need rehab/renovation (fix and flip). Cold-text every
        lead with two soft offers, cash and seller financing, unless the seller's already ruled one out.
        <strong>Daily target: 50 new properties texted per day.</strong></p>

        <h3 style="margin-top:18px;">1. Source the lead</h3>
        <p class="hint"><strong>1–4 units:</strong> Zillow and Redfin For-Sale-By-Owner listings around the
        US — <strong>single-family only, up to 4 units, no condos or apartments.</strong>
        <br><strong>5+ unit multifamily:</strong> Crexi or LoopNet instead — FSBO sites aren't where commercial
        listings live.</p>
        <p class="hint"><strong>⭐ Also pull 180+ day listings on Redfin (1–4 units) — highly recommended for beginners starting out:</strong>
        filter Redfin listings to those <strong>above 180 days old</strong> (time on Redfin / days on market) — same single-family, up to 4
        units rules as above. A listing that's sat 6+ months hasn't sold at its asking price, so those sellers are
        often more open to a discounted offer. These are usually agent-listed, so the listing shows the agent
        rather than the owner — skip trace the owner for a phone number the same way as Option 2, Step 2.
        <br><br><strong>On market ~1 year</strong> → ideal for <strong>light to medium rehab</strong> properties.
        <br><strong>On market 2+ years</strong> → best for <strong>heavy rehab</strong> properties — seller has been
        waiting long enough to be very motivated and more likely to accept a deep discount.</p>
        <p class="hint">City population <strong>50,000+</strong>. We can go up to <strong>$90M</strong> on
        commercial deals, but for simplicity, stick to deals <strong>under $20M</strong>.</p>

        <h3 style="margin-top:18px;">2. Screen before you text</h3>
        <p class="hint"><strong>1–4 units</strong> (FSBO and 180+ day Redfin listings alike): run the address through <a href="https://propwire.com/" target="_blank" rel="noopener">PropWire</a> and estimate the seller's
        loan balance against the property's value. PropWire's equity/debt data only shows reliably for 1–4
        unit properties.</p>
        <div class="banner warn">
          <strong>No debt/equity data shows on PropWire for a 1–4 unit property?</strong> Skip it immediately and move to the next address — for speed, don't investigate properties where you can't quickly verify the numbers.
          <br><strong>Debt below ~50% of value?</strong> Proceed with both offers (Step 4).
          <br><strong>Debt at or above ~50%?</strong> Seller financing won't work here — go cash-only, offered
          above the existing debt so the payoff is covered, start low, and leave room to go up (Step 4, cash only).
        </div>
        <p class="hint"><strong>Why the ~50% line (1–4 units and 5+ alike):</strong> seller financing here works
        because our buyer takes out a new senior (1st position) loan on the property, which funds the seller's
        down payment, with the seller carrying the rest behind it in 2nd position. That only works when the
        seller's existing debt is low enough (under ~50% of value) for that new 1st position loan to fit. At or
        above that, it won't, so the seller gets a cash offer only.</p>
        <p class="hint"><strong>5+ unit multifamily:</strong> PropWire won't have data here — that's expected,
        not a reason to skip. Instead, ask the seller directly:
        <br><span class="small-muted">"Does the property have under 50% debt compared to its total value?"</span>
        <br>"Yes" &rarr; qualifies for seller financing, send both offers. "No" (or high debt) &rarr; cash offer
        only, above the existing debt, start low.
        <br><strong>Skip any 5+ unit listing that requires an NDA to see financials if no NOI is shown AND the
        property is generating income</strong> — too much friction for a cold-outreach volume play. A vacant
        property is fine to pursue either way, NDA or not.</p>

        <h3 style="margin-top:18px;">3. Price it on SendMySeller before you text</h3>
        <p class="hint">Run the address through the SendMySeller wizard for the low cash offer number (the
        lowest of the calculated Max Allowable Offer figures) and the as-is/ARV value (used to frame the
        seller-financing alternative). Always follow the site's guidance for the initial low cash offer —
        don't estimate it by hand.</p>

        <h3 style="margin-top:18px;">4. Text the offer(s)</h3>
        <p class="hint">Never mention who's buying or whether it's an investor — just ask. Default to offering
        both, unless Step 2 ruled seller financing out, or the seller has separately already said no to one.
        This SOP assumes the property needs rehab — a turnkey property with nothing to fix uses a different,
        longer-horizon seller-financing structure (the wizard's Make Your Offers step switches to it
        automatically once no rehab estimate is entered).</p>
        <p class="hint">Our written offer is a <strong>30-day close</strong> for single-family, full stop — don't
        offer to move faster for this seller. We have closed in under 2 weeks before, so that track record is
        fair to mention, but only as a past fact, never as a capability on offer for this particular deal. For
        5+ unit deals, quote a <strong>45–60 day close</strong> instead, regardless of whether that deal needs
        rehab (see Step 6).</p>
        <p class="hint">Seller financing is always framed as full asking price, contingent on the property
        appraising at or above that — that's the pitch for why they'd take financing over a discounted cash
        offer. The payoff timeline offered in the text is <strong>1 year</strong> for single-family needing rehab,
        <strong>2 years</strong> for 5+ unit multifamily needing rehab, or <strong>5–15 years</strong> for turnkey
        (no rehab needed) — the wizard's Make Your Offers step shows the right numbers for each case.</p>
        <div class="banner info">
          <strong>Both live (single-family rehab):</strong> "Hi [Name] — saw [Address] is for sale. Would you be open to $[cash] cash
          to purchase outright, with a 30-day close (our requirement for deals like this, though we have closed
          in under 2 weeks before)? As another option, we could also do $[20% down] down now, with the
          remaining $[balance] paid within 1 year, at your full asking price as long as it appraises at or
          above that. Let me know which works better for you."
        </div>
        <div class="banner info" style="margin-top:10px;">
          <strong>Cash only</strong> (high debt, or seller financing already declined): "Hi [Name] — saw
          [Address] is for sale. Would you be open to $[cash] cash to purchase outright, with a 30-day close
          (our requirement for deals like this, though we have closed in under 2 weeks before)?"
        </div>
        <p class="hint" style="margin-top:14px;"><strong>If they ask who the buyer is:</strong></p>
        <div class="banner info">
          <strong>Cash:</strong> "We have a database of over 6 million buyers we can send this deal to once
          we agree on cash terms together."
        </div>
        <div class="banner info" style="margin-top:10px;">
          <strong>Seller financing:</strong> "For seller financing, we already have a specific buyer ready to go."
        </div>
        <p class="hint" style="margin-top:14px;"><strong>Only if they specifically ask whether we're the end
        buyer</strong> (don't volunteer this otherwise, same answer as above for cash):</p>
        <div class="banner info">
          <strong>Cash:</strong> "We have a database of over 6 million buyers we can send this deal to once
          we agree on cash terms together."
        </div>
        <div class="banner info" style="margin-top:10px;">
          <strong>Seller financing:</strong> "For seller financing, you'd be carrying it, and the buyer
          taking over the property would be getting an investment loan on it. We already have an end buyer
          ready to close on it right now."
        </div>

        <h3 style="margin-top:18px;">5. If they ask "how much down?"</h3>
        <p class="hint">Don't quote a number or imply there's room to negotiate up. Just say you'll review:</p>
        <div class="banner info">"Good question — I'll put a real offer together for you rather than guess
        over text. If 20% down isn't enough, let me know what you have in mind and we'll review it and get
        back to you."</div>
        <p class="hint" style="margin-top:10px;"><strong>Turnkey / no rehab needed instead:</strong> "Good
        question — it really depends on the terms we land on together, typically 20-50% down with a 5-15 year
        payoff. Let me know what you're looking for and we'll put a real offer together for you."</p>

        <h3 style="margin-top:18px;">6. Timelines</h3>
        <p class="hint">Single-family / 1–4 units needing rehab: <strong>30-day close</strong> (as fast as 2
        weeks or less if needed), seller-financing payoff within <strong>1 year</strong>.
        <br>Commercial multifamily (5+ units) needing rehab: <strong>45–60 day close</strong>, seller-financing
        payoff within <strong>2 years</strong>.
        <br>Turnkey / no rehab needed: same close timelines as above by size, seller-financing payoff over
        <strong>5–15 years</strong> instead.</p>

        <h3 style="margin-top:18px;">7. Follow up</h3>
        <p class="hint">Default to following up every <strong>3 days</strong> while an offer is out and unsigned
        — only stretch to day 7 if the conversation itself makes that the smarter call (e.g. the seller said
        they need more time, or you're waiting on something specific from them). Log every counter or objection
        in the lead's notes — admin uses it to decide how to adjust either offer.</p>
      </div>
    </details>

    <details class="sop-tab">
      <summary>Option 2: Preforeclosure Auction — High Deal Probability</summary>
      <div class="sop-tab-body">
        <p class="small-muted">Cash offer if there's equity to work with; a subject-to pitch (never a
        dollar figure) if there isn't. <strong>No standard seller-financing/carryback offers here.
        Single-family properties only.</strong></p>

        <div class="banner warn"><strong>Why the urgency in these scripts (for you, not the seller):</strong>
        sellers in this situation routinely wait until it's genuinely too late for a deal to close before
        the auction date. Framing time as almost up is what actually gets them to act while there's still
        enough runway left to close and get them real help. Keep this reasoning to yourself — never explain
        it to the seller, just use the scripts as written.</div>

        <h3 style="margin-top:18px;">1. Source</h3>
        <p class="hint">auction.com. Filter for single-family preforeclosure properties with <strong>27 to
        30 days left</strong> until the auction date, and pull about 50 of them into a spreadsheet/CSV per
        day.</p>

        <h3 style="margin-top:18px;">2. Skip trace</h3>
        <p class="hint">auction.com doesn't give you a phone number. Look up each owner on
        <strong>truepeoplesearch.com</strong> (free, one at a time) or pay for a bulk skip tracing service
        if you want to move through 50 at once faster.</p>

        <h3 style="margin-top:18px;">3. Text once, then call</h3>
        <p class="hint"><strong>Single-family only</strong> — unlike Option 1 above, this track doesn't
        have a 5+ unit variant. Send the text below <strong>one time only</strong> — do not send multiple
        texts to the same owner. After that single opening text, switch to <strong>calling the owner and
        leaving voicemails</strong>, and keep calling/leaving voicemails from there (no more texts) until
        they respond. If there's still no response after <strong>3 to 7 total touch points</strong> (the
        text plus calls/voicemails combined), stop and move on to different auction properties elsewhere
        in the US.</p>
        <div class="banner info">
          "Hey [Name], this is [Your Name]. Would you consider an offer on [Address]? I couldn't help but
          notice that its auction date is around the corner, next week or so. I was planning to go and bid on
          it, but figured it wouldn't hurt to try and work something out with you before it's gone."
        </div>
        <p class="hint"><strong>Volume:</strong> 50 new owners contacted a day for 7 days (350 total) — at
        that volume you're very likely to land a deal. Follow ups (the 3 to 7 touch points above) matter
        just as much as new outreach — don't skip them to chase new volume. If you can't handle both
        50 new contacts a day and every follow up that's due, cap your day at <strong>50 total contacts</strong>
        — new leads and follow ups combined — rather than dropping follow ups.</p>

        <h3 style="margin-top:18px;">4. Existing debt &amp; equity check</h3>
        <p class="hint"><strong>Single-family only</strong> — same as the rest of Option 2. Once they
        respond, run the address through the SendMySeller wizard for the MAO numbers (Asset Type:
        Residential Property, 1-4 units), then check <strong><a href="https://propwire.com/" target="_blank" rel="noopener">PropWire</a></strong> for their approximate
        existing debt (the wizard has a dedicated step for this once you pick "Upcoming
        Auction/Preforeclosure Property" as the deal type).</p>
        <p class="hint">If PropWire doesn't have it, ask the seller directly. If they're hesitant to share
        it:</p>
        <div class="banner info">"I want to ensure you get a fair offer and we don't waste time. If the
        offer is below existing debt, we wasted a day or longer and we don't have much time to prevent you
        from getting nothing if you do nothing."</div>
        <p class="hint">Also ask how far behind on payments (arrears) they are — needed to know if a
        subject-to structure is even workable.</p>
        <p class="hint"><strong>Debt below our highest MAO (has equity):</strong> proceed as a normal cash
        offer, texted with a real dollar number, same as Option 1's cash offers above.
        <br><strong>Debt at or above our highest MAO (no equity):</strong> don't quote a dollar figure —
        the wizard gives you a subject-to script instead, along the lines of "we can put together an offer
        that saves your credit from being damaged any further, and gets you as much money as possible at
        closing, by taking over your existing mortgage payments." Text that, then have the seller call
        their lender for a payoff statement, screenshot it, and upload it in the wizard, along with
        whatever loan details they know (monthly payment, principal, interest, taxes, insurance). Submit
        the lead to admin as a <strong>Subject To - Only Possible</strong> lead — admin structures the
        actual offer directly with the seller from there.</p>
      </div>
    </details>

    <details class="sop-tab">
      <summary>Option 3: Land Acquisition</summary>
      <div class="sop-tab-body">
        <p class="small-muted">Land is always a cash deal — no seller financing/carryback offers here. Which of
        the three paths below applies depends on how the land is sourced and the seller's own situation; run
        the address through the SendMySeller wizard (Asset Type: Land) for the actual comps and MAO numbers in
        every case — don't estimate any of this by hand.</p>

        <h3 style="margin-top:18px;">3a. ⭐ FSBO / On-Market Land (Start Here — Simplest for Beginners)</h3>
        <p class="hint">Source the same way as Option 1: Zillow/Redfin FSBO listings and MLS, land parcels only.
        <strong>City population must be 50,000+</strong> — same bar as Option 1, skip anything smaller.</p>
        <p class="hint"><strong>Also pull 180+ day land listings on Redfin:</strong> filter Redfin land listings to
        those <strong>above 180 days old</strong> (time on Redfin / days on market). Land that's sat 6+ months
        without selling is where sellers are most likely to take a discounted cash offer. These are usually
        agent-listed, so skip trace the owner for a phone number the same way as Option 2, Step 2.</p>
        <p class="hint">Run the address through the wizard's land comps prompt (Google AI, matched on zoning/
        topography/access per the wizard's own comping criteria) for a current As-Is Value — never a house's
        ARV, land has no post-repair value. Off of that As-Is Value:</p>
        <div class="banner info"><strong>Open at 50% of As-Is Value</strong>, and never go above a
        <strong>60% ceiling</strong> (both numbers already net out the wholesale/assignment fee — the wizard
        computes them for you). <strong>If the seller won't accept anywhere at or below the 60% ceiling, this
        deal needs to come off-market</strong> before we can offer more — let them know we can revisit at a
        better number once the listing comes down, then work it as Option 3b instead.</div>
        <p class="hint"><strong>Check equity on <a href="https://propwire.com/" target="_blank" rel="noopener">PropWire</a>
        before you text</strong> (FSBO and 180+ day listings alike): look up the parcel for the owner's existing
        debt or liens against the land's value. <strong>No debt (free and clear)</strong> is the best case — it's
        also the first requirement for 3c below. <strong>Debt at or above the 60% ceiling:</strong> our offer can't
        cover the payoff, skip it and move on. <strong>No data on the parcel?</strong> For speed, skip it and move to
        the next listing — don't spend time on unknowns when there are plenty of parcels where you can verify the numbers quickly.</p>
        <p class="hint">Once the seller is interested at a number in range, submit the lead through the site,
        <strong>then separately contact admin directly</strong> so they can move on it fast — don't rely on
        admin noticing the new submission on its own.</p>

        <h3 style="margin-top:18px;">3b. Off-Market Land</h3>
        <p class="hint">Sourced directly (referral, driving for dollars, a seller who reached out, or a listing
        that came off-market per 3a above) — no population minimum, since there's no live listing to compete
        with. Same land comps prompt for As-Is Value.</p>
        <div class="banner info"><strong>Base the offer at 60% of As-Is Value</strong>, with room to negotiate
        up to a <strong>70% ceiling</strong> if that's what it takes to close — off-market gives more room than
        a live listing, but don't open at 70%, work up to it.</div>
        <p class="hint">Same as 3a: once the seller is interested, submit the lead through the site, then
        contact admin directly.</p>

        <h3 style="margin-top:18px;">3c. Free and Clear, Seller Open to Deferred Payout (100% of Value)</h3>
        <p class="hint">Only applies if <strong>both</strong> are true: the land is <strong>free and clear</strong>
        (no mortgage or liens to pay off now) and the seller is <strong>open to a small down payment now</strong>
        (~5% down + realtor commission) with the rest paid once the property is developed and sold or refinanced,
        receiving their full asking price. Ask both questions directly — the wizard has dedicated Yes/No fields
        for them right under As-Is Value on the Cash Deal Details step.</p>
        <div class="banner info">If both are <strong>Yes</strong>, the offer is <strong>100% of As-Is Value</strong>
        (still net of the wholesale/assignment fee) — ~5% down at closing, remainder paid once developed/sold or refinanced.
        This applies regardless of on-market or off-market status; it replaces the 3a/3b percentage bands entirely.</div>
        <p class="hint">This is a bigger ask of the seller (deferred payout, not a full cash closing) so expect it to
        convert less often than 3a/3b — still worth offering whenever a land seller mentions no mortgage and no
        urgency to get paid everything right now. Submit through the site and contact admin directly once they're
        interested, same as the other two paths.</p>
      </div>
    </details>
  `;
  panel.querySelector("#close-outreach-sop-btn").onclick = () => overlay.hidden = true;
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}

function openDetail(lead) {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const fields = buildLeadFields(lead).filter(([k]) => k !== "Status");

  panel.innerHTML = `
    <button class="link-btn" id="close-detail-btn" style="float:right;">Close ✕</button>
    <h2>Lead Detail</h2>
    <label class="field-label">Status</label>
    <select id="status-select">
      ${LEAD_STATUSES.map(s =>
        `<option value="${s}" ${lead["Status"] === s ? "selected" : ""}>${s}</option>`).join("")}
    </select>
    <label class="field-label">Closing Likelihood <span class="small-muted">(1 = lowest, 5 = highest opportunity to close)</span></label>
    <select id="likelihood-select">
      <option value="" ${!lead["Closing Likelihood"] ? "selected" : ""}>Not scored</option>
      ${[1,2,3,4,5].map(n =>
        `<option value="${n}" ${String(lead["Closing Likelihood"]) === String(n) ? "selected" : ""}>${n}</option>`).join("")}
    </select>
    ${lead["Role"] !== "Seller" ? `
      <label class="field-label">Team <span class="small-muted">(admin-only, since this submitter isn't the seller)</span></label>
      <input type="text" id="team-input" placeholder="e.g. Team Alpha" value="${escapeHtml(lead["Team"] || "")}">
    ` : ""}
    <dl class="review-grid" style="margin-top:16px;">
      ${fields.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
    </dl>
    ${lead["MAO Cash"] ? `
      <div class="banner info" style="margin-top:16px; text-align:left; white-space:pre-wrap;">
        <strong>Wholesale Offer Math (admin-only)</strong>
        ${lead["Asset Type"] === "Land" ? `
          <br>Opening/Base Offer: $${Number(lead["MAO Cash"]).toLocaleString()}
          <br>Ceiling: $${Number(lead["MAO Hard Money (10% Down)"]).toLocaleString()}
        ` : `
          <br>Cash Buyer MAO: $${Number(lead["MAO Cash"]).toLocaleString()}
          <br>Hard Money Buyer MAO (10% Down): $${Number(lead["MAO Hard Money (10% Down)"]).toLocaleString()}
          <br>Hard Money Buyer MAO (20% Down): $${Number(lead["MAO Hard Money (20% Down)"]).toLocaleString()}
        `}
        <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
        ${escapeHtml(lead["MAO Breakdown"] || "")}
      </div>
    ` : ""}
    ${lead["CMA Screenshot URLs"] ? `
      <div class="banner info" style="margin-top:16px; text-align:left;">
        <strong>CMA Screenshots</strong>
        <br>${lead["CMA Screenshot URLs"].split("\n").filter(Boolean).map((url, i) =>
          `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Screenshot ${i + 1}</a>`).join(" &middot; ")}
      </div>
    ` : ""}
    ${(lead["Sold Comps"] || lead["Active Comps"]) ? (() => {
      const isLandLead = lead["Asset Type"] === "Land";
      const isBusinessLead = lead["Asset Type"] === "Business";
      const tdS = "border:1px solid #e5e7eb;padding:5px 7px;font-size:12px;";
      const thS = tdS + "background:#f3f4f6;font-weight:600;";
      const colHeaders = isLandLead
        ? `<tr><th style="${thS}">Address</th><th style="${thS}">Price</th><th style="${thS}">Acres</th><th style="${thS}">Price/Acre</th><th style="${thS}">Distance</th><th style="${thS}">Date / DOM</th></tr>`
        : isBusinessLead
        ? `<tr><th style="${thS}">Business Type</th><th style="${thS}">Sale Price</th><th style="${thS}">Revenue</th><th style="${thS}">EBITDA/SDE</th><th style="${thS}">Multiple</th><th style="${thS}">Location</th><th style="${thS}">Date</th></tr>`
        : `<tr><th style="${thS}">Address</th><th style="${thS}">Price</th><th style="${thS}">Sqft</th><th style="${thS}">$/Sqft</th><th style="${thS}">Beds</th><th style="${thS}">Baths</th><th style="${thS}">Distance</th><th style="${thS}">Date / DOM</th></tr>`;
      const fmtC = n => n ? "$" + Number(n).toLocaleString() : "—";
      const rowHtml = (c) => isLandLead
        ? `<tr><td style="${tdS}">${escapeHtml(c.address||"")}</td><td style="${tdS}">${fmtC(c.price)}</td><td style="${tdS}">${escapeHtml(c.acres||"—")}</td><td style="${tdS}">${escapeHtml(c.pricePerUnit||"—")}</td><td style="${tdS}">${escapeHtml(c.distance||"—")}</td><td style="${tdS}">${escapeHtml(c.date||"—")}</td></tr>`
        : isBusinessLead
        ? `<tr><td style="${tdS}">${escapeHtml(c.address||"")}</td><td style="${tdS}">${fmtC(c.price)}</td><td style="${tdS}">${escapeHtml(c.revenue||"—")}</td><td style="${tdS}">${escapeHtml(c.earnings||"—")}</td><td style="${tdS}">${escapeHtml(c.multiple||"—")}</td><td style="${tdS}">${escapeHtml(c.location||"—")}</td><td style="${tdS}">${escapeHtml(c.date||"—")}</td></tr>`
        : `<tr><td style="${tdS}">${escapeHtml(c.address||"")}</td><td style="${tdS}">${fmtC(c.price)}</td><td style="${tdS}">${escapeHtml(c.sqft||"—")}</td><td style="${tdS}">${escapeHtml(c.pricePerSqft||"—")}</td><td style="${tdS}">${escapeHtml(c.beds||"—")}</td><td style="${tdS}">${escapeHtml(c.baths||"—")}</td><td style="${tdS}">${escapeHtml(c.distance||"—")}</td><td style="${tdS}">${escapeHtml(c.date||"—")}</td></tr>`;
      let soldComps = [], activeComps = [];
      try { soldComps = lead["Sold Comps"] ? JSON.parse(lead["Sold Comps"]) : []; } catch(e) {}
      try { activeComps = lead["Active Comps"] ? JSON.parse(lead["Active Comps"]) : []; } catch(e) {}
      return `<div class="banner info" style="margin-top:16px;text-align:left;">
        <strong>AI Comps Data${lead["ARV Range"] ? " — ARV Range: " + escapeHtml(lead["ARV Range"]) : ""}</strong>
        ${soldComps.length ? `
          <div style="margin-top:10px;font-weight:600;font-size:12px;color:#374151;">SOLD COMPS (${soldComps.length})</div>
          <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;margin-top:4px;">${colHeaders}${soldComps.map(rowHtml).join("")}</table></div>
        ` : ""}
        ${activeComps.length ? `
          <div style="margin-top:10px;font-weight:600;font-size:12px;color:#374151;">ACTIVE / FOR-SALE COMPS (${activeComps.length})</div>
          <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;margin-top:4px;">${colHeaders}${activeComps.map(rowHtml).join("")}</table></div>
        ` : ""}
      </div>`;
    })() : ""}
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb;">
      <button class="btn primary" id="open-loi-btn" style="width:100%;font-size:14px;">🏠 Open in LOI Generator →</button>
      <p style="font-size:11px;color:#6b7280;margin:6px 0 0;text-align:center;">Opens <strong>loi-generator</strong> pre-filled with this lead's data — ready to generate the LOI.</p>
    </div>
    <div class="notes-list">
      <strong>Notes</strong>
      <div id="notes-container">
        ${(lead.notes || []).map(n => renderAdminNoteItem(n)).join("") || `<p class="small-muted">No notes yet.</p>`}
      </div>
      <textarea id="new-note-input" placeholder="Add a note (raw lead data above can't be edited or deleted)"></textarea>
      <label class="small-muted" style="display:block; margin-top:6px;">
        <input type="checkbox" id="private-note-checkbox"> Private (invisible to non-admins)
      </label>
      <button class="btn primary" id="add-note-btn" style="margin-top:8px;">Add Note</button>
    </div>
  `;

  panel.querySelector("#close-detail-btn").onclick = () => overlay.hidden = true;
  const loiBtn = panel.querySelector("#open-loi-btn");
  if (loiBtn) {
    loiBtn.onclick = () => {
      const propTypeMap = {
        "Residential Property (1-4 units)": "residential",
        "Commercial Property": "commercial",
        "Land": "land"
      };
      const params = new URLSearchParams();
      const addr = [lead["Street Address"], lead["City"], lead["State"], lead["Zip"]].filter(Boolean).join(", ");
      if (addr) params.set("address", addr);
      if (lead["Units"]) params.set("units", lead["Units"]);
      const pt = propTypeMap[lead["Asset Type"]];
      if (pt) params.set("prop_type", pt);
      if (lead["ARV"]) params.set("arv", String(lead["ARV"]).replace(/[^0-9.]/g, ""));
      if (lead["As-Is Value"]) params.set("as_is_value", String(lead["As-Is Value"]).replace(/[^0-9.]/g, ""));
      if (lead["MAO Cash"]) {
        const mao = String(lead["MAO Cash"]).replace(/[^0-9.]/g, "");
        params.set("purchase_price", mao);
        params.set("cash_at_closing", mao);
      }
      if (lead["Rehab Estimate"]) params.set("rehab", String(lead["Rehab Estimate"]).replace(/[^0-9.]/g, ""));
      window.open("https://pharaohm33.github.io/loi-generator?" + params.toString(), "_blank");
    };
  }
  panel.querySelector("#status-select").onchange = async (e) => {
    const res = await api("updateStatus", { token: sessionToken, leadId: lead["Lead ID"], status: e.target.value });
    if (res.ok) { lead["Status"] = e.target.value; renderCrmTable(); }
    else alert("Failed to save status: " + (res.error || "unknown error"));
  };
  panel.querySelector("#likelihood-select").onchange = async (e) => {
    const res = await api("updateClosingLikelihood", { token: sessionToken, leadId: lead["Lead ID"], score: e.target.value });
    if (res.ok) { lead["Closing Likelihood"] = e.target.value; renderCrmTable(); }
    else alert("Failed to save closing likelihood: " + (res.error || "unknown error"));
  };
  const teamInput = panel.querySelector("#team-input");
  if (teamInput) {
    teamInput.onblur = async (e) => {
      const team = e.target.value.trim();
      const res = await api("updateTeam", { token: sessionToken, leadId: lead["Lead ID"], team });
      if (res.ok) {
        // Team is keyed by submitter email, not per-lead -- the backend just
        // applied it to every lead on file from this same email, so mirror
        // that here instead of only updating the one lead we opened.
        const targetEmail = String(lead["Contact Email"] || "").trim().toLowerCase();
        currentLeads.forEach(l => {
          if (String(l["Contact Email"] || "").trim().toLowerCase() === targetEmail) l["Team"] = team;
        });
        renderCrmTable();
      } else {
        alert("Failed to save team: " + (res.error || "unknown error"));
      }
    };
  }
  bindAdminNoteControls(panel, lead);
}

// Wires up the "add note" and "delete note" controls inside an already-open
// detail panel. Split out from openDetail() so adding/deleting a note only
// touches #notes-container -- re-running openDetail() here would rebuild
// the whole panel from `lead`, wiping out any in-progress edit (e.g. a
// Team value the admin just typed but hasn't blurred out of yet) that
// hasn't been written back to `lead` by its own async save yet.
function bindAdminNoteControls(panel, lead) {
  const notesContainer = panel.querySelector("#notes-container");

  function renderNotes() {
    notesContainer.innerHTML = (lead.notes || []).map(n => renderAdminNoteItem(n)).join("") || `<p class="small-muted">No notes yet.</p>`;
    notesContainer.querySelectorAll(".admin-delete-note-btn").forEach(btn => {
      btn.onclick = async () => {
        const item = btn.closest(".note-item");
        const noteId = item.dataset.noteId;
        if (!confirm("Delete this note? This cannot be undone.")) return;
        const res = await api("deleteNote", { token: sessionToken, noteId });
        if (res.ok) {
          lead.notes = (lead.notes || []).filter(n => n.noteId !== noteId);
          renderNotes();
        } else {
          alert("Failed to delete note: " + (res.error || "unknown error"));
        }
      };
    });
  }

  panel.querySelector("#add-note-btn").onclick = async () => {
    const noteInput = panel.querySelector("#new-note-input");
    const note = noteInput.value.trim();
    if (!note) return;
    const isPrivate = panel.querySelector("#private-note-checkbox").checked;
    const res = await api("addNote", { token: sessionToken, leadId: lead["Lead ID"], note, isPrivate });
    if (res.ok) {
      lead.notes = lead.notes || [];
      lead.notes.push({ noteId: res.noteId, timestamp: new Date().toISOString(), note, author: "Admin", visibility: isPrivate ? "Private" : "Shared" });
      noteInput.value = "";
      panel.querySelector("#private-note-checkbox").checked = false;
      renderNotes();
    } else {
      alert("Failed to add note: " + (res.error || "unknown error"));
    }
  };

  renderNotes();
}

function renderAdminNoteItem(n) {
  const author = n.author || "Admin";
  const isAdminAuthor = author === "Admin";
  const badgeStyle = isAdminAuthor
    ? "background:var(--navy); color:#fff;"
    : "background:var(--accent-light); color:var(--accent);";
  return `
    <div class="note-item" data-note-id="${n.noteId || ""}">
      <span class="ts">
        ${formatDate(n.timestamp)}
        <span style="${badgeStyle} padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; margin-left:4px;">${escapeHtml(author)}</span>
        ${n.visibility === "Private" ? `<strong style="color:var(--warn);"> (Private — invisible to non-admins)</strong>` : ""}
      </span>
      <div>${escapeHtml(n.note)}</div>
      ${n.noteId ? `<button type="button" class="link-btn admin-delete-note-btn" style="color:var(--danger); margin-top:4px;">Delete</button>` : ""}
    </div>
  `;
}

/* ---------- Export + gated delete ---------- */

document.getElementById("export-btn").onclick = async () => {
  if (!confirm(`Export ${currentLeads.length} lead(s) to a timestamped Google Sheets tab?`)) return;
  adminMessage("Exporting...", "info");
  const res = await api("exportToSheet", { token: sessionToken });
  if (!res.ok) { adminMessage(res.error, "danger"); return; }
  lastExportToken = res.exportToken;
  deleteConfirmStep = 0;
  adminMessage(`Exported ${res.exportedCount} lead(s) to sheet tab "${res.tabName}".`, "info");
  document.getElementById("delete-zone").hidden = false;
};

document.getElementById("delete-step-btn").onclick = async () => {
  deleteConfirmStep++;
  if (deleteConfirmStep === 1) {
    if (!confirm("Your export is complete. Are you sure you want to delete all CRM data now?")) { deleteConfirmStep = 0; return; }
  } else if (deleteConfirmStep === 2) {
    if (!confirm("This cannot be undone — the only remaining copy will be the exported sheet tab. Really delete?")) { deleteConfirmStep = 0; return; }
  } else if (deleteConfirmStep >= 3) {
    const typed = prompt('Final confirmation: type DELETE (all caps) to permanently clear the CRM.');
    if (typed !== "DELETE") { deleteConfirmStep = 0; return; }
    const res = await api("deleteAllLeads", { token: sessionToken, exportToken: lastExportToken });
    if (!res.ok) { adminMessage(res.error, "danger"); deleteConfirmStep = 0; return; }
    adminMessage("CRM data cleared. Starting fresh.", "info");
    document.getElementById("delete-zone").hidden = true;
    deleteConfirmStep = 0;
    lastExportToken = null;
    await loadLeads();
  }
};
