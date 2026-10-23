"""Shell path preflight. Execution must already run under the bot's isolated UID."""
from pathlib import Path
import os
import re
import shlex
import sys

_VIRTUAL = re.compile(r'(?<![\w/.-])/workspace(?=/|[^\w.-]|$)')


def prepare_command(command: str, root: Path) -> str:
    root = root.resolve()
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        raise PermissionError('invalid_shell_command') from None
    for token in tokens:
        # Check paths in assignment/redirection arguments as well as plain arguments.
        for value in re.split(r'[=<>;|&\s]', token):
            if not value:
                continue
            if '..' in value.split('/'):
                raise PermissionError('path_escapes_workspace')
            if value == '/workspace' or value.startswith('/workspace/'):
                candidate = root / value[len('/workspace'):].lstrip('/')
            elif not value.startswith('/') and '/' in value:
                candidate = root / value
            else:
                candidate = None
            if candidate is not None:
                resolved = candidate.resolve()
                if resolved != root and root not in resolved.parents:
                    raise PermissionError('path_escapes_workspace')
        # A bare symlink name can also leave the bot tree.
        candidate = root / token
        if not Path(token).is_absolute() and candidate.is_symlink():
            resolved = candidate.resolve()
            if resolved != root and root not in resolved.parents:
                raise PermissionError('path_escapes_workspace')
    return _VIRTUAL.sub(lambda _: str(root), command)


if __name__ == '__main__':
    try:
        command = prepare_command(sys.argv[1], Path(os.environ['BOT_ROOT']))
    except (PermissionError, ValueError):
        print('path_escapes_workspace', file=sys.stderr)
        raise SystemExit(4)
    os.execv('/bin/bash', ['bash', '-c', command])
