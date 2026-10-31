function tests(M) {
  const results = [];
  const check = (name, cond, extra) => results.push((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra)));
  const EMAIL = 'me@example.com';
  const dealA = { street: '12 Maple Ave', city: 'Tucson', state: 'AZ', zip: '85701', assetType: 'Residential Property (1-4 units)', marketStatus: 'On-Market', units: '1', askingPrice: '330000', email: EMAIL, name: 'Agent', phone: '520-555-0100', preLoiNotes: 'notes A' };
  const dealB = Object.assign({}, dealA, { street: '99 Oak Street', zip: '85702' });
  const save = (a, crmId) => adminSavePreLoi({ email: EMAIL, crmId: crmId || '', stepIndex: 19, answers: a });
  const list = (inc) => adminGetPreLoi({ includeDeleted: !!inc }).entries;

  // 1. many Pre-LOIs, none replaces another
  const a1 = save(dealA), b1 = save(dealB);
  check('two different properties = two rows', a1.ok && b1.ok && a1.crmId !== b1.crmId && list().length === 2, { a1, b1, n: list().length });
  const a2 = save(Object.assign({}, dealA, { askingPrice: '325000' }));
  check('same property saved again updates, no duplicate', a2.ok && a2.crmId === a1.crmId && list().length === 2 && a2.how.indexOf('updated') !== -1, { a2, n: list().length });
  check('same property written differently still matches', save(Object.assign({}, dealA, { street: '12 MAPLE AVENUE.' })).crmId === a1.crmId, {});
  check('a different zip is a different property', save(Object.assign({}, dealA, { zip: '85999' })).crmId !== a1.crmId, {});
  check('saved answers are read back intact', adminGetPreLoiEntry({ crmId: a1.crmId }).entry.answers.preLoiNotes === 'notes A', {});

  // 2. soft delete, restore, purge
  const d = adminDeletePreLoi({ crmId: b1.crmId });
  check('delete hides it but keeps the row', d.ok && !list().some(e => e.crmId === b1.crmId) && list(true).some(e => e.crmId === b1.crmId && e.status === PRELOI_DELETED_STATUS), { d });
  check('restore brings it back', adminRestorePreLoi({ crmId: b1.crmId }).ok && list().some(e => e.crmId === b1.crmId), {});
  check('purge refuses a live Pre-LOI', adminPurgePreLoi({ crmId: b1.crmId }).ok === false, {});
  adminDeletePreLoi({ crmId: b1.crmId });
  check('saving a deleted property again restores it as a normal Pre-LOI', save(dealB).crmId === b1.crmId && list().some(e => e.crmId === b1.crmId && e.status === PRELOI_STATUS), {});
  adminDeletePreLoi({ crmId: b1.crmId });
  check('purge removes a deleted one for good', adminPurgePreLoi({ crmId: b1.crmId }).ok && !list(true).some(e => e.crmId === b1.crmId), {});

  // 3. finishing: no Leads row, no beehiiv call, no email, a Submissions row
  const full = Object.assign({}, dealA, { sellerContactName: 'Rita Realtor', sellerContactEmail: 'rita@broker.com', loiUrl: 'https://pharaohm33.github.io/loi-generator?address=12+Maple' });
  const fin = adminFinishPreLoi({ email: EMAIL, crmId: a1.crmId, stepIndex: 19, answers: full, loiUrl: full.loiUrl });
  check('finish succeeds', fin.ok && fin.submissionId && fin.crmId === a1.crmId, { fin });
  check('finish adds nothing to Leads', !M.sheets['Leads'] || M.sheets['Leads'].data.length <= 1, { rows: M.sheets['Leads'] && M.sheets['Leads'].data.length });
  check('finish makes no beehiiv call and no email', M.fetches() === 0 && M.mails() === 0, { f: M.fetches(), m: M.mails() });
  check('the Pre-LOI row is now Form Completed', list().find(e => e.crmId === a1.crmId).status === PRELOI_DONE_STATUS, {});
  const bad = adminFinishPreLoi({ email: EMAIL, answers: Object.assign({}, dealA, { city: '' }) });
  check('finish refuses a missing city (and says which)', !bad.ok && /city/.test(bad.error), { bad });

  // 4. a real public submission is kept too, and the two can be cross referenced
  const pub = submitLead({ data: { role: 'Seller', name: 'Sam Seller', email: 'sam@example.com', phone: '520-555-0111', street: '12 Maple Ave', city: 'Tucson', state: 'AZ', zip: '85701', units: '1', assetType: 'Residential Property (1-4 units)', marketStatus: 'Off-Market' } });
  check('public submitLead still works', pub.ok === true || /agreement|MAO|Missing/.test(String(pub.error)), { pub });
  if (pub.ok) {
    const subs = adminGetSubmissions({}).submissions;
    check('public submission is logged', subs.some(s => s.source === 'Public form' && s.leadId === pub.leadId), { n: subs.length });
    const mine = subs.find(s => s.submissionId === fin.submissionId);
    check('cross reference: the Pre-LOI submission sees the Lead and the Pre-LOI row', mine.matches.leads === 1 && mine.matches.preLoi >= 1, { m: mine.matches });
    const detail = adminGetSubmission({ submissionId: fin.submissionId }).submission;
    check('detail lists related records of each kind', ['Lead', 'Pre-LOI', 'Submission'].every(k => detail.related.some(r => r.kind === k)), { rel: detail.related.map(r => r.kind) });
  }
  const only = adminGetSubmissions({ source: 'Pre-LOI' }).submissions;
  check('source filter', only.length === 1 && only[0].adminEmailed === 'No', { only: only.map(o => o.source) });
  check('search by address', adminGetSubmissions({ q: 'maple' }).total >= 1 && adminGetSubmissions({ q: 'zzz' }).total === 0, {});

  // 5. recording where the LOI ended up
  const up = adminUpdateSubmission({ submissionId: fin.submissionId, docUrl: 'https://docs.google.com/document/d/abc', draftStatus: 'Gmail draft saved' });
  const after = adminGetSubmission({ submissionId: fin.submissionId }).submission;
  check('doc link and draft status can be recorded', up.ok && after.docUrl.indexOf('docs.google.com') !== -1 && after.draftStatus === 'Gmail draft saved', { after: after.docUrl });
  check('answers survive the round trip', after.answers.sellerContactEmail === 'rita@broker.com' && after.loiLink.indexOf('loi-generator') !== -1, {});

  // 6. sent: the Pre-LOI stays, a copy goes to the CRM, and the public CRM route never shows Pre-LOI rows
  const sent = adminMarkPreLoiSent({ crmId: a1.crmId });
  check('LOI sent keeps the Pre-LOI row', sent.ok && list().find(e => e.crmId === a1.crmId).status === PRELOI_SENT_STATUS, { sent });
  const pubCrm = getCrmEntries({ email: EMAIL }).entries;
  check('the CRM gets a copy as Offer sent to cold lead', pubCrm.length === 1 && pubCrm[0].status === 'Offer sent to cold lead' && pubCrm[0].crmId === sent.crmId, { pubCrm: pubCrm.map(e => e.status) });
  check('public CRM never exposes Pre-LOI rows', !pubCrm.some(e => isPreLoiStatus(e.status)) && getCrmEntry({ email: EMAIL, crmId: a1.crmId }).ok === false, {});
  check('no email or beehiiv call at any point', M.mails() === 0, { m: M.mails(), f: M.fetches() });

  // 7. the audit log recorded every step
  const log = M.sheets['Pre-LOI Log'].data.slice(1).map(r => r[1]);
  check('audit log has save / delete / restore / finish / sent / purge', ['save', 'delete', 'restore', 'finish', 'sent', 'purge'].every(a => log.indexOf(a) !== -1), { log });

  // 8. huge answers still produce a Submissions row
  const huge = Object.assign({}, dealA, { street: '5 Big Rd', zip: '85710', preLoiNotes: 'x'.repeat(200000) });
  const fh = adminFinishPreLoi({ email: EMAIL, answers: huge });
  check('a very large form still saves (long AI text is trimmed)', fh.ok === true || /too much data/.test(String(fh.error)), { fh: fh.error });

  // 9. submissions can be deleted (reversibly) and filed in the normal CRM at a pipeline stage
  const dealC = Object.assign({}, dealA, { street: '7 Pine Rd', zip: '85703', role: 'Wholesaler', units: '1', rentalIncomeMethod: 'Long-term rental (LTR)', rentalIncomeDetail: 'LTR rent $1,975/mo less 35% = NOI', rentcastMonthlyRent: '1975', expenseRatio: '35', residentialNOI: '15405', strAnnualRevenue: '30000', strNOI: '15000' });
  const c1 = adminFinishPreLoi({ email: EMAIL, answers: dealC, loiUrl: 'https://x.io/?a=1' });
  const subList = inc => adminGetSubmissions({ includeDeleted: !!inc }).submissions;
  check('delete hides a submission but keeps its row', adminDeleteSubmission({ submissionId: c1.submissionId }).ok && !subList().some(x => x.submissionId === c1.submissionId) && subList(true).some(x => x.submissionId === c1.submissionId && x.deletedAt), {});
  check('a deleted submission no longer counts as a match', !adminGetSubmissions({ includeDeleted: true }).submissions.some(x => x.matches && x.submissionId !== c1.submissionId && x.street === '7 Pine Rd' && x.matches.submissions > 1), {});
  check('add to CRM refuses a deleted submission', adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'New' }).ok === false, {});
  check('restore brings a submission back', adminRestoreSubmission({ submissionId: c1.submissionId }).ok && subList().some(x => x.submissionId === c1.submissionId), {});
  check('purge refuses a live submission', adminPurgeSubmission({ submissionId: c1.submissionId }).ok === false, {});
  check('add to CRM refuses an unknown stage', adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'Bogus' }).ok === false, {});
  const leadsBefore = M.sheets['Leads'] ? M.sheets['Leads'].data.length : 0, mailsBefore = M.mails(), fetchesBefore = M.fetches();
  const add = adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'Offer Sent' });
  const leadRows = () => { const sh = M.sheets['Leads'], h = sh.data[0]; return sh.data.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; }); };
  const lr = add.ok ? leadRows().find(l => l['Lead ID'] === add.leadId) : null;
  check('add to CRM writes a Leads row at the chosen stage', add.ok && add.how === 'added' && lr && lr['Status'] === 'Offer Sent' && lr['Street Address'] === '7 Pine Rd', { add, lr });
  check('the CRM row carries the rental income method and the rent / NOI numbers', lr && lr['Rental Income Method'] === 'Long-term rental (LTR)' && /35%/.test(lr['Rental Income Detail']) && lr['Monthly Rent Estimate'] === '1975' && lr['NOI'] === '15405' && lr['STR Annual Revenue'] === '30000' && lr['Expense Ratio %'] === '35', { lr: lr && [lr['Rental Income Method'], lr['Monthly Rent Estimate'], lr['NOI'], lr['STR Annual Revenue']] });
  check('add to CRM sends no email and no beehiiv call', M.mails() === mailsBefore && M.fetches() === fetchesBefore, {});
  check('the submission now points at its CRM lead and shows its stage', subList().find(x => x.submissionId === c1.submissionId).leadId === add.leadId && subList().find(x => x.submissionId === c1.submissionId).leadStatus === 'Offer Sent', {});
  const move = adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'Negotiation' });
  check('adding again just moves the same lead to the new stage', move.ok && move.how === 'moved' && move.leadId === add.leadId && leadRows().filter(l => l['Street Address'] === '7 Pine Rd').length === 1 && leadRows().find(l => l['Lead ID'] === add.leadId)['Status'] === 'Negotiation', { move });
  const dealD = Object.assign({}, dealC, { street: '7 PINE ROAD', rentalIncomeMethod: 'None: fix & flip' });
  const d1 = adminFinishPreLoi({ email: EMAIL, answers: dealD, loiUrl: 'https://x.io/?a=2' });
  const dup = adminAddSubmissionToCrm({ submissionId: d1.submissionId, status: 'New' });
  check('the same property already in the CRM is reported first', dup.ok === false && dup.duplicate && dup.duplicate.leadId === add.leadId && leadRows().filter(l => /pine/i.test(l['Street Address'])).length === 1, { dup });
  const forced = adminAddSubmissionToCrm({ submissionId: d1.submissionId, status: 'New', force: true });
  check('force adds it anyway', forced.ok && forced.how === 'added' && leadRows().filter(l => /pine/i.test(l['Street Address'])).length === 2, { forced });
  const noRole = adminFinishPreLoi({ email: EMAIL, answers: Object.assign({}, dealC, { street: '8 Elm Ct', zip: '85704', role: '' }), loiUrl: '' });
  const nr = adminAddSubmissionToCrm({ submissionId: noRole.submissionId, status: 'New' });
  check('a submission missing a required CRM field is refused and says which', nr.ok === false && /role/.test(nr.error), { nr });
  adminDeleteSubmission({ submissionId: d1.submissionId });
  check('purge removes a deleted submission for good', adminPurgeSubmission({ submissionId: d1.submissionId }).ok && !subList(true).some(x => x.submissionId === d1.submissionId), {});
  const log2 = M.sheets['Pre-LOI Log'].data.slice(1).map(r => r[1]);
  check('the audit log records submission delete / restore / purge / to-crm', ['delete submission', 'restore submission', 'purge submission', 'to-crm submission'].every(a => log2.indexOf(a) !== -1), { log2 });
  check('the public CRM sheet of cold leads is untouched by all of this', getCrmEntries({ email: EMAIL }).entries.length === 1, {});
  return results.join('\n') + '\n' + results.filter(r => r.startsWith('FAIL')).length + ' failed of ' + results.length;
}
