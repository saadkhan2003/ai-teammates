"""Deterministic final-answer checks. Only tool results count as evidence."""
from __future__ import annotations

from dataclasses import dataclass
import json
import re
from urllib.parse import urlsplit

_URL = re.compile(r'https?://[^\s<>"\\]+')
_ITEM = re.compile(r'^\s*(?:\d+[.)]|[-*])\s+', re.M)
_NUMBERS = {word: i for i, word in enumerate('zero one two three four five six seven eight nine ten'.split())}
_COUNT = re.compile(r'\b(?:top\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:jobs?|results?|items?|links?|sources?|options?|examples?|recommendations?)\b|\btop\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b', re.I)
_SOURCE = re.compile(r'\b(?:from|on|using|via)\s+(?:only\s+)?(LinkedIn|Indeed|Glassdoor|[a-z0-9-]+\.[a-z]{2,})\b', re.I)


def urls(text: str) -> set[str]:
    return {m.group().rstrip('.,;:!?)]}') for m in _URL.finditer(text or '')}


def observed_urls(messages: list) -> set[str]:
    result = set()
    for message in messages:
        if isinstance(message, dict) and message.get('role') == 'tool':
            body = message.get('content', '')
            if isinstance(body, str):
                try:
                    parsed = json.loads(body)
                except ValueError:
                    parsed = body
            else:
                parsed = body
            if isinstance(parsed, dict) and (parsed.get('ok') is False or parsed.get('status') in {'denied', 'error', 'invalid', 'waiting_approval'}):
                continue
            result |= urls(parsed if isinstance(parsed, str) else json.dumps(parsed))
    return result


def requested_count(instruction: str) -> int | None:
    match = _COUNT.search(instruction)
    if not match:
        return None
    value = (match[1] or match[2]).lower()
    return int(value) if value.isdigit() else _NUMBERS[value]


def requested_sites(instruction: str) -> set[str]:
    aliases = {'linkedin': 'linkedin.com', 'indeed': 'indeed.com', 'glassdoor': 'glassdoor.com'}
    return {aliases.get(m[1].lower(), m[1].lower()) for m in _SOURCE.finditer(instruction)}


def patterned_urls(links: set[str]) -> set[str]:
    """Flag sequences only; observed numeric IDs are still valid evidence."""
    groups: dict[str, list[tuple[int, str]]] = {}
    for link in links:
        try:
            path = urlsplit(link).path
        except ValueError:
            continue
        match = re.search(r'\d{4,}', path)
        if match:
            key = link[:link.index(match[0])] + '#' + link[link.index(match[0]) + len(match[0]):]
            groups.setdefault(key, []).append((int(match[0]), link))
    suspicious = set()
    for values in groups.values():
        values.sort()
        for a, b, c in zip(values, values[1:], values[2:]):
            if 0 < b[0] - a[0] == c[0] - b[0] <= 10:
                suspicious.update((a[1], b[1], c[1]))
    return suspicious


@dataclass(frozen=True)
class GroundingResult:
    text: str
    verified: int
    removed: int
    issues: tuple[str, ...]

    @property
    def event(self) -> dict:
        return {'type': 'grounding', 'verified': self.verified, 'removed': self.removed,
                'summary': f'verified {self.verified} links / removed {self.removed}', 'issues': list(self.issues)}


def check_answer(instruction: str, answer: str, observed: set[str]) -> GroundingResult:
    links = urls(answer)
    sites = requested_sites(instruction)
    def permitted(link):
        try:
            host = (urlsplit(link).hostname or '').lower()
        except ValueError:
            return False
        return not sites or any(host == site or host.endswith('.' + site) for site in sites)
    rejected = {link for link in links if link not in observed or not permitted(link)}
    issues = []
    if links - observed:
        issues.append('unverified_url')
    if any(not permitted(link) for link in links):
        issues.append('requested_source')
    if patterned_urls(links) - observed:
        issues.append('patterned_ids')
    count = requested_count(instruction)
    starts = list(_ITEM.finditer(answer))
    if starts:
        # Nested bullets belong to the parent result rather than being extra results.
        indent = min(len(m.group()) - len(m.group().lstrip(' \t')) for m in starts)
        starts = [m for m in starts if len(m.group()) - len(m.group().lstrip(' \t')) == indent]
    if starts:
        header = answer[:starts[0].start()]
        items = [answer[m.start():starts[i + 1].start() if i + 1 < len(starts) else len(answer)] for i, m in enumerate(starts)]
        kept = [item for item in items if not urls(item) & rejected
                and (not sites or any(link in observed and permitted(link) for link in urls(item)))]
        if sites and len(kept) < len(items) and 'requested_source' not in issues:
            issues.append('requested_source')
        if count is not None and len(kept) > count:
            issues.append('count_exceeded')
            kept = kept[:count]
        # Do not retain an introductory claim about a larger result count.
        text = (header if not issues else '') + ''.join(kept)
        verified_items = sum(bool(urls(item) & observed) for item in kept)
    else:
        text = answer
        verified_items = len(links - rejected)
    # Remove all unverified URLs, including those in prose and headings.
    text = _URL.sub(lambda m: '[source could not be verified]' if m.group().rstrip('.,;:!?)]}') in rejected else m.group(), text)
    # Prose result sets cannot be trimmed safely: withhold them rather than exceed a cap.
    if count is not None and not starts and len(urls(text)) > count:
        issues.append('count_exceeded')
        text = '\n'.join(sorted(urls(text))[:count])
        verified_items = count
    if count is not None and verified_items < count:
        text = text.rstrip() + f'\n\nI could verify only {verified_items} of the {count} requested items' + (f' from {", ".join(sorted(sites))}' if sites else '') + '.'
    if rejected:
        text = text.rstrip() + '\n\nSome sources could not be verified and were removed.'
    final_links = urls(text)
    return GroundingResult(text.strip(), len(final_links & observed), len(links - final_links), tuple(issues))
