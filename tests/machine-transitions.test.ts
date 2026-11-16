import assert from "node:assert/strict";
import test from "node:test";
import { BoardService, MemoryBoardBackend } from "../src/worker/store.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T0_PLUS_10S = "2026-01-01T00:00:10.000Z";
const T0_PLUS_119S = "2026-01-01T00:01:59.000Z";
const T0_PLUS_120S = "2026-01-01T00:02:00.000Z";
const T0_PLUS_200S = "2026-01-01T00:03:20.000Z";

function service(): BoardService {
  return new BoardService(new MemoryBoardBackend());
}

test("first heartbeat reports one online transition with the stored row", () => {
  const board = service();
  const outcome = board.heartbeat("machine-a", "test", 2, T0);
  assert.deepEqual(outcome.machineTransitions, [
    { last_heartbeat_at: T0, machine_id: "machine-a", sender_version: "test", spool_depth: 2 },
  ]);
  assert.deepEqual(outcome.machineTransitions, board.listMachines());
});

test("a heartbeat while already online reports no transition", () => {
  const board = service();
  board.heartbeat("machine-a", "test", 0, T0);
  assert.deepEqual(board.heartbeat("machine-a", "test", 0, T0_PLUS_10S).machineTransitions, []);
});

test("a heartbeat after the machine went stale and was swept reports online again", () => {
  const board = service();
  board.heartbeat("machine-a", "test", 0, T0);
  assert.equal(board.sweepMachineTransitions(T0_PLUS_200S).length, 1);
  const outcome = board.heartbeat("machine-a", "test", 0, T0_PLUS_200S);
  assert.equal(outcome.machineTransitions.length, 1);
  assert.equal(outcome.machineTransitions[0]?.last_heartbeat_at, T0_PLUS_200S);
});

test("a heartbeat after a stale gap reports online even without a sweep", () => {
  const board = service();
  board.heartbeat("machine-a", "test", 0, T0);
  assert.equal(board.heartbeat("machine-a", "test", 0, T0_PLUS_200S).machineTransitions.length, 1);
});

test("sweep reports the offline transition once, only after the deadline", () => {
  const board = service();
  board.heartbeat("machine-a", "test", 0, T0);
  assert.deepEqual(board.sweepMachineTransitions(T0_PLUS_119S), []);
  const offline = board.sweepMachineTransitions(T0_PLUS_120S);
  assert.equal(offline.length, 1);
  assert.equal(offline[0]?.machine_id, "machine-a");
  assert.equal(offline[0]?.last_heartbeat_at, T0);
  assert.deepEqual(board.sweepMachineTransitions(T0_PLUS_200S), []);
});

test("next stale deadline is the heartbeat plus 120 s while online and null after going offline", () => {
  const board = service();
  assert.equal(board.nextMachineStaleDeadline(), null);
  board.heartbeat("machine-a", "test", 0, T0);
  assert.equal(board.nextMachineStaleDeadline(), Date.parse(T0) + 120_000);
  board.sweepMachineTransitions(T0_PLUS_120S);
  assert.equal(board.nextMachineStaleDeadline(), null);
});

test("unknown tracked state is derived from freshness without reporting a transition", () => {
  const board = service();
  board.seedMachine({
    last_heartbeat_at: T0,
    machine_id: "machine-a",
    sender_version: "test",
    spool_depth: 0,
  });
  assert.deepEqual(board.sweepMachineTransitions(T0_PLUS_10S), []);
  assert.equal(board.nextMachineStaleDeadline(), Date.parse(T0) + 120_000);
  assert.equal(board.sweepMachineTransitions(T0_PLUS_120S).length, 1);
});

test("a fresh service over the same backend reports the offline transition once after a restart", () => {
  const backend = new MemoryBoardBackend();
  new BoardService(backend).heartbeat("machine-a", "test", 0, T0);
  const woken = new BoardService(backend);
  assert.equal(woken.nextMachineStaleDeadline(), Date.parse(T0) + 120_000);
  assert.deepEqual(woken.sweepMachineTransitions(T0_PLUS_119S), []);
  const offline = woken.sweepMachineTransitions(T0_PLUS_120S);
  assert.equal(offline.length, 1);
  assert.equal(offline[0]?.machine_id, "machine-a");
  assert.deepEqual(woken.sweepMachineTransitions(T0_PLUS_200S), []);
  assert.deepEqual(new BoardService(backend).sweepMachineTransitions(T0_PLUS_200S), []);
});

test("a fresh service does not report a machine that was already offline before the restart", () => {
  const backend = new MemoryBoardBackend();
  const first = new BoardService(backend);
  first.heartbeat("machine-a", "test", 0, T0);
  assert.equal(first.sweepMachineTransitions(T0_PLUS_120S).length, 1);
  const woken = new BoardService(backend);
  assert.deepEqual(woken.sweepMachineTransitions(T0_PLUS_200S), []);
  assert.equal(woken.nextMachineStaleDeadline(), null);
  assert.equal(woken.heartbeat("machine-a", "test", 0, T0_PLUS_200S).machineTransitions.length, 1);
});
