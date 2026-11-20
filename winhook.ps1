param([switch]$Test, [switch]$Overflow)

# Watches the Windows key at the lowest keyboard level.
#
# A lone tap must not open Start, but simply swallowing the key-up leaves Windows
# believing Win is still held, which turns every later keystroke into a Win
# shortcut (that is the "I can't type any more" bug). Instead the physical up is
# swallowed and replaced by a synthetic burst: Shift down, Win up, Shift up. The
# extra key suppresses Start, and the Win up clears the modifier so the keyboard
# keeps working. Chords (Win+E, Win+D, Win+L) are untouched: their Win down was
# never intercepted.
Add-Type -ReferencedAssemblies @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Management', 'System') -TypeDefinition @"
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Automation;

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
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    // Is something taking the whole screen right now? Windows knows when a game
    // owns the display (it suppresses notifications for it), and a window that
    // covers the screen without the taskbar showing is the windowed case. Either
    // answer lets the shell get out of the way completely.
    public static string GameState()
    {
        int quns = 0;
        try { SHQueryUserNotificationState(out quns); } catch { }
        if (quns == 3 || quns == 4) return "1\tfullscreen";

        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return "0";
        RECT rect;
        if (!GetWindowRect(foreground, out rect)) return "0";
        int screenWidth = GetSystemMetrics(0);
        int screenHeight = GetSystemMetrics(1);
        if (screenWidth <= 0 || screenHeight <= 0) return "0";
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        // A maximised window stops short of the taskbar; a game does not.
        bool covers = width >= screenWidth - 2 && height >= screenHeight - 2;
        if (!covers) return "0";

        // A window that covers the screen because the taskbar is hidden is a
        // maximised app, not a fullscreen one, and the pill belongs over it.
        const int GWL_STYLE = -16;
        const int WS_MAXIMIZE = 0x01000000;
        if ((GetWindowLong(foreground, GWL_STYLE) & WS_MAXIMIZE) != 0) return "0";

        uint pid;
        GetWindowThreadProcessId(foreground, out pid);
        string name = "";
        try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLower(); } catch { }
        // Our own surfaces, the shell, and the Start menu are not games.
        if (name == "electron" || name == "explorer" || name == "searchhost" ||
            name == "shellhost" || name == "shellexperiencehost" || name == "startmenuexperiencehost" ||
            name == "lockapp" || name == "textinputhost") return "0";
        return "1\tfullscreen";
    }

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

    // Packaged apps (the Store Notepad, for one) refuse the image query, so the
    // process name stands in: grouping needs an identity, not a full path.
    private static string BareName(uint pid)
    {
        try
        {
            return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName + ".exe";
        }
        catch
        {
            return "";
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
            string exe = ExeFor(pid);
            if (exe.Length == 0) exe = BareName(pid);
            output.Append(((long)hWnd).ToString()).Append('\t').Append(pid).Append('\t')
                .Append(text).Append('\t').Append(exe).Append('\n');
            return true;
        }, IntPtr.Zero);
        output.Append("WE");
        Console.WriteLine(output.ToString());
        Console.Out.Flush();
    }

    // The notification area (network, volume, privacy and input indicators, the
    // hidden-icons chevron). The clock and the show-desktop sliver are skipped:
    // the taskbar draws its own clock, and the sliver is not an icon.
    private static List<AutomationElement> _tray = new List<AutomationElement>();

    public static void ListTray()
    {
        _tray.Clear();
        StringBuilder output = new StringBuilder();
        output.Append("TB\n");
        try
        {
            AutomationElement shell = AutomationElement.RootElement.FindFirst(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ClassNameProperty, "Shell_TrayWnd"));
            if (shell != null)
            {
                AutomationElementCollection items = shell.FindAll(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.AutomationIdProperty, "SystemTrayIcon"));
                foreach (AutomationElement element in items)
                {
                    try
                    {
                        string cls = element.Current.ClassName ?? "";
                        System.Windows.Rect box = element.Current.BoundingRectangle;
                        if (box.Width <= 0 || box.Height <= 0) continue;
                        string name = (element.Current.Name ?? "").Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ').Trim();
                        output.Append(_tray.Count).Append('\t')
                            .Append((int)box.X).Append('\t').Append((int)box.Y).Append('\t')
                            .Append((int)box.Width).Append('\t').Append((int)box.Height).Append('\t')
                            .Append(cls).Append('\t').Append(name).Append('\n');
                        _tray.Add(element);
                    }
                    catch
                    {
                        // an icon that vanished mid-walk: skip it
                    }
                }
            }
        }
        catch
        {
            // no automation: the bar just shows no tray icons
        }
        output.Append("TE");
        Console.WriteLine(output.ToString());
        Console.Out.Flush();
    }

    // One press on an element: its own Invoke where the provider has one, and a
    // physical click at its middle where it does not (the tray's buttons are
    // drawn by the shell, so most of them have no Invoke).
    private static bool Press(AutomationElement element)
    {
        if (element == null) return false;
        try
        {
            object pattern;
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
            {
                ((InvokePattern)pattern).Invoke();
                return true;
            }
        }
        catch
        {
            // fall through to a physical click
        }
        try
        {
            System.Windows.Rect box = element.Current.BoundingRectangle;
            if (box.Width <= 0 || box.Height <= 0) return false;
            SetCursorPos((int)(box.X + box.Width / 2), (int)(box.Y + box.Height / 2));
            mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
            mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
            return true;
        }
        catch
        {
            return false;
        }
    }

    // Open a tray flyout the way a click on it would.
    public static void ClickTray(int index)
    {
        if (index < 0 || index >= _tray.Count) return;
        Press(_tray[index]);
    }

    // The first of these buttons whose name says what it is, in the languages
    // Windows names it in: the name is the only thing a build without the
    // chevron's own class gives away.
    private static AutomationElement Named(AutomationElementCollection buttons)
    {
        foreach (AutomationElement button in buttons)
        {
            try
            {
                string name = (button.Current.Name ?? "").ToLowerInvariant();
                if (name.Contains("chevron") || name.Contains("hidden icon") ||
                    name.Contains("hidden") || name.Contains("ausgeblendet") ||
                    name.Contains("versteckt") || name.Contains("ocult") ||
                    name.Contains("masqu") || name.Contains("nascondi") ||
                    name.Contains("verborgen") || name.Contains("ukry") ||
                    name.Contains("gizli") || name.Contains("скрыт") ||
                    name.Contains("隐藏") || name.Contains("非表示") ||
                    name.Contains("숨긴"))
                    return button;
            }
            catch
            {
                // an element that went away mid-walk: skip it
            }
        }
        return null;
    }

    // The chevron left of the icons (the ^ that hides and shows them). Windows
    // gives it a class of its own; older builds only give it a name, translated.
    private static AutomationElement Chevron()
    {
        try
        {
            AutomationElement shell = AutomationElement.RootElement.FindFirst(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ClassNameProperty, "Shell_TrayWnd"));
            if (shell == null) return null;
            AutomationElement byClass = shell.FindFirst(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ClassNameProperty, "SystemTray.OmniButton"));
            if (byClass != null) return byClass;
            // Only the tray's own buttons are candidates: the taskbar's app
            // buttons are Buttons too, and pressing one of those instead would
            // bring an app up rather than open anything.
            AutomationElement direct = null;
            int directCount = 0;
            AutomationElementCollection children = shell.FindAll(
                TreeScope.Children,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
            foreach (AutomationElement child in children)
            {
                direct = child;
                directCount += 1;
            }
            AutomationElement byName = Named(shell.FindAll(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
            if (byName != null) return byName;
            // One lone button under the bar is the chevron on builds that expose
            // nothing else about it.
            if (directCount == 1) return direct;
            return null;
        }
        catch
        {
            return null;
        }
    }

    // The hidden notification icons are Windows' own panel: the shell draws them,
    // knows their tooltips, their menus and where they sit, so the chevron opens
    // that panel rather than a copy of it. Pressing the real chevron is the only
    // way to ask for it that leaves the shell's idea of the panel's state right.
    public static void OpenOverflow()
    {
        Press(Chevron());
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtr")]
    private static extern IntPtr GetClassLongPtr64(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint = "GetClassLong")]
    private static extern uint GetClassLong32(IntPtr hWnd, int nIndex);

    private const uint WM_GETICON = 0x007F;
    private const int ICON_SMALL = 0;
    private const int ICON_BIG = 1;
    private const int ICON_SMALL2 = 2;
    private const int GCLP_HICON = -14;
    private const int GCLP_HICONSM = -34;

    private static IntPtr ClassIcon(IntPtr hWnd, int index)
    {
        if (IntPtr.Size == 8) return GetClassLongPtr64(hWnd, index);
        return (IntPtr)unchecked((int)GetClassLong32(hWnd, index));
    }

    // The icon a window draws for itself. Reading the executable's icon needs a
    // path, and packaged apps (the Store Notepad, Settings, anything UWP) do not
    // hand one out, so those buttons used to fall back to initials.
    public static string WindowIcon(long handle)
    {
        IntPtr hWnd = (IntPtr)handle;
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return "-";
        try
        {
            IntPtr icon = IntPtr.Zero;
            IntPtr result;
            int[] wanted = new int[] { ICON_BIG, ICON_SMALL2, ICON_SMALL };
            foreach (int which in wanted)
            {
                result = IntPtr.Zero;
                IntPtr ok = SendMessageTimeout(hWnd, WM_GETICON, (IntPtr)which, IntPtr.Zero, 0x0002, 150, out result);
                if (ok != IntPtr.Zero && result != IntPtr.Zero)
                {
                    icon = result;
                    break;
                }
            }
            if (icon == IntPtr.Zero) icon = ClassIcon(hWnd, GCLP_HICON);
            if (icon == IntPtr.Zero) icon = ClassIcon(hWnd, GCLP_HICONSM);
            if (icon == IntPtr.Zero) return "-";
            // Clone: the handle belongs to the other window, so it must not be
            // destroyed when this copy goes away.
            using (Icon source = Icon.FromHandle(icon))
            using (Icon copy = (Icon)source.Clone())
            using (Bitmap bitmap = copy.ToBitmap())
            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        }
        catch
        {
            return "-";
        }
    }

[DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc proc, IntPtr lParam);

    private static uint _hostOwnPid;
    private static string _hostExe = "";

    private static bool HostExeChild(IntPtr child, IntPtr lParam)
    {
        uint pid;
        GetWindowThreadProcessId(child, out pid);
        if (pid != 0 && pid != _hostOwnPid)
        {
            string exe = ExeFor(pid);
            if (exe.Length == 0) exe = ExeForApp(pid);
            if (exe.Length > 0)
            {
                _hostExe = exe;
                return false;
            }
        }
        return true;
    }

    // A packaged app draws inside a window owned by a shared host process, so the
    // window's own executable is the host, not the app. The app itself runs in a
    // window further down the tree, and that path carries the app's icon.
    public static string HostExe(long handle)
    {
        IntPtr hWnd = (IntPtr)handle;
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return "";
        GetWindowThreadProcessId(hWnd, out _hostOwnPid);
        _hostExe = "";
        EnumChildWindows(hWnd, HostExeChild, IntPtr.Zero);
        return _hostExe;
    }

    // A packaged app runs in a container this process may not open, so its
    // executable is asked of the service that can see it instead.
    private static string ExeForApp(uint pid)
    {
        try
        {
            using (System.Management.ManagementObjectSearcher searcher =
                new System.Management.ManagementObjectSearcher(
                    "SELECT ExecutablePath FROM Win32_Process WHERE ProcessId=" + pid))
            {
                foreach (System.Management.ManagementObject entry in searcher.Get())
                {
                    object path = entry["ExecutablePath"];
                    if (path != null)
                    {
                        string text = path.ToString();
                        if (text.Length > 0) return text;
                    }
                }
            }
        }
        catch
        {
            // no answer: the caller falls back to the window's own icon
        }
        return "";
    }

    // The icon in an executable's own resource. Chromium's file-icon call can
    // hand back the generic application bitmap for an app that ships a perfectly
    // good icon, which is how Freebuff's button ended up as a blank window.
    public static string ExeIcon(string path)
    {
        try
        {
            if (String.IsNullOrEmpty(path) || !System.IO.File.Exists(path)) return "-";
            using (Icon icon = Icon.ExtractAssociatedIcon(path))
            {
                if (icon == null) return "-";
                using (Bitmap bitmap = icon.ToBitmap())
                using (MemoryStream stream = new MemoryStream())
                {
                    bitmap.Save(stream, ImageFormat.Png);
                    return Convert.ToBase64String(stream.ToArray());
                }
            }
        }
        catch
        {
            return "-";
        }
    }

    // A strip of the screen as PNG, for the tray icons. GDI reads the desktop
    // surface straight away, where the Chromium capturer waits for a composited
    // frame that a still screen never delivers.
    public static void Shot(int x, int y, int w, int h)
    {
        try
        {
            using (Bitmap bmp = new Bitmap(w, h))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                }
                using (MemoryStream stream = new MemoryStream())
                {
                    bmp.Save(stream, ImageFormat.Png);
                    Console.WriteLine("IMG\t" + w + "\t" + h + "\t" + Convert.ToBase64String(stream.ToArray()));
                    Console.Out.Flush();
                }
            }
        }
        catch
        {
            Console.WriteLine("IMG\t0\t0\t");
            Console.Out.Flush();
        }
    }

    // How hard the graphics card is working, as one number.
    //
    // Windows publishes GPU use per engine instance — process, adapter and engine
    // type — so the 3D instances are added up and the rest (copy, video decode) is
    // left out: a game drawing frames is 3D. The counters are kept between calls
    // because a percentage is a delta over time and a fresh counter always reads
    // zero first; they are rebuilt every so often, since a game that starts or
    // stops renames the instances out from under them.
    private static Dictionary<string, CounterSample> _gpuBefore = new Dictionary<string, CounterSample>();

    private static string GpuLoad()
    {
        try
        {
            // One read of the whole category, not one call per instance: there are
            // dozens of instances and every single-instance read walks the category
            // again, which is the difference between a few milliseconds and a third
            // of a second.
            InstanceDataCollection samples = new PerformanceCounterCategory("GPU Engine").ReadCategory()["Utilization Percentage"];
            if (samples == null) return "-1";

            double total = 0;
            Dictionary<string, CounterSample> now = new Dictionary<string, CounterSample>(samples.Count);
            foreach (DictionaryEntry entry in samples)
            {
                string name = (string)entry.Key;
                if (name.IndexOf("engtype_3D", StringComparison.OrdinalIgnoreCase) < 0) continue;
                CounterSample current = ((InstanceData)entry.Value).Sample;
                now[name] = current;
                CounterSample before;
                if (!_gpuBefore.TryGetValue(name, out before)) continue;
                // Busy time over wall time, both in 100 ns units: that is the
                // percentage this engine reported for this sample window.
                long span = current.TimeStamp - before.TimeStamp;
                long busy = current.RawValue - before.RawValue;
                if (span <= 0 || busy < 0) continue;
                total += (busy * 100.0) / span;
            }
            _gpuBefore = now;
            if (now.Count == 0) return "-1";
            return ((int)Math.Round(Math.Min(100.0, total))).ToString();
        }
        catch
        {
            _gpuBefore.Clear();
            return "-1";
        }
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
                else if (text == "tray")
                {
                    ListTray();
                }
                else if (text.StartsWith("trayclick "))
                {
                    int index;
                    if (int.TryParse(text.Substring(10), out index)) ClickTray(index);
                }
                else if (text == "trayoverflow")
                {
                    OpenOverflow();
                }
                else if (text.StartsWith("icons "))
                {
                    long iconHandle;
                    if (long.TryParse(text.Substring(6), out iconHandle))
                    {
                        Console.WriteLine("ICO\t" + WindowIcon(iconHandle));
                        Console.Out.Flush();
                    }
                }
                else if (text.StartsWith("exeicon "))
                {
                    Console.WriteLine("ICO\t" + ExeIcon(text.Substring(8).Trim().Trim('"')));
                    Console.Out.Flush();
                }
                else if (text.StartsWith("hostexe "))
                {
                    long hostHandle;
                    if (long.TryParse(text.Substring(8), out hostHandle))
                    {
                        Console.WriteLine("EXE\t" + HostExe(hostHandle));
                        Console.Out.Flush();
                    }
                }
                else if (text.StartsWith("shot "))
                {
                    string[] parts = text.Split(' ');
                    int x, y, w, h;
                    if (parts.Length == 5 &&
                        int.TryParse(parts[1], out x) && int.TryParse(parts[2], out y) &&
                        int.TryParse(parts[3], out w) && int.TryParse(parts[4], out h) &&
                        w > 0 && h > 0 && w <= 4096 && h <= 4096 && (long)w * h <= 9000000)
                    {
                        Shot(x, y, w, h);
                    }
                }
                else if (text == "game")
                {
                    Console.WriteLine("GAME\t" + GameState());
                    Console.Out.Flush();
                }
                else if (text == "gpu")
                {
                    Console.WriteLine("GPU\t" + GpuLoad());
                    Console.Out.Flush();
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

    // An exception on this thread ends the process, and the Windows key, the taskbar
    // slots and the tray go with it until the app itself is restarted. Handing the
    // key to Windows is the cheaper failure, so the decision is guarded.
    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            return HookDecision(nCode, wParam, lParam);
        }
        catch
        {
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }
    }

    private static IntPtr HookDecision(int nCode, IntPtr wParam, IntPtr lParam)
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

# One press of the tray chevron, for a bar whose keyboard hook is not running:
# there is nothing to watch, so the process is over as soon as it has pressed.
if ($Overflow.IsPresent)
{
    [JarvisWinHook]::OpenOverflow()
    exit 0
}

exit [JarvisWinHook]::Run()
