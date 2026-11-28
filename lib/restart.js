// Restarting the Hermes gateway, or this panel, from the board.
//
// A restart asked for during an assistant turn is a turn asking for its own process to be replaced: the
// turn itself runs in the gateway, so a synchronous restart kills it before its answer is sent. Every
// request is therefore QUEUED and runs only once the requesting turn has ended.
//
// Two failures this module exists to prevent.
//
//   1. A gateway started from a tool shell comes up with no provider credentials: it binds its port,
//      answers /health, and then every run it dispatches dies with "No LLM provider configured". The
//      provider key is therefore verified in `$HERMES_HOME/.env` BEFORE anything is stopped, and the
//      refusal is the answer when it is not there.
//   2. A run never left "running". Everything a restart kills is given one terminal status — interrupted,
//      with the restart recorded as the termination — before anything is stopped, so no card is left with
//      neither a done nor an interrupted verdict.
//   3. A restart that never happened was reported as one. `hermes gateway restart` is a service-manager
//      verb and the board's gateway is a foreground `gateway run` process: the command exits successfully
//      having done nothing, and one proof turn through the UNRESTARTED gateway proves the opposite of what
//      it is asked. A restart is therefore accepted only when the gateway reports a DIFFERENT PID within
//      30 s; when it does not, the panel stops the recorded pid and starts the recorded argv itself, and if
//      the pid still does not move the outcome is a FAILURE ("the gateway process never changed"), written
//      into the restart log. A false success here cost sixteen hours of a board that kept saying the gateway
//      had just been restarted.
//
// After the new process is up it is proved with ONE REAL TURN through the gateway, never with its
// listening port, and only then is the assistant woken once with the completion payload of everything the
// restart interrupted. A gateway restart the panel did NOT ask for fires the same single wake — that path
// lives in lib/jobs.js (`sweepOrphanedRuns`) and calls `Assistant.wakeAfterRestart` with the runs it lost.
//
// Two rules about the QUEUE itself. An entry waits only for a thread its caller NAMED (`waitFor`): the default used to
// be the assistant's own thread, whose live jobs are its sweeps, so an entry that named nothing sat in `waiting` until
// the panel was replaced. And a restart is refused as "a bounce for nothing" only when the checkout's `package.json`
// names the version this process already serves — the two version numbers, never a number found in the reason's prose.
//
// BOTH HALVES ARE THEIR OWN FILES. lib/restart-checks.js holds the provider key check, the version comparisons and
// the proof turn (row 511); lib/restart-controller.js holds the controller that queues and runs a restart (row 512).
// What is left here is the entry point and nothing else: it re-exports every name it has ever published, so no
// import site moved, and the one direction holds - neither of those files imports this one.
import { gatewayIdentity } from "./hermes-runtime.js";

// The names this module published before the cut are re-exported from the file that owns them: a caller keeps
// reading lib/restart.js, and the set is the same name for name.
export {
  NEVER_CHANGED_REASON, PROOF_PROMPT, PROVIDER_KEY_NAMES, REASON_REQUIRED, RESTART_SHAPE, compareVersions,
  gatewayLaunchPlan, gatewayRestartLogPath, proveGatewayTurn, providerKeyCheck, restartFilePath, sameVersion,
  servedVersionFromDisk, versionParts, versionsNamed,
} from "./restart-checks.js";

// The controller moved to its own file in row 512 and is re-exported from here, so a caller keeps importing
// lib/restart.js and never needs to know that the work happens in two files.
export { RestartController } from "./restart-controller.js";

// What the gateway's own state file says about the process running now: pid, the process-start fingerprint
// Hermes uses as a PID-reuse guard, and its state. The READER lives in lib/hermes-runtime.js (lib/jobs.js
// needs the same answer without importing this module, which would be a cycle) and is re-exported here
// because this is where every caller has always got it from.
//
// It is corroboration for the log and for the status surface, and — since the pid guard below — the
// evidence that a restart happened at all. A fresh pid is a fact only the gateway can report; one
// successful turn is not, because the gateway that was never restarted answers it too.
export { gatewayIdentity };
