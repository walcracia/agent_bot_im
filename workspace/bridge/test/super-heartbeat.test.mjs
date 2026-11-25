import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHeartbeat } from '../super-heartbeat.mjs';
import { ManagedRuntime } from '../managed-runtime.mjs';

const deferred = () => Promise.withResolvers();

test('slow heartbeat and publication share one operation without retaining another timer tick', async () => {
  const beatGate = deferred(), publishGate = deferred(), published = deferred();
  let beats = 0, publications = 0;
  const heartbeat = createHeartbeat({ beat: async () => { beats++; await beatGate.promise; },
    publish: async () => { publications++; published.resolve(); await publishGate.promise; }, onError: assert.fail });
  const first = heartbeat.tick();
  for (let tick = 0; tick < 100; tick++) assert.equal(heartbeat.tick(), first);
  await Promise.resolve(); assert.equal(beats, 1); assert.equal(publications, 0);
  beatGate.resolve(); await published.promise;
  assert.equal(heartbeat.tick(), first); assert.equal(publications, 1);
  publishGate.resolve(); await first;
  await heartbeat.tick();
  assert.equal(beats, 2); assert.equal(publications, 2, 'A later real timer tick may start the next heartbeat.');
  await heartbeat.close();
});

test('heartbeat and publication failures are each reported once without poisoning later heartbeats', async () => {
  const failure = new Error('Synthetic state allocation failure'), publishFailure = new Error('Synthetic publication failure'), errors = [];
  let attempts = 0, publications = 0;
  const heartbeat = createHeartbeat({ beat: async () => { if (++attempts === 1) throw failure; },
    publish: () => { if (++publications === 1) throw publishFailure; }, onError: error => { errors.push(error); } });
  await heartbeat.tick();
  assert.deepEqual(errors, [failure]); assert.equal(publications, 0);
  await heartbeat.tick();
  assert.deepEqual(errors, [failure, publishFailure]);
  await heartbeat.tick();
  assert.equal(attempts, 3); assert.equal(publications, 2);
  await heartbeat.close();
});

test('shutdown waits for the current publication and prevents late listening over stopped runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-heartbeat-'));
  const path = join(directory, 'runtime.json'), runtime = new ManagedRuntime(path, randomUUID(), join(directory, 'config.json'));
  t.after(async () => {
    clearInterval(runtime.timer);
    await runtime.checking?.catch(() => {});
    const remainder = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(remainder && !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.start(() => {});
  const gate = deferred(), entered = deferred(); let publications = 0;
  const heartbeat = createHeartbeat({ beat: async () => { entered.resolve(); await gate.promise; },
    publish: () => { publications++; return runtime.publish('listening', { memory: process.memoryUsage() }); }, onError: assert.fail });
  const current = heartbeat.tick(); await entered.promise;
  let drained = false;
  const closing = heartbeat.close().then(() => { drained = true; });
  await heartbeat.tick(); assert.equal(drained, false); assert.equal(publications, 0);
  gate.resolve(); await current; await closing;
  const listening = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(listening.status, 'listening');
  for (const value of Object.values(listening.memory)) assert.ok(Number.isFinite(value) && value >= 0);
  await runtime.finish(false); await heartbeat.tick();
  assert.equal(publications, 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'stopped');
});
