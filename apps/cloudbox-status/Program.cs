// CloudBox.Status console stub (Slice 2.4 builds the real UI).
// Connects to the Agent's read-only status pipe and prints the JSON document.
// Runs unelevated: the pipe ACL grants Interactive users read access only.
using System.IO.Pipes;

const string PipeName = "CloudBoxAgent";
try
{
    using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.In);
    pipe.Connect(3000);
    using var reader = new StreamReader(pipe);
    Console.WriteLine(reader.ReadToEnd());
    return 0;
}
catch (TimeoutException)
{
    Console.Error.WriteLine($"CloudBox Agent is not running (pipe \\\\.\\pipe\\{PipeName} not available).");
    return 1;
}
catch (UnauthorizedAccessException)
{
    Console.Error.WriteLine("Access to the CloudBox Agent status pipe was denied.");
    return 1;
}
