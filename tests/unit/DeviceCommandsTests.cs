using Teammates.Api;

namespace Teammates.UnitTests;

public class DeviceCommandsTests
{
    [Theory]
    [InlineData("pending","sent",true)] [InlineData("pending","completed",false)]
    [InlineData("sent","approved",true)] [InlineData("sent","denied",true)]
    [InlineData("approved","running",true)] [InlineData("approved","completed",false)]
    [InlineData("running","completed",true)] [InlineData("running","failed",true)]
    [InlineData("completed","failed",false)] [InlineData("denied","running",false)]
    [InlineData("expired","cancelled",false)]
    public void TransitionsFollowProtocol(string from,string to,bool expected) => Assert.Equal(expected,DeviceCommandState.CanTransition(from,to));

    [Theory]
    [InlineData("echo ok",true)] [InlineData(" ",false)] [InlineData("",false)]
    public void CommandMustContainText(string command,bool expected) => Assert.Equal(expected,DeviceCommandState.ValidCommand(command));
    [Fact] public void CommandLengthIsBounded() => Assert.False(DeviceCommandState.ValidCommand(new string('x',4001)));
    [Theory]
    [InlineData(null,true)] [InlineData("/tmp/work",true)] [InlineData("relative",false)] [InlineData("",false)]
    public void WorkingDirectoryMustBeAbsoluteOrNull(string? cwd,bool expected) => Assert.Equal(expected,DeviceCommandState.ValidCwd(cwd));
    [Theory] [InlineData(null,60)] [InlineData(0,1)] [InlineData(5,5)] [InlineData(900,600)]
    public void TimeoutDefaultsAndClamps(int? given,int expected) => Assert.Equal(expected,DeviceCommandState.Timeout(given));
    [Fact] public void FramesMustBeJsonObjectsWithStringType()
    {
        Assert.True(DeviceCommandState.ValidFrame("{\"type\":\"pong\"}"u8,out var good)); good?.Dispose();
        Assert.False(DeviceCommandState.ValidFrame("[]"u8,out _));
        Assert.False(DeviceCommandState.ValidFrame("{\"type\":4}"u8,out _));
        Assert.False(DeviceCommandState.ValidFrame(new byte[256*1024+1],out _));
    }
    [Fact] public void TypedFramesValidateRequiredFieldsAndBounds()
    {
        Assert.True(DeviceCommandState.ValidIncomingFrame(new DeviceFrame("hello",Version:"0.5",Protocol:1)));
        Assert.False(DeviceCommandState.ValidIncomingFrame(new DeviceFrame("hello",Version:"",Protocol:1)));
        Assert.False(DeviceCommandState.ValidIncomingFrame(new DeviceFrame("decision",RequestId:Guid.NewGuid(),Decision:"approved",Reason:new string('x',201))));
        Assert.False(DeviceCommandState.ValidIncomingFrame(new DeviceFrame("result",RequestId:Guid.NewGuid(),ExitCode:0,Stdout:new string('x',65537),Stderr:"",Truncated:false,DurationMs:0,TimedOut:false)));
        Assert.True(DeviceCommandState.ValidIncomingFrame(new DeviceFrame("result",RequestId:Guid.NewGuid(),ExitCode:0,Stdout:"",Stderr:"",Truncated:false,DurationMs:0,TimedOut:false)));
    }
}
