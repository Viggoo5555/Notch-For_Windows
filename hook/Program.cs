using System;
using System.IO;

// The native half of Notch's key helper.
//
// JarvisWinHook.cs is the same C# the PowerShell fallback Add-Types, so there is
// one copy of the Win32 work. Built into notchhook.exe at packaging time, it runs
// without PowerShell at all — which is the point: on a machine where Add-Type is
// refused the type never existed (TypeNotFound), so the hook never started and
// the Windows key stayed Windows'.
//
// Same protocol either way: line commands on stdin, lines on stdout, `ready` once
// the keyboard hook is installed.
public static class Program
{
    public static int Main(string[] args)
    {
        bool test = false;
        bool overflow = false;
        string bar = "";

        for (int i = 0; i < args.Length; i++)
        {
            string value = args[i] == null ? "" : args[i].Trim();
            if (value == "-Test" || value == "--test") test = true;
            else if (value == "-Overflow" || value == "--overflow") overflow = true;
            else if ((value == "-Bar" || value == "--bar") && i + 1 < args.Length) bar = args[++i];
            else if (value.StartsWith("-Bar ")) bar = value.Substring(5).Trim();
        }

        JarvisWinHook.AllowInjected = test;

        // One press of the tray chevron, then out: there is nothing to watch.
        if (overflow)
        {
            JarvisWinHook.OpenOverflow();
            return 0;
        }

        // Windows' own taskbar, put away or brought back, then out.
        if (bar != "")
        {
            Console.WriteLine(JarvisWinHook.ShellBar(bar == "hide" ? 1 : 0));
            Console.Out.Flush();
            return 0;
        }

        return JarvisWinHook.Run();
    }
}
