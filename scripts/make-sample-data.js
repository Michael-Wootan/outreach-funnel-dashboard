#!/usr/bin/env node
'use strict';
/**
 * Writes small sample logs (relative dates, example.com-style addresses) into
 * STATE_DIR so the dashboard can be rendered offline:
 *
 *   npm run sample      # generates data, then writes sample-report.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.STATE_DIR || path.join(ROOT, 'state');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
if (fs.existsSync(path.join(DIR, 'outreach-log.json')) && !process.argv.includes('--force')) {
  console.error(`${DIR} already has logs. Re-run with --force to overwrite them.`);
  process.exit(1);
}

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const STATUSES = ['sent', 'sent', 'sent', 'follow1-sent', 'follow2-sent', 'replied', 'cold', 'cold'];

function makeLog(prefix, count, extra) {
  const log = {};
  for (let i = 1; i <= count; i++) {
    const domain = `${prefix}-${i}.example`;
    log[domain] = {
      name: `${prefix.replace(/^\w/, c => c.toUpperCase())} Site ${i}`,
      email: `editor@${domain}`,
      subject: 'Contributor idea',
      lastSent: daysAgo((i * 3) % 60),
      status: STATUSES[i % STATUSES.length],
      ...(extra ? extra(i) : {}),
    };
  }
  return log;
}

const partner  = makeLog('partner', 48);
const prospect = makeLog('prospect', 30, i => ({ competitor: `Competitor ${1 + (i % 4)}` }));
const resource = makeLog('resource', 12, i => ({ title: `Resource page ${i}` }));

const pool = [];
for (let i = 1; i <= 220; i++) pool.push({ domain: `target-${i}.example`, dr: 30 + (i % 50) });

const journalist = {};
for (let i = 1; i <= 9; i++) journalist[`query-${i}`] = { query: `Sample journalist query ${i}`, outlet: `Outlet ${i}`, sentAt: daysAgo(i * 4) };

const write = (name, data) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(data, null, 2));
write('outreach-log.json', partner);
write('prospect-log.json', prospect);
write('resource-outreach-log.json', resource);
write('journalist-log.json', journalist);
write('discovered-targets.json', pool);
write('reclamation-log.json', {
  broken:   { 'https://old-1.example/post': { checkedAt: daysAgo(2) }, 'https://old-2.example/post': { checkedAt: daysAgo(20) } },
  lost:     { 'https://lost-1.example/page': { foundAt: daysAgo(5) } },
  unlinked: { 'https://mention-1.example': {}, 'https://mention-2.example': {}, 'https://mention-3.example': {} },
});
write('backlink-snapshot.json', { capturedAt: daysAgo(3), totalLive: 412 });
console.log(`Sample logs written to ${DIR}`);
