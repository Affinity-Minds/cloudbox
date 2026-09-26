using System.Diagnostics;

namespace CloudBox.Agent.Install;

public static class ProcessRunner
{
    public sealed record Result(int ExitCode, string Output);

    /// <summary>Runs a system tool with argument-list quoting and a timeout. Never passes secrets.</summary>
    public static Result Run(string file, IEnumerable<string> args, int timeoutMs = 60_000)
    {
        var psi = new ProcessStartInfo(file)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"Could not start {file}");
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(timeoutMs))
        {
            p.Kill(entireProcessTree: true);
            throw new TimeoutException($"{file} did not exit within {timeoutMs} ms");
        }

        return new Result(p.ExitCode, stdout.Result + stderr.Result);
    }

    public static Result RunChecked(string file, params string[] args)
    {
        var r = Run(file, args);
        if (r.ExitCode != 0)
        {
            throw new InvalidOperationException($"{file} {string.Join(' ', args)} failed ({r.ExitCode}): {r.Output.Trim()}");
        }

        return r;
    }

    /// <summary>Deletes <paramref name="paths"/> after this process exits, via a detached cmd.</summary>
    public static void ScheduleSelfDelete(IReadOnlyList<string> paths)
    {
        if (paths.Count == 0) return;
        var commands = string.Join(" & ", paths.Select(p =>
            System.IO.Directory.Exists(p) ? $"rmdir /s /q \"{p}\"" : $"del /f /q \"{p}\""));
        var psi = new ProcessStartInfo("cmd.exe", $"/c ping -n 3 127.0.0.1 >nul & {commands}")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetTempPath(),
        };
        Process.Start(psi);
    }
}
