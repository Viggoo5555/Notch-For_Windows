param([switch]$Test)

# Watches the Windows key at the lowest keyboard level.
#
# A lone tap must not open Start, but simply swallowing the key-up leaves Windows
# believing Win is still held, which turns every later keystroke into a Win
# shortcut (that is the "I can't type any more" bug). Instead the physical up is
# swallowed and replaced by a synthetic burst: Shift down, Win up, Shift up. The
# extra key suppresses Start, and the Win up clears the modifier so the keyboard
# keeps working. Chords (Win+E, Win+D, Win+L) are untouched: their Win down was
# never intercepted.
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class JarvisWinHook
{
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    // Must be as large as the mouse variant (32 bytes on x64), or SendInput
    // rejects the whole batch and injects nothing.
    [StructLayout(LayoutKind.Explicit, Size = 32)]
    private struct INPUTUNION
    {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const uint VK_LWIN = 0x5B;
    private const uint VK_RWIN = 0x5C;
    private const uint VK_SHIFT = 0x10;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 2;
    private static readonly IntPtr MARKER = (IntPtr)0x4E4F5443; // "NOTC"

    private static LowLevelKeyboardProc _proc = HookCallback;
    private static IntPtr _hook = IntPtr.Zero;
    private static bool _other = false;
    private static bool _winDown = false;
    private static int _slot = 0;
    private static bool _slotUp = false;

    // 1..9 and 0 (tenth), from either the number row or the numpad, so the same
    // key Windows uses to open a taskbar app opens ours.
    private static int SlotFor(uint vk)
    {
        if (vk >= 0x31 && vk <= 0x39) return (int)(vk - 0x30);
        if (vk == 0x30) return 10;
        if (vk >= 0x61 && vk <= 0x69) return (int)(vk - 0x60);
        if (vk == 0x60) return 10;
        return 0;
    }

    public static bool AllowInjected = false;

    // The launcher is opened from this process's key event, not the app's, so
    // Windows refuses the app's SetForegroundWindow and typing lands in whatever
    // was in front. Attaching to the foreground thread first makes it stick.
    private static void FocusWindow(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return;
        IntPtr foreground = GetForegroundWindow();
        uint pid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out pid);
        uint mine = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != mine && AttachThreadInput(mine, foregroundThread, true);
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);
        if (attached) AttachThreadInput(mine, foregroundThread, false);
    }

    private static string ExeFor(uint pid)
    {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return "";
        try
        {
            StringBuilder path = new StringBuilder(1024);
            int size = path.Capacity;
            if (QueryFullProcessImageName(handle, 0, path, ref size)) return path.ToString(0, size);
            return "";
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    // Every real top-level app window, which Chromium's desktopCapturer misses
    // (Terminal and Explorer windows simply do not appear in its list).
    public static void ListWindows()
    {
        StringBuilder output = new StringBuilder();
        output.Append("WB\n");
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            if ((GetWindowLong(hWnd, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
            int cloak = 0;
            try
            {
                if (DwmGetWindowAttribute(hWnd, 14, out cloak, sizeof(int)) == 0 && cloak != 0) return true;
            }
            catch
            {
                // dwmapi missing: keep the window rather than drop it
            }
            StringBuilder title = new StringBuilder(512);
            if (GetWindowText(hWnd, title, 512) <= 0) return true;
            string text = title.ToString().Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ').Trim();
            if (text.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            output.Append(((long)hWnd).ToString()).Append('\t').Append(pid).Append('\t')
                .Append(text).Append('\t').Append(ExeFor(pid)).Append('\n');
            return true;
        }, IntPtr.Zero);
        output.Append("WE");
        Console.WriteLine(output.ToString());
        Console.Out.Flush();
    }

    // A taskbar click: bring it up, or put it away when it is already in front.
    private static void ToggleWindow(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return;
        if (hWnd == GetForegroundWindow())
        {
            ShowWindow(hWnd, 6); // SW_MINIMIZE
            return;
        }
        ShowWindow(hWnd, 9); // SW_RESTORE
        FocusWindow(hWnd);
    }

    // The app talks to us on stdin: "focus <hwnd>".
    private static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string text = line.Trim();
                if (text.StartsWith("focus "))
                {
                    long value;
                    if (long.TryParse(text.Substring(6), out value)) FocusWindow((IntPtr)value);
                }
                else if (text.StartsWith("toggle "))
                {
                    long value;
                    if (long.TryParse(text.Substring(7), out value)) ToggleWindow((IntPtr)value);
                }
                else if (text == "windows")
                {
                    ListWindows();
                }
                else if (text.StartsWith("activate "))
                {
                    long value;
                    if (long.TryParse(text.Substring(9), out value))
                    {
                        ShowWindow((IntPtr)value, 9); // SW_RESTORE
                        FocusWindow((IntPtr)value);
                    }
                }
            }
        }
        catch
        {
            // stdin closed: keep the hook alive, only the focus helper is gone
        }
    }

    public static int Run()
    {
        System.Threading.Thread reader = new System.Threading.Thread(ReadCommands);
        reader.IsBackground = true;
        reader.Start();

        _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
        if (_hook == IntPtr.Zero)
        {
            Console.WriteLine("fail:" + Marshal.GetLastWin32Error());
            Console.Out.Flush();
            return 2;
        }
        Console.WriteLine("ready");
        Console.Out.Flush();
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) != 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        UnhookWindowsHookEx(_hook);
        return 0;
    }

    private static INPUT KeyInput(uint vk, bool up)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = (ushort)vk;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = MARKER;
        return input;
    }

    // Shift in between makes Windows treat the release as a chord, so Start stays
    // shut, while the Win up still lands and clears the modifier state.
    private static void ReleaseWin(uint vk)
    {
        INPUT[] inputs = new INPUT[3];
        inputs[0] = KeyInput(VK_SHIFT, false);
        inputs[1] = KeyInput(vk, true);
        inputs[2] = KeyInput(VK_SHIFT, true);
        SendInput(3, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            bool injected = (info.flags & 0x10) != 0;
            bool ours = info.dwExtraInfo == MARKER;
            if (!ours && (!injected || AllowInjected))
            {
                int message = wParam.ToInt32();
                bool isWin = info.vkCode == VK_LWIN || info.vkCode == VK_RWIN;

                bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                bool up = message == WM_KEYUP || message == WM_SYSKEYUP;

                if (isWin && down)
                {
                    _other = false;
                    _winDown = true;
                    _slot = 0;
                    _slotUp = false;
                }
                else if (!isWin && down)
                {
                    int slot = _winDown ? SlotFor(info.vkCode) : 0;
                    if (slot > 0)
                    {
                        // Win+number is ours: the number never reaches the shell,
                        // and the up is swallowed to match it.
                        _slot = slot;
                        _slotUp = true;
                        _other = true;
                        return (IntPtr)1;
                    }
                    // A chord is in progress: let Windows have it.
                    _other = true;
                }
                else if (!isWin && up && _slotUp && SlotFor(info.vkCode) == _slot)
                {
                    _slotUp = false;
                    return (IntPtr)1;
                }
                else if (isWin && up)
                {
                    _winDown = false;
                    if (_slot > 0)
                    {
                        int slot = _slot;
                        _slot = 0;
                        Console.WriteLine("slot " + slot);
                        Console.Out.Flush();
                        ReleaseWin(info.vkCode);
                        return (IntPtr)1;
                    }
                    if (!_other)
                    {
                        Console.WriteLine("win");
                        Console.Out.Flush();
                        ReleaseWin(info.vkCode);
                        return (IntPtr)1;
                    }
                    _other = false;
                }
            }
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }
}
"@

[JarvisWinHook]::AllowInjected = $Test.IsPresent
exit [JarvisWinHook]::Run()
