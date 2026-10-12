// lib/sessions.js: pauses from beats, timeouts, deadlines, windows, the extension check.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/sessions');

const T0 = Date.parse('2026-10-12T14:00:00Z');
const sec = n => T0 + n * 1000;
const doc = { id: 'd1', assignmentId: 'a1', classId: 'c1', studentId: 'u1', seq: 0, status: 'in-progress' };
const assignment = (w = {}) => ({ id: 'a1', publishedAt: '2026-10-01T00:00:00Z', writing: { mode: 'open', pauseGraceSec: 0, ...w } });
function start(w, extra = {}) {
  return S.newSession({ doc, assignment: assignment(w), userId: 'u1', body: { surfaceId: 'tab1', surf: 'tab', extPresent: true }, now: T0, ...extra });
}
const beat = (s, t, b) => S.applyBeat(s, { surfaceId: 'tab1', surf: 'tab', focused: true, visible: true, fullscreen: true, extPresent: true, ...b }, sec(t));

test('leaving the tab for 5 seconds records one pause with its reason and length', () => {
  const s = start();
  beat(s, 10, {});
  beat(s, 20, { focused: false, visible: false });       // left the tab
  assert.strictEqual(s.pauses.length, 0, 'not yet: the grace is 2 seconds');
  S.evaluateFocus(s, sec(23));                            // a read 3 s later opens the pause
  assert.strictEqual(s.state, 'paused');
  assert.deepStrictEqual(s.pauses[0], { from: new Date(sec(20)).toISOString(), to: null, reason: 'left-tab' });
  beat(s, 25, {});                                        // back
  assert.strictEqual(s.state, 'active');
  assert.strictEqual(s.pauses.length, 1);
  assert.strictEqual(Date.parse(s.pauses[0].to) - Date.parse(s.pauses[0].from), 5000);
  assert.deepStrictEqual(s.events.filter(e => e.type === 'pause' || e.type === 'resume').map(e => e.type), ['pause', 'resume']);
  assert.strictEqual(S.clientView(s, sec(26)).awayMs, 5000);
});

test('a pause is recorded even when the only beats are "left" and "back"', () => {
  const s = start();
  beat(s, 10, { focused: false });                        // another window
  beat(s, 15, {});                                        // back 5 s later, no read in between
  assert.strictEqual(s.pauses.length, 1);
  assert.strictEqual(s.pauses[0].reason, 'left-window');
});

test('a quick tab-to-panel handoff (under 2 s) records no pause', () => {
  const s = start();
  beat(s, 10, { focused: false, visible: true });          // tab loses focus…
  S.applyBeat(s, { surfaceId: 'panel1', surf: 'panel', focused: true, visible: true }, sec(11.5)); // …panel has it 1.5 s later
  S.evaluateFocus(s, sec(30));
  assert.strictEqual(s.pauses.length, 0);
  assert.strictEqual(s.state, 'active');
  // but a slow one (3 s) is a pause
  beat(s, 40, { focused: true });
  S.applyBeat(s, { surfaceId: 'panel1', surf: 'panel', focused: false }, sec(41));
  beat(s, 42, { focused: false });
  beat(s, 45, { focused: true });
  assert.strictEqual(s.pauses.length, 1);
});

test('the teacher’s grace period lengthens the allowance', () => {
  const s = start({ pauseGraceSec: 10 });
  beat(s, 10, { focused: false });
  beat(s, 18, {});
  assert.strictEqual(s.pauses.length, 0);
  beat(s, 30, { focused: false });
  beat(s, 45, {});
  assert.strictEqual(s.pauses.length, 1);
});

