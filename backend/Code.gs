/**
 * Seller Lead Form — Apps Script backend.
 *
 * Deploy this bound to a Google Sheet (see SETUP.md). It is the entire
 * "server": public lead submissions, admin login, notes, export-to-sheet,
 * and gated delete-all all live here. No other backend exists.
 *
 * Required Script Properties (Project Settings -> Script Properties):
 *   ADMIN_PASSWORD      - the password the admin logs in with
 *   RECOVERY_CODE_WORD  - the word that unlocks emailing the password
 *   ADMIN_EMAIL         - where recovery emails are sent (fixed, not caller-supplied)
 *   SESSION_SECRET      - random long string, used to sign session tokens
 *   SHARED_SECRET       - (optional) simple app key the frontend also sends
 */

const LEADS_SHEET = 'Leads';
const NOTES_SHEET = 'Notes';
const SESSION_HOURS = 12;

const LEAD_COLUMNS = [
  'Lead ID', 'Submitted At', 'Role', 'Contact Name', 'Contact Email', 'Contact Phone', 'Social Link',
  'Referrer Name', 'Referrer Phone',
  'Seller Contact Name', 'Seller Contact Phone', 'Seller Contact Email',
  'Street Address', 'Parcel IDs', 'City', 'State', 'Zip', 'Units',
  'Asset Type', 'Asset Subtype', 'Beds', 'Baths', 'Sq Ft', 'Acreage', 'Land Zoning',
  'Deal Type', 'Deal Category', 'ARV', 'Asking Price', 'Chase Estimated Value', 'As-Is Value', 'Pictures Link', 'Rehab Estimate', 'Rehab Estimate Low', 'Rehab Estimate High', 'County Assessed Value',
  'CMA Screenshot URLs',
  'Bottom Dollar Price', 'Cash Deal Notes', 'Wholesale Fee',
  'MAO Cash', 'MAO Hard Money (10% Down)', 'MAO Hard Money (20% Down)', 'MAO Breakdown',
  'Under Contract', 'Seller Accepted Price',
  'Seller Declined Cash', 'Seller Declined Seller Financing', 'Seller Financing Accepted', 'Seller Financing Negotiation Notes',
  'Preforeclosure Debt', 'Arrears Amount', 'Subject To Only Possible', 'Payoff Statement URLs', 'Payoff Statement Notes',
  'Loan Monthly Payment', 'Loan Monthly Principal', 'Loan Monthly Interest', 'Loan Monthly Taxes', 'Loan Monthly Insurance',
  'Year Built', 'Purchase Year', 'Months Behind On Payments', 'Annual Maintenance Spend', 'Property Photo URLs', 'Property Photos Link',
  'Rent Ready', 'Buyer Intends To Sell', 'Occupied Status', 'Has Rent Rolls', 'Has P&L', 'Deliverable Vacant', 'Current Lease Term',
  'Lease End Date', 'Tenant Would Move Early', 'STR NOI Per Unit',
  'Monthly Rent Estimate', 'STR Annual Revenue', 'Annual Property Taxes', 'Annual Insurance', 'Expense Ratio %',
  'NOI', 'Commercial Occupancy Status', 'Commercial Occupancy %', 'STR NOI', 'Business Revenue', 'Business Earnings Type', 'Business Earnings',
  'Total Debt', 'Senior Loan Willing', 'Payment Structure Willing',
  'Price Sought', 'Price Reasoning', 'Down Payment Intent', 'Down Payment Needed', 'Down Payment Non-Negotiable',
  'Market Status', 'Source Link',
  'Status', 'Closing Likelihood', 'Sort Priority', 'Team'
];

const NOTE_COLUMNS = ['Lead ID', 'Timestamp', 'Note', 'Author', 'Note ID', 'Visibility'];

// Display order, top to bottom, for the ADMIN CRM table specifically (only
// admin ever views this raw Sheet, since it holds admin-only columns like
// Team and Closing Likelihood). Kept in sync manually with the identical
// ADMIN_STATUS_SORT_ORDER array in app.js -- there's no shared-import
// between the two runtimes. The non-admin status view uses a different
// order (New sorts lower there) that isn't reflected here since non-admins
// never see this Sheet directly. Sort Priority is just a helper number
// (its index here) written alongside Status so you can select that column
// in the Sheets UI and sort by it yourself (Data > Sort range) to see the
// same order the admin app shows, without this script ever physically
// reordering your live rows.
const STATUS_SORT_ORDER = [
  'In Escrow To Close',
  'Offer Signed By Seller',
  'Verbally Accepted But Not Signed',
  'Negotiation',
  'New',
  'Offer Sent',
  'Under Review',
  'Contacted',
  'Closed',
  'Dead'
];

function getSortPriority(status) {
  const idx = STATUS_SORT_ORDER.indexOf(status || 'New');
  return idx === -1 ? STATUS_SORT_ORDER.length : idx;
}

