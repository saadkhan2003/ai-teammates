using Teammates.Compute;

namespace Teammates.Api;

/// <summary>Maps a computer's refusal of a human-input call to a client-visible conflict instead of a 500.</summary>
public static class HumanInputErrors
{
    public const string NotHeld = "human control is not held";

    // The computer answers 403 "not held" or 409 when its desktop holder or epoch no longer matches the
    // caller's lease. Other failures (computer down, bad request) stay errors.
    public static bool LostControl(ComputeException ex) => ex.IsControlRefused || ex.Code == ComputeErrorCode.Conflict;
}
