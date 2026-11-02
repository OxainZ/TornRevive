// ==UserScript==
// @name         Torn Revive Radar
// @version      0.1.1
// @description  Free reviver radar: watches your revive clients, factions and friends through the Torn API and alerts when one is in hospital, revivable by you, and worth the energy. Revive log for billing. Alerts only; every revive stays manual.
// @author       Oxain
// @match        https://www.torn.com/*
// @run-at       document-idle
// @noframes
// @downloadURL  https://raw.githubusercontent.com/OxainZ/tornrevive/main/tornrevive.user.js
// @updateURL    https://raw.githubusercontent.com/OxainZ/tornrevive/main/tornrevive.meta.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      api.torn.com
// ==/UserScript==

(function () {
	'use strict';

	/* ---------- pure core (exported for Node, no DOM) ---------- */

	const Rev = {};
	Rev.VERSION = '0.1.1';
	Rev.API = 'https://api.torn.com/v2';
	Rev.COMMENT = 'TornRevive';
	Rev.BUDGET_PER_MIN = 60;
	Rev.TICK_MS = 1000;
	Rev.MAX_ROWS = 60;
	Rev.LOG_MAX = 200;
	Rev.LOCK_TTL_MS = 5000;
	Rev.ENERGY_PER_REVIVE = 75;     // minus 5 per Fortitude "Reviver" upgrade, floor 25
	Rev.BASE_CHANCE = 90;           // wiki: 90% at skill 0, 100% at skill 100
	Rev.PENALTY_MAX = 8;            // each revive in 24 h costs the target 8% at skill 0, 4% at skill 100
	Rev.PENALTY_MIN = 4;
	Rev.RULES = [['any', 'Any client'], ['online', 'Online now'], ['active', 'Online or idle'], ['offline', 'Offline only']];

	/** "123, 456 789" -> [123, 456, 789]: positive ids only, no repeats, order kept. */
	Rev.parseIds = function (text) {
		const out = [];
		for (const part of String(text || '').split(/[\s,;]+/)) {
			const n = Number(part);
			if (part && Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
		}
		return out;
	};

	/**
	 * Estimated success chance for ME on this target, from the wiki's numbers:
	 * base 90 + skill/10, minus one penalty per revive they got in the last 24 h (8% at skill 0 .. 4% at skill 100),
	 * each penalty fading linearly over 24 h. `recent` = unix seconds of their recent revives. Clamped 0..100.
	 */
	Rev.chance = function (skill, recent, nowSec) {
		const sk = Math.max(0, Math.min(100, Number(skill) || 0));
		const perRevive = Rev.PENALTY_MAX - (Rev.PENALTY_MAX - Rev.PENALTY_MIN) * sk / 100;
		let penalty = 0;
		for (const t of recent || []) {
			const age = nowSec - t;
			if (age >= 0 && age < 86400) penalty += perRevive * (1 - age / 86400);
		}
		return Math.max(0, Math.min(100, Math.round(Rev.BASE_CHANCE + sk / 10 - penalty)));
	};

	/** Does the client's activity match the watch rule? */
	Rev.activityOk = function (rule, lastAction) {
		const st = (lastAction && lastAction.status) || '';
		if (!rule || rule === 'any') return true;
		if (rule === 'online') return st === 'Online';
		if (rule === 'active') return st === 'Online' || st === 'Idle';
		if (rule === 'offline') return st === 'Offline';
		return false;
	};

	/**
	 * Should I revive this player now?
	 * p: profile {status, revivable, last_action, life}; watch: {rule, minChance, skipED}; est = my estimated chance.
	 * Returns {state:'go'|'wait'|'no', why}.
	 */
	Rev.evaluate = function (p, watch, est, hasED) {
		const st = (p && p.status) || {};
		if (st.state !== 'Hospital') return { state: 'no', why: st.state === 'Okay' ? 'out' : String(st.state || 'unknown').toLowerCase() };
		if (p.revivable === false) return { state: 'no', why: 'revives off for you' };
		if (watch.skipED && hasED) return { state: 'wait', why: 'has early discharge' };
		if (!Rev.activityOk(watch.rule, p.last_action)) return { state: 'wait', why: 'activity rule' };
		if (watch.minChance && est < watch.minChance) return { state: 'wait', why: `chance ${est}% < ${watch.minChance}%` };
		return { state: 'go', why: `${est}% chance` };
	};

	/** Per-target recent revive timestamps from my own /user/revives history (what I can see of their 24 h). */
	Rev.recentByTarget = function (revives, nowSec) {
		const map = new Map();
		for (const r of revives || []) {
			const id = Number(r.target && r.target.id);
			const t = Number(r.timestamp) || 0;
			if (!id || nowSec - t >= 86400) continue;
			if (!map.has(id)) map.set(id, []);
			if (String(r.result).toLowerCase() === 'success') map.get(id).push(t);
		}
		return map;
	};

	/** My skill from the newest entry that has it, else null. */
	Rev.skillFrom = function (revives, myId) {
		let best = null;
		for (const r of revives || []) {
			if (Number(r.reviver && r.reviver.id) === myId && r.reviver.skill != null) {
				if (!best || r.timestamp > best.timestamp) best = r;
			}
		}
		return best ? Number(best.reviver.skill) : null;
	};

	/** API sources: one profile per client; faction lists for faction watches. */
	Rev.sources = function (watches, factions) {
		const map = new Map();
		const add = (key, path) => { if (!map.has(key)) map.set(key, { key, path }); };
		for (const f of factions || []) add(`f${f.id}`, `/faction/${f.id}/members`);
		for (const w of watches || []) add(`u${w.id}`, `/user/${w.id}/profile`);
		return [...map.values()];
	};

	/** Poll faster for anyone in hospital (they are the job), slower for the rest. */
	Rev.pollSeconds = function (players) {
		let best = 120;
		for (const p of players || []) if (p && p.status && p.status.state === 'Hospital') best = Math.min(best, 30);
		return best;
	};

	Rev.nextDue = function (sources, dueAt, nowMs, remaining) {
		if (remaining <= 0) return null;
		let pick = null;
		for (const s of sources) {
			const due = dueAt[s.key] || 0;
			if (due <= nowMs && (!pick || due < (dueAt[pick.key] || 0))) pick = s;
		}
		return pick;
	};

	Rev.makeBudget = function (limit) {
		let stamps = [];
		const trim = (now) => { stamps = stamps.filter((t) => now - t < 60000); };
		return { hit(now) { trim(now); stamps.push(now); }, remaining(now) { trim(now); return limit - stamps.length; } };
	};

	Rev.newlyGo = function (rows, prev) { return rows.filter((r) => r.state === 'go' && !prev.has(r.key)); };
	Rev.ownsLock = function (lock, tabId, nowMs) { return !lock || lock.tab === tabId || nowMs - lock.at > Rev.LOCK_TTL_MS; };

	Rev.url = function (path, key, fresh) {
		return `${Rev.API}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}&comment=${Rev.COMMENT}${fresh ? `&timestamp=${fresh}` : ''}`;
	};

	Rev.apiError = function (json) {
		const e = json && json.error;
		if (!e) return null;
		const code = Number(e.code);
		const known = { 2: 'API key is wrong', 5: 'Rate limit hit, wait a minute', 8: 'Your IP is temporarily blocked by the API', 10: 'Key owner is in federal jail', 13: 'Key disabled for inactivity', 14: 'Key read-limit reached', 16: 'Key access level is too low', 18: 'API key is paused' };
		return { code, text: known[code] || String(e.error || `API error ${code}`), fatal: code in known };
	};

	/** Plain links. Opening one revives nobody: you still click Revive and confirm. */
	Rev.profileUrl = function (id) { return `https://www.torn.com/profiles.php?XID=${Number(id)}`; };

	/** One billing line per revive I performed, from the API's own record (the truth, not my guess). */
	Rev.billLine = function (r) {
		const t = r.target || {};
		const ok = String(r.result).toLowerCase() === 'success';
		return `${Rev.tct(r.timestamp)} TCT ${ok ? 'REVIVED' : 'FAILED'} ${t.name || t.id} [${t.id}]${t.faction ? ` of ${t.faction.name}` : ''} at ${Math.round(Number(r.success_chance) || 0)}%${t.early_discharge ? ' (had ED)' : ''}`;
	};

	/** Bill summary for a client or faction over a window: {attempts, successes, energy}. */
	Rev.bill = function (revives, filter, fromSec) {
		let attempts = 0, successes = 0;
		for (const r of revives || []) {
			if ((Number(r.timestamp) || 0) < fromSec) continue;
			const t = r.target || {};
			if (filter.targetId && Number(t.id) !== filter.targetId) continue;
			if (filter.factionId && Number(t.faction && t.faction.id) !== filter.factionId) continue;
			attempts += 1;
			if (String(r.result).toLowerCase() === 'success') successes += 1;
		}
		return { attempts, successes, energy: attempts * Rev.ENERGY_PER_REVIVE };
	};

	Rev.tct = function (sec) {
		const d = new Date((Number(sec) || 0) * 1000);
		return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
	};
	Rev.clock = function (seconds) {
		const s = Math.max(0, Math.floor(seconds));
		return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	};

	/** Display order: go (highest chance first), wait, no. */
	Rev.sortRows = function (rows) {
		const rank = { go: 0, wait: 1, no: 2 };
		return rows.slice().sort((a, b) => rank[a.state] - rank[b.state] || (b.est || 0) - (a.est || 0) || a.level - b.level);
	};

	if (typeof module !== 'undefined' && module.exports) module.exports = Rev;
	if (typeof document === 'undefined') return;

	/* ---------- storage + http ---------- */

	const hasGM = typeof GM_getValue === 'function';
	const load = (k, d) => { try { return hasGM ? GM_getValue(k, d) : (localStorage.getItem('tornrevive.' + k) === null ? d : JSON.parse(localStorage.getItem('tornrevive.' + k))); } catch (e) { return d; } };
	const save = (k, v) => { try { if (hasGM) GM_setValue(k, v); else localStorage.setItem('tornrevive.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };

	function getJson(url) {
		if (typeof GM_xmlhttpRequest === 'function') {
			return new Promise((resolve, reject) => GM_xmlhttpRequest({
				method: 'GET', url, timeout: 15000,
				onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('bad response')); } },
				onerror: () => reject(new Error('network error')),
				ontimeout: () => reject(new Error('timed out')),
			}));
		}
		if (typeof PDA_httpGet === 'function') return PDA_httpGet(url, {}).then((r) => { if (!r) throw new Error('repeat call dropped'); return JSON.parse(r.responseText); });
		return fetch(url).then((r) => r.json());
	}

	/* ---------- panel ---------- */

	const css = document.createElement('style');
	css.textContent = `
#tr-btn{position:fixed;left:8px;bottom:100px;z-index:99998;padding:6px 10px;border:1px solid #666;border-radius:6px;background:#222;color:#eee;font:bold 12px Arial,sans-serif;cursor:pointer}
#tr-btn.tr-live{background:#2f5f8a}
#tr-panel{position:fixed;left:8px;bottom:136px;z-index:99999;width:min(460px,calc(100vw - 16px));max-height:78vh;overflow:auto;box-sizing:border-box;padding:10px;border:1px solid #666;border-radius:8px;background:#1b1b1b;color:#ddd;font:12px Arial,sans-serif}
#tr-panel label{display:block;margin:6px 0 2px;color:#aaa}
#tr-panel input:not([type=checkbox]),#tr-panel select{box-sizing:border-box;width:100%;padding:4px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#eee;font:12px Arial,sans-serif}
#tr-panel .tr-two{display:flex;gap:8px}#tr-panel .tr-two>div{flex:1;min-width:0}
#tr-panel button{margin:6px 4px 6px 0;padding:6px 10px;border:0;border-radius:4px;background:#3a6ea5;color:#fff;font:bold 12px Arial,sans-serif;cursor:pointer}
#tr-panel button.tr-x{margin:0;padding:0 5px;background:none;color:#999}
#tr-panel details{margin-top:6px}#tr-panel summary{cursor:pointer;color:#bbb}
#tr-panel table{width:100%;border-collapse:collapse}#tr-panel td{padding:4px 3px;border-top:1px solid #333}
#tr-panel a{color:#7db8f0}#tr-panel a.tr-go{display:inline-block;padding:2px 8px;border-radius:4px;background:#2d7a3a;color:#fff;font-weight:bold;text-decoration:none}
#tr-panel tr.tr-state-go td{background:#1f3526}#tr-panel tr.tr-state-wait td{background:#33301c}
#tr-panel .tr-note{color:#999;font-size:11px;line-height:1.35}#tr-status{min-height:15px;margin:4px 0;color:#8fd0ff}
#tr-panel .tr-log div{padding:3px 0;border-top:1px solid #333;font-size:11px;word-break:break-word}`;
	document.head.appendChild(css);

	function el(tag, props, ...kids) { const n = Object.assign(document.createElement(tag), props || {}); for (const k of kids) n.append(k); return n; }
	function field(labelText, input) { return el('div', {}, el('label', { textContent: labelText }), input); }

	let watches = load('watches', []);
	let factions = load('factions', []);
	let revives = [];

	const keyIn = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Limited-access key', value: load('key', '') });
	const typeIn = el('select', {}, el('option', { value: 'player', textContent: 'Client' }), el('option', { value: 'faction', textContent: 'Whole faction (contract)' }));
	const idsIn = el('input', { placeholder: 'Ids, e.g. 12345, 67890' });
	const ruleIn = el('select', {});
	for (const [v, t] of Rev.RULES) ruleIn.append(el('option', { value: v, textContent: t }));
	const minChanceIn = el('input', { type: 'number', min: 0, max: 100, placeholder: '0', value: '' });
	const skipEdIn = el('input', { type: 'checkbox' });
	const noteIn = el('input', { placeholder: 'Optional: who pays, rate' });
	const addBtn = el('button', { textContent: 'Add' });
	const radarBtn = el('button', { textContent: 'Start radar' });
	const soundIn = el('input', { type: 'checkbox', checked: load('sound', true) });
	const volumeIn = el('input', { type: 'range', min: 0, max: 100, value: load('volume', 25), title: 'Alert volume' });
	const skillIn = el('input', { type: 'number', min: 0, max: 100, step: 0.1, placeholder: 'auto from your history', value: load('skill', '') });
	const statusEl = el('div', { id: 'tr-status' });
	const listEl = el('div', {});
	const manageEl = el('div', {});
	const logEl = el('div', { className: 'tr-log' });
	const billEl = el('div', { className: 'tr-note' });

	const panel = el('div', { id: 'tr-panel', hidden: true },
		el('strong', { textContent: 'Revive Radar' }), statusEl, radarBtn, listEl,
		el('details', {}, el('summary', { textContent: 'Clients' }),
			el('div', { className: 'tr-two' }, field('Type', typeIn), field('Ids', idsIn)),
			el('div', { className: 'tr-two' }, field('Only when they are', ruleIn), field('Min chance % (blank = any)', minChanceIn)),
			el('label', {}, skipEdIn, ' Skip while they have early discharge'),
			field('Note', noteIn), addBtn, manageEl),
		el('details', {}, el('summary', { textContent: 'Billing (from the API, last 7 days)' }), billEl, logEl),
		el('details', {}, el('summary', { textContent: 'Settings' }),
			field('Torn API key', keyIn),
			el('div', { className: 'tr-note', textContent: 'Limited access: it reads your own revive history for your skill, the 24 h revive count on each target and the billing log. Stored only in this browser\'s script storage and sent only to api.torn.com. Nothing is shared with anyone.' }),
			field('My revive skill (override)', skillIn),
			el('label', {}, soundIn, ' Sound on alerts'), field('Alert volume', volumeIn)));
	const toggle = el('button', { id: 'tr-btn', textContent: 'Revive', onclick: () => { panel.hidden = !panel.hidden; } });
	document.body.append(toggle, panel);
	const say = (text) => { statusEl.textContent = text; };

	function beep() {
		if (!soundIn.checked) return;
		const vol = Math.max(0, Math.min(1, (Number(volumeIn.value) || 0) / 100));
		if (!vol) return;
		try {
			const ctx = new AudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			gain.gain.setValueAtTime(0.15 * vol, ctx.currentTime);   // 0.15 is a soft ping; 1.0 was the raw oscillator at full blast
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.frequency.value = 660;
			osc.start();
			osc.stop(ctx.currentTime + 0.3);
			osc.onended = () => ctx.close();
		} catch (e) { /* the browser needs a click on the page before it allows sound */ }
	}
	function alertMe(title, text, url) {
		beep();
		// Clicking the popup is the user's click: it goes to the page they asked for. It never attacks or revives.
		const go = () => { if (url) location.assign(url); else window.focus(); };
		if (typeof GM_notification === 'function') GM_notification({ title, text, timeout: 15000, onclick: go });
		else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') { const n = new Notification(title, { body: text }); n.onclick = go; }
		document.title = `(!) ${title}`;
	}

	/* ---------- radar ---------- */

	const tabId = Math.random().toString(36).slice(2);
	const budget = Rev.makeBudget(Rev.BUDGET_PER_MIN);
	const live = new Map();
	const members = new Map();
	const dueAt = {};
	let prevGo = new Set();
	let myId = 0;
	let skill = null;
	let running = false;
	let problem = '';

	function readLock() { try { return JSON.parse(localStorage.getItem('tornrevive.lock')); } catch (e) { return null; } }
	function holdLock(now) {
		if (!Rev.ownsLock(readLock(), tabId, now)) return false;
		try { localStorage.setItem('tornrevive.lock', JSON.stringify({ tab: tabId, at: now })); } catch (e) { /* no storage */ }
		return true;
	}

	function mySkill() { return Number(skillIn.value) || skill || 0; }

	function buildRows(nowSec) {
		const recent = Rev.recentByTarget(revives, nowSec);
		const rows = [];
		const row = (key, id, p, watch, label) => {
			const est = Rev.chance(mySkill(), recent.get(id), nowSec);
			const r = Rev.evaluate(p, watch, est, p.has_early_discharge);
			rows.push({ key, id, name: p.name || String(id), level: Number(p.level) || 0, label, est, until: Number(p.status && p.status.until) || 0, ...r });
		};
		for (const w of watches) { const p = live.get(w.id); if (p) row(`p${w.id}`, w.id, p, w, w.note || 'client'); }
		for (const f of factions) for (const id of members.get(f.id) || []) if (id !== myId && live.get(id)) row(`f${f.id}:${id}`, id, live.get(id), f, `faction ${f.id}`);
		return Rev.sortRows(rows);
	}

	function render(rows, nowSec) {
		listEl.textContent = '';
		const body = el('tbody', {});
		for (const r of rows.filter((x) => x.state !== 'no').slice(0, Rev.MAX_ROWS)) {
			const left = r.until - nowSec;
			body.append(el('tr', { className: `tr-state-${r.state}` },
				el('td', {}, el('a', { href: Rev.profileUrl(r.id), textContent: r.name, title: r.label })),
				el('td', { textContent: `${r.level} · ${r.est}%` }),
				el('td', { textContent: `${r.why}${left > 0 ? ` · out in ${Rev.clock(left)}` : ''}` }),
				el('td', {}, el('a', { className: 'tr-go', href: Rev.profileUrl(r.id), textContent: 'Revive' }))));
		}
		if (body.childElementCount) listEl.append(el('table', {}, body));
		else listEl.append(el('div', { className: 'tr-note', textContent: running ? 'Nobody in hospital on your list.' : 'Add clients, then start the radar.' }));
	}

	function renderManage() {
		manageEl.textContent = '';
		const line = (text, onRemove) => el('div', {}, el('span', { textContent: text }), el('button', { className: 'tr-x', textContent: '×', title: 'Remove', onclick: onRemove }));
		const ruleName = (v) => (Rev.RULES.find(([k]) => k === v) || [v, v])[1];
		for (const w of watches) manageEl.append(line(`Client ${w.id}: ${ruleName(w.rule)}${w.minChance ? `, ${w.minChance}%+` : ''}${w.skipED ? ', skip ED' : ''}${w.note ? ` · ${w.note}` : ''}`, () => { watches = watches.filter((x) => x !== w); save('watches', watches); live.delete(w.id); renderManage(); }));
		for (const f of factions) manageEl.append(line(`Faction ${f.id}: ${ruleName(f.rule)}${f.minChance ? `, ${f.minChance}%+` : ''}${f.skipED ? ', skip ED' : ''}${f.note ? ` · ${f.note}` : ''}`, () => { factions = factions.filter((x) => x !== f); save('factions', factions); members.delete(f.id); renderManage(); }));
	}

	function renderBilling(nowSec) {
		const from = nowSec - 7 * 86400;
		const all = Rev.bill(revives, {}, from);
		const parts = [`All: ${all.successes}/${all.attempts} revives, ${all.energy} energy.`];
		for (const w of watches) { const b = Rev.bill(revives, { targetId: w.id }, from); if (b.attempts) parts.push(`${(live.get(w.id) || {}).name || w.id}: ${b.successes}/${b.attempts}.`); }
		for (const f of factions) { const b = Rev.bill(revives, { factionId: f.id }, from); if (b.attempts) parts.push(`Faction ${f.id}: ${b.successes}/${b.attempts}.`); }
		billEl.textContent = parts.join(' ');
		logEl.textContent = '';
		for (const r of revives.filter((x) => Number(x.reviver && x.reviver.id) === myId && x.timestamp >= from).slice(0, Rev.LOG_MAX)) logEl.append(el('div', { textContent: Rev.billLine(r) }));
	}

	function absorb(src, json) {
		if (src.key === 'me') { myId = Number(json.profile.id); return []; }
		if (src.key === 'revives') {
			revives = json.revives || [];
			const s = Rev.skillFrom(revives, myId);
			if (s != null) skill = s;
			return [];
		}
		if (src.key[0] === 'f') {
			const fid = Number(src.key.slice(1));
			const list = json.members || [];
			members.set(fid, list.map((m) => m.id));
			for (const m of list) live.set(m.id, { ...m, revivable: m.is_revivable });
			return list;
		}
		const p = json.profile;
		live.set(p.id, p);
		return [p];
	}

	async function tick() {
		if (!running) return;
		const now = Date.now();
		try {
			if (!holdLock(now)) { say('Radar is running in another Torn tab.'); return; }
			const sources = [{ key: 'me', path: '/user/basic' }, { key: 'revives', path: '/user/revives?filters=outgoing&limit=100&sort=DESC' }, ...Rev.sources(watches, factions)];
			const src = Rev.nextDue(sources, dueAt, now, budget.remaining(now));
			if (src) {
				budget.hit(now);
				dueAt[src.key] = now + 60000;
				const json = await getJson(Rev.url(src.path, keyIn.value.trim(), Math.floor(now / 1000)));
				const err = Rev.apiError(json);
				if (err && err.fatal) { stop(err.text); return; }
				if (err) problem = `${src.key}: ${err.text}`;
				else {
					const seen = absorb(src, json);
					const fixed = src.key === 'me' ? 300 : src.key === 'revives' ? 60 : Rev.pollSeconds(seen);
					dueAt[src.key] = now + fixed * 1000;
				}
			}
			const nowSec = Math.floor(Date.now() / 1000);
			const rows = buildRows(nowSec);
			for (const r of Rev.newlyGo(rows, prevGo)) alertMe(`Revive ${r.name}`, `${r.est}% chance · lvl ${r.level} · ${r.label} · click to open their profile`, Rev.profileUrl(r.id));
			prevGo = new Set(rows.filter((r) => r.state === 'go').map((r) => r.key));
			render(rows, nowSec);
			renderBilling(nowSec);
			const n = watches.length + factions.length;
			say(`Watching ${n} client${n === 1 ? '' : 's'} · skill ${mySkill() || '?'} · ${Rev.BUDGET_PER_MIN - budget.remaining(Date.now())}/${Rev.BUDGET_PER_MIN} calls a minute${problem ? ` · ${problem}` : ''}`);
		} catch (e) {
			say(`Radar error: ${e.message}. Retrying.`);
		} finally {
			if (running) setTimeout(tick, Rev.TICK_MS);
		}
	}

	function stop(reason) { running = false; radarBtn.textContent = 'Start radar'; toggle.classList.remove('tr-live'); save('running', false); say(reason || 'Radar stopped.'); }
	function start() {
		if (!keyIn.value.trim()) { say('Paste your API key under Settings first.'); return; }
		save('key', keyIn.value.trim());
		running = true; problem = '';
		radarBtn.textContent = 'Stop radar'; toggle.classList.add('tr-live'); save('running', true);
		tick();
	}

	radarBtn.addEventListener('click', () => { if (running) stop(); else start(); });
	soundIn.addEventListener('change', () => save('sound', soundIn.checked));
	volumeIn.addEventListener('change', () => { save('volume', Number(volumeIn.value)); beep(); });
	keyIn.addEventListener('change', () => save('key', keyIn.value.trim()));
	skillIn.addEventListener('change', () => save('skill', skillIn.value));
	addBtn.addEventListener('click', () => {
		const ids = Rev.parseIds(idsIn.value);
		if (!ids.length) { say('Enter at least one id.'); return; }
		const entry = (id) => ({ id, rule: ruleIn.value, minChance: Number(minChanceIn.value) || 0, skipED: skipEdIn.checked, note: noteIn.value.trim() });
		if (typeIn.value === 'faction') { factions = factions.filter((f) => !ids.includes(f.id)).concat(ids.map(entry)); save('factions', factions); }
		else { watches = watches.filter((w) => !ids.includes(w.id)).concat(ids.map(entry)); save('watches', watches); }
		idsIn.value = ''; noteIn.value = '';
		renderManage();
	});

	renderManage();
	render([], 0);
	if (load('running', false) && keyIn.value.trim()) start();
})();