test('locked mode: leaving full screen pauses; the side panel doesn’t need it when the teacher allows it', () => {
  const s = start({ mode: 'locked', panelBrowsing: true });
  assert.strictEqual(s.panelResearch, true);
  beat(s, 5, { fullscreen: false });
  S.evaluateFocus(s, sec(9));
  assert.strictEqual(s.pauses[0].reason, 'exit-fullscreen');
  assert.ok(s.events.some(e => e.type === 'fullscreen-exit'));
  beat(s, 12, { fullscreen: true });
  assert.strictEqual(s.state, 'active');
  // writing in the panel while the tab is out of full screen is fine
  S.applyBeat(s, { surfaceId: 'panel1', surf: 'panel', focused: true }, sec(20));
  beat(s, 20.5, { fullscreen: false, focused: false });
  S.evaluateFocus(s, sec(30));
  assert.strictEqual(s.state, 'active');
  // a session started before the setting existed may use the panel too
  const old = start({ mode: 'locked' });
  delete old.panelResearch;
  S.applyBeat(old, { surfaceId: 'panel1', surf: 'panel', focused: true }, sec(20));
  beat(old, 20.5, { fullscreen: false, focused: false });
  S.evaluateFocus(old, sec(30));
  assert.strictEqual(old.state, 'active');
});

// Side-panel research: the panel holds the lease, the student is on another tab
const panelBeat = (s, t, b) => S.applyBeat(s, { surfaceId: 'panel1', surf: 'panel', focused: false, visible: true, holdsLease: true, ...b }, sec(t));
const iso = t => new Date(sec(t)).toISOString();
// The tab hands the lease to the panel, leaves full screen and goes out of view
function intoPanel(w) {
  const s = start(w);
  panelBeat(s, 5, { focused: true });
  beat(s, 5.5, { fullscreen: false, focused: false, visible: false });
  return s;
}

test('(a) locked, side panel allowed: another tab is research, not time away', () => {
  const s = intoPanel({ mode: 'locked', panelBrowsing: true });
  const researching = { browser: { focused: true, blocked: false } };
  panelBeat(s, 10, researching);
  beat(s, 15, { fullscreen: false, focused: false, visible: false });   // the tab's beats don't end it
  panelBeat(s, 20, researching);
  panelBeat(s, 30, researching);
  S.evaluateFocus(s, sec(35));
  assert.strictEqual(s.state, 'active');
  assert.strictEqual(s.pauses.length, 0);
  assert.deepStrictEqual(s.research, { since: sec(10) });
  assert.strictEqual(S.docSessionStats([s], sec(35)).researchMs, 25000, 'an open span counts up to now');
  panelBeat(s, 40, { focused: true });                                    // back in the panel's editor
  assert.strictEqual(s.research, null);
  assert.deepStrictEqual(s.researchSpans, [{ from: iso(10), to: iso(40) }]);
  const st = S.docSessionStats([s], sec(50));
  assert.strictEqual(st.researchMs, 30000);
  assert.strictEqual(st.awayMs, 0, 'research is never time away');
  assert.strictEqual(S.clientView(s, sec(50)).pauseCount, 0);
});

test('(b) on Visor’s blocked page, the side panel doesn’t count: a blocked-site pause', () => {
  const s = intoPanel({ mode: 'locked', panelBrowsing: true });
  panelBeat(s, 10, { browser: { focused: true, blocked: true } });
  S.evaluateFocus(s, sec(13));
  assert.strictEqual(s.state, 'paused');
  assert.strictEqual(s.pauses[0].reason, 'blocked-site');
  assert.ok(S.PAUSE_REASONS.includes('blocked-site'));
  assert.strictEqual(s.research || null, null);
  // back to an allowed tab: the pause ends and research starts
  panelBeat(s, 20, { browser: { focused: true, blocked: false } });
  assert.strictEqual(s.state, 'active');
  assert.strictEqual(S.docSessionStats([s], sec(20)).awayMs, 10000);
  assert.deepStrictEqual(s.research, { since: sec(20) });
});

test('(c) leaving Chrome with the side panel open is time away (left the window)', () => {
  const s = intoPanel({ mode: 'locked', panelBrowsing: true });
  panelBeat(s, 10, { browser: { focused: true, blocked: false } });
  panelBeat(s, 20, { browser: { focused: false, blocked: false } });      // another app
  assert.deepStrictEqual(s.researchSpans, [{ from: iso(10), to: iso(20) }]);
  S.evaluateFocus(s, sec(25));
  assert.strictEqual(s.state, 'paused');
  assert.strictEqual(s.pauses[0].reason, 'left-window');
  assert.strictEqual(s.pauses[0].from, iso(20));
});

