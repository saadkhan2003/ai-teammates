import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/agent'))
from grounding import check_answer, observed_urls, patterned_urls, requested_count


def test_linkedin_sequential_fabrication():
    links = {f'https://www.linkedin.com/jobs/view/{1000000+i}' for i in range(6)}
    answer = '\n'.join(f'{i}. [Job]({link})' for i, link in enumerate(sorted(links), 1))
    result = check_answer('5 jobs from LinkedIn', answer, set())
    assert result.verified == 0 and result.removed == 6
    assert 'patterned_ids' in result.issues
    assert 'only 0 of the 5' in result.text
    assert 'https://' not in result.text


def test_count_overshoot_with_multiline_items():
    links = {f'https://example.com/job/{i}' for i in range(6)}
    answer = '\n'.join(f'{i}. {link}\n   Description\n' for i, link in enumerate(sorted(links), 1))
    result = check_answer('5 jobs', answer, links)
    assert result.verified == 5 and result.removed == 1
    assert result.text.count('Description') == 5
    assert 'count_exceeded' in result.issues


@pytest.mark.parametrize('prompt,count', [('top three', 3), ('5 jobs', 5), ('three results', 3), ('20 links', 20), ('explain this', None)])
def test_counts(prompt, count):
    assert requested_count(prompt) == count


@pytest.mark.parametrize('link', ['https://example.com/a?q=hello&x=1', 'https://linkedin.com/jobs/view/987654321', 'http://example.org/'])
def test_legitimate_url_passes(link):
    result = check_answer('Describe it', f'[Source]({link}).', {link})
    assert result.issues == () and result.verified == 1 and result.removed == 0


def test_substitute_site_and_lookalike_are_removed():
    for link in ['https://indeed.com/job/1', 'https://linkedin.com.evil.test/job/1']:
        result = check_answer('top three jobs from LinkedIn', '1. ' + link, {link})
        assert result.verified == 0 and result.removed == 1
        assert 'requested_source' in result.issues


def test_observed_sequence_is_valid():
    links = {f'https://example.com/jobs/{10000+i}' for i in range(3)}
    assert patterned_urls(links) == links
    assert check_answer('3 jobs', '\n'.join(f'{i}. {s}' for i,s in enumerate(sorted(links))), links).issues == ()


def test_only_tool_outputs_count():
    assert observed_urls([{'role': 'user', 'content': 'https://unseen.test'}, {'role': 'assistant', 'content': 'https://fake.test'}, {'role': 'tool', 'content': {'text': 'https://seen.test'}}]) == {'https://seen.test'}


def test_missing_items_disclosed():
    result = check_answer('5 jobs', '1. https://example.com/job/1', {'https://example.com/job/1'})
    assert 'only 1 of the 5' in result.text


def test_prose_url_removed_and_prose_count_capped():
    assert 'https://' not in check_answer('explain', 'See https://unseen.test/a.', set()).text
    links = {'https://example.com/1', 'https://example.com/2'}
    assert check_answer('1 link', ' '.join(links), links).verified == 1


def test_failed_tool_url_is_not_evidence():
    assert observed_urls([{'role':'tool','content':{'ok':False,'url':'https://unseen.test'}}]) == set()


def test_nested_bullets_are_part_of_item():
    answer = '1. https://example.com/a\n   - detail\n2. https://example.com/b\n   - detail\n'
    result = check_answer('top one', answer, {'https://example.com/a','https://example.com/b'})
    assert result.verified == 1 and result.text.count('detail') == 1


def test_worker_reasks_once_and_accepts_only_sanitized_answer():
    import asyncio
    from worker import Worker
    class Fake(Worker):
        def __init__(self):
            super().__init__()
            self.rounds, self.events, self.answer = 0, [], None
        async def _load_transcript(self, task): return []
        async def _put_transcript(self, task, messages): pass
        async def _complete_model(self, task, messages):
            self.rounds += 1
            return {'role':'assistant','content':'1. Fake https://unseen.test/jobs/1234567'}
        async def request(self, method, path, body=None): self.events.append(body)
        async def _complete(self, task, text): self.answer = text
    worker = Fake()
    asyncio.run(worker.execute({'id':'task','instruction':'5 jobs from LinkedIn'}, asyncio.Event()))
    assert worker.rounds == 2
    assert 'https://' not in worker.answer
    assert len(worker.events) == 2 and worker.events[0]['removed'] == 1
