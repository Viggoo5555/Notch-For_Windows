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
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
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
    private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);
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
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
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

        // The display this window sits on, not the primary one: a borderless game
        // on a second monitor covers its own screen, and the primary's size says
        // nothing about that one's.
        int left = 0, top = 0, width = 0, height = 0;
        IntPtr monitor = MonitorFromWindow(foreground, 2); // MONITOR_DEFAULTTONEAREST
        if (monitor != IntPtr.Zero)
        {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(monitor, ref info))
            {
                left = info.rcMonitor.Left;
                top = info.rcMonitor.Top;
                width = info.rcMonitor.Right - info.rcMonitor.Left;
                height = info.rcMonitor.Bottom - info.rcMonitor.Top;
            }
        }
        if (width <= 0 || height <= 0)
        {
            width = GetSystemMetrics(0);
            height = GetSystemMetrics(1);
        }
        if (width <= 0 || height <= 0) return "0";

        // Edge to edge on that display: a maximised window stops short of the
        // taskbar, a game does not.
        bool covers =
            rect.Left <= left + 2 && rect.Top <= top + 2 &&
            rect.Right >= left + width - 2 && rect.Bottom >= top + height - 2;
        if (!covers) return "0";

        // A title bar and a resizable frame are what an ordinary window wears, and
        // one that fills its display while wearing them is a maximised app — the
        // pill belongs over that. A game in a borderless window has neither,
        // maximised flag or not, and owns the display.
        const int GWL_STYLE = -16;
        const int WS_MAXIMIZE = 0x01000000;
        const int WS_CAPTION = 0x00C00000;
        const int WS_THICKFRAME = 0x00040000;
        int style = GetWindowLong(foreground, GWL_STYLE);
        bool framed = (style & WS_CAPTION) != 0 || (style & WS_THICKFRAME) != 0;
        if (framed && (style & WS_MAXIMIZE) != 0) return "0";

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
    // The press Windows was given for a chord, and which Windows key it was.
    private static bool _chord = false;
    private static uint _winVk = 0;

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
    // Whether the Windows key is Notch's or Windows'. Off means every key event is
    // simply handed on, exactly as if this hook were not installed — the helper is
    // still up for the tray, the window list and the taskbar.
    public static bool WatchWin = true;

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
                        // An icon whose bar is hidden still exists to be pressed, so
                        // it is still listed: there is simply no picture to go with
                        // it, because there are no pixels left to photograph.
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
            // The shell's tray buttons usually offer their click as a default
            // action rather than Invoke, and that action still works when the bar
            // they sit on is hidden.
            if (element.TryGetCurrentPattern(LegacyIAccessiblePattern.Pattern, out pattern))
            {
                ((LegacyIAccessiblePattern)pattern).DoDefaultAction();
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

    // Open a tray flyout the way a click on it would. When the bar is hidden
    // behind Notch's own, it is put back just long enough to be clicked: the
    // flyouts hang off the shell's icons, and an icon with no pixels on screen
    // has nothing a click can land on.
    public static void ClickTray(int index)
    {
        if (index < 0 || index >= _tray.Count) return;
        IntPtr bar = FindWindow("Shell_TrayWnd", null);
        bool wasHidden = bar != IntPtr.Zero && !IsWindowVisible(bar);
        if (wasHidden)
        {
            ShowWindow(bar, 4); // SW_SHOWNOACTIVATE
            System.Threading.Thread.Sleep(120);
        }
        try
        {
            Press(_tray[index]);
        }
        finally
        {
            if (wasHidden)
            {
                // Long enough for the press to reach the shell and its flyout to
                // be on its way out before the bar goes away again.
                System.Threading.Thread.Sleep(220);
                ShowWindow(bar, 0); // SW_HIDE
            }
        }
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

    // Notch's bar replaces the taskbar, so the real one can be taken out of the
    // way. Its window is only hidden, never removed: bringing it back is one
    // call, and SW_SHOWNOACTIVATE does it without taking the focus away from
    // whatever is in front.
    public static string ShellBar(int hide)
    {
        try
        {
            IntPtr bar = FindWindow("Shell_TrayWnd", null);
            if (bar == IntPtr.Zero) return "missing";
            ShowWindow(bar, hide != 0 ? 0 : 4); // SW_HIDE / SW_SHOWNOACTIVATE
            return hide != 0 ? "hidden" : "shown";
        }
        catch
        {
            return "missing";
        }
    }

    // A press on a taskbar button, read the way Windows reads it: the app in
    // front is put away, an app behind comes forward, and a group of windows
    // moves through its windows before any of them is minimised.
    public static void GroupClick(string list)
    {
        List<IntPtr> windows = new List<IntPtr>();
        foreach (string part in list.Split(' '))
        {
            long value;
            if (long.TryParse(part, out value) && value != 0) windows.Add((IntPtr)value);
        }
        if (windows.Count == 0) return;
        IntPtr foreground = GetForegroundWindow();
        bool front = false;
        foreach (IntPtr hwnd in windows) if (hwnd == foreground) front = true;
        if (front)
        {
            // Another window of this app is still open, so that one comes up
            // instead of the whole app going away: a second press on a grouped
            // button moves to the next window, the way Windows does it.
            foreach (IntPtr hwnd in windows)
            {
                if (hwnd == foreground || !IsWindow(hwnd) || IsIconic(hwnd)) continue;
                ShowWindow(hwnd, 9); // SW_RESTORE
                FocusWindow(hwnd);
                return;
            }
            foreach (IntPtr hwnd in windows)
            {
                if (!IsWindow(hwnd)) continue;
                ShowWindow(hwnd, 6); // SW_MINIMIZE
            }
            return;
        }
        // Nothing of this app is in front: a minimised window comes back, and
        // otherwise the first one is brought forward.
        foreach (IntPtr hwnd in windows)
        {
            if (!IsWindow(hwnd) || !IsIconic(hwnd)) continue;
            ShowWindow(hwnd, 9);
            FocusWindow(hwnd);
            return;
        }
        foreach (IntPtr hwnd in windows)
        {
            if (!IsWindow(hwnd)) continue;
            ShowWindow(hwnd, 9);
            FocusWindow(hwnd);
            return;
        }
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
                // Silent on purpose: the app's reader treats every tabbed line
                // as a row of a list it is collecting, and this is not one.
                else if (text == "taskbarhide")
                {
                    ShellBar(1);
                }
                else if (text == "taskbarshow")
                {
                    ShellBar(0);
                }
                else if (text.StartsWith("group "))
                {
                    GroupClick(text.Substring(6).Trim());
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
                else if (text == "winkey on")
                {
                    WatchWin = true;
                }
                else if (text == "winkey off")
                {
                    WatchWin = false;
                }
                else if (text.StartsWith("close "))
                {
                    long value;
                    if (long.TryParse(text.Substring(6), out value))
                    {
                        // Exactly what the window's own close button does, so an app
                        // with unsaved work still gets to ask about it.
                        PostMessage((IntPtr)value, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
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

    // A chord is the only thing Windows is ever given a real Windows press for,
    // and it gets one of each: down when the other key arrives, up when the key
    // comes back up. Marked as ours, so the hook itself ignores it.
    private static void SendWin(uint vk, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0] = KeyInput(vk, up);
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
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
        if (!WatchWin) return CallNextHookEx(_hook, nCode, wParam, lParam);
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
                    Console.WriteLine("windown");
                    Console.Out.Flush();
                    // Swallowed, both halves yet to come: Windows never sees a press
                    // of its own, so nothing it does with one — Start opening on it,
                    // or on the release — can happen. Before this the press was let
                    // through and only the release was taken, which is why the menu
                    // kept opening: the shell had already been told about the key.
                    _other = false;
                    _winDown = true;
                    _slot = 0;
                    _slotUp = false;
                    _chord = false;
                    _winVk = info.vkCode;
                    return (IntPtr)1;
                }
                else if (!isWin && down && _winDown)
                {
                    int slot = SlotFor(info.vkCode);
                    if (slot > 0)
                    {
                        // Win+number is ours: the number never reaches the shell,
                        // and the up is swallowed to match it.
                        _slot = slot;
                        _slotUp = true;
                        _other = true;
                        return (IntPtr)1;
                    }
                    // A real chord (Win+E, Win+D, Win+L): hand over the press it
                    // never got, then let the key itself through.
                    if (!_chord)
                    {
                        _chord = true;
                        Console.WriteLine("chord");
                        Console.Out.Flush();
                        SendWin(_winVk, false);
                    }
                    _other = true;
                }
                else if (!isWin && up && _slotUp && SlotFor(info.vkCode) == _slot)
                {
                    _slotUp = false;
                    return (IntPtr)1;
                }
                else if (isWin && up)
                {
                    Console.WriteLine("winup");
                    Console.Out.Flush();
                    bool chord = _chord;
                    int slot = _slot;
                    _winDown = false;
                    _slot = 0;
                    _slotUp = false;
                    _other = false;
                    _chord = false;
                    // The release is always swallowed too; only a chord gets a
                    // synthetic one, to clear the press it was given.
                    if (chord) SendWin(info.vkCode, true);
                    if (slot > 0)
                    {
                        Console.WriteLine("slot " + slot);
                        Console.Out.Flush();
                    }
                    else if (!chord)
                    {
                        Console.WriteLine("win");
                        Console.Out.Flush();
                    }
                    return (IntPtr)1;
                }
            }
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }
}