test('(d) locked, side panel turned off: the panel doesn’t count, so leaving full screen pauses', () => {
  const s = start({ mode: 'locked', panelBrowsing: false });
  assert.strictEqual(s.panelResearch, false);
  S.applyBeat(s, { surfaceId: 'panel1', surf: 'panel', focused: true, visible: true, holdsLease: true }, sec(20));
  beat(s, 20.5, { fullscreen: false, focused: false });
  S.evaluateFocus(s, sec(30));
  assert.strictEqual(s.state, 'paused');
  assert.strictEqual(s.pauses[0].reason, 'exit-fullscreen');
  // and research on another tab doesn't count either
  panelBeat(s, 40, { browser: { focused: true, blocked: false } });
  assert.strictEqual(s.state, 'paused');
  assert.strictEqual(s.research || null, null);
});

test('(e) open mode: research with the side panel works the same; the span closes when the session ends', () => {
  const s = intoPanel({ mode: 'open' });
  assert.strictEqual(s.panelResearch, true);
  // a copy of the panel without the lease isn't researching
  panelBeat(s, 8, { surfaceId: 'panel2', holdsLease: false, browser: { focused: true, blocked: false } });
  assert.strictEqual(s.research || null, null);
  panelBeat(s, 10, { browser: { focused: true, blocked: false } });
  panelBeat(s, 20, { browser: { focused: true, blocked: false } });
  S.evaluateFocus(s, sec(25));
  assert.strictEqual(s.pauses.length, 0);
  S.endSession(s, 'student', sec(30));
  assert.strictEqual(s.research, null);
  assert.deepStrictEqual(s.researchSpans, [{ from: iso(10), to: iso(30) }]);
  assert.strictEqual(S.docSessionStats([s], sec(60)).researchMs, 20000);
});

test('a handoff to the side panel is present only while the panel loads, and never backdates time away', () => {
  const s = start({ mode: 'locked', panelBrowsing: true });
  beat(s, 100, {});
  S.leaseMoved(s, 'panel', sec(100), { handoff: true });                       // the tab gave the lease to the panel
  beat(s, 101, { fullscreen: false, focused: false, visible: true, panelLease: true });
  S.evaluateFocus(s, sec(110));
  assert.strictEqual(s.pauses.length, 0, 'no pause while the panel loads');
  const researching = { browser: { focused: true, blocked: false } };
  for (let t = 112; t <= 700; t += 10) panelBeat(s, t, researching);           // ten minutes of research
  panelBeat(s, 705, { browser: { focused: false, blocked: false } });          // left Chrome
  S.evaluateFocus(s, sec(710));
  assert.strictEqual(s.pauses.length, 1);
  assert.ok(Date.parse(s.pauses[0].from) >= sec(702), `time away starts when the student left, not before: ${s.pauses[0].from}`);
  assert.strictEqual(s.pauses[0].reason, 'left-window');
  const st = S.docSessionStats([s], sec(710));
  assert.ok(st.researchMs >= 580000, `the research time stays: ${st.researchMs}`);
  assert.ok(st.awayMs < 10000, `away is only the last few seconds: ${st.awayMs}`);
});

test('a copy of the side panel that went quiet doesn’t backdate time away', () => {
  const s = start({ mode: 'open' });
  const researching = { browser: { focused: true, blocked: false } };
  S.applyBeat(s, { surfaceId: 'copyA', surf: 'panel', focused: false, visible: true, holdsLease: true, ...researching }, sec(10));
  beat(s, 11, { focused: false, visible: false, panelLease: true });
  for (let t = 20; t <= 560; t += 10) S.applyBeat(s, { surfaceId: 'copyB', surf: 'panel', focused: false, visible: true, holdsLease: true, ...researching }, sec(t));
  S.applyBeat(s, { surfaceId: 'copyB', surf: 'panel', focused: false, visible: true, holdsLease: true, browser: { focused: false } }, sec(565));
  S.evaluateFocus(s, sec(570));
  assert.strictEqual(s.pauses.length, 1);
  assert.ok(Date.parse(s.pauses[0].from) >= sec(560), `starts at the last research beat or later: ${s.pauses[0].from}`);
});