// Allowlist, not a blocklist: only these columns are ever sent to the
// public getLeadsByEmail endpoint. Anything you add directly in the Leads
// sheet -- extra columns, private calculations, doc links -- is invisible
// to that endpoint by default, not just unrendered by the front-end. Add a
// column here deliberately if you ever want it exposed to submitters.
const PUBLIC_LEAD_FIELDS = LEAD_COLUMNS.filter(function (c) {
  return c !== 'Closing Likelihood' && c !== 'Sort Priority' && c !== 'Team'
    && c !== 'MAO Cash' && c !== 'MAO Hard Money (10% Down)' && c !== 'MAO Hard Money (20% Down)'
    && c !== 'MAO Breakdown';
});

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'ping') {
    return jsonOut({ ok: true, message: 'Seller Lead Form backend is alive.' });
  }
  return jsonOut({ ok: false, error: 'Use POST for this API.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'Bad request body.' });
  }

  const action = body.action;
  try {
    switch (action) {
      case 'submitLead':
        return jsonOut(submitLead(body));
      case 'adminLogin':
        return jsonOut(adminLogin(body));
      case 'forgotPassword':
        return jsonOut(forgotPassword(body));
      case 'getLeads':
        return jsonOut(withSession(body, getLeads));
      case 'addNote':
        return jsonOut(withSession(body, addNote));
      case 'deleteNote':
        return jsonOut(withSession(body, deleteNote));
      case 'updateStatus':
        return jsonOut(withSession(body, updateStatus));
      case 'updateClosingLikelihood':
        return jsonOut(withSession(body, updateClosingLikelihood));
      case 'updateTeam':
        return jsonOut(withSession(body, updateTeam));
      case 'updateMaoForLead':
        return jsonOut(withSession(body, updateMaoForLead));
      case 'exportToSheet':
        return jsonOut(withSession(body, exportToSheet));
      case 'deleteAllLeads':
        return jsonOut(withSession(body, deleteAllLeads));
      case 'getLeadsByEmail':
        return jsonOut(getLeadsByEmail(body));
      case 'checkAddressDuplicate':
        return jsonOut(checkAddressDuplicate(body));
      case 'uploadCmaScreenshot':
        return jsonOut(uploadCmaScreenshot(body));
      case 'addPublicNote':
        return jsonOut(addPublicNote(body));
      case 'editPublicNote':
        return jsonOut(editPublicNote(body));
      case 'deletePublicNote':
        return jsonOut(deletePublicNote(body));
      default:
        return jsonOut({ ok: false, error: 'Unknown action.' });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Sheets helpers ----------

function getSheet(name, columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
  } else {
    ensureHeaders(sheet, columns);
  }
  return sheet;
}

// Adds any columns that didn't exist yet (e.g. a sheet created before a
// later feature added a new field) without disturbing existing data.
function ensureHeaders(sheet, columns) {
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = columns.filter(function (c) { return existing.indexOf(c) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

// 1-indexed column number for a header name, read from the sheet's actual
// current header row -- never assume a column's position matches its index
// in LEAD_COLUMNS/NOTE_COLUMNS, since ensureHeaders appends new columns at
// the end rather than reordering, so an already-migrated sheet's physical
// layout can differ from those arrays' declared order.
function getColumnIndex(sheet, headerName) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  return headers.indexOf(headerName) + 1;
}

// Forces a single cell to plain-text format and re-writes its value, so a
// leading "+"/"-" or a leading zero can't get reinterpreted as a formula
// or a number by Sheets' auto-parsing. Used for phone numbers and zip codes.
function forceTextValue(sheet, row, headerName, value) {
  if (value === undefined || value === null || value === '') return;
  const col = getColumnIndex(sheet, headerName);
  if (!col) return;
  const cell = sheet.getRange(row, col);
  cell.setNumberFormat('@');
  cell.setValue(String(value));
}

// Builds a row from a {headerName: value} object rather than a fixed
// positional array, since a sheet created before a later feature added new
// columns will have those new columns appended at the end (by
// ensureHeaders) rather than in LEAD_COLUMNS's logical order -- a plain
// positional appendRow would silently write values into the wrong columns.
function appendRowByHeaders(sheet, dataObj) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = headers.map(function (h) {
    const v = dataObj[h];
    return (v === undefined || v === null) ? '' : v;
  });
  sheet.appendRow(row);
}

function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    const obj = {};
    headers.forEach(function (h, idx) { obj[h] = row[idx]; });
    obj._row = i + 1; // 1-indexed sheet row, for in-place updates
    rows.push(obj);
  }
  return rows;
}

// ---------- Public: submit a lead ----------

// Strips "+" specifically (leaves hyphens/parens/spaces alone -- those
// write to Sheets fine). A leading "+" is what makes Sheets' auto-parser
// treat the value as the start of a formula and throw an error in the
// cell instead of storing the phone number, and that error happens at
// the initial write itself -- before forceTextValue() below ever gets a
// chance to run -- so the "+" has to be gone before the row is appended,
// not fixed up afterward.
function sanitizePhone(phone) {
  return String(phone || '').replace(/\+/g, '').trim();
}

function submitLead(body) {
  const d = body.data || {};
  const required = ['role', 'name', 'email', 'phone', 'street', 'city', 'state', 'zip', 'units', 'assetType', 'marketStatus'];
  for (const key of required) {
    if (d[key] === undefined || d[key] === null || d[key] === '') {
      return { ok: false, error: 'Missing required field: ' + key };
    }
  }

  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leadId = Utilities.getUuid();
  const submittedAt = new Date().toISOString();
  const phone = sanitizePhone(d.phone);
  const sellerContactPhone = sanitizePhone(d.sellerContactPhone);
  const referrerPhone = sanitizePhone(d.referrerPhone);

  // If this email already has a Team assigned from an earlier lead, carry
  // it forward automatically -- see updateTeam() for why Team is keyed by
  // submitter email rather than per-lead.
  const submitterEmail = String(d.email || '').trim().toLowerCase();
  const existingTeamLead = submitterEmail
    ? sheetToObjects(sheet).find(function (l) {
        return String(l['Contact Email'] || '').trim().toLowerCase() === submitterEmail && l['Team'];
      })
    : null;
  const inheritedTeam = existingTeamLead ? existingTeamLead['Team'] : '';

  appendRowByHeaders(sheet, {
    'Lead ID': leadId, 'Submitted At': submittedAt, 'Role': d.role, 'Contact Name': d.name,
    'Contact Email': d.email, 'Contact Phone': phone, 'Social Link': d.socialLink || '',
    'Referrer Name': d.referrerName || '', 'Referrer Phone': referrerPhone,
    'Seller Contact Name': d.sellerContactName || '', 'Seller Contact Phone': sellerContactPhone,
    'Seller Contact Email': d.sellerContactEmail || '',
    'Street Address': d.street, 'Parcel IDs': d.parcelIds || '', 'City': d.city, 'State': d.state, 'Zip': d.zip, 'Units': d.units,
    'Asset Type': d.assetType, 'Asset Subtype': d.assetSubtype || '',
    'Beds': d.beds || '', 'Baths': d.baths || '', 'Sq Ft': d.sqft || '', 'Acreage': d.acreage || '', 'Land Zoning': d.landZoning || '',
    'Deal Type': d.dealType || '', 'Deal Category': d.dealCategory || '',
    'ARV': d.arv || '', 'Asking Price': d.askingPrice || '', 'Chase Estimated Value': d.chaseEstimate || '', 'As-Is Value': d.asIsValue || '', 'Pictures Link': d.picturesLink || '',
    'Rehab Estimate': d.rehabEstimate || '',
    'Rehab Estimate Low': d.rehabEstimateLow || '', 'Rehab Estimate High': d.rehabEstimateHigh || '',
    'County Assessed Value': d.countyAssessedValue || '',
    'CMA Screenshot URLs': d.cmaScreenshotUrls || '',
    'Bottom Dollar Price': d.bottomDollarPrice || '',
    'Cash Deal Notes': d.cashDealNotes || '', 'Wholesale Fee': d.wholesaleFee || '',
    'MAO Cash': d.maoCash || '', 'MAO Hard Money (10% Down)': d.maoHardMoney10 || '',
    'MAO Hard Money (20% Down)': d.maoHardMoney20 || '', 'MAO Breakdown': d.maoBreakdown || '',
    'Under Contract': d.underContract || '', 'Seller Accepted Price': d.sellerAcceptedPrice || '',
    'Seller Declined Cash': d.sellerDeclinedCash || '', 'Seller Declined Seller Financing': d.sellerDeclinedSellerFinancing || '',
    'Seller Financing Accepted': d.sellerFinancingAccepted || '', 'Seller Financing Negotiation Notes': d.sellerFinancingNegotiationNotes || '',
    'Preforeclosure Debt': d.preforeclosureDebt || '', 'Arrears Amount': d.arrearsAmount || '',
    'Subject To Only Possible': d.subjectToOnlyPossible || '',
    'Payoff Statement URLs': d.payoffStatementUrls || '', 'Payoff Statement Notes': d.payoffStatementNotes || '',
    'Loan Monthly Payment': d.loanMonthlyPayment || '', 'Loan Monthly Principal': d.loanMonthlyPrincipal || '',
    'Loan Monthly Interest': d.loanMonthlyInterest || '', 'Loan Monthly Taxes': d.loanMonthlyTaxes || '',
    'Loan Monthly Insurance': d.loanMonthlyInsurance || '',
    'Year Built': d.yearBuilt || '', 'Purchase Year': d.purchaseYear || '',
    'Months Behind On Payments': d.monthsBehindOnPayments || '', 'Annual Maintenance Spend': d.annualMaintenanceSpend || '',
    'Property Photo URLs': d.propertyPhotoUrls || '', 'Property Photos Link': d.propertyPhotosLink || '',
    'Rent Ready': d.propertyRentReady || '', 'Buyer Intends To Sell': d.buyerIntendsToSell || '', 'Occupied Status': d.occupiedStatus || '',
    'Has Rent Rolls': d.hasRentRolls || '', 'Has P&L': d.hasProfitLoss || '',
    'Deliverable Vacant': d.deliverableVacant || '', 'Current Lease Term': d.currentLeaseTerm || '',
    'Lease End Date': d.leaseEndDate || '', 'Tenant Would Move Early': d.tenantWouldMoveEarly || '',
    'STR NOI Per Unit': d.strNoiPerUnit || '',
    'Monthly Rent Estimate': d.monthlyRentEstimate || '',
    'STR Annual Revenue': d.strAnnualRevenue || '',
    'Annual Property Taxes': d.annualPropertyTaxes || '', 'Annual Insurance': d.annualInsurance || '',
    'Expense Ratio %': d.expenseRatio || '',
    // Commercial NOI has an explicit "I don't know" toggle on the front end (unlike Residential's
    // required NOI) -- a blank value there always means unknown, not not-applicable, so it's worth
    // persisting as 'Unknown' the same way Total Debt already does below, rather than leaving it
    // indistinguishable from Land/Business's blank (genuinely no-NOI-concept) case.
    'NOI': d.noi || (d.assetType === 'Commercial Property' ? 'Unknown' : ''),
    'Commercial Occupancy Status': d.commercialOccupancyStatus || '', 'Commercial Occupancy %': d.commercialOccupancyPct || '',
    'STR NOI': d.strNOI || '', 'Business Revenue': d.businessRevenue || '',
    'Business Earnings Type': d.businessEarningsType || '', 'Business Earnings': d.businessEarnings || '',
    'Total Debt': (d.totalDebt === undefined || d.totalDebt === null || d.totalDebt === '') ? 'Unknown' : d.totalDebt,
    'Senior Loan Willing': d.seniorLoanWilling, 'Payment Structure Willing': d.paymentStructureWilling,
    'Price Sought': d.priceSought, 'Price Reasoning': d.priceReasoning,
    'Down Payment Intent': d.downPaymentIntent || '',
    'Down Payment Needed': (d.downPaymentNeeded === undefined || d.downPaymentNeeded === '') ? 'Skipped' : d.downPaymentNeeded,
    'Down Payment Non-Negotiable': d.downPaymentNonNegotiable || 'N/A',
    'Market Status': d.marketStatus, 'Source Link': d.sourceLink || '',
    'Status': 'New', 'Sort Priority': getSortPriority('New'), 'Team': inheritedTeam
  });

  // Google Sheets can misread a leading "+" (e.g. "+1 520-633-6437") as the
  // start of a formula, and can drop a leading zero from a zip code by
  // treating it as a number. Force these columns to plain text on the row
  // we just wrote, then re-set their values so nothing gets silently
  // mangled by that auto-parsing.
  const newRow = sheet.getLastRow();
  forceTextValue(sheet, newRow, 'Contact Phone', phone);
  forceTextValue(sheet, newRow, 'Seller Contact Phone', sellerContactPhone);
  forceTextValue(sheet, newRow, 'Referrer Phone', referrerPhone);
  forceTextValue(sheet, newRow, 'Zip', d.zip);

  return { ok: true, leadId: leadId };
}

// ---------- Admin auth ----------

function adminLogin(body) {
  const props = PropertiesService.getScriptProperties();
  const password = props.getProperty('ADMIN_PASSWORD');
  if (!password || body.password !== password) {
    return { ok: false, error: 'Incorrect password.' };
  }
  return { ok: true, token: makeSessionToken() };
}

function forgotPassword(body) {
  // Always return the same generic message whether or not the code word
  // matched, so a caller can't use the response to guess the code word.
  const props = PropertiesService.getScriptProperties();
  const codeWord = props.getProperty('RECOVERY_CODE_WORD');
  const adminEmail = props.getProperty('ADMIN_EMAIL');
  const password = props.getProperty('ADMIN_PASSWORD');

  if (codeWord && adminEmail && password && body.codeWord === codeWord) {
    MailApp.sendEmail({
      to: adminEmail,
      subject: 'Seller Lead Form — admin password recovery',
      body: 'Your admin password is:\n\n' + password + '\n\nIf you did not request this, someone else knows your recovery code word — consider changing it in the Apps Script project\'s Script Properties.'
    });
  }
  return { ok: true, message: 'If the code word was correct, a recovery email was just sent.' };
}

function makeSessionToken() {
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const sig = hmacHex(String(expires), secret);
  return expires + '.' + sig;
}

function verifySessionToken(token) {
  if (!token || token.indexOf('.') === -1) return false;
  const parts = token.split('.');
  const expires = Number(parts[0]);
  const sig = parts[1];
  if (!expires || expires < Date.now()) return false;
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  return hmacHex(String(expires), secret) === sig;
}

function hmacHex(value, secret) {
  const raw = Utilities.computeHmacSha256Signature(value, secret);
  return raw.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function withSession(body, fn) {
  if (!verifySessionToken(body.token)) {
    return { ok: false, error: 'Session expired or invalid. Please log in again.' };
  }
  return fn(body);
}

// ---------- Admin: leads + notes ----------

function getLeads(body) {
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const leads = sheetToObjects(leadsSheet);
  const notes = sheetToObjects(notesSheet);

  const notesByLead = {};
  notes.forEach(function (n) {
    const id = n['Lead ID'];
    if (!notesByLead[id]) notesByLead[id] = [];
    notesByLead[id].push({
      noteId: n['Note ID'], timestamp: n['Timestamp'], note: n['Note'],
      author: n['Author'] || 'Admin', visibility: n['Visibility'] || 'Shared'
    });
  });

  leads.forEach(function (l) {
    l.notes = notesByLead[l['Lead ID']] || [];
  });

  return { ok: true, leads: leads };
}

function addNote(body) {
  if (!body.leadId || !body.note) return { ok: false, error: 'Missing leadId or note.' };
  const sheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const noteId = Utilities.getUuid();
  appendRowByHeaders(sheet, {
    'Lead ID': body.leadId, 'Timestamp': new Date().toISOString(), 'Note': body.note,
    'Author': 'Admin', 'Note ID': noteId,
    'Visibility': body.isPrivate ? 'Private' : 'Shared'
  });
  return { ok: true, noteId: noteId };
}

// Admin can delete any note (their own or a submitter's) -- this is the one
// deliberate exception to "raw data is never deleted": notes are a working
// log, not the original lead submission, which stays immutable regardless.
function deleteNote(body) {
  if (!body.noteId) return { ok: false, error: 'Missing noteId.' };
  const sheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const notes = sheetToObjects(sheet);
  const match = notes.find(function (n) { return n['Note ID'] === body.noteId; });
  if (!match) return { ok: false, error: 'Note not found.' };
  sheet.deleteRow(match._row);
  return { ok: true };
}

// ---------- Public: duplicate-address check ----------
// No auth needed -- this only ever reveals a date, never who else
// submitted it, so it's safe to expose to anyone filling out the form.

// Word-for-word normalization so "123 Main St." and "123 Main Street"
// (or "Saint Louis" vs "St Louis") compare equal. Only exact whole-word
// matches get rewritten, so words like "Eastwood" are left alone even
// though "east" appears in the map.
const ADDRESS_ABBREVIATIONS = {
  'street': 'st', 'st': 'st',
  'avenue': 'ave', 'ave': 'ave', 'av': 'ave',
  'boulevard': 'blvd', 'blvd': 'blvd',
  'drive': 'dr', 'dr': 'dr',
  'lane': 'ln', 'ln': 'ln',
  'road': 'rd', 'rd': 'rd',
  'court': 'ct', 'ct': 'ct',
  'place': 'pl', 'pl': 'pl',
  'circle': 'cir', 'cir': 'cir',
  'terrace': 'ter', 'ter': 'ter',
  'parkway': 'pkwy', 'pkwy': 'pkwy',
  'highway': 'hwy', 'hwy': 'hwy',
  'square': 'sq', 'sq': 'sq',
  'trail': 'trl', 'trl': 'trl',
  'plaza': 'plz', 'plz': 'plz',
  'crossing': 'xing', 'xing': 'xing',
  'point': 'pt', 'pt': 'pt',
  'ridge': 'rdg', 'rdg': 'rdg',
  'alley': 'aly', 'aly': 'aly',
  'crescent': 'cres', 'cres': 'cres',
  'expressway': 'expy', 'expy': 'expy',
  'freeway': 'fwy', 'fwy': 'fwy',
  'turnpike': 'tpke', 'tpke': 'tpke',
  'extension': 'ext', 'ext': 'ext',
  'junction': 'jct', 'jct': 'jct',
  'heights': 'hts', 'hts': 'hts',
  'gardens': 'gdns', 'gdns': 'gdns',
  'village': 'vlg', 'vlg': 'vlg',
  'manor': 'mnr', 'mnr': 'mnr',
  'landing': 'lndg', 'lndg': 'lndg',
  'north': 'n', 'south': 's', 'east': 'e', 'west': 'w',
  'northeast': 'ne', 'northwest': 'nw', 'southeast': 'se', 'southwest': 'sw',
  'apartment': 'apt', 'apt': 'apt',
  'suite': 'ste', 'ste': 'ste',
  'building': 'bldg', 'bldg': 'bldg',
  'floor': 'fl', 'fl': 'fl',
  'number': 'num', 'no': 'num', 'num': 'num',
  'saint': 'st', 'fort': 'ft', 'ft': 'ft', 'mount': 'mt', 'mt': 'mt',
  'mountain': 'mtn', 'mtn': 'mtn'
};

function normalizeAddressPart(s) {
  const wordNormalized = String(s || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(function (w) { return ADDRESS_ABBREVIATIONS[w] || w; })
    .join(' ');
  // Collapse all remaining whitespace so extra spaces (double-spaced,
  // trailing/leading) and missing spaces ("123MainSt" vs "123 Main St")
  // both compare equal -- spacing stops mattering entirely at this point.
  return wordNormalized.replace(/\s+/g, '');
}

// Splits a "portfolio" street address entry (multiple properties in one
// field, e.g. "118 & 144 Main St", "118-144 Main St", "118/144 Main St",
// "118, 144 Main St", "118 and 144 Main St", or "118 Main St & 144 Main
// St") into individual comparable addresses. A bare hyphen only splits
// when it sits directly between two digit runs, so unit designators like
// "123-A Main St" are left alone. Returns [rawStreet] unchanged when there's
// nothing to split (including when it can't tell where the street name is).
function extractPortfolioAddresses(rawStreet) {
  const s = String(rawStreet || '').trim();
  if (!s) return [];

  const fragments = s
    .split(/\s*&\s*|\s*\/\s*|\s*,\s*|\s+and\s+|(?<=\d)\s*-\s*(?=\d)/i)
    .map(function (f) { return f.trim(); })
    .filter(Boolean);
  if (fragments.length <= 1) return [s];

  const lastFragment = fragments[fragments.length - 1];
  if (!/[a-zA-Z]/.test(lastFragment)) return [s]; // no street name anywhere; can't safely split

  const lastMatch = lastFragment.match(/^(\d+)\s+(.+)$/);
  const sharedStreetName = lastMatch ? lastMatch[2] : null;

  return fragments.map(function (f) {
    const isPureNumber = /^\d+$/.test(f);
    return (isPureNumber && sharedStreetName) ? (f + ' ' + sharedStreetName) : f;
  });
}

// Public, unauthenticated (called mid-wizard, before a lead ID exists) -- an associate can upload
// several CMA screenshots while filling out Cash Deal Details. Uploads straight to Drive and hands
// back only a shareable link; the raw image bytes never touch the Sheet or the Save My Progress URL,
// which both need to stay small. Basic content-type/size guards since this endpoint has no auth.
function uploadCmaScreenshot(body) {
  if (!body.fileData || !body.fileName) return { ok: false, error: 'Missing file data.' };
  const contentType = body.contentType || 'image/png';
  if (contentType.indexOf('image/') !== 0) return { ok: false, error: 'Only image files are allowed.' };
  if (String(body.fileData).length > 14000000) return { ok: false, error: 'File is too large (10MB max).' };
  try {
    const folder = getOrCreateCmaFolder();
    const bytes = Utilities.base64Decode(body.fileData);
    const safeAddress = String(body.address || '').replace(/[^a-zA-Z0-9 ,-]/g, '').trim();
    const fileName = (safeAddress ? safeAddress + ' - ' : '') + new Date().toISOString() + ' - ' + body.fileName;
    const blob = Utilities.newBlob(bytes, contentType, fileName);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { ok: true, url: file.getUrl() };
  } catch (e) {
    return { ok: false, error: 'Upload failed: ' + e.message };
  }
}

function getOrCreateCmaFolder() {
  const folderName = 'SendMySeller CMA Screenshots';
  const existing = DriveApp.getFoldersByName(folderName);
  if (existing.hasNext()) return existing.next();
  return DriveApp.createFolder(folderName);
}

function checkAddressDuplicate(body) {
  const city = normalizeAddressPart(body.city);
  const state = normalizeAddressPart(body.state);
  const zip = normalizeAddressPart(body.zip);
  const rawStreet = String(body.street || '').trim();
  if (!rawStreet || !city || !state || !zip) return { ok: true, duplicate: false };

  const newComponents = extractPortfolioAddresses(rawStreet).map(normalizeAddressPart);

  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const sameLocation = sheetToObjects(sheet).filter(function (l) {
    return normalizeAddressPart(l['City']) === city &&
      normalizeAddressPart(l['State']) === state &&
      normalizeAddressPart(l['Zip']) === zip;
  });

  const exactMatches = [];
  const partialMatches = [];

  sameLocation.forEach(function (l) {
    const existingRaw = String(l['Street Address'] || '').trim();
    const existingComponents = extractPortfolioAddresses(existingRaw).map(normalizeAddressPart);
    const isSimpleFullMatch = newComponents.length === 1 && existingComponents.length === 1 &&
      newComponents[0] === existingComponents[0];
    if (isSimpleFullMatch) {
      exactMatches.push(l);
      return;
    }
    const overlaps = newComponents.some(function (nc) { return existingComponents.indexOf(nc) !== -1; });
    if (overlaps) partialMatches.push(l);
  });

  const matches = exactMatches.length > 0 ? exactMatches : partialMatches;
  if (matches.length === 0) return { ok: true, duplicate: false };

  const targetEmail = String(body.email || '').trim().toLowerCase();
  const ownedByYou = matches.some(function (l) {
    return String(l['Contact Email'] || '').trim().toLowerCase() === targetEmail;
  });
  const earliest = matches.reduce(function (a, b) {
    return new Date(a['Submitted At']) < new Date(b['Submitted At']) ? a : b;
  });

  return {
    ok: true,
    duplicate: true,
    partial: exactMatches.length === 0,
    ownedByYou: ownedByYou,
    submittedAt: earliest['Submitted At'],
    status: earliest['Status'] || 'New'
  };
}

// ---------- Public: non-admin "check my leads" by email ----------
// No password on this path by design -- knowing the email is the access
// check. Only that email's own leads are ever returned, and only the
// PUBLIC_LEAD_FIELDS allowlist of columns -- any column you add directly
// in the Leads sheet (private calculations, doc links, scratch work) is
// never included here regardless of its name, since this builds a fresh
// object field-by-field rather than stripping known-sensitive ones out of
// the full row. All non-private notes are visible here (admin's
// included), tagged by author, but editing stays restricted server-side
// (see editPublicNote) to notes this same email actually authored.

function getLeadsByEmail(body) {
  if (!body.email) return { ok: false, error: 'Email is required.' };
  const targetEmail = String(body.email).trim().toLowerCase();

  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const matchingLeads = sheetToObjects(leadsSheet).filter(function (l) {
    return String(l['Contact Email'] || '').trim().toLowerCase() === targetEmail;
  });
  const notes = sheetToObjects(notesSheet);

  const notesByLead = {};
  notes.forEach(function (n) {
    if (String(n['Visibility'] || 'Shared') === 'Private') return; // admin-only, never sent here
    const id = n['Lead ID'];
    if (!notesByLead[id]) notesByLead[id] = [];
    notesByLead[id].push({ noteId: n['Note ID'], timestamp: n['Timestamp'], note: n['Note'], author: n['Author'] || 'Admin' });
  });

  const leads = matchingLeads.map(function (l) {
    const safe = {};
    PUBLIC_LEAD_FIELDS.forEach(function (f) { safe[f] = l[f]; });
    safe.notes = notesByLead[l['Lead ID']] || [];
    return safe;
  });

  return { ok: true, leads: leads };
}

function addPublicNote(body) {
  if (!body.leadId || !body.note || !body.email) return { ok: false, error: 'Missing information.' };
  const targetEmail = String(body.email).trim().toLowerCase();
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(leadsSheet);
  const match = leads.find(function (l) { return l['Lead ID'] === body.leadId; });
  if (!match || String(match['Contact Email'] || '').trim().toLowerCase() !== targetEmail) {
    return { ok: false, error: 'That lead does not belong to this email address.' };
  }
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const noteId = Utilities.getUuid();
  appendRowByHeaders(notesSheet, {
    'Lead ID': body.leadId, 'Timestamp': new Date().toISOString(), 'Note': body.note,
    'Author': body.email, 'Note ID': noteId, 'Visibility': 'Shared'
  });
  return { ok: true, noteId: noteId };
}

// Lets a submitter edit only a note they themselves added (matched by
// Note ID + Author == their email) -- never the original lead fields, and
// never anyone else's notes, including admin's.
function editPublicNote(body) {
  if (!body.noteId || !body.newText || !body.email) return { ok: false, error: 'Missing information.' };
  const targetEmail = String(body.email).trim().toLowerCase();
  const sheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const notes = sheetToObjects(sheet);
  const match = notes.find(function (n) { return n['Note ID'] === body.noteId; });
  if (!match) return { ok: false, error: 'Note not found.' };
  if (String(match['Author'] || '').trim().toLowerCase() !== targetEmail) {
    return { ok: false, error: 'You can only edit your own notes.' };
  }
  const noteCol = getColumnIndex(sheet, 'Note');
  sheet.getRange(match._row, noteCol).setValue(body.newText);
  return { ok: true };
}

// Same author check as editPublicNote, but deletes the row instead.
function deletePublicNote(body) {
  if (!body.noteId || !body.email) return { ok: false, error: 'Missing information.' };
  const targetEmail = String(body.email).trim().toLowerCase();
  const sheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const notes = sheetToObjects(sheet);
  const match = notes.find(function (n) { return n['Note ID'] === body.noteId; });
  if (!match) return { ok: false, error: 'Note not found.' };
  if (String(match['Author'] || '').trim().toLowerCase() !== targetEmail) {
    return { ok: false, error: 'You can only delete your own notes.' };
  }
  sheet.deleteRow(match._row);
  return { ok: true };
}

function updateStatus(body) {
  if (!body.leadId || !body.status) return { ok: false, error: 'Missing leadId or status.' };
  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['Lead ID'] === body.leadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  const statusCol = getColumnIndex(sheet, 'Status');
  sheet.getRange(match._row, statusCol).setValue(body.status);
  const priorityCol = getColumnIndex(sheet, 'Sort Priority');
  if (priorityCol) sheet.getRange(match._row, priorityCol).setValue(getSortPriority(body.status));
  return { ok: true };
}

// One-time convenience: run this manually from the Apps Script editor
// (select "backfillSortPriority" in the function dropdown, click Run) to
// populate Sort Priority for leads that existed before this column did.
// New leads and any future status change already keep it current on
// their own -- this is only needed once, for old rows.
function backfillSortPriority() {
  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const priorityCol = getColumnIndex(sheet, 'Sort Priority');
  leads.forEach(function (l) {
    sheet.getRange(l._row, priorityCol).setValue(getSortPriority(l['Status']));
  });
}

// Manual for now -- admin sets 1-5 (or blank for "not scored") by hand.
// Room to later add an auto-scoring rule (based on down payment requested,
// total debt, asking price, current asset value) without touching how this
// is read/displayed anywhere -- it's just a value in this one column.
function updateClosingLikelihood(body) {
  if (!body.leadId) return { ok: false, error: 'Missing leadId.' };
  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['Lead ID'] === body.leadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  const col = getColumnIndex(sheet, 'Closing Likelihood');
  sheet.getRange(match._row, col).setValue(body.score || '');
  return { ok: true };
}

// Admin-only, free text -- lets you group non-seller submitters (bird
// dogs, wholesalers, etc.) by team. Never sent to the public endpoint
// (see PUBLIC_LEAD_FIELDS). Team represents the submitter, not a single
// deal, so this applies to every lead on file from the same Contact Email,
// not just the one being edited -- and submitLead() below carries it
// forward automatically onto that email's future submissions too.
function updateTeam(body) {
  if (!body.leadId) return { ok: false, error: 'Missing leadId.' };
  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['Lead ID'] === body.leadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  const col = getColumnIndex(sheet, 'Team');
  const team = body.team || '';
  const targetEmail = String(match['Contact Email'] || '').trim().toLowerCase();

  const sameEmailLeads = targetEmail
    ? leads.filter(function (l) { return String(l['Contact Email'] || '').trim().toLowerCase() === targetEmail; })
    : [match];
  sameEmailLeads.forEach(function (l) {
    sheet.getRange(l._row, col).setValue(team);
  });

  return { ok: true, updatedCount: sameEmailLeads.length };
}

// Lets admin write a freshly-recalculated MAO suite (from the standalone MAO
// Calculator panel) onto an existing lead -- e.g. after the seller countered
// with a different rehab number, without having the associate re-run the
// whole wizard. Overwrites whatever MAO values that lead already had.
function updateMaoForLead(body) {
  if (!body.leadId) return { ok: false, error: 'Missing leadId.' };
  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['Lead ID'] === body.leadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  const fields = {
    'MAO Cash': body.maoCash || '',
    'MAO Hard Money (10% Down)': body.maoHardMoney10 || '',
    'MAO Hard Money (20% Down)': body.maoHardMoney20 || '',
    'MAO Breakdown': body.maoBreakdown || ''
  };
  Object.keys(fields).forEach(function (key) {
    const col = getColumnIndex(sheet, key);
    if (col) sheet.getRange(match._row, col).setValue(fields[key]);
  });
  return { ok: true };
}

// ---------- Admin: export + gated delete ----------

function exportToSheet(body) {
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const leads = sheetToObjects(leadsSheet);

  if (leads.length === 0) {
    return { ok: false, error: 'No leads to export.' };
  }

  const notes = sheetToObjects(notesSheet);
  const notesByLead = {};
  notes.forEach(function (n) {
    const id = n['Lead ID'];
    const line = '[' + n['Timestamp'] + '] ' + n['Note'];
    notesByLead[id] = notesByLead[id] ? notesByLead[id] + ' | ' + line : line;
  });

  const now = new Date();
  const stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let tabName = 'Export ' + stamp;
  let suffix = 1;
  while (ss.getSheetByName(tabName)) {
    tabName = 'Export ' + stamp + ' (' + (++suffix) + ')';
  }
  const exportSheet = ss.insertSheet(tabName);
  const headers = LEAD_COLUMNS.concat(['All Notes', 'Exported At']);
  exportSheet.appendRow(headers);
  exportSheet.setFrozenRows(1);

  const exportedAt = now.toISOString();
  leads.forEach(function (l) {
    const row = LEAD_COLUMNS.map(function (c) { return l[c]; });
    row.push(notesByLead[l['Lead ID']] || '');
    row.push(exportedAt);
    exportSheet.appendRow(row);
  });

  const exportToken = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('EXPORT_TOKEN', exportToken);
  props.setProperty('EXPORT_TOKEN_EXPIRES', String(Date.now() + 30 * 60 * 1000));

  return {
    ok: true,
    exportedCount: leads.length,
    tabName: tabName,
    exportToken: exportToken
  };
}

function deleteAllLeads(body) {
  const props = PropertiesService.getScriptProperties();
  const storedToken = props.getProperty('EXPORT_TOKEN');
  const expires = Number(props.getProperty('EXPORT_TOKEN_EXPIRES') || 0);

  if (!storedToken || !body.exportToken || body.exportToken !== storedToken) {
    return { ok: false, error: 'You must export the current data before it can be deleted.' };
  }
  if (Date.now() > expires) {
    return { ok: false, error: 'Export confirmation expired — please export again before deleting.' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);

  clearSheetBody(leadsSheet);
  clearSheetBody(notesSheet);

  props.deleteProperty('EXPORT_TOKEN');
  props.deleteProperty('EXPORT_TOKEN_EXPIRES');

  return { ok: true, message: 'CRM data cleared. Exported copy is safe in tab.' };
}

function clearSheetBody(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }
}
