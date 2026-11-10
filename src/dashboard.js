#!/usr/bin/env node
/**
 * dashboard.js: one weekly rollup of every outreach channel
 *
 * Each sender script keeps its own JSON log. This job reads all of them and
 * sends ONE consolidated report:
 *   - Partner pitches            (outreach-log.json)
 *   - Competitor-link prospects  (prospect-log.json)
 *   - Resource page outreach     (resource-outreach-log.json)
 *   - Link reclamation           (reclamation-log.json)
 *   - Journalist requests        (journalist-log.json)
 *   - Follow-up activity         (read from the three outreach logs)
 *   - Backlink snapshot          (backlink-snapshot.json)
 *   - Target pool                (discovered-targets.json)
 *
 * A missing log is treated as an empty channel, never as an error.
 *
 * Usage:
 *   node src/dashboard.js                        # send report
 *   node src/dashboard.js --dry-run              # print totals only
 *   node src/dashboard.js --dry-run --html=out.html   # also write the report HTML
 *
 * Schedule: Sunday evening, so the full week is visible before Monday.
 */

const fs         = require('fs');
const path       = require('path');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: true, quiet: true });

const DRY_RUN  = process.argv.includes('--dry-run');
const HTML_ARG = process.argv.find(a => a.startsWith('--html='));
const DIR      = process.env.STATE_DIR || path.join(ROOT, 'state');

const COMPANY      = process.env.COMPANY_NAME || 'Acme Supply Co.';
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAIL = process.env.EMAIL_NOTIFY || GMAIL_USER;
// Combined weekday send rate across channels, used for the pool runway estimate
const DAILY_SEND_RATE = parseInt(process.env.DAILY_SEND_RATE || '16', 10);

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function daysAgo(dateStr) {
  if (!dateStr) return Infinity;
  return (Date.now() - new Date(dateStr).getTime()) / 86400000;
}

function withinDays(dateStr, days) {
  return daysAgo(dateStr) <= days;
}

// ── Gather stats from all logs ──────────────────────────────────────────────
function gatherStats() {
  const stats = {
    guestPost:    { total: 0, thisWeek: 0, sent: 0, replied: 0, cold: 0, entries: [] },
    competitor:   { total: 0, thisWeek: 0, sent: 0, replied: 0, cold: 0, entries: [] },
    resource:     { total: 0, thisWeek: 0, sent: 0, replied: 0, cold: 0, entries: [] },
    reclamation:  { broken: 0, lost: 0, mentions: 0, thisWeek: 0 },
    haro:         { total: 0, thisWeek: 0, entries: [] },
    followUps:    { sent7day: 0, sent14day: 0, markedCold: 0 },
    pool:         { total: 0, contacted: 0, remaining: 0 },
    backlinks:    { live: 0, snapshotDate: null },
  };

  // 1. Partner pitch log
  const guestLog = loadJson(path.join(DIR, 'outreach-log.json')) || {};
  for (const [key, entry] of Object.entries(guestLog)) {
    stats.guestPost.total++;
    if (entry.status === 'replied') stats.guestPost.replied++;
    else if (entry.status === 'cold') stats.guestPost.cold++;
    else stats.guestPost.sent++;
    if (withinDays(entry.lastSent, 7)) {
      stats.guestPost.thisWeek++;
      stats.guestPost.entries.push({ name: entry.name || key, email: entry.email, status: entry.status, date: entry.lastSent });
    }
  }

  // 2. Competitor-link prospect log
  const stealerLog = loadJson(path.join(DIR, 'prospect-log.json')) || {};
  for (const [key, entry] of Object.entries(stealerLog)) {
    stats.competitor.total++;
    if (entry.status === 'replied') stats.competitor.replied++;
    else if (entry.status === 'cold') stats.competitor.cold++;
    else stats.competitor.sent++;
    if (withinDays(entry.lastSent, 7)) {
      stats.competitor.thisWeek++;
      stats.competitor.entries.push({ name: entry.competitor || key, email: entry.email, status: entry.status, date: entry.lastSent });
    }
  }

  // 3. Resource page outreach log
  const resourceLog = loadJson(path.join(DIR, 'resource-outreach-log.json')) || {};
  for (const [key, entry] of Object.entries(resourceLog)) {
    stats.resource.total++;
    if (entry.status === 'replied') stats.resource.replied++;
    else if (entry.status === 'cold') stats.resource.cold++;
    else stats.resource.sent++;
    if (withinDays(entry.lastSent, 7)) {
      stats.resource.thisWeek++;
      stats.resource.entries.push({ name: entry.title || key, email: entry.email, status: entry.status, date: entry.lastSent });
    }
  }

  // 4. Link reclamation log
  const reclaimLog = loadJson(path.join(DIR, 'reclamation-log.json')) || {};
  if (reclaimLog.broken) {
    for (const [key, entry] of Object.entries(reclaimLog.broken)) {
      stats.reclamation.broken++;
      if (withinDays(entry.checkedAt, 7)) stats.reclamation.thisWeek++;
    }
  }
  if (reclaimLog.lost) {
    for (const [key, entry] of Object.entries(reclaimLog.lost)) {
      stats.reclamation.lost++;
      if (withinDays(entry.foundAt, 7)) stats.reclamation.thisWeek++;
    }
  }
  if (reclaimLog.unlinked) {
    stats.reclamation.mentions = Object.keys(reclaimLog.unlinked).length;
  }

  // 5. Journalist request log
  const haroLog = loadJson(path.join(DIR, 'journalist-log.json')) || {};
  for (const [key, entry] of Object.entries(haroLog)) {
    stats.haro.total++;
    if (withinDays(entry.sentAt || entry.lastSent, 7)) {
      stats.haro.thisWeek++;
      stats.haro.entries.push({ query: entry.query || key, outlet: entry.outlet, date: entry.sentAt || entry.lastSent });
    }
  }

  // 6. Follow-up stats (scan all 3 outreach logs for follow-up statuses)
  for (const log of [guestLog, stealerLog, resourceLog]) {
    for (const entry of Object.values(log)) {
      if (entry.status === 'follow1-sent' && withinDays(entry.lastSent, 7)) stats.followUps.sent7day++;
      if (entry.status === 'follow2-sent' && withinDays(entry.lastSent, 7)) stats.followUps.sent14day++;
      if (entry.status === 'cold' && withinDays(entry.lastSent, 7)) stats.followUps.markedCold++;
    }
  }

  // 7. Target pool stats
  const blogs = loadJson(path.join(DIR, 'discovered-targets.json')) || [];
  stats.pool.total = blogs.length;
  const allLogs = { ...guestLog, ...stealerLog, ...resourceLog };
  stats.pool.contacted = Object.keys(allLogs).length;
  stats.pool.remaining = Math.max(0, stats.pool.total - stats.pool.contacted);

  // 8. Backlink snapshot
  const snapshot = loadJson(path.join(DIR, 'backlink-snapshot.json'));
  if (snapshot) {
    stats.backlinks.live = snapshot.totalLive || Object.keys(snapshot.backlinks || {}).length;
    stats.backlinks.snapshotDate = snapshot.capturedAt;
  }

  return stats;
}