test('research ends when the tab takes the lease back (Back to full screen)', () => {
  const s = intoPanel({ mode: 'locked', panelBrowsing: true });
  const researching = { browser: { focused: true, blocked: false } };
  panelBeat(s, 10, researching);
  panelBeat(s, 300, researching);
  S.leaseMoved(s, 'tab', sec(305));                                            // the lease route
  beat(s, 306, { holdsLease: true });                                          // full screen, writing again
  for (let t = 316; t <= 2100; t += 10) beat(s, t, { holdsLease: true });
  S.endSession(s, 'student', sec(2100));
  const st = S.docSessionStats([s], sec(2100));
  assert.strictEqual(st.researchMs, 295000, 'only the time in research mode');
  assert.strictEqual(s.pauses.length, 0);
  // the same through a tab beat alone (a takeover the lease route didn't see)
  const s2 = intoPanel({ mode: 'locked', panelBrowsing: true });
  panelBeat(s2, 10, researching);
  beat(s2, 100, { holdsLease: true });
  assert.strictEqual(s2.research, null);
  assert.deepStrictEqual(s2.researchSpans, [{ from: iso(10), to: iso(100) }]);
});

test('an offline blip while researching isn’t also research time', () => {
  const s = intoPanel({ mode: 'open' });
  const researching = { browser: { focused: true, blocked: false } };
  panelBeat(s, 10, researching);
  panelBeat(s, 60, { ...researching, offlinePause: { from: sec(12), to: sec(37) } });
  S.endSession(s, 'student', sec(60));
  const st = S.docSessionStats([s], sec(60));
  assert.strictEqual(st.awayMs, 25000);
  assert.strictEqual(st.researchMs, 2000 + 0, 'research up to the outage; it starts again at the next research beat');
});

test('while the side panel holds the lease, the tab’s beats don’t change why the student is away', () => {
  const s = intoPanel({ mode: 'locked', panelBrowsing: true });
  panelBeat(s, 10, { browser: { focused: false } });                           // left Chrome
  beat(s, 10.5, { fullscreen: false, focused: false, visible: true, panelLease: true });
  beat(s, 11, { fullscreen: false, focused: false, visible: false, panelLease: true });
  S.evaluateFocus(s, sec(20));
  assert.strictEqual(s.pauses.length, 1);
  assert.strictEqual(s.pauses[0].reason, 'left-window');
});

test('the lease handed to the side panel belongs to every copy of it', () => {
  const lease = { surfaceId: 'panel', sessionId: 's1', surf: 'panel' };
  assert.strictEqual(S.holdsLease(lease, 's1', 'copy-2', 'panel'), true);
  assert.strictEqual(S.holdsLease(lease, 's1', 'tab1', 'tab'), false);
  assert.strictEqual(S.holdsLease(lease, 's2', 'copy-2', 'panel'), false);
  const tabLease = { surfaceId: 'tab1', sessionId: 's1', surf: 'tab' };
  assert.strictEqual(S.holdsLease(tabLease, 's1', 'tab1', 'tab'), true);
  assert.strictEqual(S.holdsLease(tabLease, 's1', 'tab2', 'tab'), false);
  assert.strictEqual(S.holdsLease(tabLease, 's1', 'copy-2', 'panel'), false);
  assert.strictEqual(S.holdsLease(null, 's1', 'tab1', 'tab'), false);
});

