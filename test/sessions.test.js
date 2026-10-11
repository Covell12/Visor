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

test('locked mode: leaving full screen pauses; the side panel doesn’t need it', () => {
  const s = start({ mode: 'locked' });
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
