namespace Teammates.Compute;

public static class ComputerReadiness
{
    // A mounted workspace or running container does not mean the desktop API is
    // usable. Ensure the canonical desktop and browser without changing its lease.
    public const string ProbeScript = """
        import json, os, urllib.request
        assert os.path.isdir('/workspace')
        computer = os.environ['COMPUTER_ID']
        body = json.dumps({'botId': computer, 'display': 1, 'name': os.environ.get('COMPUTER_NAME', 'Teammate'), 'chrome': True}).encode()
        req = urllib.request.Request('http://127.0.0.1:7700/desktops', data=body, headers={'Authorization': 'Bearer ' + os.environ['COMPUTER_TOKEN'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=3) as response:
            state = json.load(response)
        assert state.get('ready') and state.get('chrome')
        with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=1) as response:
            assert json.load(response).get('webSocketDebuggerUrl')
        print('ready')
        """;
}
