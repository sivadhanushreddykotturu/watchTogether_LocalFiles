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
  check('create-room returns 5-char code', /^[A-Z2-9]{5}$/.test(created.code));
  check('creator is in user list', created.users.length === 1 && created.users[0].name === 'Alice');
  check('initial state paused at 0', created.state.playing === false && created.state.time === 0);
  check('join response carries history array', Array.isArray(created.history));

  // --- B joins with wrong code first, then the right one ---
  const bad = await new Promise((res) => b.emit('join-room', { code: 'ZZZZZ', name: 'Bob' }, res));
  check('wrong code rejected', !!bad.error);

  const bEvents = { playback: [], chat: [], users: [] };
  b.on('playback', (m) => bEvents.playback.push(m));
  b.on('chat', (m) => bEvents.chat.push(m));
  b.on('users', (m) => bEvents.users.push(m));

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

  a.close(); b.close(); c.close(); e.close(); e2.close();
  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