test('locked mode: the extension turned off mid-session pauses with reason ext-missing', () => {
  const s = start({ mode: 'locked' });
  beat(s, 10, { extPresent: false });
  S.evaluateFocus(s, sec(15));
  assert.strictEqual(s.pauses[0].reason, 'ext-missing');
  assert.ok(s.events.some(e => e.type === 'ext-missing'));
  beat(s, 20, { extPresent: true });
  assert.strictEqual(s.state, 'active');
  assert.ok(s.events.some(e => e.type === 'ext-back'));
});

test('no beat for 3 minutes ends the session as a timeout at the last beat', () => {
  const s = start();
  beat(s, 10, {});
  assert.strictEqual(S.sweep(s, sec(10 + 170)), null);
  assert.strictEqual(S.sweep(s, sec(10 + 181)), 'timeout');
  assert.strictEqual(s.state, 'ended');
  assert.strictEqual(s.endReason, 'timeout');
  assert.strictEqual(s.endedAt, new Date(sec(10)).toISOString());
});

test('deadlines: limit × accommodation, minus earlier sessions; 5-minute warning; time-up', () => {
  const earlier = [{ id: 'old', startedAt: new Date(T0 - 3600e3).toISOString(), endedAt: new Date(T0 - 3600e3 + 20 * 60e3).toISOString() }];
  const used = S.usedMs(earlier);
  assert.strictEqual(used, 20 * 60e3);
  const dl = S.computeDeadline({ timeLimitMin: 45, multiplier: 1.5, used, now: T0 });
  assert.strictEqual(Date.parse(dl) - T0, (67.5 - 20) * 60e3);
  assert.strictEqual(S.computeDeadline({ timeLimitMin: null, now: T0 }), null);
  const s = start({ timeLimitMin: 10 }, { deadlineAt: new Date(sec(600)).toISOString() });
  beat(s, 280, {});
  S.sweep(s, sec(290));
  assert.ok(!s.events.some(e => e.type === 'time-warning'));
  beat(s, 310, {});
  S.sweep(s, sec(310));
  assert.ok(s.events.some(e => e.type === 'time-warning'));
  beat(s, 590, {});
  assert.strictEqual(S.sweep(s, sec(601)), 'time-limit');
  assert.strictEqual(s.endedAt, new Date(sec(600)).toISOString());
  // The teacher adding time moves the deadline
  const s2 = start({}, { deadlineAt: new Date(sec(600)).toISOString() });
  S.addTime(s2, 5, sec(10));
  assert.strictEqual(Date.parse(s2.deadlineAt), sec(900));
});

test('window checks', () => {
  const w = { windowStart: new Date(sec(3600)).toISOString(), windowEnd: new Date(sec(7200)).toISOString() };
  assert.match(S.windowProblem(w, T0), /opens/);
  assert.strictEqual(S.windowProblem(w, sec(4000)), null);
  assert.match(S.windowProblem(w, sec(7200)), /closed/);
  assert.throws(() => S.checkStart({ doc, assignment: assignment(w), userId: 'u1', body: {}, now: T0 }), e => e.status === 403 && /opens/.test(e.message));
  const s = start(w);
  beat(s, 7100, {});
  assert.strictEqual(S.sweep(s, sec(7201), { windowEnd: w.windowEnd }), 'window-closed');
});

test('locked mode refuses to start without the extension’s acknowledgement', () => {
  const a = assignment({ mode: 'locked', requireExtension: true, researchTracking: true });
  const body = { surfaceId: 'tab1', surf: 'tab', extPresent: true, fullscreen: true };
  assert.throws(() => S.checkStart({ doc, assignment: a, userId: 'u1', body, extAck: null, now: T0 }), e => e.status === 409 && /Locked sessions need the Visor extension/.test(e.message));
  // an old acknowledgement doesn't count
  assert.throws(() => S.checkStart({ doc, assignment: a, userId: 'u1', body, extAck: { userId: 'u1', at: new Date(T0 - 60e3).toISOString(), hasHostPermission: true }, now: T0 }), e => e.status === 409);
  // nor does someone else's
  assert.throws(() => S.checkStart({ doc, assignment: a, userId: 'u1', body, extAck: { userId: 'u2', at: new Date(T0).toISOString(), hasHostPermission: true }, now: T0 }), e => e.status === 409);
  // no research permission: locked mode won't start
  assert.throws(() => S.checkStart({ doc, assignment: a, userId: 'u1', body, extAck: { userId: 'u1', at: new Date(T0).toISOString(), hasHostPermission: false }, now: T0 }), e => /see the sites you visit/.test(e.message));
  const ok = S.checkStart({ doc, assignment: a, userId: 'u1', body, extAck: { userId: 'u1', at: new Date(T0 - 5e3).toISOString(), hasHostPermission: true }, now: T0 });
  assert.deepStrictEqual(ok, { takeover: null });
  // open mode doesn't need it
  assert.deepStrictEqual(S.checkStart({ doc, assignment: assignment(), userId: 'u1', body: {}, now: T0 }), { takeover: null });
});

