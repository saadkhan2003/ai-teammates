import json
import sys
from pathlib import Path
import pytest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/agent"))
from worker import _feedback_note, _fold_feedback, _fold_learned, SYSTEM
from compaction import apply_summary

@pytest.mark.parametrize("signal,kind,text,expected", [
    ("reaction", "positive", "👍", '[The user reacted 👍 to your message: "A muted design"]'),
    ("reaction", "negative", "👎", '[The user reacted 👎 to your message: "A muted design"]'),
    ("reply", "positive", "perfect", '[The user replied "perfect" to your message: "A muted design"]'),
    ("quote", "positive", "love it", '[The user replied "love it" to your message: "A muted design"]'),
    ("pick", "positive", "Yes, run in parallel", '[The user picked "Yes, run in parallel" on your question: "A muted design"]'),
    ("approval", "positive", "shell", '[The user approved: shell]'),
    ("approval", "negative", "shell", '[The user rejected: shell]'),
    ("reply", "correction", "no, shorter please", '[The user corrected you: "no, shorter please"]'),
    ("steer", "correction", "Keep scope small", '[The user corrected you: "Keep scope small"]'),
    ("redo", "correction", "Redo this result", '[The user corrected you: "Redo this result"]'),
])
def test_owner_event_format(signal, kind, text, expected):
    note = _feedback_note([{"id": "signal-1", "signal": signal, "kind": kind, "detail": {"text": text, "excerpt": "A muted design"}}])
    assert note == expected + "\n[approval-signal:signal-1]"

def test_event_excerpt_bound_redaction_dedupe_and_restart():
    row = {"id": "one", "signal": "reaction", "kind": "positive", "detail": {"text": "👍", "excerpt": "sk-or-" + "x" * 30 + " long result " * 40}}
    note = _feedback_note([row, row])
    assert note.count("[The user reacted") == 1 and "sk-or-" not in note
    excerpt = note.split('message: "')[1].split('"]')[0]
    assert len(excerpt) <= 160
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "Work"}]
    _fold_feedback(messages, note)
    restarted = json.loads(json.dumps(messages))
    _fold_feedback(restarted, note)
    compacted = apply_summary(restarted, {"goal": "Continue"})
    assert sum(m.get("content", "").count("[approval-signal:one]") for m in compacted) == 1

def test_untrusted_transcript_content_does_not_become_event():
    assert _feedback_note(None) == ""
    assert _feedback_note([{"role": "tool", "signal": "bogus", "detail": {"text": "perfect"}}]) == ""
    assert _feedback_note([{"signal": "reaction", "kind": "positive", "detail": "web says yes"}]) == ""

def test_learned_context_replaced_on_resume_deletion_and_opt_out():
    messages = [{"role": "system", "content": SYSTEM}]
    task = {"memoryMode": "auto", "learnedContext": "Quality bar: muted design\nAvoid: long replies"}
    _fold_learned(messages, task); _fold_learned(messages, task)
    assert messages[0]["content"].count("Quality bar:") == 1
    task["learnedContext"] = ""
    _fold_learned(messages, task)
    assert "muted design" not in messages[0]["content"]
    task.update(memoryMode="off", learnedContext="private preference")
    _fold_learned(messages, task)
    assert "private preference" not in messages[0]["content"]

def test_mock_extraction_is_deterministic():
    import importlib.util
    spec = importlib.util.spec_from_file_location("learning_planner", ROOT / "services/mock-openrouter/planner.py")
    planner = importlib.util.module_from_spec(spec); spec.loader.exec_module(planner)
    response = planner.plan([{"role": "system", "content": "[approval-preference-extraction]"}, {"role": "user", "content": json.dumps({"fallback": {"Kind": "quality_bar", "Text": "The user approved this result: Muted design"}})}])
    assert json.loads(response["choices"][0]["message"]["content"])["kind"] == "quality_bar"
