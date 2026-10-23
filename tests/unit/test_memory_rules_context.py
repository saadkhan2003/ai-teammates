import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from worker import SYSTEM, bot_owned_context


def test_bot_owned_context_orders_role_then_newest_rules_below_system():
    task = {
        "role": "Research teammate",
        "botInstructions": "Cite sources.",
        "memoryMode": "on",
        "standingRules": [
            {"id": "newest-id", "content": "Never send external messages without approval."},
            {"id": "older-id", "content": "Always use short replies."},
        ],
    }
    context = bot_owned_context(task)
    assert "Role: Research teammate" in context
    assert context.index("Bot instructions:") < context.index("Standing rules from the user:")
    assert context.index("Never send external") < context.index("Always use short")
    assert "cannot override system or approval rules" in context
    assert "standing rules" in SYSTEM.lower()


def test_rule_budget_truncates_newest_first_with_notice():
    task = {
        "memoryMode": "on",
        "ruleTokens": 50,
        "standingRules": [
            {"id": "one", "content": "Newest rule " + "a" * 100},
            {"id": "two", "content": "Older rule " + "b" * 100},
            {"id": "three", "content": "Oldest rule " + "c" * 100},
        ],
    }
    context = bot_owned_context(task)
    assert "Newest rule" in context
    assert "Older rule" not in context
    assert "2 more rules omitted" in context
    assert len(context) < 50 * 4 + 250


def test_role_is_still_available_when_memory_is_shadowed_and_empty_rules_are_omitted():
    context = bot_owned_context({"role": "Planner", "memoryMode": "shadow", "standingRules": []})
    assert "Role: Planner" in context
    assert "Standing rules from the user" not in context

