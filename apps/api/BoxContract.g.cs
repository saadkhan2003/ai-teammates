// @generated sha256:28fb83906ddd44d32cdd516e1f4d1cea713612a93391c207d3bf27686642ef2a
namespace Teammates.Api;

public static class BoxContract
{
    public const int MaxWindows = 8;
    public const int Exec = 1337;
    public const int Pty = 1338;
    public const int WindowRouter = 1339;
    public const int HostGateway = 1340;
    public const int VncPrimary = 5900;
    public const int NovncPlain = 6080;
    public const int NovncTokened = 6081;
    public const int EgressTunnelWs = 8790;
    public const int EgressProxy = 8791;
    public const int CdpBase = 9222;
    public const int ExternalViewBase = 9400;
    public const int TailnetChromeCdp = 9600;
    public const int ScreenWidth = 1920;
    public const int ScreenHeight = 1200;
    public const int ModelWidth = 1280;
    public const int ModelHeight = 800;
    public const double ModelScale = 1.5;
    public const string NovncTokensPath = "/tmp/box-novnc-tokens.d";
    public const string WindowTokensPath = "/tmp/box-window-tokens.d";
    public const string WindowUsedPath = "/tmp/box-window-used.d";
    public const string EgressFailClosedPath = "/tmp/box-egress-fail-closed";
    public static int PortFor(string kind, int display)
    {
        if (display < 1 || display > MaxWindows) throw new ArgumentOutOfRangeException(nameof(display));
        var basis = kind switch
        {
            "vnc" => 5900,
            "exec" => 14000,
            "pty" => 13600,
            "cdp" => 9222,
            "externalView" => 9400,
            _ => throw new ArgumentException("Unknown port kind", nameof(kind))
        };
        return basis + display;
    }
}
