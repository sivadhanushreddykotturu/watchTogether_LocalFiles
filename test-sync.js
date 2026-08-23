// End-to-end test: two clients, one room — verifies sync, chat, state, cleanup,
// reconnect grace behavior, and the health endpoint.
// Run with the server already started (LEAVE_GRACE_MS=150 keeps tests fast).
const http = require('http');
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
let failures = 0;

function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label);
  if (!cond) failures++;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((res, rej) => {
    http.get(URL + path, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function main() {
  // --- health endpoint (UptimeRobot target) ---
  const health = await getJson('/health');
  check('/health returns ok', health.ok === true && typeof health.rooms === 'number');
  check('/health reports mongo flag (off in tests)', health.mongo === false);

  const a = io(URL);
  const b = io(URL);
  await wait(300);

  // --- A creates a room ---
  const created = await new Promise((res) => a.emit('create-room', 'Alice', res));
  const aId = created.self.id;
  check('create-room returns 5-char code', /^[A-Z2-9]{5}$/.test(created.code));
  check('creator is in user list', created.users.length === 1 && created.users[0].name === 'Alice');
  check('initial state paused at 0', created.state.playing === false && created.state.time === 0);
  check('initial subtitle offset is 0', created.state.subOffset === 0);
  check('join response carries history array', Array.isArray(created.history));

  // --- B joins with wrong code first, then the right one ---
  const bad = await new Promise((res) => b.emit('join-room', { code: 'ZZZZZ', name: 'Bob' }, res));
  check('wrong code rejected', !!bad.error);

  const bEvents = { playback: [], chat: [], users: [], subtitle: [] };
  b.on('playback', (m) => bEvents.playback.push(m));
  b.on('chat', (m) => bEvents.chat.push(m));
  b.on('users', (m) => bEvents.users.push(m));
  b.on('subtitle', (m) => bEvents.subtitle.push(m));

  const joined = await new Promise((res) => b.emit('join-room', { code: created.code, name: 'Bob' }, res));
  check('join-room succeeds', joined.code === created.code);
  check('both users listed', joined.users.length === 2);

  // --- A presses play at t=42 ---
  a.emit('playback', { action: 'play', time: 42 });
  await wait(200);
  const playMsg = bEvents.playback.find((m) => m.action === 'play');
  check('B receives play with time+actor', playMsg && playMsg.time === 42 && playMsg.name === 'Alice' && playMsg.playing === true);

  // --- room state should now report ~42s + elapsed ---
  const pos = await new Promise((res) => b.emit('time-update', 42.2, res));
  check('heartbeat ack returns expected position near 42', pos.expected > 42 && pos.expected < 44);
  check('heartbeat ack says playing', pos.playing === true);

  // --- B seeks back to 10 (anyone can control) ---
  const aEvents = { playback: [], chat: [], peerTime: [] };
  a.on('playback', (m) => aEvents.playback.push(m));
  a.on('chat', (m) => aEvents.chat.push(m));
  a.on('peer-time', (m) => aEvents.peerTime.push(m));

  b.emit('playback', { action: 'seek', time: 10 });
  await wait(200);
  const seekMsg = aEvents.playback.find((m) => m.action === 'seek');
  check('A receives seek from Bob, still playing', seekMsg && seekMsg.time === 10 && seekMsg.playing === true && seekMsg.name === 'Bob');

  // --- B pauses ---
  b.emit('playback', { action: 'pause', time: 10 });
  await wait(200);
  const pauseMsg = aEvents.playback.find((m) => m.action === 'pause');
  check('A receives pause', pauseMsg && pauseMsg.playing === false);

  // --- paused: expected position must freeze ---
  const p1 = await new Promise((res) => a.emit('time-update', 10, res));
  await wait(300);
  const p2 = await new Promise((res) => a.emit('time-update', 10, res));
  check('paused position does not drift', p1.expected === 10 && p2.expected === 10);

  // --- subtitle delay: broadcast to the room, clamped, persisted in state ---
  a.emit('subtitle', { offset: 350 });
  await wait(200);
  const subMsg = bEvents.subtitle.find((m) => m.offset === 350);
  check('B receives subtitle offset with actor', subMsg && subMsg.name === 'Alice');
  a.emit('subtitle', { offset: 999999 });
  await wait(200);
  check('subtitle offset clamped to ±60s', bEvents.subtitle.some((m) => m.offset === 60000));

  // --- chat both ways ---
  a.emit('chat', 'hello from alice');
  b.emit('chat', 'hi from bob');
  await wait(200);
  check('B got Alice\'s chat', bEvents.chat.some((m) => m.text === 'hello from alice' && m.name === 'Alice'));
  check('A got Bob\'s chat', aEvents.chat.some((m) => m.text === 'hi from bob' && m.name === 'Bob'));

  // --- late joiner C gets current state ---
  const c = io(URL);
  await wait(200);
  const cJoined = await new Promise((res) => c.emit('join-room', { code: created.code, name: 'Cleo' }, res));
  check('late joiner sees paused at 10', cJoined.state.playing === false && cJoined.state.time === 10);
  check('late joiner sees 3 users', cJoined.users.length === 3);
  check('late joiner inherits room subtitle offset', cJoined.state.subOffset === 60000);

  // --- reconnect grace: leave + rejoin within window = no chat spam ---
  const e = io(URL);
  await wait(200);
  await new Promise((res) => e.emit('join-room', { code: created.code, name: 'Eli' }, res));
  await wait(200);
  const eliJoins = aEvents.chat.filter((m) => m.system && /Eli joined/.test(m.text)).length;
  check('Eli joining announced once', eliJoins === 1);

  const e2 = io(URL);
  await wait(200); // e2 connected but not in the room yet
  e.emit('leave-room');
  // rejoin lands well inside the grace window, exactly like a mobile blip
  const e2Join = await new Promise((res) => e2.emit('join-room', { code: created.code, name: 'Eli', rejoin: true }, res));
  await wait(600); // longer than the test grace window
  const eliLeftMsgs = aEvents.chat.filter((m) => m.system && /Eli left/.test(m.text)).length;
  const eliRejoinMsgs = aEvents.chat.filter((m) => m.system && /Eli joined/.test(m.text)).length - eliJoins;
  check('quick leave+rejoin sends no "left" message', eliLeftMsgs === 0);
  check('quick leave+rejoin sends no second "joined" message', eliRejoinMsgs === 0);
  check('rejoin response omits history', e2Join.history === undefined);
  check('rejoin still returns state+users', e2Join.state.time === 10 && e2Join.users.length === 4);

  // --- source: YouTube switch broadcasts, resets playhead, persists in state ---
  const bSrc = [];
  b.on('source', (m) => bSrc.push(m));

  a.emit('source', { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  await wait(200);
  const srcMsg = bSrc.find((m) => m.source && m.source.type === 'youtube');
  check('B receives YouTube source with videoId+actor', srcMsg && srcMsg.source.videoId === 'dQw4w9WgXcQ' && srcMsg.name === 'Alice');
  check('source switch resets playhead', srcMsg && srcMsg.time === 0);
  check('queued YouTube starts playing automatically', srcMsg && srcMsg.playing === true);

  a.emit('source', { type: 'youtube', videoId: 'not-a-real-id' });
  await wait(300);
  check('invalid videoId rejected silently', bSrc.filter((m) => m.source && m.source.type === 'youtube').length === 1);

  const f = io(URL);
  await wait(200);
  const fJoin = await new Promise((res) => f.emit('join-room', { code: created.code, name: 'Fred' }, res));
  check('late joiner inherits YouTube source', fJoin.state.source && fJoin.state.source.videoId === 'dQw4w9WgXcQ');

  a.emit('source', { type: 'local' });
  await wait(200);
  check('switch back to local clears source', bSrc.some((m) => m.source === null));
  f.close();

  // --- voice: token requires env (absent in tests), mic state relays ---
  const noToken = await new Promise((res) => a.emit('voice-token', res));
  check('voice-token without env fails gracefully', !!(noToken && noToken.error));

  const bVoice = [];
  b.on('peer-voice', (m) => bVoice.push(m));
  a.emit('voice-state', { on: true });
  await wait(200);
  check('B sees A go live on mic', bVoice.some((m) => m.id === aId && m.on === true));

  const g = io(URL);
  await wait(200);
  const gJoin = await new Promise((res) => g.emit('join-room', { code: created.code, name: 'Gus' }, res));
  check('late joiner sees existing mic state', gJoin.voice && gJoin.voice[aId] === true);

  a.emit('voice-state', { on: false });
  await wait(200);
  check('B sees A mute', bVoice.some((m) => m.id === aId && m.on === false));
  g.close();

  // --- B leaves for real: announcement arrives after the grace window ---
  b.emit('leave-room');
  await wait(600);
  check('A notified of B leaving after grace window', aEvents.chat.some((m) => m.system && /Bob left/.test(m.text)));

  // --- empty room: evicted from memory; without Mongo the code dies ---
  a.emit('leave-room');
  c.emit('leave-room');
  e2.emit('leave-room');
  await wait(300);
  const rejoin = await new Promise((res) => a.emit('join-room', { code: created.code, name: 'Alice' }, res));
  check('room gone after everyone left (no Mongo in tests)', !!rejoin.error);

  // --- regression: SAME socket creates then re-joins (React room-page flow) ---
  const s = io(URL);
  await wait(200);
  const cr = await new Promise((res) => s.emit('create-room', 'Solo', res));
  const sj = await new Promise((res) => s.emit('join-room', { code: cr.code, name: 'Solo' }, res));
  check('same-socket create then join succeeds', !sj.error && sj.code === cr.code);
  check('same-socket rejoin keeps single membership', sj.users && sj.users.length === 1);
  s.emit('leave-room');
  s.close();

  a.close(); b.close(); c.close(); e.close(); e2.close();
  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