test('starting again: a live session is taken over, a quiet one times out first; submitted docs refuse', () => {
  const live = { state: 'active', lastBeat: new Date(T0 - 20e3).toISOString() };
  assert.deepStrictEqual(S.checkStart({ doc, assignment: assignment(), userId: 'u1', active: live, body: {}, now: T0 }).takeover, { reuse: true });
  const quiet = { state: 'active', lastBeat: new Date(T0 - 120e3).toISOString() };
  assert.deepStrictEqual(S.checkStart({ doc, assignment: assignment(), userId: 'u1', active: quiet, body: {}, now: T0 }).takeover, { end: 'timeout' });
  assert.throws(() => S.checkStart({ doc: { ...doc, status: 'submitted' }, assignment: assignment(), userId: 'u1', body: {}, now: T0 }), e => e.status === 409);
  assert.throws(() => S.checkStart({ doc, assignment: assignment(), userId: 'someone-else', body: {}, now: T0 }), e => e.status === 403);
});

test('teacher pause and resume', () => {
  const s = start();
  S.teacherPause(s, sec(10));
  assert.strictEqual(s.state, 'paused');
  beat(s, 12, {});
  assert.strictEqual(s.state, 'paused', 'focus doesn’t end a teacher pause');
  S.teacherResume(s, sec(40));
  assert.strictEqual(s.state, 'active');
  assert.deepStrictEqual(s.pauses.map(p => p.reason), ['teacher']);
  assert.strictEqual(S.docSessionStats([s], sec(50)).pauses, 0, 'teacher pauses aren’t counted as time away');
});

test('offline time reported after reconnecting becomes an offline pause', () => {
  const s = start();
  beat(s, 60, { offlinePause: { from: sec(20), to: sec(50) }, events: [{ type: 'offline', t: sec(20) }, { type: 'online', t: sec(50) }, { type: 'made-up' }] });
  assert.deepStrictEqual(s.pauses.map(p => p.reason), ['offline']);
  assert.ok(!s.events.some(e => e.type === 'made-up'));
  assert.ok(s.events.some(e => e.type === 'online'));
});

test('switching tabs is "left the tab", even though the window blur arrives first', () => {
  const s = start();
  beat(s, 10, { focused: false, visible: true });     // blur
  beat(s, 10.2, { focused: false, visible: false });  // then hidden
  S.evaluateFocus(s, sec(15));
  assert.strictEqual(s.pauses[0].reason, 'left-tab');
  beat(s, 20, {});
  assert.strictEqual(s.pauses.length, 1);
});

test('offline time is one pause, even if the server already opened one while beats were missing', () => {
  const s = start();
  beat(s, 10, {});
  // No beats while offline: a read 40 s later sees the surface gone quiet and opens a pause
  S.evaluateFocus(s, sec(50));
  assert.strictEqual(s.pauses.length, 1);
  // Back online: the page reports its offline stretch
  beat(s, 60, { offlinePause: { from: sec(12), to: sec(58) } });
  assert.strictEqual(s.pauses.length, 1);
  assert.strictEqual(s.pauses[0].reason, 'offline');
  assert.ok(s.pauses[0].to);
});
