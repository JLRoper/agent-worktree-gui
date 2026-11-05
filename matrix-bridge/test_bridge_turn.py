#!/usr/bin/env python3
"""The bridge's panel contract, without Matrix and without a network.

What this pins:
  1. the panel's policy preamble is APPENDED to the prompt of the turn being run;
  2. it is fetched on EVERY turn — a second turn reads the panel again and never reuses the first copy;
  3. a failed fetch is reported in the prompt AND at the top of the reply, not swallowed;
  4. the reminder list and the read-only watches view ride in the same turn, and the bridge has no write path
     for either (the panel owns the list; a watch is an assistant's, not the bridge's).

Run it directly (`python test_bridge_turn.py`) or through test/matrix-bridge-turn.test.js, which is the copy
`npm test` executes. Nothing here imports matrix-nio: the bridge imports it lazily, so this file runs on a bare
Python and proves the turn contract rather than the room.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hermes_matrix_bridge as bridge  # noqa: E402

POLICY_ONE = (
    "## How the reader wants the Matrix bridge to speak to them\n\n"
    "- First-turn-only: answer in one line.\n- Quiet hours 22:00-07:00.\n"
)
POLICY_TWO = (
    "## How the reader wants the Matrix bridge to speak to them\n\n"
    "- Second-turn: the reader edited the routing.\n"
)
REMINDERS = (
    "## Reminders you keep for the reader (the panel's list — not an assistant's watches)\n"
    "- [ ] check the deploy\n"
    "\n## Assistants' watches — READ ONLY\n"
    "- deploy watch — watching (assistant-1, thread-7)\n"
)


def opener_for(policy=("preamble", POLICY_ONE), reminders=("preamble", REMINDERS), seen=None):
    """A stand-in for the panel: answers the two routes and records what was asked for."""

    def opener(route):
        if seen is not None:
            seen.append(route)
        if route == bridge.PANEL_POLICY_ROUTE:
            key, value = policy
            return {key: value}
        if route == bridge.PANEL_REMINDERS_ROUTE:
            if reminders[0] == "raise":
                raise OSError(reminders[1])
            return {"preamble": reminders[1], "reminders": [{"text": "check the deploy"}],
                    "watches": [{"title": "deploy watch"}], "watchesReadOnly": True}
        raise AssertionError(f"the bridge asked for an unexpected route: {route}")

    return opener


class PolicyTurnTest(unittest.TestCase):
    def test_policy_is_appended_to_the_turn(self):
        context = bridge.turn_context(opener_for())
        prompt = bridge.build_prompt("what is on the board?", [], context)
        self.assertIn("First-turn-only", prompt, "the reader's words must be in the turn")
        self.assertIn("How the reader wants the Matrix bridge to speak to them", prompt)
        # Appended, not instead of: the turn still carries its own instructions and the new message.
        self.assertIn("Matrix chat bridge", prompt)
        self.assertIn("New message from the user: what is on the board?", prompt)

    def test_policy_is_read_again_on_the_next_turn_never_cached(self):
        seen: list[str] = []
        turns = {"n": 0}

        def opener(route):
            seen.append(route)
            if route == bridge.PANEL_POLICY_ROUTE:
                turns["n"] += 1
                return {"preamble": POLICY_ONE if turns["n"] == 1 else POLICY_TWO}
            return {"preamble": "", "reminders": [], "watches": [], "watchesReadOnly": True}

        first = bridge.build_prompt("a", [], bridge.turn_context(opener))
        second = bridge.build_prompt("b", [], bridge.turn_context(opener))
        self.assertIn("First-turn-only", first)
        self.assertIn("Second-turn", second)
        self.assertNotIn("First-turn-only", second, "the second turn must not run on the first turn's policy")
        self.assertEqual(seen.count(bridge.PANEL_POLICY_ROUTE), 2, "one fetch per turn")
        self.assertEqual(seen.count(bridge.PANEL_REMINDERS_ROUTE), 2, "and the list is read per turn too")

    def test_a_failed_fetch_is_said_in_the_prompt_and_the_reply(self):
        def opener(route):
            if route == bridge.PANEL_POLICY_ROUTE:
                raise OSError("connection refused")
            return {"preamble": "", "reminders": [], "watches": [], "watchesReadOnly": True}

        context = bridge.turn_context(opener)
        self.assertFalse(context["policy"]["ok"])
        self.assertIn("connection refused", context["policy"]["error"])

        prompt = bridge.build_prompt("hello", [], context)
        self.assertIn("THE PANEL POLICY COULD NOT BE READ THIS TURN", prompt)

        reply = bridge.reply_with_context("Here is the answer.", context)
        self.assertIn("could not read the panel policy", reply, "the phone must be told, not just the log")
        self.assertIn("connection refused", reply)
        self.assertTrue(reply.rstrip().endswith("Here is the answer."), "the answer still arrives")

    def test_a_second_failed_turn_does_not_reuse_the_first_policy(self):
        turns = {"n": 0}

        def opener(route):
            if route == bridge.PANEL_POLICY_ROUTE:
                turns["n"] += 1
                if turns["n"] == 1:
                    return {"preamble": POLICY_ONE}
                raise OSError("the panel is down")
            return {"preamble": "", "reminders": [], "watches": [], "watchesReadOnly": True}

        bridge.turn_context(opener)
        second = bridge.turn_context(opener)
        prompt = bridge.build_prompt("again", [], second)
        self.assertNotIn("First-turn-only", prompt, "stale policy must never be carried")
        self.assertIn("the panel is down", bridge.reply_with_context("ok", second))

    def test_a_healthy_turn_wraps_nothing_around_the_answer(self):
        context = bridge.turn_context(opener_for())
        self.assertEqual(bridge.reply_with_context("plain answer", context), "plain answer")


class RemindersTurnTest(unittest.TestCase):
    def test_reminders_and_the_watches_view_reach_the_turn(self):
        context = bridge.turn_context(opener_for())
        prompt = bridge.build_prompt("did anything finish?", [], context)
        self.assertIn("check the deploy", prompt)
        self.assertIn("READ ONLY", prompt, "the model is told the watches are not its to change")
        self.assertIn("deploy watch", prompt)
        self.assertTrue(context["reminders"]["watchesReadOnly"])
        self.assertEqual(context["reminders"]["reminders"], 1)
        self.assertEqual(context["reminders"]["watches"], 1)

    def test_the_bridge_reads_the_list_and_never_writes_it(self):
        seen: list[str] = []
        bridge.turn_context(opener_for(seen=seen))
        self.assertEqual(seen, [bridge.PANEL_POLICY_ROUTE, bridge.PANEL_REMINDERS_ROUTE],
                         "GET only: there is no write route in this process")
        # A watch is a thread plus a state and wake an assistant; the bridge has no code path that writes one,
        # and no task queue for the reminder list either (work belongs to an assistant's queue).
        for name in ("post_reminder", "add_watch", "remove_watch", "TASK_QUEUE"):
            self.assertFalse(hasattr(bridge, name), f"the bridge must not grow {name}")

    def test_a_failed_reminder_fetch_is_reported_too(self):
        context = bridge.turn_context(opener_for(reminders=("raise", "HTTP 500")))
        self.assertFalse(context["reminders"]["ok"])
        reply = bridge.reply_with_context("answer", context)
        self.assertIn("could not read your reminders", reply)


if __name__ == "__main__":
    unittest.main(verbosity=2)
