namespace Teammates.Api;

public static class EpochFence
{
    public static bool Accepts(bool hasEpoch, int suppliedEpoch, int currentEpoch, string? status) =>
        !hasEpoch || suppliedEpoch == currentEpoch && status == "running";
}