// ── Build HTML report ───────────────────────────────────────────────────────
function buildReport(stats) {
  const date = new Date().toLocaleDateString('en-CA');
  const weekStart = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA');

  const totalSentThisWeek = stats.guestPost.thisWeek + stats.competitor.thisWeek + stats.resource.thisWeek;
  const totalAllTime = stats.guestPost.total + stats.competitor.total + stats.resource.total;
  const totalReplied = stats.guestPost.replied + stats.competitor.replied + stats.resource.replied;
  const replyRate = totalAllTime > 0 ? ((totalReplied / totalAllTime) * 100).toFixed(1) : '0.0';

  return `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;background:#f9f9f9">

<div style="background:#1a1a2e;color:white;padding:24px;border-radius:12px 12px 0 0">
  <h1 style="margin:0;font-size:22px">📊 Weekly Outreach Dashboard</h1>
  <p style="margin:6px 0 0;opacity:0.8;font-size:14px">${weekStart} → ${date}</p>
</div>

<div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:0">

<!-- ── TOP-LINE METRICS ── -->
<div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap">
  <div style="flex:1;min-width:120px;background:#eef7f0;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:#27ae60">${totalSentThisWeek}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">Emails Sent<br>This Week</div>
  </div>
  <div style="flex:1;min-width:120px;background:#f0f4ff;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:#3498db">${totalAllTime}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">Total Contacts<br>All Time</div>
  </div>
  <div style="flex:1;min-width:120px;background:#fef9f0;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:#e67e22">${totalReplied}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">Replies<br>(${replyRate}% rate)</div>
  </div>
  <div style="flex:1;min-width:120px;background:#f5f0ff;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:#8e44ad">${stats.pool.remaining}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">Targets Left<br>in Pool (${stats.pool.total})</div>
  </div>
</div>

<!-- ── CHANNEL BREAKDOWN ── -->
<h3 style="color:#1a1a2e;border-bottom:2px solid #eee;padding-bottom:8px;margin-top:0">📬 Outreach by Channel</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
  <tr style="background:#f8f9fa;font-weight:bold">
    <td style="padding:10px;border-bottom:1px solid #eee">Channel</td>
    <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">This Week</td>
    <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">All Time</td>
    <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">Replied</td>
    <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">Cold</td>
  </tr>
  <tr>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0">📝 Partner Pitches</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:bold">${stats.guestPost.thisWeek}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center">${stats.guestPost.total}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#27ae60">${stats.guestPost.replied}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#999">${stats.guestPost.cold}</td>
  </tr>
  <tr>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0">🕵️ Competitor-Link Prospects</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:bold">${stats.competitor.thisWeek}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center">${stats.competitor.total}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#27ae60">${stats.competitor.replied}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#999">${stats.competitor.cold}</td>
  </tr>
  <tr style="opacity:0.5">
    <td style="padding:10px;border-bottom:1px solid #f0f0f0">📋 Resource Page Outreach <span style="background:#f0f0f0;color:#999;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:4px">PAUSED</span><br><span style="font-size:10px;color:#999">Pitches sites with roundup and list pages to add the company as a resource link.</span></td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:bold">-</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center">${stats.resource.total}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#27ae60">${stats.resource.replied}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#999">${stats.resource.cold}</td>
  </tr>
  <tr>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0">🔗 Link Reclamation</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:bold">${stats.reclamation.thisWeek}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center">${stats.reclamation.broken + stats.reclamation.lost}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#666">-</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#666">-</td>
  </tr>
  <tr>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0">📰 Journalist Request Pitches</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:bold">${stats.haro.thisWeek}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center">${stats.haro.total}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#666">-</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#666">-</td>
  </tr>
</table>

<!-- ── FOLLOW-UP STATUS ── -->
<h3 style="color:#1a1a2e;border-bottom:2px solid #eee;padding-bottom:8px">🔄 Follow-Up Activity (This Week)</h3>
<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
  <div style="flex:1;min-width:100px;background:#fff8e6;padding:12px;border-radius:8px;text-align:center">
    <div style="font-size:22px;font-weight:bold;color:#f39c12">${stats.followUps.sent7day}</div>
    <div style="font-size:11px;color:#666">First Follow-Ups</div>
  </div>
  <div style="flex:1;min-width:100px;background:#ffeee6;padding:12px;border-radius:8px;text-align:center">
    <div style="font-size:22px;font-weight:bold;color:#e74c3c">${stats.followUps.sent14day}</div>
    <div style="font-size:11px;color:#666">Breakup Notes</div>
  </div>
  <div style="flex:1;min-width:100px;background:#f0f0f0;padding:12px;border-radius:8px;text-align:center">
    <div style="font-size:22px;font-weight:bold;color:#999">${stats.followUps.markedCold}</div>
    <div style="font-size:11px;color:#666">Marked Cold</div>
  </div>
</div>

<!-- ── BACKLINK HEALTH ── -->
<h3 style="color:#1a1a2e;border-bottom:2px solid #eee;padding-bottom:8px">🔗 Backlink Health</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
  <tr>
    <td style="padding:8px;color:#666">Live backlinks (Ahrefs snapshot)</td>
    <td style="padding:8px;text-align:right;font-weight:bold">${stats.backlinks.live || 'No snapshot yet'}</td>
  </tr>
  <tr>
    <td style="padding:8px;color:#666">Broken backlinks detected</td>
    <td style="padding:8px;text-align:right;font-weight:bold;color:#e74c3c">${stats.reclamation.broken}</td>
  </tr>
  <tr>
    <td style="padding:8px;color:#666">Lost backlinks detected</td>
    <td style="padding:8px;text-align:right;font-weight:bold;color:#e67e22">${stats.reclamation.lost}</td>
  </tr>
  <tr>
    <td style="padding:8px;color:#666">Unlinked brand mentions found</td>
    <td style="padding:8px;text-align:right;font-weight:bold;color:#3498db">${stats.reclamation.mentions}</td>
  </tr>
  <tr>
    <td style="padding:8px;color:#666">Last snapshot</td>
    <td style="padding:8px;text-align:right;font-size:12px;color:#999">${stats.backlinks.snapshotDate ? stats.backlinks.snapshotDate.split('T')[0] : 'Never'}</td>
  </tr>
</table>

<!-- ── TARGET POOL ── -->
<h3 style="color:#1a1a2e;border-bottom:2px solid #eee;padding-bottom:8px">🎯 Target Pool Status</h3>
<div style="background:#f8f9fa;padding:16px;border-radius:8px;margin-bottom:20px">
  <div style="display:flex;justify-content:space-between;margin-bottom:8px">
    <span style="font-size:13px;color:#666">Progress through the discovered target pool</span>
    <span style="font-size:13px;font-weight:bold">${stats.pool.contacted} / ${stats.pool.total}</span>
  </div>
  <div style="background:#e0e0e0;border-radius:4px;height:12px;overflow:hidden">
    <div style="background:linear-gradient(90deg,#27ae60,#2ecc71);height:100%;width:${stats.pool.total > 0 ? Math.round((stats.pool.contacted / stats.pool.total) * 100) : 0}%;border-radius:4px"></div>
  </div>
  <p style="font-size:12px;color:#999;margin:8px 0 0">
    At ~${DAILY_SEND_RATE} emails per weekday across channels, the pool will be exhausted in ~${Math.ceil(stats.pool.remaining / DAILY_SEND_RATE)} business days.
    ${stats.pool.remaining < 50 ? '<strong style="color:#e74c3c">⚠️ Running low: time to discover more targets!</strong>' : ''}
  </p>
</div>

${stats.guestPost.entries.length > 0 ? `
<!-- ── THIS WEEK'S SENDS ── -->
<h3 style="color:#1a1a2e;border-bottom:2px solid #eee;padding-bottom:8px">📨 This Week's Outreach Detail</h3>
<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px">
  <tr style="background:#f8f9fa;font-weight:bold">
    <td style="padding:8px;border-bottom:1px solid #eee">Target</td>
    <td style="padding:8px;border-bottom:1px solid #eee">Email</td>
    <td style="padding:8px;border-bottom:1px solid #eee">Channel</td>
    <td style="padding:8px;border-bottom:1px solid #eee">Status</td>
  </tr>
  ${[
    ...stats.guestPost.entries.map(e => ({ ...e, channel: 'Partner' })),
    ...stats.competitor.entries.map(e => ({ ...e, channel: 'Competitor' })),
    ...stats.resource.entries.map(e => ({ ...e, channel: 'Resource' })),
  ].slice(0, 30).map(e => `
  <tr>
    <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${e.name}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#666">${e.email || '-'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${e.channel}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">
      <span style="background:${e.status === 'replied' ? '#eef7f0' : e.status === 'cold' ? '#f0f0f0' : '#f0f4ff'};
                    color:${e.status === 'replied' ? '#27ae60' : e.status === 'cold' ? '#999' : '#3498db'};
                    padding:2px 8px;border-radius:10px;font-size:11px">${e.status}</span>
    </td>
  </tr>`).join('')}
</table>
` : ''}

</div>

<p style="text-align:center;font-size:11px;color:#999;margin-top:16px">
  ${COMPANY} outreach pipeline, weekly dashboard
</p>

</body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n📊 Weekly Outreach Dashboard  [${new Date().toISOString()}]\n`);

  const stats = gatherStats();

  const totalSent = stats.guestPost.thisWeek + stats.competitor.thisWeek + stats.resource.thisWeek;
  const totalAll = stats.guestPost.total + stats.competitor.total + stats.resource.total;
  const totalReplied = stats.guestPost.replied + stats.competitor.replied + stats.resource.replied;

  console.log(`  📬 This week: ${totalSent} emails sent`);
  console.log(`  📊 All time:  ${totalAll} contacts | ${totalReplied} replies`);
  console.log(`  🔄 Follow-ups: ${stats.followUps.sent7day} nudges + ${stats.followUps.sent14day} last-touch`);
  console.log(`  🎯 Pool: ${stats.pool.contacted}/${stats.pool.total} contacted (${stats.pool.remaining} remaining)`);
  console.log(`  🔗 Backlinks: ${stats.backlinks.live} live | ${stats.reclamation.broken} broken | ${stats.reclamation.lost} lost\n`);

  const html = buildReport(stats);

  if (DRY_RUN) {
    if (HTML_ARG) {
      const out = path.resolve(HTML_ARG.split('=')[1]);
      fs.writeFileSync(out, html);
      console.log(`  📝 Report HTML written to ${out}`);
    }
    console.log('── DRY RUN: no email sent ──\n');
    return;
  }

  const date = new Date().toLocaleDateString('en-CA');

  if (!GMAIL_PASS) {
    console.error('❌ GMAIL_APP_PASSWORD not set: cannot send dashboard email.');
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  await transporter.sendMail({
    from:    `"${COMPANY} Outreach Dashboard" <${GMAIL_USER}>`,
    to:      NOTIFY_EMAIL,
    subject: `[${COMPANY} | Report] Outreach Dashboard: ${totalSent} sent, ${totalReplied} replies: ${date}`,
    html,
  });

  console.log(`  ✅ Dashboard emailed to ${NOTIFY_EMAIL}\n`);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
