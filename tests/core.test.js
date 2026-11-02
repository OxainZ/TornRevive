'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Rev = require('../tornrevive.user.js');

const NOW = 1000000;
const hosp = (until) => ({ state: 'Hospital', description: 'In hospital', until });
const okay = { state: 'Okay', description: 'Okay', until: null };
const la = (status) => ({ status, timestamp: NOW - 10 });

test('parseIds keeps valid unique ids in order', () => {
	assert.deepEqual(Rev.parseIds('12, 34\n56;12 x -1 0'), [12, 34, 56]);
});

test('chance follows the wiki: base 90 + skill/10, minus fading penalties', () => {
	assert.equal(Rev.chance(0, [], NOW), 90);
	assert.equal(Rev.chance(100, [], NOW), 100);
	assert.equal(Rev.chance(0, [NOW], NOW), 82);
	assert.equal(Rev.chance(100, [NOW], NOW), 96);
	assert.equal(Rev.chance(0, [NOW - 43200], NOW), 86);
	assert.equal(Rev.chance(0, [NOW - 86400], NOW), 90);
	assert.equal(Rev.chance(0, Array(20).fill(NOW), NOW), 0);
	assert.equal(Rev.chance(50, [NOW, NOW], NOW), 83);
});

test('activityOk follows the client rule', () => {
	assert.equal(Rev.activityOk('any', null), true);
	assert.equal(Rev.activityOk('online', la('Online')), true);
	assert.equal(Rev.activityOk('online', la('Idle')), false);
	assert.equal(Rev.activityOk('active', la('Idle')), true);
	assert.equal(Rev.activityOk('offline', la('Offline')), true);
	assert.equal(Rev.activityOk('offline', la('Online')), false);
});

test('evaluate says go only for a revivable hospitalised client inside the terms', () => {
	const p = { status: hosp(NOW + 600), revivable: true, last_action: la('Online') };
	assert.deepEqual(Rev.evaluate(p, { rule: 'any' }, 85, false), { state: 'go', why: '85% chance' });
	assert.equal(Rev.evaluate({ ...p, status: okay }, { rule: 'any' }, 85, false).why, 'out');
	assert.equal(Rev.evaluate({ ...p, revivable: false }, { rule: 'any' }, 85, false).why, 'revives off for you');
	assert.equal(Rev.evaluate(p, { rule: 'any', skipED: true }, 85, true).state, 'wait');
	assert.equal(Rev.evaluate(p, { rule: 'offline' }, 85, false).why, 'activity rule');
	assert.equal(Rev.evaluate(p, { rule: 'any', minChance: 90 }, 85, false).why, 'chance 85% < 90%');
	assert.equal(Rev.evaluate({ status: { state: 'Traveling' } }, { rule: 'any' }, 85, false).why, 'traveling');
});

test('recentByTarget counts only my successful revives inside 24 h', () => {
	const r = (id, t, result) => ({ target: { id }, timestamp: t, result });
	const m = Rev.recentByTarget([r(1, NOW - 10, 'success'), r(1, NOW - 20, 'Success'), r(1, NOW - 30, 'failure'), r(2, NOW - 90000, 'success')], NOW);
	assert.deepEqual(m.get(1), [NOW - 10, NOW - 20]);
	assert.equal(m.has(2), false);
});

test('skillFrom takes my newest entry with a skill', () => {
	const r = (id, t, skill) => ({ reviver: { id, skill }, timestamp: t });
	assert.equal(Rev.skillFrom([r(9, 5, 40), r(9, 7, 42.5), r(9, 9, null), r(8, 99, 90)], 9), 42.5);
	assert.equal(Rev.skillFrom([], 9), null);
});

test('sources reads clients by profile and contract factions by member list', () => {
	const s = Rev.sources([{ id: 1 }], [{ id: 9 }]);
	assert.deepEqual(s.map((x) => x.path), ['/faction/9/members', '/user/1/profile']);
});

test('pollSeconds is fast only for people in hospital', () => {
	assert.equal(Rev.pollSeconds([{ status: hosp(NOW + 9) }]), 30);
	assert.equal(Rev.pollSeconds([{ status: okay }]), 120);
});

test('bill sums attempts, successes and energy for a client, a faction or everything', () => {
	const r = (id, fid, t, result) => ({ target: { id, faction: fid ? { id: fid, name: 'F' } : null }, timestamp: t, result });
	const list = [r(1, 9, NOW - 10, 'success'), r(1, 9, NOW - 20, 'failure'), r(2, 9, NOW - 30, 'success'), r(3, 5, NOW - 99999999, 'success')];
	assert.deepEqual(Rev.bill(list, { targetId: 1 }, NOW - 86400), { attempts: 2, successes: 1, energy: 150 });
	assert.deepEqual(Rev.bill(list, { factionId: 9 }, NOW - 86400), { attempts: 3, successes: 2, energy: 225 });
	assert.equal(Rev.bill(list, {}, -1e9).attempts, 4);
	assert.equal(Rev.bill(list, {}, NOW - 86400).attempts, 3);
});

test('billLine is one pasteable record from the API', () => {
	const line = Rev.billLine({ timestamp: 3660, result: 'success', success_chance: 87.4, target: { id: 5, name: 'Bob', faction: { id: 1, name: 'Goblin Horde' }, early_discharge: true } });
	assert.equal(line, '01:01 TCT REVIVED Bob [5] of Goblin Horde at 87% (had ED)');
});

test('sortRows: go by chance, then wait, then no', () => {
	const rows = Rev.sortRows([{ key: 'a', state: 'no', level: 1 }, { key: 'b', state: 'go', est: 80, level: 5 }, { key: 'c', state: 'go', est: 95, level: 9 }, { key: 'd', state: 'wait', level: 2 }]);
	assert.deepEqual(rows.map((r) => r.key), ['c', 'b', 'd', 'a']);
});

test('url handles paths with a query already', () => {
	assert.equal(Rev.url('/user/revives?filters=outgoing', 'k'), 'https://api.torn.com/v2/user/revives?filters=outgoing&key=k&comment=TornRevive');
});

test('the script never touches torn.com pages or automates input', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'tornrevive.user.js'), 'utf8');
	assert.doesNotMatch(src, /\.click\(|dispatchEvent|\.submit\(|location\.(href|replace)|window\.open|querySelector/);
	assert.equal((src.match(/location\.assign\(/g) || []).length, 1, 'only the notification click navigates, and only to the profile the user clicked for');
	assert.doesNotMatch(src, /innerHTML/);
	assert.deepEqual([...new Set(src.match(/@connect\s+\S+/g))], ['@connect      api.torn.com']);
});
